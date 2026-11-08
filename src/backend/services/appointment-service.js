const { getDb } = require('../db');
const { generateManagementToken } = require('../utils/auth');
const {
  addMinutesToTime,
  timeToMinutes,
  isValidDateString,
  isValidTimeFormat,
  getAvailableStartSlots,
  canClientModifyAppointment,
  formatDateBR,
  getDayNamePT
} = require('../utils/time');
const {
  validateClientInput,
  formatPhoneBR,
  formatCurrencyBR
} = require('../utils/validators');
const {
  notifyNewAppointment,
  notifyClientCancellation,
  notifyAppointmentCompleted,
  getMessageTemplatesSync,
  renderMessageTemplate
} = require('./whatsapp-service');
const { evaluateWaitlistForDate } = require('./waitlist-service');

function enrichAppointment(app) {
  if (!app) return null;
  const cleanDigits = String(app.client_phone || '').replace(/\D/g, '');
  const waPhone = cleanDigits ? (cleanDigits.startsWith('55') ? cleanDigits : `55${cleanDigits}`) : '';
  const dateBR = formatDateBR(app.appointment_date);
  const totalPriceFormatted = formatCurrencyBR(app.total_price);
  const servicesSummary = (app.items || []).map((i) => i.service_name).join(', ');
  const clientPhoneFormatted = formatPhoneBR(app.client_phone);

  let clientWhatsappUrl = '';
  if (waPhone) {
    const templates = getMessageTemplatesSync();
    const msgText = renderMessageTemplate(templates.mensagem_cliente, {
      cliente: app.client_name,
      telefone: clientPhoneFormatted,
      servicos: servicesSummary,
      data: dateBR,
      horario: `${app.start_time} às ${app.end_time}`,
      valor: totalPriceFormatted
    });
    clientWhatsappUrl = `https://wa.me/${waPhone}?text=${encodeURIComponent(msgText)}`;
  }

  return {
    ...app,
    dateBR,
    dayName: getDayNamePT(app.appointment_date),
    client_phone_formatted: clientPhoneFormatted,
    total_price_formatted: totalPriceFormatted,
    services_summary: servicesSummary,
    management_url: `/agendamento/${app.management_token}`,
    client_whatsapp_url: clientWhatsappUrl,
    can_client_modify:
      app.status === 'confirmado' &&
      canClientModifyAppointment(app.appointment_date, app.start_time)
  };
}

function validateSlotInsideTransaction(
  dayConfig,
  activeOnDay,
  startTime,
  totalDuration,
  isAdmin = false
) {
  if (!dayConfig || !dayConfig.is_working) {
    const err = new Error('O barbeiro não atende na data selecionada.');
    err.statusCode = 400;
    err.code = 'DIA_INDISPONIVEL';
    throw err;
  }

  if (!isAdmin && dayConfig.status !== 'publicada') {
    const err = new Error('Aguarde a confirmação dos dias e horários disponíveis.');
    err.statusCode = 403;
    err.code = 'AGENDA_NAO_PUBLICADA';
    throw err;
  }

  const startMin = timeToMinutes(startTime);
  const endMin = startMin + totalDuration;
  const dayStartMin = timeToMinutes(dayConfig.start_time);
  const dayEndMin = timeToMinutes(dayConfig.end_time);

  if (startMin < dayStartMin || endMin > dayEndMin) {
    const err = new Error(
      `Horário fora do expediente definido (${dayConfig.start_time} às ${dayConfig.end_time}).`
    );
    err.statusCode = 400;
    err.code = 'FORA_DO_EXPEDIENTE';
    throw err;
  }

  const breaks = Array.isArray(dayConfig.breaks) ? dayConfig.breaks : [];
  for (const brk of breaks) {
    const bStart = timeToMinutes(brk.start);
    const bEnd = timeToMinutes(brk.end);
    if (startMin < bEnd && endMin > bStart) {
      const err = new Error(
        `O horário selecionado conflita com o intervalo de descanso (${brk.start} às ${brk.end}).`
      );
      err.statusCode = 400;
      err.code = 'CONFLITO_INTERVALO';
      throw err;
    }
  }

  const hasConflict = (activeOnDay || []).some((other) => {
    if (other.status === 'cancelado') return false;
    const oStart = timeToMinutes(other.start_time);
    const oEnd = timeToMinutes(other.end_time);
    return startMin < oEnd && endMin > oStart;
  });

  if (hasConflict) {
    const err = new Error(
      'Este horário acabou de ser ocupado. Por favor, escolha outro horário disponível.'
    );
    err.statusCode = 409;
    err.code = 'HORARIO_OCUPADO';
    throw err;
  }

  // Confirma também via gerador de blocos consecutivos de 30 minutos
  const validStarts = getAvailableStartSlots(dayConfig, activeOnDay, totalDuration);
  if (!validStarts.some((s) => s.start_time === startTime)) {
    const err = new Error(
      'O horário selecionado não comporta a duração total consecutiva dos serviços escolhidos.'
    );
    err.statusCode = 409;
    err.code = 'HORARIO_OCUPADO';
    throw err;
  }
}

async function resolveServicesSelection(serviceIds, { requireActive = true } = {}) {
  const db = getDb();
  if (!Array.isArray(serviceIds) || serviceIds.length === 0) {
    const err = new Error('Selecione pelo menos um serviço.');
    err.statusCode = 400;
    throw err;
  }

  const uniqueIds = [...new Set(serviceIds.map((id) => String(id).trim()).filter(Boolean))];
  const services = await db.getServicesByIds(uniqueIds);

  if (services.length !== uniqueIds.length) {
    const err = new Error('Um ou mais serviços selecionados não foram encontrados.');
    err.statusCode = 400;
    throw err;
  }

  if (requireActive && services.some((s) => !s.active)) {
    const err = new Error('Um ou mais serviços selecionados não estão mais ativos.');
    err.statusCode = 400;
    throw err;
  }

  // Regra: Cada serviço ocupa um bloco de 30 minutos
  const items = services.map((s) => ({
    service_id: s.id,
    service_name: s.name,
    price: Number(s.price),
    duration: 30
  }));

  const totalDuration = items.length * 30;
  const totalPrice = items.reduce((sum, item) => sum + item.price, 0);

  return { items, totalDuration, totalPrice };
}

async function createAppointment({
  clientName,
  clientPhone,
  appointmentDate,
  startTime,
  serviceIds,
  isAdmin = false,
  notes = ''
}) {
  const db = getDb();

  const clientCheck = validateClientInput(clientName, clientPhone);
  if (!clientCheck.valid) {
    const err = new Error(clientCheck.error);
    err.statusCode = 400;
    throw err;
  }

  if (!isValidDateString(appointmentDate)) {
    const err = new Error('Data do agendamento inválida.');
    err.statusCode = 400;
    throw err;
  }

  if (!isValidTimeFormat(startTime)) {
    const err = new Error('Horário inicial inválido. Escolha um bloco de 30 minutos.');
    err.statusCode = 400;
    throw err;
  }

  const { items, totalDuration, totalPrice } = await resolveServicesSelection(serviceIds, {
    requireActive: !isAdmin
  });
  const endTime = addMinutesToTime(startTime, totalDuration);
  const managementToken = generateManagementToken();

  let created;
  try {
    created = await db.createAppointmentAtomic({
      clientName: clientCheck.name,
      clientPhone: clientCheck.phone,
      appointmentDate,
      startTime,
      endTime,
      totalDuration,
      totalPrice,
      managementToken,
      items,
      isAdmin,
      notes,
      validateSlotFn: (dayConfig, activeOnDay) => {
        validateSlotInsideTransaction(dayConfig, activeOnDay, startTime, totalDuration, isAdmin);
      }
    });
  } catch (err) {
    if (err.message && err.message.includes('HORARIO_OCUPADO')) {
      err.statusCode = 409;
      err.code = 'HORARIO_OCUPADO';
    } else if (err.message && err.message.includes('AGENDA_NAO_PUBLICADA')) {
      err.statusCode = 403;
      err.code = 'AGENDA_NAO_PUBLICADA';
    } else if (!err.statusCode) {
      err.statusCode = 400;
    }
    throw err;
  }

  // Envia notificação WhatsApp para o Luan (Evento 1)
  await notifyNewAppointment(created);

  return enrichAppointment(created);
}

async function getAppointmentByToken(token) {
  const db = getDb();
  const app = await db.getAppointmentByToken(token);
  if (!app) {
    const err = new Error('Agendamento não encontrado ou link inválido.');
    err.statusCode = 404;
    throw err;
  }
  return enrichAppointment(app);
}

/**
 * Cancelamento pelo cliente usando o link individual com token.
 * Regra: permitido até 2 horas antes do atendimento.
 */
async function cancelAppointmentByClientToken(token, now = new Date()) {
  const db = getDb();
  const app = await db.getAppointmentByToken(token);
  if (!app) {
    const err = new Error('Agendamento não encontrado.');
    err.statusCode = 404;
    throw err;
  }

  if (app.status === 'cancelado') {
    const err = new Error('Este agendamento já foi cancelado.');
    err.statusCode = 400;
    throw err;
  }

  if (app.status === 'concluido') {
    const err = new Error('Este atendimento já foi concluído e não pode ser cancelado.');
    err.statusCode = 400;
    throw err;
  }

  // Regra das 2 horas de antecedência
  if (!canClientModifyAppointment(app.appointment_date, app.start_time, now)) {
    const err = new Error(
      'Para alterações ou cancelamentos com menos de 2 horas de antecedência, entre em contato diretamente com a barbearia.'
    );
    err.statusCode = 403;
    err.code = 'BLOQUEIO_2_HORAS';
    throw err;
  }

  const updated = await db.updateAppointmentAtomic(app.id, (existing) => ({
    ...existing,
    status: 'cancelado',
    cancelled_by: 'cliente',
    cancelled_at: now.toISOString()
  }));

  // 1. Notificar Luan pelo WhatsApp (Evento 2)
  await notifyClientCancellation(updated);

  // 2. Verificar se existem clientes na lista de espera compatíveis com o horário liberado
  const waitlistMatches = await evaluateWaitlistForDate(updated.appointment_date);

  return {
    appointment: enrichAppointment(updated),
    waitlist_matches: waitlistMatches
  };
}

/**
 * Alteração (remarcação e/ou troca de serviços) pelo cliente usando seu link individual.
 * Regra: permitido até 2 horas antes do atendimento atual.
 */
async function updateAppointmentByClientToken(
  token,
  { appointmentDate, startTime, serviceIds },
  now = new Date()
) {
  const db = getDb();
  const app = await db.getAppointmentByToken(token);
  if (!app) {
    const err = new Error('Agendamento não encontrado.');
    err.statusCode = 404;
    throw err;
  }

  if (app.status !== 'confirmado') {
    const err = new Error('Apenas agendamentos confirmados podem ser alterados.');
    err.statusCode = 400;
    throw err;
  }

  // Regra das 2 horas de antecedência em relação ao horário atual do agendamento
  if (!canClientModifyAppointment(app.appointment_date, app.start_time, now)) {
    const err = new Error(
      'Para alterações ou cancelamentos com menos de 2 horas de antecedência, entre em contato diretamente com a barbearia.'
    );
    err.statusCode = 403;
    err.code = 'BLOQUEIO_2_HORAS';
    throw err;
  }

  const nextDate = appointmentDate || app.appointment_date;
  const nextStart = startTime || app.start_time;

  if (!isValidDateString(nextDate) || !isValidTimeFormat(nextStart)) {
    const err = new Error('Nova data ou horário inválido.');
    err.statusCode = 400;
    throw err;
  }

  let newItems = null;
  let nextDuration = app.total_duration;
  let nextPrice = app.total_price;

  if (Array.isArray(serviceIds) && serviceIds.length > 0) {
    const currentServiceIds = (app.items || []).map((i) => i.service_id).filter(Boolean);
    const sameServices =
      serviceIds.length === currentServiceIds.length &&
      serviceIds.every((id) => currentServiceIds.includes(id));

    if (!sameServices) {
      const resolved = await resolveServicesSelection(serviceIds, { requireActive: true });
      newItems = resolved.items;
      nextDuration = resolved.totalDuration;
      nextPrice = resolved.totalPrice;
    }
  }

  const nextEnd = addMinutesToTime(nextStart, nextDuration);
  const previousDate = app.appointment_date;

  const updated = await db.updateAppointmentAtomic(
    app.id,
    (existing, { getDayConfig, getActiveAppointmentsOnDate }) => {
      const dayConfig = getDayConfig(nextDate);
      const activeOnDay = getActiveAppointmentsOnDate(nextDate);
      validateSlotInsideTransaction(dayConfig, activeOnDay, nextStart, nextDuration, false);

      return {
        ...existing,
        appointment_date: nextDate,
        start_time: nextStart,
        end_time: nextEnd,
        total_duration: nextDuration,
        total_price: nextPrice,
        newItems
      };
    }
  );

  // Avalia lista de espera na data anterior pois abriu vaga
  await evaluateWaitlistForDate(previousDate);

  return enrichAppointment(updated);
}

/**
 * Atualização manual pelo Luan no Painel Administrativo.
 * O administrador pode alterar horário, serviços, dados do cliente, status e pagamento
 * sem a restrição de 2 horas.
 */
async function updateAppointmentByAdmin(appointmentId, updates) {
  const db = getDb();
  const existing = await db.getAppointmentById(appointmentId);
  if (!existing) {
    const err = new Error('Agendamento não encontrado.');
    err.statusCode = 404;
    throw err;
  }

  const nextClientName =
    updates.clientName !== undefined ? String(updates.clientName).trim() : existing.client_name;
  const nextClientPhone =
    updates.clientPhone !== undefined ? updates.clientPhone : existing.client_phone;

  const clientCheck = validateClientInput(nextClientName, nextClientPhone);
  if (!clientCheck.valid) {
    const err = new Error(clientCheck.error);
    err.statusCode = 400;
    throw err;
  }

  const nextDate = updates.appointmentDate || existing.appointment_date;
  const nextStart = updates.startTime || existing.start_time;
  const nextStatus = updates.status || existing.status;
  const nextPaymentStatus = updates.paymentStatus || existing.payment_status;

  if (!['confirmado', 'concluido', 'cancelado'].includes(nextStatus)) {
    const err = new Error('Status do agendamento inválido.');
    err.statusCode = 400;
    throw err;
  }

  if (!['pendente', 'pago'].includes(nextPaymentStatus)) {
    const err = new Error('Status de pagamento inválido.');
    err.statusCode = 400;
    throw err;
  }

  let newItems = null;
  let nextDuration = existing.total_duration;
  let nextPrice = existing.total_price;

  // Regra 12: Preserva os itens e preços originais a menos que os serviços selecionados sejam explicitamente alterados
  if (Array.isArray(updates.serviceIds) && updates.serviceIds.length > 0) {
    const currentIds = (existing.items || [])
      .map((i) => i.service_id)
      .filter(Boolean)
      .sort()
      .join(',');
    const incomingIds = [...new Set(updates.serviceIds)].sort().join(',');

    if (currentIds !== incomingIds) {
      const resolved = await resolveServicesSelection(updates.serviceIds, {
        requireActive: false
      });
      newItems = resolved.items;
      nextDuration = resolved.totalDuration;
      nextPrice = resolved.totalPrice;
    }
  }

  const nextEnd = addMinutesToTime(nextStart, nextDuration);
  const nowIso = new Date().toISOString();

  const updated = await db.updateAppointmentAtomic(
    appointmentId,
    (curr, { getDayConfig, getActiveAppointmentsOnDate }) => {
      // Se o agendamento estiver ativo (não cancelado) e o horário/data/duração mudou (ou foi reativado), valida conflitos
      const scheduleChanged =
        nextDate !== curr.appointment_date ||
        nextStart !== curr.start_time ||
        nextDuration !== curr.total_duration ||
        curr.status === 'cancelado';

      if (nextStatus !== 'cancelado' && scheduleChanged) {
        const dayConfig = getDayConfig(nextDate);
        const activeOnDay = getActiveAppointmentsOnDate(nextDate);
        validateSlotInsideTransaction(dayConfig, activeOnDay, nextStart, nextDuration, true);
      }

      return {
        ...curr,
        client_name: clientCheck.name,
        client_phone: clientCheck.phone,
        appointment_date: nextDate,
        start_time: nextStart,
        end_time: nextEnd,
        total_duration: nextDuration,
        total_price: nextPrice,
        status: nextStatus,
        payment_status: nextPaymentStatus,
        notes: updates.notes !== undefined ? updates.notes : curr.notes,
        cancelled_by:
          nextStatus === 'cancelado' && curr.status !== 'cancelado'
            ? 'admin'
            : curr.cancelled_by,
        cancelled_at:
          nextStatus === 'cancelado' && curr.status !== 'cancelado'
            ? nowIso
            : curr.cancelled_at,
        completed_at:
          nextStatus === 'concluido' && curr.status !== 'concluido'
            ? nowIso
            : curr.completed_at,
        paid_at:
          nextPaymentStatus === 'pago' && curr.payment_status !== 'pago'
            ? nowIso
            : nextPaymentStatus === 'pendente'
              ? null
              : curr.paid_at,
        newItems
      };
    }
  );

  let waitlistMatches = [];
  // Se foi marcado como concluído agora, dispara notificação WhatsApp (Evento 4)
  if (nextStatus === 'concluido' && existing.status !== 'concluido') {
    await notifyAppointmentCompleted(updated);
  }

  // Se foi cancelado ou mudou de data/horário, verifica oportunidades na lista de espera
  if (
    (nextStatus === 'cancelado' && existing.status !== 'cancelado') ||
    nextDate !== existing.appointment_date ||
    nextStart !== existing.start_time
  ) {
    waitlistMatches = await evaluateWaitlistForDate(existing.appointment_date);
  }

  return {
    appointment: enrichAppointment(updated),
    waitlist_matches: waitlistMatches
  };
}

async function listAppointmentsForAdmin(filters = {}) {
  const db = getDb();
  const list = await db.listAppointments(filters);
  return list.map(enrichAppointment);
}

module.exports = {
  createAppointment,
  getAppointmentByToken,
  cancelAppointmentByClientToken,
  updateAppointmentByClientToken,
  updateAppointmentByAdmin,
  listAppointmentsForAdmin,
  enrichAppointment
};

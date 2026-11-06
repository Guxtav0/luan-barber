const { getDb } = require('../db');
const {
  getMondayOfDate,
  getWeekDates,
  timeToMinutes,
  isValidTimeFormat,
  generateBase30MinBlocks,
  getAvailableStartSlots,
  formatDateBR
} = require('../utils/time');
const { notifySchedulePublished } = require('./whatsapp-service');

/**
 * Configuração inicial sugerida para uma nova semana em rascunho
 * (baseada no exemplo da especificação: Terça 09-18, Quarta 13-20, Sexta 09-18, Sábado 08-16)
 */
function getDefaultDayConfigForWeekday(dayOfWeek) {
  switch (dayOfWeek) {
    case 1: // Segunda-feira
      return { is_working: false, start_time: '09:00', end_time: '18:00', breaks: [] };
    case 2: // Terça-feira
      return { is_working: true, start_time: '09:00', end_time: '18:00', breaks: [] };
    case 3: // Quarta-feira
      return { is_working: true, start_time: '13:00', end_time: '20:00', breaks: [] };
    case 4: // Quinta-feira
      return { is_working: false, start_time: '09:00', end_time: '18:00', breaks: [] };
    case 5: // Sexta-feira
      return { is_working: true, start_time: '09:00', end_time: '18:00', breaks: [] };
    case 6: // Sábado
      return { is_working: true, start_time: '08:00', end_time: '16:00', breaks: [] };
    case 0: // Domingo
    default:
      return { is_working: false, start_time: '09:00', end_time: '14:00', breaks: [] };
  }
}

async function getWeeklyScheduleForAdmin(dateOrWeekStart) {
  const db = getDb();
  const weekStart = getMondayOfDate(dateOrWeekStart);
  const weekDates = getWeekDates(weekStart);
  const existing = await db.getWeeklyScheduleRecord(weekStart);

  const appointments = await db.listAppointments({
    startDate: weekDates[0].date,
    endDate: weekDates[6].date
  });

  const existingDayMap = new Map();
  if (existing && Array.isArray(existing.days)) {
    for (const d of existing.days) {
      existingDayMap.set(d.work_date, d);
    }
  }

  const days = weekDates.map((wd) => {
    const saved = existingDayMap.get(wd.date);
    const defaults = getDefaultDayConfigForWeekday(wd.dayOfWeek);
    const dayObj = saved
      ? {
          work_date: wd.date,
          dateBR: wd.dateBR,
          day_of_week: wd.dayOfWeek,
          dayName: wd.dayName,
          dayShortName: wd.dayShortName,
          is_working: Boolean(saved.is_working),
          start_time: saved.start_time,
          end_time: saved.end_time,
          breaks: Array.isArray(saved.breaks) ? saved.breaks : [],
          status: saved.status
        }
      : {
          work_date: wd.date,
          dateBR: wd.dateBR,
          day_of_week: wd.dayOfWeek,
          dayName: wd.dayName,
          dayShortName: wd.dayShortName,
          ...defaults,
          status: 'rascunho'
        };

    const dayApps = appointments.filter((a) => a.appointment_date === wd.date);
    const baseBlocks = generateBase30MinBlocks(dayObj);
    const freeSlots = getAvailableStartSlots(dayObj, dayApps, 30);

    return {
      ...dayObj,
      total_blocks: baseBlocks.length,
      free_blocks: freeSlots.length,
      appointments_count: dayApps.filter((a) => a.status !== 'cancelado').length
    };
  });

  return {
    week_start: weekStart,
    week_end: weekDates[6].date,
    status: existing ? existing.status : 'rascunho',
    published_at: existing ? existing.published_at : null,
    is_persisted: Boolean(existing),
    days
  };
}

function validateDayInput(day) {
  if (!day.is_working) return { valid: true };
  if (!isValidTimeFormat(day.start_time) || !isValidTimeFormat(day.end_time)) {
    return {
      valid: false,
      error: `Horários inválidos em ${formatDateBR(day.work_date)}. Utilize intervalos de 30 minutos (ex: 09:00, 09:30).`
    };
  }
  const startMin = timeToMinutes(day.start_time);
  const endMin = timeToMinutes(day.end_time);
  if (endMin <= startMin) {
    return {
      valid: false,
      error: `O horário final deve ser maior que o horário inicial em ${formatDateBR(day.work_date)}.`
    };
  }

  const breaks = Array.isArray(day.breaks) ? day.breaks : [];
  for (const brk of breaks) {
    if (!isValidTimeFormat(brk.start) || !isValidTimeFormat(brk.end)) {
      return {
        valid: false,
        error: `Intervalo de descanso inválido em ${formatDateBR(day.work_date)}. Utilize blocos de 30 minutos.`
      };
    }
    const bStart = timeToMinutes(brk.start);
    const bEnd = timeToMinutes(brk.end);
    if (bEnd <= bStart) {
      return {
        valid: false,
        error: `O fim do intervalo deve ser maior que o início em ${formatDateBR(day.work_date)}.`
      };
    }
    if (bStart < startMin || bEnd > endMin) {
      return {
        valid: false,
        error: `O intervalo ${brk.start}-${brk.end} está fora do expediente em ${formatDateBR(day.work_date)}.`
      };
    }
  }
  return { valid: true };
}

/**
 * Regra 14: Não permitir que o Luan remova ou reduza horários de expediente de forma que
 * prejudique agendamentos já confirmados sem apresentar um alerta e exigir resolução dos conflitos.
 */
async function checkScheduleConflictsWithAppointments(weekStart, proposedDays) {
  const db = getDb();
  const weekDates = getWeekDates(weekStart);
  const appointments = await db.listAppointments({
    startDate: weekDates[0].date,
    endDate: weekDates[6].date
  });

  const confirmedAppointments = appointments.filter((a) => a.status === 'confirmado');
  const dayByDate = new Map(proposedDays.map((d) => [d.work_date, d]));
  const conflicts = [];

  for (const app of confirmedAppointments) {
    const dayCfg = dayByDate.get(app.appointment_date);
    if (!dayCfg || !dayCfg.is_working) {
      conflicts.push({
        appointment_id: app.id,
        client_name: app.client_name,
        client_phone: app.client_phone,
        appointment_date: app.appointment_date,
        dateBR: formatDateBR(app.appointment_date),
        start_time: app.start_time,
        end_time: app.end_time,
        reason: 'O dia foi desmarcado da programação semanal.'
      });
      continue;
    }

    const appStart = timeToMinutes(app.start_time);
    const appEnd = timeToMinutes(app.end_time);
    const dayStart = timeToMinutes(dayCfg.start_time);
    const dayEnd = timeToMinutes(dayCfg.end_time);

    if (appStart < dayStart || appEnd > dayEnd) {
      conflicts.push({
        appointment_id: app.id,
        client_name: app.client_name,
        client_phone: app.client_phone,
        appointment_date: app.appointment_date,
        dateBR: formatDateBR(app.appointment_date),
        start_time: app.start_time,
        end_time: app.end_time,
        reason: `Horário do agendamento (${app.start_time} às ${app.end_time}) fica fora do novo expediente (${dayCfg.start_time} às ${dayCfg.end_time}).`
      });
      continue;
    }

    const breaks = Array.isArray(dayCfg.breaks) ? dayCfg.breaks : [];
    const hitBreak = breaks.find((brk) => {
      const bStart = timeToMinutes(brk.start);
      const bEnd = timeToMinutes(brk.end);
      return appStart < bEnd && appEnd > bStart;
    });

    if (hitBreak) {
      conflicts.push({
        appointment_id: app.id,
        client_name: app.client_name,
        client_phone: app.client_phone,
        appointment_date: app.appointment_date,
        dateBR: formatDateBR(app.appointment_date),
        start_time: app.start_time,
        end_time: app.end_time,
        reason: `Horário do agendamento (${app.start_time} às ${app.end_time}) conflita com o intervalo de descanso (${hitBreak.start} às ${hitBreak.end}).`
      });
    }
  }

  return conflicts;
}

async function saveWeeklySchedule({ weekStart, days, publish = false }) {
  const db = getDb();
  const normalizedMonday = getMondayOfDate(weekStart);
  const weekDates = getWeekDates(normalizedMonday);

  const inputByDate = new Map((days || []).map((d) => [d.work_date, d]));
  const normalizedDays = weekDates.map((wd) => {
    const incoming = inputByDate.get(wd.date) || {};
    return {
      work_date: wd.date,
      day_of_week: wd.dayOfWeek,
      is_working: Boolean(incoming.is_working),
      start_time: incoming.start_time || '09:00',
      end_time: incoming.end_time || '18:00',
      breaks: Array.isArray(incoming.breaks) ? incoming.breaks : []
    };
  });

  for (const day of normalizedDays) {
    const check = validateDayInput(day);
    if (!check.valid) {
      const err = new Error(check.error);
      err.statusCode = 400;
      err.code = 'HORARIO_INVALIDO';
      throw err;
    }
  }

  // Verificar se há conflitos com agendamentos confirmados (Regra 14)
  const conflicts = await checkScheduleConflictsWithAppointments(normalizedMonday, normalizedDays);
  if (conflicts.length > 0) {
    const err = new Error(
      `Não é possível salvar esta alteração de expediente pois existem ${conflicts.length} agendamento(s) confirmado(s) em conflito. Remaneje ou cancele os agendamentos antes de reduzir o expediente.`
    );
    err.statusCode = 409;
    err.code = 'CONFLITO_EXPEDIENTE';
    err.conflicts = conflicts;
    throw err;
  }

  // Se estiver publicando, verificar se há pelo menos um dia de trabalho configurado
  if (publish) {
    const hasAnyWorkDay = normalizedDays.some((d) => d.is_working);
    if (!hasAnyWorkDay) {
      const err = new Error(
        'Selecione pelo menos um dia de trabalho antes de publicar a agenda semanal.'
      );
      err.statusCode = 400;
      err.code = 'SEM_DIAS_TRABALHO';
      throw err;
    }
  }

  const existing = await db.getWeeklyScheduleRecord(normalizedMonday);
  const targetStatus = publish
    ? 'publicada'
    : existing && existing.status === 'publicada' && publish === false
      ? 'rascunho'
      : 'rascunho';
  const publishedAt = publish ? new Date().toISOString() : null;

  await db.upsertWeeklySchedule(normalizedMonday, targetStatus, normalizedDays, publishedAt);

  let notificationResult = null;
  if (publish) {
    notificationResult = await notifySchedulePublished(normalizedMonday, publishedAt);
  }

  const updated = await getWeeklyScheduleForAdmin(normalizedMonday);
  return {
    ...updated,
    notification: notificationResult
  };
}

/**
 * Consulta a disponibilidade pública da semana para os clientes.
 * Implementa as 3 situações da seção 4.2:
 * - Situação 1: Agenda não publicada -> "Aguarde a confirmação dos dias e horários disponíveis."
 * - Situação 2: Agenda publicada e com horários disponíveis
 * - Situação 3: Agenda publicada, mas completamente ocupada -> "Agenda semanal fechada."
 */
async function getPublicScheduleAvailability({
  weekStart,
  durationMinutes = 30,
  excludeAppointmentId = null
} = {}) {
  const db = getDb();
  const normalizedMonday = getMondayOfDate(weekStart);
  const weekDates = getWeekDates(normalizedMonday);
  const existing = await db.getWeeklyScheduleRecord(normalizedMonday);

  // Situação 1 — Agenda não publicada
  if (!existing || existing.status === 'rascunho') {
    return {
      week_start: normalizedMonday,
      week_end: weekDates[6].date,
      situation: 'nao_publicada',
      status: 'rascunho',
      can_book: false,
      allow_waitlist: false,
      message: 'Aguarde a confirmação dos dias e horários disponíveis.',
      days: []
    };
  }

  const appointments = await db.listAppointments({
    startDate: weekDates[0].date,
    endDate: weekDates[6].date
  });

  const dayMap = new Map((existing.days || []).map((d) => [d.work_date, d]));
  let totalBaseFreeBlocksInWeek = 0;
  let totalCompatibleSlotsInWeek = 0;

  const daysOutput = weekDates.map((wd) => {
    const dayCfg = dayMap.get(wd.date) || {
      work_date: wd.date,
      day_of_week: wd.dayOfWeek,
      is_working: false,
      start_time: '09:00',
      end_time: '18:00',
      breaks: []
    };

    const dayApps = appointments.filter((a) => a.appointment_date === wd.date);
    const free30MinSlots = getAvailableStartSlots(dayCfg, dayApps, 30, excludeAppointmentId);
    const compatibleSlots = getAvailableStartSlots(
      dayCfg,
      dayApps,
      durationMinutes,
      excludeAppointmentId
    );

    const occupiedRanges = dayApps
      .filter((a) => a.status !== 'cancelado' && a.id !== excludeAppointmentId)
      .map((a) => ({
        start_time: a.start_time,
        end_time: a.end_time
      }));

    totalBaseFreeBlocksInWeek += free30MinSlots.length;
    totalCompatibleSlotsInWeek += compatibleSlots.length;

    return {
      work_date: wd.date,
      dateBR: wd.dateBR,
      day_of_week: wd.dayOfWeek,
      dayName: wd.dayName,
      dayShortName: wd.dayShortName,
      is_working: Boolean(dayCfg.is_working),
      start_time: dayCfg.start_time,
      end_time: dayCfg.end_time,
      breaks: dayCfg.breaks || [],
      occupied_ranges: occupiedRanges,
      free_30min_count: free30MinSlots.length,
      available_slots: compatibleSlots
    };
  });

  // Situação 3 — Agenda publicada, mas completamente ocupada (ou fechada)
  if (existing.status === 'fechada' || totalBaseFreeBlocksInWeek === 0) {
    return {
      week_start: normalizedMonday,
      week_end: weekDates[6].date,
      situation: 'fechada',
      status: 'fechada',
      can_book: false,
      allow_waitlist: true,
      message: 'Agenda semanal fechada.',
      days: daysOutput
    };
  }

  // Situação 2 — Agenda publicada e com horários disponíveis
  // (Se para a duração específica escolhida ex: 90min não houver blocos consecutivos, habilita lista de espera também)
  return {
    week_start: normalizedMonday,
    week_end: weekDates[6].date,
    situation: 'disponivel',
    status: 'publicada',
    can_book: totalCompatibleSlotsInWeek > 0,
    allow_waitlist: totalCompatibleSlotsInWeek === 0,
    total_available_slots: totalCompatibleSlotsInWeek,
    message:
      totalCompatibleSlotsInWeek > 0
        ? 'Horários disponíveis para agendamento.'
        : 'Não há horários consecutivos livres suficientes para a duração total dos serviços selecionados. Você pode entrar na lista de espera.',
    days: daysOutput
  };
}

module.exports = {
  getWeeklyScheduleForAdmin,
  saveWeeklySchedule,
  getPublicScheduleAvailability,
  checkScheduleConflictsWithAppointments
};

const { getDb } = require('../db');
const { validateClientInput, formatPhoneBR } = require('../utils/validators');
const {
  getMondayOfDate,
  getDayNamePT,
  formatDateBR,
  getAvailableStartSlots
} = require('../utils/time');

function buildWhatsAppContactLink(entry) {
  const cleanDigits = String(entry.phone || '').replace(/\D/g, '');
  const fullPhone = cleanDigits.startsWith('55') ? cleanDigits : `55${cleanDigits}`;
  const serviceNames = (entry.desired_services || []).map((s) => s.name).join(', ');
  const detailText = entry.matched_details
    ? ` Surgiu uma vaga compatível (${entry.matched_details}).`
    : ' Surgiu um horário disponível na agenda.';
  const msg = `Olá ${entry.name}! Aqui é da Luan Barber.${detailText} Você ainda tem interesse em agendar (${serviceNames || 'corte'})?`;
  return `https://wa.me/${fullPhone}?text=${encodeURIComponent(msg)}`;
}

async function addClientToWaitlist({
  weekStart,
  name,
  phone,
  serviceIds = [],
  preferredDays = [],
  preferredPeriods = []
}) {
  const db = getDb();
  const clientCheck = validateClientInput(name, phone);
  if (!clientCheck.valid) {
    const err = new Error(clientCheck.error);
    err.statusCode = 400;
    throw err;
  }

  if (!Array.isArray(serviceIds) || serviceIds.length === 0) {
    const err = new Error('Selecione pelo menos um serviço desejado para entrar na lista de espera.');
    err.statusCode = 400;
    throw err;
  }

  const services = await db.getServicesByIds(serviceIds);
  if (services.length === 0) {
    const err = new Error('Serviços selecionados inválidos.');
    err.statusCode = 400;
    throw err;
  }

  const desiredServices = services.map((s) => ({
    id: s.id,
    name: s.name,
    price: s.price,
    duration: 30
  }));

  const normalizedWeek = weekStart ? getMondayOfDate(weekStart) : getMondayOfDate();

  const created = await db.createWaitlistEntry({
    weekStart: normalizedWeek,
    name: clientCheck.name,
    phone: clientCheck.phone,
    desiredServices,
    preferredDays: Array.isArray(preferredDays) ? preferredDays : [],
    preferredPeriods: Array.isArray(preferredPeriods) ? preferredPeriods : []
  });

  // Já verifica se no momento há alguma vaga compatível aberta
  await evaluateWaitlistOpportunitiesForWeek(normalizedWeek);

  const refreshed = await db.getWaitlistById(created.id);
  return {
    ...refreshed,
    phone_formatted: formatPhoneBR(refreshed.phone),
    whatsapp_url: buildWhatsAppContactLink(refreshed)
  };
}

async function listWaitlistForAdmin({ status, weekStart } = {}) {
  const db = getDb();
  const entries = await db.listWaitlist({ status, weekStart });
  return entries.map((e) => ({
    ...e,
    phone_formatted: formatPhoneBR(e.phone),
    total_duration: Math.max(30, (e.desired_services || []).length * 30),
    total_price: (e.desired_services || []).reduce((acc, s) => acc + Number(s.price || 0), 0),
    whatsapp_url: buildWhatsAppContactLink(e)
  }));
}

async function updateWaitlistStatus(id, status) {
  const db = getDb();
  if (!['aguardando', 'atendido', 'removido'].includes(status)) {
    const err = new Error('Status da lista de espera inválido.');
    err.statusCode = 400;
    throw err;
  }
  const updated = await db.updateWaitlistEntry(id, {
    status,
    matchedOpportunity: status === 'aguardando' ? undefined : false
  });
  if (!updated) {
    const err = new Error('Registro não encontrado na lista de espera.');
    err.statusCode = 404;
    throw err;
  }
  return {
    ...updated,
    phone_formatted: formatPhoneBR(updated.phone),
    whatsapp_url: buildWhatsAppContactLink(updated)
  };
}

async function removeWaitlistEntry(id) {
  const db = getDb();
  const ok = await db.deleteWaitlistEntry(id);
  if (!ok) {
    const err = new Error('Registro não encontrado na lista de espera.');
    err.statusCode = 404;
    throw err;
  }
  return { deleted: true };
}

/**
 * Avalia se algum cliente aguardando na lista de espera é compatível com horários livres
 * na data `targetDate` (por exemplo, imediatamente após um cancelamento).
 */
async function evaluateWaitlistForDate(targetDate) {
  const db = getDb();
  const dayCfg = await db.getScheduleDayByDate(targetDate);
  if (!dayCfg || !dayCfg.is_working || dayCfg.status !== 'publicada') {
    return [];
  }

  const activeAppointments = await db.listAppointments({ date: targetDate });
  const waitingEntries = await db.listWaitlist({ status: 'aguardando' });
  const dayName = getDayNamePT(targetDate);
  const dateBR = formatDateBR(targetDate);
  const matchedEntries = [];

  for (const entry of waitingEntries) {
    const desiredCount = Array.isArray(entry.desired_services) && entry.desired_services.length > 0
      ? entry.desired_services.length
      : 1;
    const requiredDuration = desiredCount * 30;

    // Verifica preferência de dia (se o cliente especificou dias preferidos)
    const prefDays = Array.isArray(entry.preferred_days) ? entry.preferred_days : [];
    const dayMatches =
      prefDays.length === 0 ||
      prefDays.includes(targetDate) ||
      prefDays.includes(dayName) ||
      prefDays.some((d) => dayName.toLowerCase().startsWith(String(d).toLowerCase()));

    if (!dayMatches) continue;

    // Calcula slots livres na data que comportem a duração desejada pelo cliente
    const compatibleSlots = getAvailableStartSlots(dayCfg, activeAppointments, requiredDuration);
    if (compatibleSlots.length === 0) continue;

    // Verifica preferência de período (manhã, tarde, noite)
    const prefPeriods = Array.isArray(entry.preferred_periods) ? entry.preferred_periods : [];
    const matchingPeriodSlots =
      prefPeriods.length === 0
        ? compatibleSlots
        : compatibleSlots.filter((slot) => prefPeriods.includes(slot.period));

    if (matchingPeriodSlots.length > 0) {
      const sampleSlots = matchingPeriodSlots
        .slice(0, 3)
        .map((s) => s.start_time)
        .join(', ');
      const details = `${dayName} (${dateBR}) às ${sampleSlots} (${requiredDuration} min)`;
      const updated = await db.updateWaitlistEntry(entry.id, {
        matchedOpportunity: true,
        matchedDetails: details
      });
      matchedEntries.push({
        ...updated,
        phone_formatted: formatPhoneBR(updated.phone),
        whatsapp_url: buildWhatsAppContactLink(updated)
      });
    }
  }

  return matchedEntries;
}

async function evaluateWaitlistOpportunitiesForWeek(weekStart) {
  const db = getDb();
  const monday = getMondayOfDate(weekStart);
  const weekRecord = await db.getWeeklyScheduleRecord(monday);
  if (!weekRecord || weekRecord.status !== 'publicada') return [];

  const allMatches = [];
  for (const day of weekRecord.days || []) {
    if (day.is_working) {
      const matches = await evaluateWaitlistForDate(day.work_date);
      allMatches.push(...matches);
    }
  }
  return allMatches;
}

module.exports = {
  addClientToWaitlist,
  listWaitlistForAdmin,
  updateWaitlistStatus,
  removeWaitlistEntry,
  evaluateWaitlistForDate,
  evaluateWaitlistOpportunitiesForWeek
};

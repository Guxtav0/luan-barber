const DAY_NAMES_PT = [
  'Domingo',
  'Segunda-feira',
  'Terça-feira',
  'Quarta-feira',
  'Quinta-feira',
  'Sexta-feira',
  'Sábado'
];

const DAY_NAMES_SHORT_PT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

function timeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return 0;
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function addMinutesToTime(timeStr, minutesToAdd) {
  return minutesToTime(timeToMinutes(timeStr) + minutesToAdd);
}

function isValidTimeFormat(timeStr) {
  if (typeof timeStr !== 'string') return false;
  if (!/^\d{2}:\d{2}$/.test(timeStr)) return false;
  const [h, m] = timeStr.split(':').map(Number);
  return h >= 0 && h <= 23 && (m === 0 || m === 30);
}

function isValidDateString(dateStr) {
  if (typeof dateStr !== 'string') return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}

function parseLocalDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

function formatDateISO(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getTodayISO(referenceDate = new Date()) {
  return formatDateISO(referenceDate);
}

function formatDateBR(dateStr) {
  if (!dateStr || !isValidDateString(dateStr)) return dateStr || '';
  const [y, m, d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

function getDayOfWeek(dateStr) {
  const dt = parseLocalDate(dateStr);
  return dt.getDay(); // 0=Dom ... 6=Sáb
}

function getDayNamePT(dateStr) {
  return DAY_NAMES_PT[getDayOfWeek(dateStr)];
}

function getDayShortNamePT(dateStr) {
  return DAY_NAMES_SHORT_PT[getDayOfWeek(dateStr)];
}

/**
 * Retorna a Segunda-feira (YYYY-MM-DD) da semana à qual pertence `dateStr`.
 * Na convenção de semanas de Segunda a Domingo:
 * Se for Domingo (0), recua 6 dias; senão recua (day - 1) dias.
 */
function getMondayOfDate(dateStr) {
  const dt = dateStr ? parseLocalDate(dateStr) : new Date();
  const day = dt.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  dt.setDate(dt.getDate() + diff);
  return formatDateISO(dt);
}

function addDaysISO(dateStr, days) {
  const dt = parseLocalDate(dateStr);
  dt.setDate(dt.getDate() + days);
  return formatDateISO(dt);
}

/**
 * Retorna os 7 dias da semana (Segunda a Domingo) a partir de `weekStart` (Segunda-feira).
 */
function getWeekDates(weekStart) {
  const monday = getMondayOfDate(weekStart);
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const dateISO = addDaysISO(monday, i);
    dates.push({
      date: dateISO,
      dateBR: formatDateBR(dateISO),
      dayOfWeek: getDayOfWeek(dateISO),
      dayName: getDayNamePT(dateISO),
      dayShortName: getDayShortNamePT(dateISO)
    });
  }
  return dates;
}

/**
 * Gera todos os blocos base de 30 minutos dentro do expediente do dia,
 * excluindo os blocos que colidem com intervalos de descanso.
 */
function generateBase30MinBlocks(dayConfig) {
  if (!dayConfig || !dayConfig.is_working) return [];
  const startMin = timeToMinutes(dayConfig.start_time);
  const endMin = timeToMinutes(dayConfig.end_time);
  if (endMin <= startMin) return [];

  const breaks = Array.isArray(dayConfig.breaks) ? dayConfig.breaks : [];
  const parsedBreaks = breaks
    .filter((b) => b && b.start && b.end)
    .map((b) => ({
      start: timeToMinutes(b.start),
      end: timeToMinutes(b.end)
    }));

  const blocks = [];
  for (let t = startMin; t + 30 <= endMin; t += 30) {
    const blockStart = t;
    const blockEnd = t + 30;
    const overlapsBreak = parsedBreaks.some(
      (brk) => blockStart < brk.end && blockEnd > brk.start
    );
    if (!overlapsBreak) {
      blocks.push(minutesToTime(blockStart));
    }
  }
  return blocks;
}

/**
 * Calcula os horários iniciais disponíveis que comportam `requiredDurationMinutes`
 * (múltiplo de 30 min: 30, 60, 90...) de forma consecutiva sem colidir com:
 * - fim do expediente
 * - intervalos de descanso
 * - outros agendamentos ativos (status != 'cancelado' e id != excludeAppointmentId)
 */
function getAvailableStartSlots(dayConfig, activeAppointments = [], requiredDurationMinutes = 30, excludeAppointmentId = null) {
  if (!dayConfig || !dayConfig.is_working) return [];
  const duration = Math.max(30, Number(requiredDurationMinutes) || 30);
  const blocksNeeded = Math.ceil(duration / 30);
  const baseBlocks = generateBase30MinBlocks(dayConfig);
  const baseBlockSet = new Set(baseBlocks);

  const occupiedRanges = (activeAppointments || [])
    .filter((app) => app.status !== 'cancelado' && app.id !== excludeAppointmentId)
    .map((app) => ({
      start: timeToMinutes(app.start_time),
      end: timeToMinutes(app.end_time)
    }));

  const availableStarts = [];

  for (const candidateTime of baseBlocks) {
    const startMin = timeToMinutes(candidateTime);
    let allConsecutiveFree = true;

    for (let i = 0; i < blocksNeeded; i++) {
      const subBlockStart = startMin + i * 30;
      const subBlockEnd = subBlockStart + 30;
      const subBlockTime = minutesToTime(subBlockStart);

      // Precisa existir como bloco válido de expediente (não pode estar fora ou em intervalo)
      if (!baseBlockSet.has(subBlockTime)) {
        allConsecutiveFree = false;
        break;
      }

      // Não pode sobrepor nenhum agendamento ativo
      const overlapsAppointment = occupiedRanges.some(
        (occ) => subBlockStart < occ.end && subBlockEnd > occ.start
      );
      if (overlapsAppointment) {
        allConsecutiveFree = false;
        break;
      }
    }

    if (allConsecutiveFree) {
      availableStarts.push({
        start_time: candidateTime,
        end_time: minutesToTime(startMin + duration),
        period: getTimePeriod(candidateTime)
      });
    }
  }

  return availableStarts;
}

/**
 * Classifica um horário HH:mm em período do dia:
 * - manha: antes das 12:00
 * - tarde: das 12:00 até 17:59
 * - noite: a partir das 18:00
 */
function getTimePeriod(timeStr) {
  const mins = timeToMinutes(timeStr);
  if (mins < 12 * 60) return 'manha';
  if (mins < 18 * 60) return 'tarde';
  return 'noite';
}

/**
 * Verifica se ainda faltam pelo menos 2 horas (120 minutos) para o início do atendimento.
 */
function canClientModifyAppointment(appointmentDate, startTime, now = new Date()) {
  const [y, m, d] = appointmentDate.split('-').map(Number);
  const [hh, mm] = startTime.split(':').map(Number);
  const appointmentDateTime = new Date(y, m - 1, d, hh, mm, 0, 0);
  const diffMs = appointmentDateTime.getTime() - now.getTime();
  const twoHoursMs = 2 * 60 * 60 * 1000;
  return diffMs >= twoHoursMs;
}

/**
 * Calcula intervalo de datas [startDate, endDate] (YYYY-MM-DD) para filtros financeiros:
 * - hoje
 * - 7dias (últimos 7 dias incluindo hoje)
 * - 30dias (últimos 30 dias incluindo hoje)
 * - este_mes (do dia 1 ao último dia do mês atual)
 * - mes_anterior (do dia 1 ao último dia do mês anterior)
 * - personalizado (usa customStart e customEnd)
 * - todos
 */
function getPeriodDateRange(periodType, customStart, customEnd, now = new Date()) {
  const todayISO = getTodayISO(now);
  switch (periodType) {
    case 'hoje':
      return { startDate: todayISO, endDate: todayISO };
    case '7dias':
      return { startDate: addDaysISO(todayISO, -6), endDate: todayISO };
    case '30dias':
      return { startDate: addDaysISO(todayISO, -29), endDate: todayISO };
    case 'este_mes': {
      const y = now.getFullYear();
      const m = now.getMonth();
      const firstDay = formatDateISO(new Date(y, m, 1, 12, 0, 0));
      const lastDay = formatDateISO(new Date(y, m + 1, 0, 12, 0, 0));
      return { startDate: firstDay, endDate: lastDay };
    }
    case 'mes_anterior': {
      const y = now.getFullYear();
      const m = now.getMonth();
      const firstDay = formatDateISO(new Date(y, m - 1, 1, 12, 0, 0));
      const lastDay = formatDateISO(new Date(y, m, 0, 12, 0, 0));
      return { startDate: firstDay, endDate: lastDay };
    }
    case 'personalizado': {
      const start = isValidDateString(customStart) ? customStart : todayISO;
      const end = isValidDateString(customEnd) ? customEnd : start;
      return start <= end
        ? { startDate: start, endDate: end }
        : { startDate: end, endDate: start };
    }
    case 'todos':
    default:
      return { startDate: '2000-01-01', endDate: '2099-12-31' };
  }
}

module.exports = {
  DAY_NAMES_PT,
  DAY_NAMES_SHORT_PT,
  timeToMinutes,
  minutesToTime,
  addMinutesToTime,
  isValidTimeFormat,
  isValidDateString,
  parseLocalDate,
  formatDateISO,
  getTodayISO,
  formatDateBR,
  getDayOfWeek,
  getDayNamePT,
  getDayShortNamePT,
  getMondayOfDate,
  addDaysISO,
  getWeekDates,
  generateBase30MinBlocks,
  getAvailableStartSlots,
  getTimePeriod,
  canClientModifyAppointment,
  getPeriodDateRange
};

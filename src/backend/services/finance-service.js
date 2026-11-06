const { getDb } = require('../db');
const { getPeriodDateRange, getTodayISO } = require('../utils/time');
const { formatCurrencyBR, formatPhoneBR } = require('../utils/validators');
const { enrichAppointment } = require('./appointment-service');

async function getFinancialDashboard({
  period = 'este_mes',
  startDate: customStart,
  endDate: customEnd,
  statusFilter = '',
  paymentFilter = '',
  searchQuery = '',
  now = new Date()
} = {}) {
  const db = getDb();
  const { startDate, endDate } = getPeriodDateRange(period, customStart, customEnd, now);
  const todayISO = getTodayISO(now);

  // Busca agendamentos dentro do período selecionado
  const periodAppointments = await db.listAppointments({ startDate, endDate });
  // Busca todos os agendamentos confirmados ainda não realizados (a partir de hoje) para referência
  const allAppointments = await db.listAppointments({});

  // Filtra os atendimentos do período
  // 1. Faturamento recebido: Soma dos atendimentos pagos (excluindo cancelados e agendamentos futuros não realizados)
  const paidAppointments = periodAppointments.filter(
    (a) =>
      a.status !== 'cancelado' &&
      a.payment_status === 'pago' &&
      (a.status === 'concluido' || a.appointment_date <= todayISO)
  );
  const faturamentoRecebido = paidAppointments.reduce(
    (sum, a) => sum + Number(a.total_price || 0),
    0
  );

  // 2. Faturamento pendente (Inadimplência): Soma dos atendimentos concluídos, mas ainda não pagos
  const completedUnpaidInPeriod = periodAppointments.filter(
    (a) => a.status === 'concluido' && a.payment_status === 'pendente'
  );
  const faturamentoPendente = completedUnpaidInPeriod.reduce(
    (sum, a) => sum + Number(a.total_price || 0),
    0
  );

  // 3. Total de cortes realizados: Quantidade de atendimentos concluídos no período
  const completedInPeriod = periodAppointments.filter((a) => a.status === 'concluido');
  const totalCortesRealizados = completedInPeriod.length;

  // 4. Agendamentos futuros: Quantidade de atendimentos ainda não realizados (status = 'confirmado')
  // Se o período inclui datas futuras (ex: este_mes, personalizado) ou se é filtro até hoje (hoje, 7dias, 30dias),
  // respeita o filtro se houver agendamentos confirmados no período ou considera os agendamentos confirmados pendentes de realização
  const confirmedInPeriod = periodAppointments.filter((a) => a.status === 'confirmado');
  const allFutureConfirmed = allAppointments.filter(
    (a) => a.status === 'confirmado' && a.appointment_date >= startDate
  );
  const agendamentosFuturos =
    endDate >= todayISO && period !== 'personalizado'
      ? allFutureConfirmed.length
      : confirmedInPeriod.length;

  // Seção 3.6 — Controle de inadimplência ("Pagamentos pendentes")
  // Clientes que já realizaram o atendimento (status = 'concluido'), mas ainda não tiveram o pagamento confirmado.
  // Não considerar futuros agendamentos (status = 'confirmado') como inadimplência.
  const pendingPayments = completedUnpaidInPeriod.map(enrichAppointment);

  // Seção 3.7 — Ranking de clientes ("Clientes que mais cortam")
  // Ordenados pela quantidade de atendimentos concluídos no período
  const clientMap = new Map();
  for (const app of completedInPeriod) {
    const key = app.client_phone || app.client_id;
    const current = clientMap.get(key) || {
      client_id: app.client_id,
      name: app.client_name,
      phone: app.client_phone,
      phone_formatted: formatPhoneBR(app.client_phone),
      cuts_count: 0,
      total_spent: 0,
      last_appointment_date: app.appointment_date
    };
    current.name = app.client_name;
    current.cuts_count += 1;
    current.total_spent += Number(app.total_price || 0);
    if (app.appointment_date >= current.last_appointment_date) {
      current.last_appointment_date = app.appointment_date;
    }
    clientMap.set(key, current);
  }

  const topClients = Array.from(clientMap.values())
    .map((c) => ({
      ...c,
      total_spent_formatted: formatCurrencyBR(c.total_spent),
      last_appointment_date_br: c.last_appointment_date
        ? c.last_appointment_date.split('-').reverse().join('/')
        : '-',
      is_recurring: c.cuts_count >= 2
    }))
    .sort((a, b) => {
      if (b.cuts_count !== a.cuts_count) return b.cuts_count - a.cuts_count;
      return b.total_spent - a.total_spent;
    });

  // Seção 3.8 — Histórico financeiro (com filtros adicionais da listagem)
  let historyList = periodAppointments.map(enrichAppointment);
  if (statusFilter) {
    historyList = historyList.filter((a) => a.status === statusFilter);
  }
  if (paymentFilter) {
    historyList = historyList.filter((a) => a.payment_status === paymentFilter);
  }
  if (searchQuery && searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase();
    historyList = historyList.filter(
      (a) =>
        a.client_name.toLowerCase().includes(q) ||
        a.client_phone.includes(q) ||
        a.services_summary.toLowerCase().includes(q)
    );
  }

  // Ordenar histórico do mais recente para o mais antigo
  historyList.sort((a, b) => {
    if (b.appointment_date !== a.appointment_date) {
      return b.appointment_date.localeCompare(a.appointment_date);
    }
    return b.start_time.localeCompare(a.start_time);
  });

  return {
    period: {
      type: period,
      start_date: startDate,
      end_date: endDate,
      start_date_br: startDate.split('-').reverse().join('/'),
      end_date_br: endDate.split('-').reverse().join('/')
    },
    cards: {
      faturamento_recebido: faturamentoRecebido,
      faturamento_recebido_formatted: formatCurrencyBR(faturamentoRecebido),
      faturamento_pendente: faturamentoPendente,
      faturamento_pendente_formatted: formatCurrencyBR(faturamentoPendente),
      total_cortes_realizados: totalCortesRealizados,
      agendamentos_futuros: agendamentosFuturos
    },
    pending_payments: pendingPayments,
    top_clients: topClients,
    history: historyList
  };
}

module.exports = {
  getFinancialDashboard
};

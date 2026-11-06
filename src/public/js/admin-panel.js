(function () {
  const state = {
    admin: null,
    integrations: null,
    activeTab: 'agenda',
    currentWeekStart: UI.getMondayISO(UI.getTodayISO()),
    schedule: null,
    appointments: [],
    waitlist: [],
    services: [],
    agendaViewMode: 'list', // 'list' | 'calendar'
    agendaFilterDay: '',
    agendaFilterStatus: '',
    waitlistFilterStatus: 'aguardando',
    financePeriod: 'este_mes',
    financeCustomStart: UI.getTodayISO(),
    financeCustomEnd: UI.getTodayISO(),
    financeData: null
  };

  const TIME_OPTIONS = UI.getTimeOptions30Min();

  // ==================== INICIALIZAÇÃO & AUTH ====================
  async function init() {
    bindStaticEvents();
    await checkAuthSession();
  }

  async function checkAuthSession() {
    try {
      const data = await ApiClient.get('/api/auth/me');
      state.admin = data.admin;
      state.integrations = data.integrations;
      showAdminApp();
      await loadAllInitialData();
    } catch {
      showLoginScreen();
    }
  }

  function showLoginScreen() {
    document.getElementById('admin-login-screen').classList.remove('hidden');
    document.getElementById('admin-app-screen').classList.add('hidden');
  }

  function showAdminApp() {
    document.getElementById('admin-login-screen').classList.add('hidden');
    document.getElementById('admin-app-screen').classList.remove('hidden');
    updateWhatsAppHeaderBadge();
  }

  function updateWhatsAppHeaderBadge() {
    const badge = document.getElementById('wa-status-indicator');
    if (!badge || !state.integrations) return;
    const wa = state.integrations.whatsapp;
    if (wa.configured) {
      badge.className = 'badge badge-green';
      badge.textContent = 'Ativo';
    } else {
      badge.className = 'badge badge-yellow';
      badge.textContent = 'Pendente (.env)';
    }
  }

  async function loadAllInitialData() {
    await Promise.all([
      loadAdminServices(),
      loadAgendaData(state.currentWeekStart)
    ]);
  }

  // ==================== EVENTOS GERAIS ====================
  function bindStaticEvents() {
    // Login
    const loginForm = document.getElementById('login-form');
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('login-email').value.trim();
      const password = document.getElementById('login-password').value;
      const errBox = document.getElementById('login-error');
      const btn = document.getElementById('login-submit-btn');

      errBox.classList.add('hidden');
      btn.disabled = true;
      btn.textContent = 'Autenticando...';

      try {
        const res = await ApiClient.post('/api/auth/login', { email, password });
        ApiClient.setToken(res.token);
        await checkAuthSession();
        UI.toast('Bem-vindo ao painel, Luan!', 'success');
      } catch (err) {
        errBox.textContent = err.message || 'Falha no login.';
        errBox.classList.remove('hidden');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Entrar no Painel';
      }
    });

    // Logout
    document.getElementById('btn-logout').addEventListener('click', async () => {
      await ApiClient.post('/api/auth/logout', {}).catch(() => {});
      ApiClient.setToken('');
      state.admin = null;
      showLoginScreen();
      UI.toast('Sessão encerrada.', 'info');
    });

    // Navegação entre abas
    document.querySelectorAll('.admin-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        switchTab(tab);
      });
    });

    // Botão de Notificações WhatsApp
    document.getElementById('btn-open-notifications').addEventListener('click', () => {
      openNotificationsModal();
    });

    // Controles de semana (Aba Agenda)
    document.getElementById('btn-prev-week').addEventListener('click', () => {
      const prev = UI.addDaysISO(state.currentWeekStart, -7);
      loadAgendaData(prev);
    });
    document.getElementById('btn-current-week').addEventListener('click', () => {
      loadAgendaData(UI.getMondayISO(UI.getTodayISO()));
    });
    document.getElementById('btn-next-week').addEventListener('click', () => {
      const next = UI.addDaysISO(state.currentWeekStart, 7);
      loadAgendaData(next);
    });
    document.getElementById('week-date-picker').addEventListener('change', (e) => {
      if (e.target.value) {
        loadAgendaData(UI.getMondayISO(e.target.value));
      }
    });

    // Expandir / ocultar editor de expediente
    document.getElementById('btn-toggle-schedule-editor').addEventListener('click', () => {
      const body = document.getElementById('schedule-editor-body');
      body.classList.toggle('hidden');
    });

    // Salvar rascunho e Publicar agenda
    document.getElementById('btn-save-draft').addEventListener('click', () => {
      submitWeeklySchedule(false);
    });
    document.getElementById('btn-publish-schedule').addEventListener('click', () => {
      submitWeeklySchedule(true);
    });

    // Alternar modo Lista / Calendário
    document.getElementById('view-mode-list').addEventListener('click', () => {
      state.agendaViewMode = 'list';
      updateAgendaViewModeButtons();
      renderAppointmentsSection();
    });
    document.getElementById('view-mode-calendar').addEventListener('click', () => {
      state.agendaViewMode = 'calendar';
      updateAgendaViewModeButtons();
      renderAppointmentsSection();
    });

    // Filtros da Agenda
    document.getElementById('agenda-filter-day').addEventListener('change', (e) => {
      state.agendaFilterDay = e.target.value;
      renderAppointmentsSection();
    });
    document.getElementById('agenda-filter-status').addEventListener('change', (e) => {
      state.agendaFilterStatus = e.target.value;
      renderAppointmentsSection();
    });

    // Novo Agendamento Manual
    document.getElementById('btn-new-manual-appointment').addEventListener('click', () => {
      openAppointmentModal(null);
    });

    // Filtro Lista de Espera
    document.getElementById('waitlist-filter-status').addEventListener('change', async (e) => {
      state.waitlistFilterStatus = e.target.value;
      await reloadWaitlistOnly();
    });

    // Filtros Financeiros (Aba 2)
    document.querySelectorAll('#finance-period-buttons button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const period = btn.getAttribute('data-period');
        state.financePeriod = period;
        document.querySelectorAll('#finance-period-buttons button').forEach((b) => {
          b.className = b === btn ? 'btn btn-sm btn-white' : 'btn btn-sm btn-outline';
        });
        const customBox = document.getElementById('finance-custom-dates');
        if (period === 'personalizado') {
          customBox.classList.remove('hidden');
        } else {
          customBox.classList.add('hidden');
          loadFinanceDashboard();
        }
      });
    });

    document.getElementById('btn-apply-custom-finance').addEventListener('click', () => {
      state.financeCustomStart = document.getElementById('finance-start-date').value;
      state.financeCustomEnd = document.getElementById('finance-end-date').value;
      loadFinanceDashboard();
    });

    document.getElementById('finance-search-input').addEventListener('input', () => {
      loadFinanceDashboard();
    });
    document.getElementById('finance-status-filter').addEventListener('change', () => {
      loadFinanceDashboard();
    });
    document.getElementById('finance-payment-filter').addEventListener('change', () => {
      loadFinanceDashboard();
    });

    // Aba 3: Preços
    document.getElementById('btn-add-service').addEventListener('click', () => {
      openServiceModal(null);
    });
  }

  function switchTab(tabName) {
    state.activeTab = tabName;
    document.querySelectorAll('.admin-tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName);
    });
    document.querySelectorAll('.admin-tab-panel').forEach((panel) => {
      panel.classList.toggle('hidden', panel.id !== `tab-${tabName}`);
    });

    if (tabName === 'agenda') {
      loadAgendaData(state.currentWeekStart);
    } else if (tabName === 'financeiro') {
      loadFinanceDashboard();
    } else if (tabName === 'precos') {
      loadAdminServices();
    }
  }

  // ==================== ABA 1: AGENDA & DISPONIBILIDADE ====================
  async function loadAgendaData(weekStart) {
    try {
      const normalized = UI.getMondayISO(weekStart);
      state.currentWeekStart = normalized;
      document.getElementById('week-date-picker').value = normalized;
      document.getElementById('schedule-conflict-alert').classList.add('hidden');

      const data = await ApiClient.get(
        `/api/admin/schedule?week_start=${encodeURIComponent(normalized)}`
      );
      state.schedule = data.schedule;
      state.appointments = data.appointments || [];

      await reloadWaitlistOnly();
      renderScheduleHeaderAndEditor();
      populateAgendaDayFilter();
      renderAppointmentsSection();
    } catch (err) {
      UI.toast(err.message || 'Erro ao carregar agenda da semana.', 'error');
    }
  }

  async function reloadWaitlistOnly() {
    const statusParam = state.waitlistFilterStatus
      ? `?status=${encodeURIComponent(state.waitlistFilterStatus)}`
      : '';
    const wlData = await ApiClient.get(`/api/admin/waitlist${statusParam}`);
    state.waitlist = wlData.waitlist || [];
    renderWaitlistSection();
  }

  function renderScheduleHeaderAndEditor() {
    const sched = state.schedule;
    if (!sched) return;

    const rangeLabel = document.getElementById('week-range-label');
    rangeLabel.textContent = `Semana de ${UI.formatDateBR(sched.week_start)} a ${UI.formatDateBR(sched.week_end)}`;

    const statusBadge = document.getElementById('week-status-badge');
    if (sched.status === 'publicada') {
      statusBadge.className = 'badge badge-green';
      statusBadge.textContent = 'Agenda Publicada';
    } else if (sched.status === 'fechada') {
      statusBadge.className = 'badge badge-red';
      statusBadge.textContent = 'Agenda Fechada';
    } else {
      statusBadge.className = 'badge badge-yellow';
      statusBadge.textContent = 'Rascunho (Não visível aos clientes)';
    }

    const pubInfo = document.getElementById('schedule-published-info');
    if (sched.status === 'publicada' && sched.published_at) {
      const dt = new Date(sched.published_at);
      pubInfo.textContent = `Publicada para os clientes em ${dt.toLocaleDateString('pt-BR')} às ${dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.`;
    } else {
      pubInfo.textContent =
        'Enquanto estiver em rascunho, os clientes verão: "Aguarde a confirmação dos dias e horários disponíveis."';
    }

    const container = document.getElementById('schedule-days-container');
    container.innerHTML = sched.days
      .map((day, idx) => {
        const startOptions = TIME_OPTIONS.map(
          (t) => `<option value="${t}" ${t === day.start_time ? 'selected' : ''}>${t}</option>`
        ).join('');
        const endOptions = TIME_OPTIONS.map(
          (t) => `<option value="${t}" ${t === day.end_time ? 'selected' : ''}>${t}</option>`
        ).join('');

        const breaksHtml = (day.breaks || [])
          .map((brk, bIdx) => {
            const bStartOpts = TIME_OPTIONS.map(
              (t) => `<option value="${t}" ${t === brk.start ? 'selected' : ''}>${t}</option>`
            ).join('');
            const bEndOpts = TIME_OPTIONS.map(
              (t) => `<option value="${t}" ${t === brk.end ? 'selected' : ''}>${t}</option>`
            ).join('');
            return `
              <div class="flex-gap" style="margin-top: 8px; padding: 8px; background: var(--bg-black); border-radius: var(--radius-sm); border: 1px solid var(--border-gray);">
                <span class="text-muted" style="font-size:0.8rem;">Intervalo:</span>
                <select class="form-control break-start-select" data-day-idx="${idx}" data-break-idx="${bIdx}" style="width: auto; padding: 5px 8px;">
                  ${bStartOpts}
                </select>
                <span class="text-muted">às</span>
                <select class="form-control break-end-select" data-day-idx="${idx}" data-break-idx="${bIdx}" style="width: auto; padding: 5px 8px;">
                  ${bEndOpts}
                </select>
                <button type="button" class="btn btn-sm btn-red btn-remove-break" data-day-idx="${idx}" data-break-idx="${bIdx}">
                  Remover intervalo
                </button>
              </div>
            `;
          })
          .join('');

        return `
          <div class="schedule-day-row ${day.is_working ? 'working' : ''}" data-day-index="${idx}">
            <div class="schedule-day-top">
              <div class="flex-gap">
                <label class="toggle-switch">
                  <input type="checkbox" class="day-working-checkbox" data-day-idx="${idx}" ${day.is_working ? 'checked' : ''} />
                  <span>${UI.escapeHtml(day.dayName)}</span>
                </label>
                <span class="badge">${UI.escapeHtml(day.dateBR)}</span>
                ${
                  day.appointments_count > 0
                    ? `<span class="badge badge-blue">${day.appointments_count} agendamento(s)</span>`
                    : ''
                }
              </div>

              ${
                day.is_working
                  ? `
                <div class="flex-gap">
                  <span class="text-muted" style="font-size: 0.82rem;">Expediente:</span>
                  <select class="form-control day-start-select" data-day-idx="${idx}" style="width: auto; padding: 6px 10px;">
                    ${startOptions}
                  </select>
                  <span class="text-muted">às</span>
                  <select class="form-control day-end-select" data-day-idx="${idx}" style="width: auto; padding: 6px 10px;">
                    ${endOptions}
                  </select>
                  <button type="button" class="btn btn-sm btn-outline btn-add-break" data-day-idx="${idx}">
                    + Intervalo
                  </button>
                </div>
              `
                  : `<span class="text-muted">Não trabalha neste dia</span>`
              }
            </div>
            ${day.is_working && breaksHtml ? `<div style="margin-top: 6px;">${breaksHtml}</div>` : ''}
          </div>
        `;
      })
      .join('');

    // Bind events do editor de expediente
    container.querySelectorAll('.day-working-checkbox').forEach((cb) => {
      cb.addEventListener('change', (e) => {
        const idx = Number(e.target.getAttribute('data-day-idx'));
        state.schedule.days[idx].is_working = e.target.checked;
        renderScheduleHeaderAndEditor();
      });
    });

    container.querySelectorAll('.day-start-select').forEach((sel) => {
      sel.addEventListener('change', (e) => {
        const idx = Number(e.target.getAttribute('data-day-idx'));
        state.schedule.days[idx].start_time = e.target.value;
      });
    });

    container.querySelectorAll('.day-end-select').forEach((sel) => {
      sel.addEventListener('change', (e) => {
        const idx = Number(e.target.getAttribute('data-day-idx'));
        state.schedule.days[idx].end_time = e.target.value;
      });
    });

    container.querySelectorAll('.btn-add-break').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const idx = Number(e.currentTarget.getAttribute('data-day-idx'));
        if (!Array.isArray(state.schedule.days[idx].breaks)) {
          state.schedule.days[idx].breaks = [];
        }
        state.schedule.days[idx].breaks.push({ start: '12:00', end: '13:00' });
        renderScheduleHeaderAndEditor();
      });
    });

    container.querySelectorAll('.btn-remove-break').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const dIdx = Number(e.currentTarget.getAttribute('data-day-idx'));
        const bIdx = Number(e.currentTarget.getAttribute('data-break-idx'));
        state.schedule.days[dIdx].breaks.splice(bIdx, 1);
        renderScheduleHeaderAndEditor();
      });
    });

    container.querySelectorAll('.break-start-select').forEach((sel) => {
      sel.addEventListener('change', (e) => {
        const dIdx = Number(e.target.getAttribute('data-day-idx'));
        const bIdx = Number(e.target.getAttribute('data-break-idx'));
        state.schedule.days[dIdx].breaks[bIdx].start = e.target.value;
      });
    });

    container.querySelectorAll('.break-end-select').forEach((sel) => {
      sel.addEventListener('change', (e) => {
        const dIdx = Number(e.target.getAttribute('data-day-idx'));
        const bIdx = Number(e.target.getAttribute('data-break-idx'));
        state.schedule.days[dIdx].breaks[bIdx].end = e.target.value;
      });
    });
  }

  async function submitWeeklySchedule(publish) {
    if (!state.schedule) return;
    const conflictAlert = document.getElementById('schedule-conflict-alert');
    conflictAlert.classList.add('hidden');

    try {
      const res = await ApiClient.post('/api/admin/schedule/save', {
        week_start: state.schedule.week_start,
        days: state.schedule.days,
        publish
      });
      state.schedule = res.schedule;
      renderScheduleHeaderAndEditor();
      UI.toast(res.message, 'success');
    } catch (err) {
      if (err.code === 'CONFLITO_EXPEDIENTE' && Array.isArray(err.conflicts)) {
        renderScheduleConflictAlert(err.conflicts);
        UI.toast('Conflito detectado com agendamentos confirmados!', 'error');
      } else {
        UI.toast(err.message || 'Erro ao salvar programação.', 'error');
      }
    }
  }

  function renderScheduleConflictAlert(conflicts) {
    const alertBox = document.getElementById('schedule-conflict-alert');
    const listBox = document.getElementById('schedule-conflict-list');
    listBox.innerHTML = conflicts
      .map(
        (c) => `
        <div class="flex-between" style="padding: 10px; background: var(--bg-black); border: 1px solid var(--red-border); border-radius: var(--radius-sm); margin-bottom: 8px;">
          <div>
            <strong>${UI.escapeHtml(c.client_name)}</strong> — ${UI.escapeHtml(c.dateBR)} (${UI.escapeHtml(c.start_time)} às ${UI.escapeHtml(c.end_time)})
            <div style="font-size: 0.82rem; color: var(--text-light);">${UI.escapeHtml(c.reason)}</div>
          </div>
          <button type="button" class="btn btn-sm btn-outline btn-resolve-conflict" data-app-id="${c.appointment_id}">
            Resolver Agendamento
          </button>
        </div>
      `
      )
      .join('');

    listBox.querySelectorAll('.btn-resolve-conflict').forEach((btn) => {
      btn.addEventListener('click', () => {
        const appId = btn.getAttribute('data-app-id');
        const app = state.appointments.find((a) => a.id === appId);
        if (app) openAppointmentModal(app);
      });
    });

    alertBox.classList.remove('hidden');
  }

  // ==================== 3.3 GERENCIAMENTO DE AGENDAMENTOS ====================
  function updateAgendaViewModeButtons() {
    const listBtn = document.getElementById('view-mode-list');
    const calBtn = document.getElementById('view-mode-calendar');
    const listView = document.getElementById('appointments-list-view');
    const calView = document.getElementById('appointments-calendar-view');

    if (state.agendaViewMode === 'list') {
      listBtn.className = 'btn btn-sm btn-white';
      calBtn.className = 'btn btn-sm btn-outline';
      listView.classList.remove('hidden');
      calView.classList.add('hidden');
    } else {
      calBtn.className = 'btn btn-sm btn-white';
      listBtn.className = 'btn btn-sm btn-outline';
      calView.classList.remove('hidden');
      listView.classList.add('hidden');
    }
  }

  function populateAgendaDayFilter() {
    const sel = document.getElementById('agenda-filter-day');
    if (!state.schedule) return;
    const currentVal = state.agendaFilterDay;
    sel.innerHTML =
      `<option value="">Todos os dias da semana</option>` +
      state.schedule.days
        .map(
          (d) =>
            `<option value="${d.work_date}" ${d.work_date === currentVal ? 'selected' : ''}>${UI.escapeHtml(d.dayName)} (${UI.escapeHtml(d.dateBR)})</option>`
        )
        .join('');
  }

  function getFilteredAppointments() {
    return (state.appointments || []).filter((a) => {
      if (state.agendaFilterDay && a.appointment_date !== state.agendaFilterDay) return false;
      if (state.agendaFilterStatus && a.status !== state.agendaFilterStatus) return false;
      return true;
    });
  }

  function getStatusBadgeHtml(status) {
    if (status === 'concluido') return `<span class="badge badge-green">Concluído</span>`;
    if (status === 'cancelado') return `<span class="badge badge-red">Cancelado</span>`;
    return `<span class="badge badge-blue">Confirmado</span>`;
  }

  function getPaymentBadgeHtml(paymentStatus) {
    if (paymentStatus === 'pago') return `<span class="badge badge-green">Pago</span>`;
    return `<span class="badge badge-yellow">Pagamento Pendente</span>`;
  }

  function renderAppointmentsSection() {
    const filtered = getFilteredAppointments();
    const activeCount = (state.appointments || []).filter((a) => a.status !== 'cancelado').length;
    document.getElementById('agenda-summary-counts').textContent =
      `${filtered.length} exibido(s) • ${activeCount} ativo(s) na semana`;

    renderAppointmentsListView(filtered);
    renderAppointmentsCalendarView();
  }

  function renderAppointmentsListView(list) {
    const container = document.getElementById('appointments-list-view');
    if (!list.length) {
      container.innerHTML = `
        <div style="text-align: center; padding: 32px 16px; color: var(--text-gray);">
          Nenhum agendamento encontrado para os filtros selecionados nesta semana.
        </div>
      `;
      return;
    }

    container.innerHTML = list
      .map(
        (app) => `
        <div class="schedule-day-row" style="margin-bottom: 10px;">
          <div class="flex-between">
            <div>
              <div class="flex-gap">
                <strong style="font-size: 1.02rem;">${UI.escapeHtml(app.start_time)} às ${UI.escapeHtml(app.end_time)}</strong>
                <span class="badge">${UI.escapeHtml(app.dayName)}, ${UI.escapeHtml(app.dateBR)}</span>
                ${getStatusBadgeHtml(app.status)}
                ${app.status !== 'cancelado' ? getPaymentBadgeHtml(app.payment_status) : ''}
              </div>
              <div style="margin-top: 6px; font-weight: 600; font-size: 1rem;">
                ${UI.escapeHtml(app.client_name)}
                <a href="${UI.escapeHtml(app.client_whatsapp_url)}" target="_blank" class="text-muted" style="margin-left: 8px; text-decoration: underline;">
                  ${UI.escapeHtml(app.client_phone_formatted)} ↗
                </a>
              </div>
              <div class="text-muted" style="margin-top: 4px;">
                Serviços: <strong style="color: var(--text-light);">${UI.escapeHtml(app.services_summary)}</strong>
                • Duração: ${app.total_duration} min
                • Valor total: <strong style="color: var(--text-white);">${UI.escapeHtml(app.total_price_formatted)}</strong>
              </div>
            </div>

            <div class="flex-gap">
              ${
                app.status === 'confirmado'
                  ? `
                <button type="button" class="btn btn-sm btn-green btn-quick-complete" data-id="${app.id}">
                  ✓ Concluir
                </button>
              `
                  : ''
              }
              ${
                app.status !== 'cancelado'
                  ? `
                <button type="button" class="btn btn-sm ${app.payment_status === 'pago' ? 'btn-outline' : 'btn-yellow'} btn-quick-payment" data-id="${app.id}" data-next-pay="${app.payment_status === 'pago' ? 'pendente' : 'pago'}">
                  ${app.payment_status === 'pago' ? 'Marcar Pendente' : '$ Marcar Pago'}
                </button>
              `
                  : ''
              }
              <button type="button" class="btn btn-sm btn-outline btn-edit-app" data-id="${app.id}">
                Editar / Detalhes
              </button>
              ${
                app.status !== 'cancelado'
                  ? `
                <button type="button" class="btn btn-sm btn-red btn-cancel-app" data-id="${app.id}">
                  Cancelar
                </button>
              `
                  : ''
              }
            </div>
          </div>
        </div>
      `
      )
      .join('');

    // Bind quick actions
    container.querySelectorAll('.btn-quick-complete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        await quickUpdateAppointment(id, { status: 'concluido' });
      });
    });

    container.querySelectorAll('.btn-quick-payment').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const nextPay = btn.getAttribute('data-next-pay');
        await quickUpdateAppointment(id, { payment_status: nextPay });
      });
    });

    container.querySelectorAll('.btn-edit-app').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const app = state.appointments.find((a) => a.id === id);
        if (app) openAppointmentModal(app);
      });
    });

    container.querySelectorAll('.btn-cancel-app').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const app = state.appointments.find((a) => a.id === id);
        if (!app) return;
        const confirmed = await UI.confirm({
          title: 'Cancelar agendamento',
          message: `Deseja realmente cancelar o agendamento de ${app.client_name} em ${app.dateBR} às ${app.start_time}? O horário será liberado imediatamente.`,
          confirmText: 'Sim, cancelar agendamento',
          danger: true
        });
        if (confirmed) {
          await quickUpdateAppointment(id, { status: 'cancelado' });
        }
      });
    });
  }

  function renderAppointmentsCalendarView() {
    const container = document.getElementById('appointments-calendar-view');
    if (!state.schedule) return;

    const colsHtml = state.schedule.days
      .map((day) => {
        const dayApps = (state.appointments || []).filter(
          (a) =>
            a.appointment_date === day.work_date &&
            (!state.agendaFilterStatus || a.status === state.agendaFilterStatus)
        );

        const cardsHtml = dayApps.length
          ? dayApps
              .map(
                (app) => `
              <div class="calendar-slot-card" data-app-id="${app.id}">
                <div class="flex-between" style="margin-bottom: 4px;">
                  <strong>${UI.escapeHtml(app.start_time)} - ${UI.escapeHtml(app.end_time)}</strong>
                  ${getStatusBadgeHtml(app.status)}
                </div>
                <div style="font-weight: 600; color: var(--text-white);">${UI.escapeHtml(app.client_name)}</div>
                <div class="text-muted" style="font-size: 0.75rem;">${UI.escapeHtml(app.services_summary)}</div>
                <div class="flex-between" style="margin-top: 6px;">
                  <span style="font-weight: 700;">${UI.escapeHtml(app.total_price_formatted)}</span>
                  ${app.status !== 'cancelado' ? getPaymentBadgeHtml(app.payment_status) : ''}
                </div>
              </div>
            `
              )
              .join('')
          : `<div class="text-muted" style="font-size: 0.8rem; padding: 12px 0; text-align: center;">Sem agendamentos</div>`;

        return `
          <div class="calendar-day-column">
            <div style="border-bottom: 1px solid var(--border-gray); padding-bottom: 8px; margin-bottom: 8px;">
              <div style="font-weight: 700; font-size: 0.9rem;">${UI.escapeHtml(day.dayShortName)} — ${UI.escapeHtml(day.dateBR.slice(0, 5))}</div>
              <div class="text-muted" style="font-size: 0.75rem;">
                ${day.is_working ? `${day.start_time} às ${day.end_time}` : 'Não trabalha'}
              </div>
            </div>
            ${cardsHtml}
          </div>
        `;
      })
      .join('');

    container.innerHTML = `<div class="calendar-grid-wrapper">${colsHtml}</div>`;

    container.querySelectorAll('.calendar-slot-card').forEach((card) => {
      card.addEventListener('click', () => {
        const id = card.getAttribute('data-app-id');
        const app = state.appointments.find((a) => a.id === id);
        if (app) openAppointmentModal(app);
      });
    });
  }

  async function quickUpdateAppointment(id, patch) {
    try {
      const res = await ApiClient.put(`/api/admin/appointments/${id}`, patch);
      UI.toast(res.message || 'Agendamento atualizado!', 'success');
      if (res.waitlist_matches && res.waitlist_matches.length > 0) {
        UI.toast(
          `Atenção: ${res.waitlist_matches.length} cliente(s) na lista de espera compatível(is) com a vaga liberada!`,
          'warning'
        );
      }
      await loadAgendaData(state.currentWeekStart);
    } catch (err) {
      UI.toast(err.message || 'Erro ao atualizar agendamento.', 'error');
    }
  }

  // ==================== MODAL DE EDIÇÃO / CRIAÇÃO DE AGENDAMENTO ====================
  function openAppointmentModal(appointment = null, prefillFromWaitlist = null) {
    const isEdit = Boolean(appointment);
    const root = document.getElementById('admin-modal-root');

    // Não pré-seleciona serviço silenciosamente no novo agendamento para evitar desmarcar ao clicar
    const selectedServiceIds = new Set(
      isEdit
        ? (appointment.items || []).map((i) => i.service_id).filter(Boolean)
        : prefillFromWaitlist
          ? (prefillFromWaitlist.desired_services || []).map((s) => s.id).filter(Boolean)
          : []
    );

    const workingDays = (state.schedule?.days || []).filter((d) => d.is_working);
    const defaultWorkDay =
      workingDays.find((d) => d.work_date === state.agendaFilterDay) ||
      workingDays[0] ||
      state.schedule?.days?.[0];

    const initialDate = isEdit
      ? appointment.appointment_date
      : defaultWorkDay?.work_date || UI.getTodayISO();

    const getDayScheduleForDate = (dateStr) => {
      return (state.schedule?.days || []).find((d) => d.work_date === dateStr) || null;
    };

    const initialDayCfg = getDayScheduleForDate(initialDate);
    // O horário de início padrão é exatamente o horário de início definido na agenda semanal para o dia
    const initialTime = isEdit
      ? appointment.start_time
      : initialDayCfg && initialDayCfg.is_working
        ? initialDayCfg.start_time
        : '09:00';

    const initialName = isEdit
      ? appointment.client_name
      : prefillFromWaitlist
        ? prefillFromWaitlist.name
        : '';
    const initialPhone = isEdit
      ? appointment.client_phone
        ? appointment.client_phone_formatted
        : ''
      : prefillFromWaitlist && prefillFromWaitlist.phone
        ? prefillFromWaitlist.phone_formatted
        : '';

    const buildTimeSelectOptions = (dateStr, targetTime = null) => {
      const dayCfg = getDayScheduleForDate(dateStr);
      let blocks = [];
      if (dayCfg && dayCfg.is_working) {
        blocks = UI.generateDayWorkBlocks(dayCfg);
      }
      if (blocks.length === 0) {
        blocks = TIME_OPTIONS;
      }
      const chosenTime =
        targetTime && blocks.includes(targetTime)
          ? targetTime
          : dayCfg && dayCfg.is_working
            ? dayCfg.start_time
            : blocks[0];

      const occupiedApps = (state.appointments || []).filter(
        (a) =>
          a.appointment_date === dateStr &&
          a.status !== 'cancelado' &&
          (!isEdit || a.id !== appointment.id)
      );

      const optionsHtml = blocks
        .map((t) => {
          const tMin = UI.timeToMinutes(t);
          const occ = occupiedApps.find(
            (a) => tMin >= UI.timeToMinutes(a.start_time) && tMin < UI.timeToMinutes(a.end_time)
          );
          const label = occ ? `${t} (Ocupado — ${occ.client_name})` : t;
          return `<option value="${t}" ${t === chosenTime ? 'selected' : ''}>${UI.escapeHtml(label)}</option>`;
        })
        .join('');

      const infoText =
        dayCfg && dayCfg.is_working
          ? `Expediente definido neste dia (${dayCfg.dayName}): ${dayCfg.start_time} às ${dayCfg.end_time}`
          : 'Atenção: Este dia está marcado como "Não trabalha" na programação semanal.';

      return { optionsHtml, infoText, isWorking: Boolean(dayCfg && dayCfg.is_working) };
    };

    const initialTimeBuild = buildTimeSelectOptions(initialDate, initialTime);

    const servicesCheckboxesHtml = state.services
      .map((s) => {
        const checked = selectedServiceIds.has(s.id);
        return `
          <label
            class="service-item ${checked ? 'selected' : ''}"
            style="padding: 10px 12px; ${checked ? 'border: 2px solid var(--green-action); background: rgba(22, 163, 74, 0.12);' : ''}"
          >
            <input type="checkbox" class="modal-service-cb" value="${s.id}" ${checked ? 'checked' : ''} style="margin-right: 10px; width: 18px; height: 18px; accent-color: var(--green-action);" />
            <div class="service-info">
              <div class="service-name">${UI.escapeHtml(s.name)} ${!s.active ? '(Inativo)' : ''}</div>
            </div>
            <div class="service-price-box">
              <div class="service-price">${UI.escapeHtml(s.price_formatted)}</div>
              <div class="service-duration">30 min</div>
            </div>
          </label>
        `;
      })
      .join('');

    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal-content">
          <div class="modal-header">
            <h3 class="modal-title">${isEdit ? 'Editar Agendamento' : 'Novo Agendamento Manual'}</h3>
            <button type="button" class="btn btn-sm btn-outline" id="modal-close-btn">✕</button>
          </div>

          <form id="modal-appointment-form">
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Nome do cliente *</label>
                <input type="text" id="modal-client-name" class="form-control" value="${UI.escapeHtml(initialName)}" placeholder="Ex: Gabriel" required />
              </div>
              <div class="form-group">
                <label class="form-label">WhatsApp (opcional)</label>
                <input type="text" id="modal-client-phone" class="form-control" value="${UI.escapeHtml(initialPhone)}" placeholder="(11) 99999-9999 (opcional)" />
              </div>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Data do atendimento</label>
                <input type="date" id="modal-app-date" class="form-control" value="${UI.escapeHtml(initialDate)}" required />
              </div>
              <div class="form-group">
                <label class="form-label">Horário de início</label>
                <select id="modal-app-time" class="form-control">
                  ${initialTimeBuild.optionsHtml}
                </select>
              </div>
            </div>
            <div id="modal-day-schedule-hint" class="text-muted" style="font-size: 0.8rem; margin-top: -6px; margin-bottom: 12px; color: ${initialTimeBuild.isWorking ? 'var(--green-text)' : 'var(--yellow-text)'};">
              ${UI.escapeHtml(initialTimeBuild.infoText)}
            </div>

            ${
              isEdit
                ? `
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">Status do agendamento</label>
                  <select id="modal-app-status" class="form-control">
                    <option value="confirmado" ${appointment.status === 'confirmado' ? 'selected' : ''}>Confirmado</option>
                    <option value="concluido" ${appointment.status === 'concluido' ? 'selected' : ''}>Concluído</option>
                    <option value="cancelado" ${appointment.status === 'cancelado' ? 'selected' : ''}>Cancelado</option>
                  </select>
                </div>
                <div class="form-group">
                  <label class="form-label">Status do pagamento</label>
                  <select id="modal-app-payment" class="form-control">
                    <option value="pendente" ${appointment.payment_status === 'pendente' ? 'selected' : ''}>Pendente</option>
                    <option value="pago" ${appointment.payment_status === 'pago' ? 'selected' : ''}>Pago</option>
                  </select>
                </div>
              </div>
            `
                : ''
            }

            <div class="form-group">
              <div class="flex-between" style="margin-bottom: 6px;">
                <label class="form-label" style="margin-bottom: 0;">Serviços selecionados (cada serviço = 30 min) *</label>
                <span id="modal-services-summary-badge" class="badge">Nenhum selecionado</span>
              </div>
              <div class="service-grid" id="modal-services-grid" style="max-height: 210px; overflow-y: auto;">
                ${servicesCheckboxesHtml}
              </div>
            </div>

            ${
              isEdit
                ? `
              <div class="alert" style="margin-top: 10px; margin-bottom: 0;">
                <div style="font-size: 0.8rem; color: var(--text-gray);">Link exclusivo de gerenciamento do cliente:</div>
                <div class="flex-between" style="margin-top: 4px;">
                  <code style="font-size: 0.78rem; word-break: break-all;">${window.location.origin}${UI.escapeHtml(appointment.management_url)}</code>
                  <a href="${UI.escapeHtml(appointment.management_url)}" target="_blank" class="btn btn-sm btn-outline">Abrir Link ↗</a>
                </div>
              </div>
            `
                : ''
            }

            <div class="modal-footer">
              <button type="button" class="btn btn-outline" id="modal-cancel-btn">Cancelar</button>
              <button type="submit" class="btn btn-green" id="modal-save-btn">
                ${isEdit ? 'Salvar Alterações' : 'Confirmar Agendamento'}
              </button>
            </div>
          </form>
        </div>
      </div>
    `;

    const phoneInput = document.getElementById('modal-client-phone');
    UI.attachPhoneMask(phoneInput);

    const updateModalServiceSummary = () => {
      const checkedIds = Array.from(root.querySelectorAll('.modal-service-cb:checked')).map(
        (cb) => cb.value
      );
      const badge = document.getElementById('modal-services-summary-badge');
      if (!badge) return;
      if (checkedIds.length === 0) {
        badge.className = 'badge badge-yellow';
        badge.textContent = 'Clique nos serviços';
      } else {
        const selServices = state.services.filter((s) => checkedIds.includes(s.id));
        const total = selServices.reduce((sum, s) => sum + Number(s.price || 0), 0);
        badge.className = 'badge badge-green';
        badge.textContent = `${checkedIds.length} serviço(s) • ${checkedIds.length * 30} min • ${UI.formatBRL(total)}`;
      }
    };
    updateModalServiceSummary();

    // Ao mudar a data no modal, atualiza o select de horário para começar no horário de início definido na agenda semanal daquele dia
    document.getElementById('modal-app-date').addEventListener('change', (e) => {
      const newDate = e.target.value;
      const built = buildTimeSelectOptions(newDate, null);
      document.getElementById('modal-app-time').innerHTML = built.optionsHtml;
      const hintEl = document.getElementById('modal-day-schedule-hint');
      hintEl.textContent = built.infoText;
      hintEl.style.color = built.isWorking ? 'var(--green-text)' : 'var(--yellow-text)';
    });

    const closeModal = () => {
      root.innerHTML = '';
    };

    document.getElementById('modal-close-btn').addEventListener('click', closeModal);
    document.getElementById('modal-cancel-btn').addEventListener('click', closeModal);

    root.querySelectorAll('.modal-service-cb').forEach((cb) => {
      cb.addEventListener('change', (e) => {
        const label = e.target.closest('.service-item');
        if (label) {
          label.classList.toggle('selected', e.target.checked);
          label.style.border = e.target.checked ? '2px solid var(--green-action)' : '';
          label.style.background = e.target.checked ? 'rgba(22, 163, 74, 0.12)' : '';
        }
        updateModalServiceSummary();
      });
    });

    document.getElementById('modal-appointment-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const checkedIds = Array.from(root.querySelectorAll('.modal-service-cb:checked')).map(
        (cb) => cb.value
      );
      if (checkedIds.length === 0) {
        UI.toast('Selecione pelo menos um serviço na lista.', 'error');
        return;
      }

      const payload = {
        client_name: document.getElementById('modal-client-name').value.trim(),
        client_phone: document.getElementById('modal-client-phone').value.trim(),
        appointment_date: document.getElementById('modal-app-date').value,
        start_time: document.getElementById('modal-app-time').value,
        service_ids: checkedIds
      };

      if (isEdit) {
        payload.status = document.getElementById('modal-app-status').value;
        payload.payment_status = document.getElementById('modal-app-payment').value;
      }

      const saveBtn = document.getElementById('modal-save-btn');
      saveBtn.disabled = true;

      try {
        if (isEdit) {
          await ApiClient.put(`/api/admin/appointments/${appointment.id}`, payload);
          UI.toast('Agendamento atualizado com sucesso!', 'success');
        } else {
          await ApiClient.post('/api/admin/appointments', payload);
          UI.toast('Agendamento criado com sucesso!', 'success');
          if (prefillFromWaitlist) {
            await ApiClient.put(`/api/admin/waitlist/${prefillFromWaitlist.id}`, {
              status: 'atendido'
            });
          }
        }
        closeModal();
        await loadAgendaData(state.currentWeekStart);
      } catch (err) {
        UI.toast(err.message || 'Erro ao salvar agendamento.', 'error');
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  // ==================== SEÇÃO 6: LISTA DE ESPERA ====================
  function renderWaitlistSection() {
    const list = state.waitlist || [];
    const waitingCount = list.filter((w) => w.status === 'aguardando').length;
    const badge = document.getElementById('waitlist-count-badge');
    badge.textContent = `${waitingCount} aguardando`;
    badge.className = waitingCount > 0 ? 'badge badge-yellow' : 'badge';

    const container = document.getElementById('waitlist-container');
    if (list.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 24px 12px; color: var(--text-gray);">
          Nenhum cliente na lista de espera com este filtro.
        </div>
      `;
      return;
    }

    const periodLabels = { manha: 'Manhã', tarde: 'Tarde', noite: 'Noite' };

    container.innerHTML = list
      .map((entry) => {
        const servicesText = (entry.desired_services || []).map((s) => s.name).join(', ');
        const daysText =
          (entry.preferred_days || []).length > 0
            ? entry.preferred_days.map((d) => (d.includes('-') ? UI.formatDateBR(d) : d)).join(', ')
            : 'Qualquer dia';
        const periodsText =
          (entry.preferred_periods || []).length > 0
            ? entry.preferred_periods.map((p) => periodLabels[p] || p).join(', ')
            : 'Qualquer período';

        return `
          <div class="schedule-day-row" style="${entry.matched_opportunity ? 'border-color: var(--yellow-action); background: rgba(217, 119, 6, 0.08);' : ''}">
            ${
              entry.matched_opportunity
                ? `
              <div class="alert alert-yellow" style="padding: 8px 12px; margin-bottom: 10px; font-weight: 600;">
                ★ OPORTUNIDADE COMPATÍVEL LIBERADA: ${UI.escapeHtml(entry.matched_details)}
              </div>
            `
                : ''
            }
            <div class="flex-between">
              <div>
                <div class="flex-gap">
                  <strong style="font-size: 1rem;">${UI.escapeHtml(entry.name)}</strong>
                  <span class="badge">${UI.escapeHtml(entry.phone_formatted)}</span>
                  <span class="badge ${entry.status === 'atendido' ? 'badge-green' : 'badge-yellow'}">
                    ${entry.status === 'atendido' ? 'Atendido' : 'Aguardando'}
                  </span>
                </div>
                <div class="text-muted" style="margin-top: 4px;">
                  Serviços desejados: <strong style="color: var(--text-white);">${UI.escapeHtml(servicesText)}</strong> (${entry.total_duration} min)
                </div>
                <div class="text-muted" style="font-size: 0.82rem; margin-top: 2px;">
                  Dias de preferência: ${UI.escapeHtml(daysText)} • Períodos: ${UI.escapeHtml(periodsText)}
                </div>
              </div>

              <div class="flex-gap">
                <a href="${UI.escapeHtml(entry.whatsapp_url)}" target="_blank" class="btn btn-sm btn-green">
                  Chamar no WhatsApp ↗
                </a>
                ${
                  entry.status === 'aguardando'
                    ? `
                  <button type="button" class="btn btn-sm btn-white btn-waitlist-book" data-id="${entry.id}">
                    Agendar Manualmente
                  </button>
                  <button type="button" class="btn btn-sm btn-outline btn-waitlist-attended" data-id="${entry.id}">
                    Marcar como Atendido
                  </button>
                `
                    : ''
                }
                <button type="button" class="btn btn-sm btn-red btn-waitlist-remove" data-id="${entry.id}">
                  Remover
                </button>
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    container.querySelectorAll('.btn-waitlist-book').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const entry = state.waitlist.find((w) => w.id === id);
        if (entry) openAppointmentModal(null, entry);
      });
    });

    container.querySelectorAll('.btn-waitlist-attended').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        try {
          await ApiClient.put(`/api/admin/waitlist/${id}`, { status: 'atendido' });
          UI.toast('Cliente marcado como atendido!', 'success');
          await reloadWaitlistOnly();
        } catch (err) {
          UI.toast(err.message, 'error');
        }
      });
    });

    container.querySelectorAll('.btn-waitlist-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const ok = await UI.confirm({
          title: 'Remover da lista de espera',
          message: 'Deseja remover este cliente da lista de espera?',
          confirmText: 'Remover',
          danger: true
        });
        if (!ok) return;
        try {
          await ApiClient.delete(`/api/admin/waitlist/${id}`);
          UI.toast('Removido da lista de espera.', 'info');
          await reloadWaitlistOnly();
        } catch (err) {
          UI.toast(err.message, 'error');
        }
      });
    });
  }

  // ==================== ABA 2: FINANCEIRO ====================
  async function loadFinanceDashboard() {
    try {
      const q = new URLSearchParams({
        period: state.financePeriod,
        status: document.getElementById('finance-status-filter').value,
        payment_status: document.getElementById('finance-payment-filter').value,
        q: document.getElementById('finance-search-input').value.trim()
      });
      if (state.financePeriod === 'personalizado') {
        q.set('start_date', state.financeCustomStart);
        q.set('end_date', state.financeCustomEnd);
      }

      const data = await ApiClient.get(`/api/admin/finance?${q.toString()}`);
      state.financeData = data;
      renderFinanceDashboard(data);
    } catch (err) {
      UI.toast(err.message || 'Erro ao carregar dados financeiros.', 'error');
    }
  }

  function renderFinanceDashboard(data) {
    document.getElementById('finance-period-label').textContent =
      `Período: ${data.period.start_date_br} até ${data.period.end_date_br}`;

    // 3.4 Cards principais
    document.getElementById('kpi-recebido').textContent =
      data.cards.faturamento_recebido_formatted;
    document.getElementById('kpi-pendente').textContent =
      data.cards.faturamento_pendente_formatted;
    document.getElementById('kpi-cortes').textContent =
      String(data.cards.total_cortes_realizados);
    document.getElementById('kpi-futuros').textContent =
      String(data.cards.agendamentos_futuros);

    // 3.6 Pagamentos pendentes (Inadimplência)
    const pendingList = data.pending_payments || [];
    document.getElementById('pending-payments-badge').textContent = String(pendingList.length);
    const pendingContainer = document.getElementById('pending-payments-container');

    if (pendingList.length === 0) {
      pendingContainer.innerHTML = `<p class="text-muted" style="padding: 12px 0;">Nenhum pagamento pendente de atendimentos concluídos neste período.</p>`;
    } else {
      pendingContainer.innerHTML = pendingList
        .map(
          (app) => `
          <div class="schedule-day-row" style="margin-bottom: 8px;">
            <div class="flex-between">
              <div>
                <strong>${UI.escapeHtml(app.client_name)}</strong>
                <span class="text-muted" style="margin-left: 6px;">${UI.escapeHtml(app.client_phone_formatted)}</span>
                <div class="text-muted" style="font-size: 0.82rem; margin-top: 2px;">
                  Data: ${UI.escapeHtml(app.dateBR)} • Serviços: ${UI.escapeHtml(app.services_summary)}
                </div>
                <div style="color: var(--yellow-text); font-weight: 700; margin-top: 4px;">
                  Valor pendente: ${UI.escapeHtml(app.total_price_formatted)}
                </div>
              </div>
              <button type="button" class="btn btn-sm btn-green btn-mark-paid-finance" data-id="${app.id}">
                Marcar como pago
              </button>
            </div>
          </div>
        `
        )
        .join('');

      pendingContainer.querySelectorAll('.btn-mark-paid-finance').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-id');
          try {
            await ApiClient.put(`/api/admin/appointments/${id}`, { payment_status: 'pago' });
            UI.toast('Pagamento confirmado com sucesso!', 'success');
            await loadFinanceDashboard();
          } catch (err) {
            UI.toast(err.message, 'error');
          }
        });
      });
    }

    // 3.7 Ranking de Clientes ("Clientes que mais cortam")
    const topClients = data.top_clients || [];
    const topContainer = document.getElementById('top-clients-container');
    if (topClients.length === 0) {
      topContainer.innerHTML = `<p class="text-muted" style="padding: 12px 0;">Nenhum atendimento concluído no período selecionado.</p>`;
    } else {
      topContainer.innerHTML = `
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Cliente</th>
                <th>Cortes</th>
                <th>Total Gasto</th>
                <th>Último Corte</th>
              </tr>
            </thead>
            <tbody>
              ${topClients
                .map(
                  (c, i) => `
                <tr>
                  <td><strong>${i + 1}º</strong></td>
                  <td>
                    <div><strong>${UI.escapeHtml(c.name)}</strong></div>
                    ${c.is_recurring ? '<span class="badge badge-green" style="font-size:0.68rem;">Cliente Recorrente</span>' : ''}
                  </td>
                  <td><strong>${c.cuts_count}</strong></td>
                  <td>${UI.escapeHtml(c.total_spent_formatted)}</td>
                  <td>${UI.escapeHtml(c.last_appointment_date_br)}</td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    // 3.8 Histórico Financeiro
    const history = data.history || [];
    const histContainer = document.getElementById('finance-history-container');
    if (history.length === 0) {
      histContainer.innerHTML = `<p class="text-muted" style="padding: 16px 0; text-align: center;">Nenhum registro encontrado no histórico para este período.</p>`;
    } else {
      histContainer.innerHTML = `
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Data / Horário</th>
                <th>Serviço(s)</th>
                <th>Valor</th>
                <th>Status Atendimento</th>
                <th>Status Pagamento</th>
              </tr>
            </thead>
            <tbody>
              ${history
                .map(
                  (app) => `
                <tr>
                  <td>
                    <strong>${UI.escapeHtml(app.client_name)}</strong>
                    <div class="text-muted" style="font-size: 0.78rem;">${UI.escapeHtml(app.client_phone_formatted)}</div>
                  </td>
                  <td>${UI.escapeHtml(app.dateBR)} às ${UI.escapeHtml(app.start_time)}</td>
                  <td>${UI.escapeHtml(app.services_summary)}</td>
                  <td><strong>${UI.escapeHtml(app.total_price_formatted)}</strong></td>
                  <td>${getStatusBadgeHtml(app.status)}</td>
                  <td>${app.status === 'cancelado' ? '<span class="text-muted">—</span>' : getPaymentBadgeHtml(app.payment_status)}</td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      `;
    }
  }

  // ==================== ABA 3: PREÇOS (SERVIÇOS) ====================
  async function loadAdminServices() {
    try {
      const data = await ApiClient.get('/api/admin/services');
      state.services = data.services || [];
      renderAdminServices();
    } catch (err) {
      UI.toast(err.message || 'Erro ao carregar serviços.', 'error');
    }
  }

  function renderAdminServices() {
    const container = document.getElementById('admin-services-list');
    if (!container) return;

    if (state.services.length === 0) {
      container.innerHTML = `<p class="text-muted">Nenhum serviço cadastrado.</p>`;
      return;
    }

    container.innerHTML = state.services
      .map(
        (svc) => `
        <div class="schedule-day-row" style="margin-bottom: 10px;">
          <div class="flex-between">
            <div>
              <div class="flex-gap">
                <strong style="font-size: 1.05rem;">${UI.escapeHtml(svc.name)}</strong>
                <span class="badge ${svc.active ? 'badge-green' : 'badge-red'}">
                  ${svc.active ? 'Ativo' : 'Inativo'}
                </span>
                <span class="badge">Duração fixa: 30 min</span>
              </div>
              ${
                svc.description
                  ? `<div class="text-muted" style="margin-top: 4px;">${UI.escapeHtml(svc.description)}</div>`
                  : ''
              }
              <div style="font-size: 1.15rem; font-weight: 800; margin-top: 6px; color: var(--text-white);">
                ${UI.escapeHtml(svc.price_formatted)}
              </div>
            </div>

            <div class="flex-gap">
              <button type="button" class="btn btn-sm btn-outline btn-toggle-service" data-id="${svc.id}" data-active="${svc.active}">
                ${svc.active ? 'Desativar' : 'Ativar'}
              </button>
              <button type="button" class="btn btn-sm btn-outline btn-edit-service" data-id="${svc.id}">
                Editar
              </button>
              <button type="button" class="btn btn-sm btn-red btn-delete-service" data-id="${svc.id}">
                Excluir
              </button>
            </div>
          </div>
        </div>
      `
      )
      .join('');

    container.querySelectorAll('.btn-toggle-service').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const currentlyActive = btn.getAttribute('data-active') === 'true';
        try {
          await ApiClient.put(`/api/admin/services/${id}`, { active: !currentlyActive });
          UI.toast(
            !currentlyActive ? 'Serviço ativado!' : 'Serviço desativado!',
            'success'
          );
          await loadAdminServices();
        } catch (err) {
          UI.toast(err.message, 'error');
        }
      });
    });

    container.querySelectorAll('.btn-edit-service').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const svc = state.services.find((s) => s.id === id);
        if (svc) openServiceModal(svc);
      });
    });

    container.querySelectorAll('.btn-delete-service').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const svc = state.services.find((s) => s.id === id);
        if (!svc) return;
        const confirmed = await UI.confirm({
          title: 'Excluir serviço',
          message: `Tem certeza que deseja excluir o serviço "${svc.name}"? Agendamentos já realizados manterão seu valor histórico preservado.`,
          confirmText: 'Sim, excluir',
          danger: true
        });
        if (!confirmed) return;
        try {
          await ApiClient.delete(`/api/admin/services/${id}`);
          UI.toast('Serviço excluído com sucesso.', 'success');
          await loadAdminServices();
        } catch (err) {
          UI.toast(err.message, 'error');
        }
      });
    });
  }

  function openServiceModal(service = null) {
    const isEdit = Boolean(service);
    const root = document.getElementById('admin-modal-root');

    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal-content">
          <div class="modal-header">
            <h3 class="modal-title">${isEdit ? 'Editar Serviço' : 'Novo Serviço'}</h3>
            <button type="button" class="btn btn-sm btn-outline" id="svc-modal-close">✕</button>
          </div>

          <form id="svc-modal-form">
            <div class="form-group">
              <label class="form-label">Nome do serviço</label>
              <input type="text" id="svc-name" class="form-control" value="${UI.escapeHtml(service?.name || '')}" placeholder="Ex: Corte Degradê" required />
            </div>

            <div class="form-group">
              <label class="form-label">Descrição (opcional)</label>
              <input type="text" id="svc-desc" class="form-control" value="${UI.escapeHtml(service?.description || '')}" placeholder="Detalhes do serviço..." />
            </div>

            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Preço (R$)</label>
                <input type="number" step="0.01" min="0" id="svc-price" class="form-control" value="${service ? service.price : ''}" placeholder="35.00" required />
              </div>
              <div class="form-group">
                <label class="form-label">Duração fixa</label>
                <input type="text" class="form-control" value="30 minutos (Padrão)" disabled />
              </div>
            </div>

            <div class="form-group">
              <label class="toggle-switch">
                <input type="checkbox" id="svc-active" ${!service || service.active ? 'checked' : ''} />
                <span>Serviço ativo para agendamento público</span>
              </label>
            </div>

            <div class="modal-footer">
              <button type="button" class="btn btn-outline" id="svc-modal-cancel">Cancelar</button>
              <button type="submit" class="btn btn-green">Salvar Serviço</button>
            </div>
          </form>
        </div>
      </div>
    `;

    const closeModal = () => {
      root.innerHTML = '';
    };
    document.getElementById('svc-modal-close').addEventListener('click', closeModal);
    document.getElementById('svc-modal-cancel').addEventListener('click', closeModal);

    document.getElementById('svc-modal-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        name: document.getElementById('svc-name').value.trim(),
        description: document.getElementById('svc-desc').value.trim(),
        price: Number(document.getElementById('svc-price').value),
        active: document.getElementById('svc-active').checked
      };

      try {
        if (isEdit) {
          await ApiClient.put(`/api/admin/services/${service.id}`, payload);
          UI.toast('Serviço atualizado com sucesso!', 'success');
        } else {
          await ApiClient.post('/api/admin/services', payload);
          UI.toast('Serviço adicionado com sucesso!', 'success');
        }
        closeModal();
        await loadAdminServices();
      } catch (err) {
        UI.toast(err.message || 'Erro ao salvar serviço.', 'error');
      }
    });
  }

  // ==================== MODAL DE NOTIFICAÇÕES WHATSAPP ====================
  async function openNotificationsModal() {
    const root = document.getElementById('admin-modal-root');
    try {
      const data = await ApiClient.get('/api/admin/notifications');
      const wa = data.integration;
      const list = data.notifications || [];

      const rowsHtml = list.length
        ? list
            .map(
              (n) => `
            <div class="schedule-day-row" style="margin-bottom: 8px; padding: 10px;">
              <div class="flex-between">
                <span class="badge ${n.status === 'enviada' ? 'badge-green' : n.status === 'falha' ? 'badge-red' : 'badge-yellow'}">
                  ${UI.escapeHtml(n.status)}
                </span>
                <span class="text-muted" style="font-size: 0.75rem;">
                  Tentativas: ${n.attempts} • ${new Date(n.created_at).toLocaleString('pt-BR')}
                </span>
                ${
                  n.status !== 'enviada'
                    ? `<button type="button" class="btn btn-sm btn-outline btn-retry-notif" data-id="${n.id}">Tentar Reenviar</button>`
                    : ''
                }
              </div>
              <pre style="white-space: pre-wrap; font-family: inherit; font-size: 0.82rem; color: var(--text-light); margin-top: 6px; background: var(--bg-black); padding: 8px; border-radius: 4px;">${UI.escapeHtml(n.content)}</pre>
              ${
                n.error
                  ? `<div style="font-size: 0.75rem; color: var(--yellow-text); margin-top: 4px;">Detalhe: ${UI.escapeHtml(n.error)}</div>`
                  : ''
              }
            </div>
          `
            )
            .join('')
        : `<p class="text-muted">Nenhuma notificação disparada ainda.</p>`;

      root.innerHTML = `
        <div class="modal-backdrop">
          <div class="modal-content" style="max-width: 640px;">
            <div class="modal-header">
              <h3 class="modal-title">Integração e Histórico WhatsApp</h3>
              <button type="button" class="btn btn-sm btn-outline" id="notif-modal-close">✕</button>
            </div>

            <div class="alert ${wa.configured ? 'alert-green' : 'alert-yellow'}">
              <div><strong>Status da Integração:</strong> ${UI.escapeHtml(wa.statusLabel)}</div>
              <div style="font-size: 0.82rem; margin-top: 4px;">
                Provedor configurado: <code>${UI.escapeHtml(wa.provider)}</code> • Destinatário (Luan): <code>${UI.escapeHtml(wa.recipient)}</code>
              </div>
            </div>

            <h4 style="margin-bottom: 10px; font-size: 0.95rem;">Últimas notificações registradas</h4>
            <div style="max-height: 360px; overflow-y: auto;">
              ${rowsHtml}
            </div>

            <div class="modal-footer">
              <button type="button" class="btn btn-white" id="notif-modal-ok">Fechar</button>
            </div>
          </div>
        </div>
      `;

      const closeModal = () => {
        root.innerHTML = '';
      };
      document.getElementById('notif-modal-close').addEventListener('click', closeModal);
      document.getElementById('notif-modal-ok').addEventListener('click', closeModal);

      root.querySelectorAll('.btn-retry-notif').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-id');
          try {
            const res = await ApiClient.post(`/api/admin/notifications/${id}/retry`, {});
            UI.toast(res.message, res.notification.status === 'enviada' ? 'success' : 'warning');
            openNotificationsModal();
          } catch (err) {
            UI.toast(err.message, 'error');
          }
        });
      });
    } catch (err) {
      UI.toast(err.message || 'Erro ao carregar notificações.', 'error');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();

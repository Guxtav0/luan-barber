(function () {
  const state = {
    admin: null,
    integrations: null,
    messageTemplates: null,
    defaultTemplates: null,
    activeTab: 'agenda',
    currentWeekStart: UI.getMondayISO(UI.getTodayISO()),
    schedule: null,
    appointments: [],
    waitlist: [],
    services: [],
    openDaySections: new Set(),
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
    let data;
    try {
      data = await ApiClient.get('/api/auth/me');
    } catch {
      showLoginScreen();
      return;
    }

    state.admin = data.admin;
    state.integrations = data.integrations;
    showAdminApp();
    try {
      await loadAllInitialData();
    } catch (err) {
      console.error('Erro ao carregar dados iniciais:', err);
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
    syncSettingsTabUI();
  }

  function updateWhatsAppHeaderBadge() {
    const badge = document.getElementById('wa-status-indicator');
    if (!badge || !state.integrations) return;
    const wa = state.integrations.whatsapp;
    if (wa && wa.configured) {
      badge.className = 'badge badge-green';
      badge.textContent = 'Ativo';
    } else {
      badge.className = 'badge badge-yellow';
      badge.textContent = 'Não configurado';
    }
  }

  function updateThemeButtonsUI() {
    const currentTheme = UI.getTheme();
    const darkBtn = document.getElementById('btn-theme-dark');
    const lightBtn = document.getElementById('btn-theme-light');
    if (darkBtn && lightBtn) {
      darkBtn.className = currentTheme === 'dark' ? 'btn btn-white' : 'btn btn-outline';
      lightBtn.className = currentTheme === 'light' ? 'btn btn-white' : 'btn btn-outline';
    }
  }

  function syncSettingsTabUI() {
    updateWhatsAppHeaderBadge();
    updateThemeButtonsUI();

    const emailLabel = document.getElementById('settings-admin-email-label');
    if (emailLabel && state.admin) {
      emailLabel.textContent = `Conectado como ${state.admin.name || 'Luan'} (${state.admin.email})`;
    }

    const waInput = document.getElementById('settings-wa-number');
    if (waInput && state.integrations && state.integrations.whatsapp) {
      const raw =
        state.integrations.whatsapp.rawRecipient ||
        state.integrations.whatsapp.number ||
        '';
      const localDigits = raw.startsWith('55') && raw.length >= 12 ? raw.slice(2) : raw;
      waInput.value = localDigits ? UI.formatPhoneDisplay(localDigits) : '';
    }

    if (state.messageTemplates) {
      const tpl = state.messageTemplates;
      const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el && val !== undefined) el.value = val;
      };
      setVal('tpl-mensagem-cliente', tpl.mensagem_cliente);
      setVal('tpl-novo-agendamento', tpl.novo_agendamento);
      setVal('tpl-cancelamento-cliente', tpl.cancelamento_cliente);
      setVal('tpl-atendimento-concluido', tpl.atendimento_concluido);
      setVal('tpl-publicacao-agenda', tpl.publicacao_agenda);
    }
  }

  async function loadSettingsTab() {
    try {
      const data = await ApiClient.get('/api/admin/settings');
      if (data && data.whatsapp) {
        if (!state.integrations) state.integrations = {};
        state.integrations.whatsapp = data.whatsapp;
      }
      if (data && data.message_templates) {
        state.messageTemplates = data.message_templates;
      }
      if (data && data.default_templates) {
        state.defaultTemplates = data.default_templates;
      }
      syncSettingsTabUI();
    } catch {
      syncSettingsTabUI();
    }
  }

  function openMobileSidebar() {
    document.getElementById('sidebar-backdrop')?.classList.add('open');
    document.getElementById('sidebar-drawer')?.classList.add('open');
  }

  function closeMobileSidebar() {
    document.getElementById('sidebar-backdrop')?.classList.remove('open');
    document.getElementById('sidebar-drawer')?.classList.remove('open');
  }

  function toggleScheduleEditor() {
    const body = document.getElementById('schedule-editor-body');
    const btn = document.getElementById('btn-toggle-schedule-editor');
    if (!body || !btn) return;
    const isHidden = body.classList.toggle('hidden');
    btn.classList.toggle('open', !isHidden);
  }

  async function loadAllInitialData() {
    await Promise.all([
      loadAdminServices(),
      loadAgendaData(state.currentWeekStart),
      loadSettingsTab()
    ]);
  }

  // ==================== EVENTOS GERAIS ====================
  function bindStaticEvents() {
    const waInput = document.getElementById('settings-wa-number');
    if (waInput) UI.attachPhoneMask(waInput);

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
      closeMobileSidebar();
      await ApiClient.post('/api/auth/logout', {}).catch(() => {});
      ApiClient.setToken('');
      state.admin = null;
      showLoginScreen();
      UI.toast('Sessão encerrada.', 'info');
    });

    // Menu Lateral Mobile (Drawer)
    document.getElementById('btn-open-sidebar')?.addEventListener('click', openMobileSidebar);
    document.getElementById('btn-close-sidebar')?.addEventListener('click', closeMobileSidebar);
    document.getElementById('sidebar-backdrop')?.addEventListener('click', closeMobileSidebar);

    // Navegação entre abas (Desktop e Menu Lateral Mobile)
    document.querySelectorAll('.admin-tab-btn, .sidebar-nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        closeMobileSidebar();
        switchTab(tab);
      });
    });

    // Aba 4: Configurações (WhatsApp, Mensagens Automáticas e Tema)
    const waSettingsForm = document.getElementById('settings-whatsapp-form');
    if (waSettingsForm) {
      waSettingsForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const numberVal = document.getElementById('settings-wa-number').value.trim();
        try {
          const res = await ApiClient.put('/api/admin/settings', {
            luan_whatsapp_number: numberVal
          });
          if (!state.integrations) state.integrations = {};
          state.integrations.whatsapp = res.whatsapp;
          syncSettingsTabUI();
          UI.toast(res.message || 'Número de WhatsApp salvo com sucesso!', 'success');
        } catch (err) {
          UI.toast(err.message || 'Erro ao salvar número de WhatsApp.', 'error');
        }
      });
    }

    const msgSettingsForm = document.getElementById('settings-messages-form');
    if (msgSettingsForm) {
      msgSettingsForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const templatesPayload = {
          mensagem_cliente: document.getElementById('tpl-mensagem-cliente')?.value || '',
          novo_agendamento: document.getElementById('tpl-novo-agendamento')?.value || '',
          cancelamento_cliente: document.getElementById('tpl-cancelamento-cliente')?.value || '',
          atendimento_concluido: document.getElementById('tpl-atendimento-concluido')?.value || '',
          publicacao_agenda: document.getElementById('tpl-publicacao-agenda')?.value || ''
        };
        try {
          const res = await ApiClient.put('/api/admin/settings', {
            message_templates: templatesPayload
          });
          if (res.message_templates) {
            state.messageTemplates = res.message_templates;
          }
          syncSettingsTabUI();
          UI.toast('Mensagens automáticas salvas com sucesso!', 'success');
        } catch (err) {
          UI.toast(err.message || 'Erro ao salvar mensagens automáticas.', 'error');
        }
      });
    }

    document.getElementById('btn-reset-messages')?.addEventListener('click', async () => {
      if (!state.defaultTemplates) return;
      state.messageTemplates = { ...state.defaultTemplates };
      syncSettingsTabUI();
      try {
        await ApiClient.put('/api/admin/settings', {
          message_templates: state.defaultTemplates
        });
        UI.toast('Textos padrão restaurados!', 'info');
      } catch {
        UI.toast('Textos padrão carregados na tela.', 'info');
      }
    });

    document.getElementById('btn-theme-dark')?.addEventListener('click', () => {
      UI.setTheme('dark');
      updateThemeButtonsUI();
      UI.toast('Tema escuro ativado.', 'info');
    });

    document.getElementById('btn-theme-light')?.addEventListener('click', () => {
      UI.setTheme('light');
      updateThemeButtonsUI();
      UI.toast('Tema claro ativado.', 'info');
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

    // Expandir / ocultar editor de expediente com ícone ">" animado
    const schedHeader = document.getElementById('schedule-editor-header');
    const schedToggleBtn = document.getElementById('btn-toggle-schedule-editor');
    if (schedHeader) {
      schedHeader.addEventListener('click', (e) => {
        if (schedToggleBtn && schedToggleBtn.contains(e.target)) return;
        toggleScheduleEditor();
      });
    }
    if (schedToggleBtn) {
      schedToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleScheduleEditor();
      });
    }

    // Salvar rascunho e Publicar agenda
    document.getElementById('btn-save-draft').addEventListener('click', () => {
      submitWeeklySchedule(false);
    });
    document.getElementById('btn-publish-schedule').addEventListener('click', () => {
      submitWeeklySchedule(true);
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
    document.querySelectorAll('.admin-tab-btn, .sidebar-nav-btn').forEach((btn) => {
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
    } else if (tabName === 'configuracoes') {
      loadSettingsTab();
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
        renderAppointmentsSection();
      });
    });

    container.querySelectorAll('.day-start-select').forEach((sel) => {
      sel.addEventListener('change', (e) => {
        const idx = Number(e.target.getAttribute('data-day-idx'));
        state.schedule.days[idx].start_time = e.target.value;
        renderAppointmentsSection();
      });
    });

    container.querySelectorAll('.day-end-select').forEach((sel) => {
      sel.addEventListener('change', (e) => {
        const idx = Number(e.target.getAttribute('data-day-idx'));
        state.schedule.days[idx].end_time = e.target.value;
        renderAppointmentsSection();
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
        renderAppointmentsSection();
      });
    });

    container.querySelectorAll('.btn-remove-break').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const dIdx = Number(e.currentTarget.getAttribute('data-day-idx'));
        const bIdx = Number(e.currentTarget.getAttribute('data-break-idx'));
        state.schedule.days[dIdx].breaks.splice(bIdx, 1);
        renderScheduleHeaderAndEditor();
        renderAppointmentsSection();
      });
    });

    container.querySelectorAll('.break-start-select').forEach((sel) => {
      sel.addEventListener('change', (e) => {
        const dIdx = Number(e.target.getAttribute('data-day-idx'));
        const bIdx = Number(e.target.getAttribute('data-break-idx'));
        state.schedule.days[dIdx].breaks[bIdx].start = e.target.value;
        renderAppointmentsSection();
      });
    });

    container.querySelectorAll('.break-end-select').forEach((sel) => {
      sel.addEventListener('change', (e) => {
        const dIdx = Number(e.target.getAttribute('data-day-idx'));
        const bIdx = Number(e.target.getAttribute('data-break-idx'));
        state.schedule.days[dIdx].breaks[bIdx].end = e.target.value;
        renderAppointmentsSection();
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
      renderAppointmentsSection();
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
    const container = document.getElementById('appointments-list-view');
    if (!container || !state.schedule) return;

    const workingDays = (state.schedule.days || []).filter((d) => d.is_working);
    const activeApps = (state.appointments || []).filter((a) => a.status !== 'cancelado');

    const summaryEl = document.getElementById('agenda-summary-counts');
    if (summaryEl) {
      summaryEl.textContent = `${workingDays.length} dia(s) de trabalho • ${activeApps.length} agendamento(s) na semana`;
    }

    if (workingDays.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 32px 16px; color: var(--text-gray);">
          Nenhum dia de trabalho selecionado para esta semana. Habilite os dias desejados na seção "1. Configurar Disponibilidade da Semana".
        </div>
      `;
      return;
    }

    container.innerHTML = workingDays
      .map((day) => {
        const dayApps = activeApps
          .filter((a) => a.appointment_date === day.work_date)
          .sort((a, b) => a.start_time.localeCompare(b.start_time));

        const workBlocks = UI.generateDayWorkBlocks(day);
        const freeBlocks = workBlocks.filter((t) => {
          const tMin = UI.timeToMinutes(t);
          return !dayApps.some(
            (a) => tMin >= UI.timeToMinutes(a.start_time) && tMin < UI.timeToMinutes(a.end_time)
          );
        });

        const confirmedCount = dayApps.length;
        const availableCount = freeBlocks.length;
        const isOpen = state.openDaySections.has(day.work_date);

        const compactListHtml = dayApps.length
          ? dayApps
              .map(
                (app) => `
              <div class="compact-client-card">
                <div class="compact-client-top">
                  <span class="compact-client-name">${UI.escapeHtml(app.client_name)}</span>
                  <span class="compact-client-time">${UI.escapeHtml(app.start_time)}</span>
                </div>

                <div class="compact-client-actions">
                  <button
                    type="button"
                    class="btn btn-sm ${app.status === 'concluido' ? 'btn-green' : 'btn-outline'} btn-quick-complete"
                    data-id="${app.id}"
                    data-next-status="${app.status === 'concluido' ? 'confirmado' : 'concluido'}"
                  >
                    ${app.status === 'concluido' ? '✓ Realizado' : 'Realizado'}
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm ${app.payment_status === 'pago' ? 'btn-green' : 'btn-yellow'} btn-quick-payment"
                    data-id="${app.id}"
                    data-next-pay="${app.payment_status === 'pago' ? 'pendente' : 'pago'}"
                  >
                    ${app.payment_status === 'pago' ? '✓ Pago' : 'Pago'}
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-outline btn-edit-app"
                    data-id="${app.id}"
                  >
                    Editar
                  </button>
                </div>
              </div>
            `
              )
              .join('')
          : `
            <div class="text-muted" style="padding: 14px 10px; text-align: center; background: var(--bg-black); border: 1px dashed var(--border-gray); border-radius: var(--radius-sm); margin-top: 8px;">
              Nenhum agendamento confirmado neste dia. Clique no botão <strong>+</strong> ao lado para agendar.
            </div>
          `;

        return `
          <div class="schedule-day-row working" style="margin-bottom: 12px;">
            <div class="collapsible-header day-section-header" data-date="${day.work_date}">
              <div>
                <div class="flex-gap">
                  <h4 style="font-size: 1.05rem; font-weight: 700; color: var(--text-white); margin: 0;">
                    ${UI.escapeHtml(day.dayName)}
                  </h4>
                  <span class="badge">${UI.escapeHtml(day.dateBR)}</span>
                </div>
                <div style="margin-top: 6px; font-size: 0.84rem; color: var(--text-gray); display: flex; flex-direction: column; gap: 2px;">
                  <span>Confirmados: <strong style="color: var(--text-white);">${confirmedCount}</strong></span>
                  <span>Disponíveis: <strong style="color: var(--text-white);">${availableCount}</strong></span>
                </div>
              </div>

              <div class="collapsible-header-actions">
                <button
                  type="button"
                  class="btn btn-green day-add-btn btn-add-day-appointment"
                  data-date="${day.work_date}"
                  title="Novo agendamento em ${UI.escapeHtml(day.dayName)}"
                  aria-label="Novo agendamento em ${UI.escapeHtml(day.dayName)}"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" style="width: 18px; height: 18px; display: block;">
                    <line x1="12" y1="5" x2="12" y2="19"></line>
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                  </svg>
                </button>
                <button
                  type="button"
                  class="chevron-toggle-btn ${isOpen ? 'open' : ''} btn-toggle-day-section"
                  data-date="${day.work_date}"
                  aria-label="Expandir ou recolher agendamentos do dia"
                >
                  <svg class="chevron-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="9 6 15 12 9 18"></polyline>
                  </svg>
                </button>
              </div>
            </div>

            <div class="day-section-body ${isOpen ? '' : 'hidden'}" data-date="${day.work_date}" style="margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border-gray);">
              ${compactListHtml}
            </div>
          </div>
        `;
      })
      .join('');

    const toggleDaySection = (dateStr) => {
      const willOpen = !state.openDaySections.has(dateStr);
      if (willOpen) {
        state.openDaySections.add(dateStr);
      } else {
        state.openDaySections.delete(dateStr);
      }

      const btn = container.querySelector(`.btn-toggle-day-section[data-date="${dateStr}"]`);
      const body = container.querySelector(`.day-section-body[data-date="${dateStr}"]`);
      if (btn) btn.classList.toggle('open', willOpen);
      if (body) body.classList.toggle('hidden', !willOpen);
    };

    container.querySelectorAll('.day-section-header').forEach((hdr) => {
      hdr.addEventListener('click', (e) => {
        if (
          e.target.closest('.btn-add-day-appointment') ||
          e.target.closest('.btn-toggle-day-section')
        ) {
          return;
        }
        toggleDaySection(hdr.getAttribute('data-date'));
      });
    });

    container.querySelectorAll('.btn-toggle-day-section').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDaySection(btn.getAttribute('data-date'));
      });
    });

    container.querySelectorAll('.btn-add-day-appointment').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const dateStr = btn.getAttribute('data-date');
        state.openDaySections.add(dateStr);
        openAppointmentModal(null, null, dateStr);
      });
    });

    container.querySelectorAll('.btn-quick-complete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const nextStatus = btn.getAttribute('data-next-status');
        await quickUpdateAppointment(id, { status: nextStatus });
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
  function openAppointmentModal(
    appointment = null,
    prefillFromWaitlist = null,
    preselectedDate = null
  ) {
    const isEdit = Boolean(appointment);
    const root = document.getElementById('admin-modal-root');

    const selectedServiceIds = new Set(
      isEdit
        ? (appointment.items || []).map((i) => i.service_id).filter(Boolean)
        : prefillFromWaitlist
          ? (prefillFromWaitlist.desired_services || []).map((s) => s.id).filter(Boolean)
          : []
    );

    const workingDays = (state.schedule?.days || []).filter((d) => d.is_working);
    const availableDaysForSelect = [...workingDays];

    // Caso esteja editando um agendamento antigo de um dia que não está em workingDays, inclui na lista para não quebrar a edição
    if (
      isEdit &&
      appointment.appointment_date &&
      !availableDaysForSelect.some((d) => d.work_date === appointment.appointment_date)
    ) {
      const existingDay = (state.schedule?.days || []).find(
        (d) => d.work_date === appointment.appointment_date
      );
      if (existingDay) {
        availableDaysForSelect.push(existingDay);
      } else {
        availableDaysForSelect.push({
          work_date: appointment.appointment_date,
          dayName: appointment.dayName || UI.formatDateBR(appointment.appointment_date),
          dateBR: appointment.dateBR || UI.formatDateBR(appointment.appointment_date),
          is_working: true,
          start_time: '09:00',
          end_time: '18:00',
          breaks: []
        });
      }
    }

    const defaultWorkDay =
      (preselectedDate && availableDaysForSelect.find((d) => d.work_date === preselectedDate)) ||
      availableDaysForSelect[0] ||
      state.schedule?.days?.[0];

    const initialDate = isEdit
      ? appointment.appointment_date
      : preselectedDate || defaultWorkDay?.work_date || UI.getTodayISO();

    const getDayScheduleForDate = (dateStr) => {
      return (
        availableDaysForSelect.find((d) => d.work_date === dateStr) ||
        (state.schedule?.days || []).find((d) => d.work_date === dateStr) ||
        null
      );
    };

    // Calcula o primeiro horário livre naquele dia (considerando agendamentos ativos e duração necessária)
    const getFirstAvailableSlotForDate = (dateStr, requiredDuration = 30) => {
      const dayCfg = getDayScheduleForDate(dateStr);
      let blocks = [];
      if (dayCfg && dayCfg.is_working) {
        blocks = UI.generateDayWorkBlocks(dayCfg);
      }
      if (blocks.length === 0) {
        blocks = TIME_OPTIONS;
      }

      const occupiedApps = (state.appointments || []).filter(
        (a) =>
          a.appointment_date === dateStr &&
          a.status !== 'cancelado' &&
          (!isEdit || a.id !== appointment.id)
      );

      const dur = Math.max(30, requiredDuration);
      const dayEndMin =
        dayCfg && dayCfg.is_working ? UI.timeToMinutes(dayCfg.end_time) : 24 * 60;
      const breaks = Array.isArray(dayCfg?.breaks) ? dayCfg.breaks : [];

      // Procura primeiro bloco que comporte toda a duração sem conflito
      for (const t of blocks) {
        const startMin = UI.timeToMinutes(t);
        const endMin = startMin + dur;
        if (endMin > dayEndMin) continue;

        const hitsBreak = breaks.some(
          (b) => startMin < UI.timeToMinutes(b.end) && endMin > UI.timeToMinutes(b.start)
        );
        if (hitsBreak) continue;

        const hitsApp = occupiedApps.some(
          (a) =>
            startMin < UI.timeToMinutes(a.end_time) && endMin > UI.timeToMinutes(a.start_time)
        );
        if (!hitsApp) {
          return t;
        }
      }

      // Fallback: primeiro bloco de 30min não ocupado
      for (const t of blocks) {
        const tMin = UI.timeToMinutes(t);
        const isOcc = occupiedApps.some(
          (a) => tMin >= UI.timeToMinutes(a.start_time) && tMin < UI.timeToMinutes(a.end_time)
        );
        if (!isOcc) return t;
      }

      return dayCfg && dayCfg.is_working ? dayCfg.start_time : blocks[0];
    };

    const initialDuration = Math.max(30, selectedServiceIds.size * 30);
    const initialTime = isEdit
      ? appointment.start_time
      : getFirstAvailableSlotForDate(initialDate, initialDuration);

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

    const buildTimeSelectOptions = (dateStr, targetTime = null, requiredDuration = 30) => {
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
          : getFirstAvailableSlotForDate(dateStr, requiredDuration);

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

    const initialTimeBuild = buildTimeSelectOptions(
      initialDate,
      initialTime,
      initialDuration
    );

    const dateSelectOptionsHtml = availableDaysForSelect.length
      ? availableDaysForSelect
          .map(
            (d) =>
              `<option value="${d.work_date}" ${d.work_date === initialDate ? 'selected' : ''}>${UI.escapeHtml(d.dayName)} (${UI.escapeHtml(d.dateBR)})</option>`
          )
          .join('')
      : `<option value="${UI.escapeHtml(initialDate)}" selected>${UI.escapeHtml(UI.formatDateBR(initialDate))}</option>`;

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
                <label class="form-label">Data disponível na agenda</label>
                <select id="modal-app-date" class="form-control" required>
                  ${dateSelectOptionsHtml}
                </select>
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
                <div style="font-size: 0.8rem; color: var(--text-gray);">Ações rápidas e Link do cliente:</div>
                <div class="flex-between" style="margin-top: 6px;">
                  <div class="flex-gap">
                    ${
                      appointment.client_whatsapp_url
                        ? `<a href="${UI.escapeHtml(appointment.client_whatsapp_url)}" target="_blank" class="btn btn-sm btn-green">Enviar WhatsApp ↗</a>`
                        : ''
                    }
                    <a href="${UI.escapeHtml(appointment.management_url)}" target="_blank" class="btn btn-sm btn-outline">Link do Cliente ↗</a>
                  </div>
                  ${
                    appointment.status !== 'cancelado'
                      ? `<button type="button" class="btn btn-sm btn-red" id="modal-quick-cancel-btn">Cancelar Agendamento</button>`
                      : ''
                  }
                </div>
              </div>
            `
                : ''
            }

            <div class="modal-footer">
              <button type="button" class="btn btn-outline" id="modal-cancel-btn">Fechar</button>
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

    const getModalSelectedDuration = () => {
      const checkedCount = root.querySelectorAll('.modal-service-cb:checked').length;
      return Math.max(30, checkedCount * 30);
    };

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

    // Ao mudar a data no modal, pré-seleciona automaticamente o primeiro horário livre daquele dia
    document.getElementById('modal-app-date').addEventListener('change', (e) => {
      const newDate = e.target.value;
      const built = buildTimeSelectOptions(newDate, null, getModalSelectedDuration());
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

    document.getElementById('modal-quick-cancel-btn')?.addEventListener('click', async () => {
      const confirmed = await UI.confirm({
        title: 'Cancelar agendamento',
        message: `Deseja realmente cancelar o agendamento de ${appointment.client_name} em ${appointment.dateBR} às ${appointment.start_time}?`,
        confirmText: 'Sim, cancelar',
        danger: true
      });
      if (!confirmed) return;
      closeModal();
      await quickUpdateAppointment(appointment.id, { status: 'cancelado' });
    });

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
        (svc, idx) => `
        <div
          class="schedule-day-row service-sortable-row"
          draggable="true"
          data-service-id="${svc.id}"
          data-idx="${idx}"
          style="margin-bottom: 10px;"
        >
          <div class="service-card-top">
            <div class="service-card-info">
              <div class="service-card-header">
                <span class="badge">${idx + 1}º</span>
                <strong class="service-card-title">${UI.escapeHtml(svc.name)}</strong>
                <span class="badge ${svc.active ? 'badge-green' : 'badge-red'}">
                  ${svc.active ? 'Ativo' : 'Inativo'}
                </span>
              </div>
              ${
                svc.description
                  ? `<div class="text-muted" style="font-size: 0.86rem;">${UI.escapeHtml(svc.description)}</div>`
                  : ''
              }
              <div class="service-card-meta">
                <span class="service-card-price">${UI.escapeHtml(svc.price_formatted)}</span>
                <span class="badge">30 min</span>
              </div>
            </div>

            <div
              class="service-drag-handle"
              title="Clique e arraste para reordenar"
              aria-label="Clique e arraste para reordenar"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="9" cy="5" r="1.8"></circle>
                <circle cx="15" cy="5" r="1.8"></circle>
                <circle cx="9" cy="12" r="1.8"></circle>
                <circle cx="15" cy="12" r="1.8"></circle>
                <circle cx="9" cy="19" r="1.8"></circle>
                <circle cx="15" cy="19" r="1.8"></circle>
              </svg>
            </div>
          </div>

          <div class="service-card-actions">
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
      `
      )
      .join('');

    const moveService = async (fromIdx, toIdx) => {
      if (fromIdx === toIdx || toIdx < 0 || toIdx >= state.services.length) return;
      const reordered = [...state.services];
      const [moved] = reordered.splice(fromIdx, 1);
      reordered.splice(toIdx, 0, moved);
      state.services = reordered;
      renderAdminServices();

      try {
        const res = await ApiClient.put('/api/admin/services/reorder', {
          ordered_ids: reordered.map((s) => s.id)
        });
        if (res.services) {
          state.services = res.services;
          renderAdminServices();
        }
        UI.toast('Ordem dos serviços atualizada!', 'success');
      } catch (err) {
        UI.toast(err.message || 'Erro ao reordenar serviços.', 'error');
        await loadAdminServices();
      }
    };

    let draggedIdx = null;
    const rows = Array.from(container.querySelectorAll('.service-sortable-row'));

    rows.forEach((row) => {
      row.addEventListener('dragstart', (e) => {
        if (e.target.closest('button')) {
          e.preventDefault();
          return;
        }
        draggedIdx = Number(row.getAttribute('data-idx'));
        row.classList.add('dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(draggedIdx));
        }
      });

      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        const overIdx = Number(row.getAttribute('data-idx'));
        rows.forEach((r) => r.classList.remove('drag-over'));
        if (draggedIdx !== null && overIdx !== draggedIdx) {
          row.classList.add('drag-over');
        }
      });

      row.addEventListener('dragleave', () => {
        row.classList.remove('drag-over');
      });

      row.addEventListener('drop', (e) => {
        e.preventDefault();
        rows.forEach((r) => r.classList.remove('drag-over', 'dragging'));
        const toIdx = Number(row.getAttribute('data-idx'));
        const fromIdx =
          draggedIdx !== null
            ? draggedIdx
            : Number(e.dataTransfer?.getData('text/plain'));
        draggedIdx = null;
        if (!Number.isNaN(fromIdx) && !Number.isNaN(toIdx) && fromIdx !== toIdx) {
          moveService(fromIdx, toIdx);
        }
      });

      row.addEventListener('dragend', () => {
        draggedIdx = null;
        rows.forEach((r) => r.classList.remove('drag-over', 'dragging'));
      });

      const handle = row.querySelector('.service-drag-handle');
      if (handle) {
        let touchFromIdx = null;
        let touchTargetIdx = null;

        handle.addEventListener(
          'touchstart',
          () => {
            touchFromIdx = Number(row.getAttribute('data-idx'));
            touchTargetIdx = touchFromIdx;
            row.classList.add('dragging');
          },
          { passive: true }
        );

        handle.addEventListener(
          'touchmove',
          (e) => {
            if (touchFromIdx === null) return;
            e.preventDefault();
            const touch = e.touches[0];
            const el = document.elementFromPoint(touch.clientX, touch.clientY);
            const overRow = el ? el.closest('.service-sortable-row') : null;
            rows.forEach((r) => r.classList.remove('drag-over'));
            if (overRow) {
              const idx = Number(overRow.getAttribute('data-idx'));
              touchTargetIdx = idx;
              if (idx !== touchFromIdx) {
                overRow.classList.add('drag-over');
              }
            }
          },
          { passive: false }
        );

        handle.addEventListener('touchend', () => {
          rows.forEach((r) => r.classList.remove('drag-over', 'dragging'));
          if (
            touchFromIdx !== null &&
            touchTargetIdx !== null &&
            touchFromIdx !== touchTargetIdx
          ) {
            moveService(touchFromIdx, touchTargetIdx);
          }
          touchFromIdx = null;
          touchTargetIdx = null;
        });
      }
    });

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

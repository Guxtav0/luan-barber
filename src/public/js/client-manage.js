(function () {
  const state = {
    token: '',
    appointment: null,
    activeServices: [],
    selectedServiceIds: new Set(),
    weekStart: null,
    availability: null,
    selectedDate: null,
    selectedTime: null
  };

  function extractTokenFromUrl() {
    const url = new URL(window.location.href);
    const qToken = url.searchParams.get('token');
    if (qToken) return qToken.trim();
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'agendamento' && parts[1]) {
      return parts[1].trim();
    }
    return '';
  }

  async function init() {
    state.token = extractTokenFromUrl();
    if (!state.token) {
      showFatalError('Link de agendamento inválido ou incompleto.');
      return;
    }

    bindEvents();
    await loadAppointmentDetails();
  }

  function bindEvents() {
    document.getElementById('btn-toggle-reschedule').addEventListener('click', async () => {
      const panel = document.getElementById('reschedule-panel');
      panel.classList.remove('hidden');
      state.weekStart = UI.getMondayISO(state.appointment.appointment_date);
      state.selectedDate = state.appointment.appointment_date;
      state.selectedTime = state.appointment.start_time;
      renderRescheduleServices();
      await loadRescheduleAvailability();
    });

    document.getElementById('btn-close-reschedule').addEventListener('click', () => {
      document.getElementById('reschedule-panel').classList.add('hidden');
    });

    document.getElementById('resched-prev-week').addEventListener('click', async () => {
      state.weekStart = UI.addDaysISO(state.weekStart, -7);
      state.selectedDate = null;
      state.selectedTime = null;
      await loadRescheduleAvailability();
    });

    document.getElementById('resched-next-week').addEventListener('click', async () => {
      state.weekStart = UI.addDaysISO(state.weekStart, 7);
      state.selectedDate = null;
      state.selectedTime = null;
      await loadRescheduleAvailability();
    });

    document.getElementById('btn-save-reschedule').addEventListener('click', submitReschedule);

    document.getElementById('btn-cancel-my-appointment').addEventListener('click', async () => {
      const confirmed = await UI.confirm({
        title: 'Cancelar agendamento',
        message: 'Tem certeza que deseja cancelar o seu agendamento na Luan Barber? O horário será liberado imediatamente.',
        confirmText: 'Sim, cancelar meu agendamento',
        danger: true
      });
      if (!confirmed) return;

      try {
        const res = await ApiClient.post(`/api/public/appointments/${state.token}/cancel`, {});
        UI.toast(res.message, 'success');
        document.getElementById('reschedule-panel').classList.add('hidden');
        await loadAppointmentDetails();
      } catch (err) {
        UI.toast(err.message || 'Não foi possível cancelar.', 'error');
        await loadAppointmentDetails();
      }
    });
  }

  function showFatalError(msg) {
    const errBox = document.getElementById('manage-error-box');
    errBox.textContent = msg;
    errBox.classList.remove('hidden');
    document.getElementById('manage-content-box').classList.add('hidden');
  }

  async function loadAppointmentDetails() {
    try {
      const data = await ApiClient.get(`/api/public/appointments/${state.token}`);
      state.appointment = data.appointment;
      state.activeServices = data.active_services || [];
      state.selectedServiceIds = new Set(
        (state.appointment.items || []).map((i) => i.service_id).filter(Boolean)
      );

      document.getElementById('manage-error-box').classList.add('hidden');
      document.getElementById('manage-content-box').classList.remove('hidden');
      renderAppointmentCard();
    } catch (err) {
      showFatalError(err.message || 'Agendamento não encontrado.');
    }
  }

  function renderAppointmentCard() {
    const app = state.appointment;
    if (!app) return;

    const statusBadgeBox = document.getElementById('manage-status-badge');
    if (app.status === 'confirmado') {
      statusBadgeBox.innerHTML = `<span class="badge badge-green">Confirmado</span>`;
    } else if (app.status === 'concluido') {
      statusBadgeBox.innerHTML = `<span class="badge badge-blue">Atendimento Concluído</span>`;
    } else {
      statusBadgeBox.innerHTML = `<span class="badge badge-red">Cancelado</span>`;
    }

    const itemsHtml = (app.items || [])
      .map(
        (item) => `
        <div class="flex-between" style="padding: 6px 10px; background: var(--bg-surface); border-radius: var(--radius-sm); border: 1px solid var(--border-gray);">
          <span>${UI.escapeHtml(item.service_name)} (${item.duration} min)</span>
          <strong>${UI.formatBRL(item.price)}</strong>
        </div>
      `
      )
      .join('');

    document.getElementById('manage-details-list').innerHTML = `
      <div class="flex-between" style="padding-bottom: 6px; border-bottom: 1px solid var(--border-gray);">
        <span class="text-muted">Cliente:</span>
        <strong>${UI.escapeHtml(app.client_name)}</strong>
      </div>
      <div class="flex-between" style="padding-bottom: 6px; border-bottom: 1px solid var(--border-gray);">
        <span class="text-muted">WhatsApp:</span>
        <strong>${UI.escapeHtml(app.client_phone_formatted)}</strong>
      </div>
      <div class="flex-between" style="padding-bottom: 6px; border-bottom: 1px solid var(--border-gray);">
        <span class="text-muted">Data:</span>
        <strong>${UI.escapeHtml(app.dayName)}, ${UI.escapeHtml(app.dateBR)}</strong>
      </div>
      <div class="flex-between" style="padding-bottom: 6px; border-bottom: 1px solid var(--border-gray);">
        <span class="text-muted">Horário:</span>
        <strong>${UI.escapeHtml(app.start_time)} às ${UI.escapeHtml(app.end_time)} (${app.total_duration} min)</strong>
      </div>
      <div>
        <div class="text-muted" style="margin-bottom: 6px;">Serviços contratados:</div>
        <div style="display: grid; gap: 6px;">${itemsHtml}</div>
      </div>
      <div class="flex-between" style="padding-top: 8px; border-top: 1px solid var(--border-gray); font-size: 1.15rem;">
        <span>Valor Total:</span>
        <strong style="color: var(--green-text);">${UI.escapeHtml(app.total_price_formatted)}</strong>
      </div>
    `;

    const warning2h = document.getElementById('manage-2h-warning');
    const actionsBar = document.getElementById('manage-actions-bar');

    if (app.status !== 'confirmado') {
      warning2h.classList.add('hidden');
      actionsBar.classList.add('hidden');
    } else if (!app.can_client_modify) {
      warning2h.classList.remove('hidden');
      actionsBar.classList.add('hidden');
    } else {
      warning2h.classList.add('hidden');
      actionsBar.classList.remove('hidden');
    }
  }

  function renderRescheduleServices() {
    const container = document.getElementById('reschedule-services-list');
    container.innerHTML = state.activeServices
      .map((s) => {
        const isSel = state.selectedServiceIds.has(s.id);
        return `
          <div class="service-item ${isSel ? 'selected' : ''}" data-id="${s.id}" style="padding: 10px 12px;">
            <div class="service-check">${isSel ? '✓' : ''}</div>
            <div class="service-info">
              <div class="service-name">${UI.escapeHtml(s.name)}</div>
            </div>
            <div class="service-price-box">
              <div class="service-price">${UI.escapeHtml(s.price_formatted)}</div>
              <div class="service-duration">30 min</div>
            </div>
          </div>
        `;
      })
      .join('');

    container.querySelectorAll('.service-item').forEach((item) => {
      item.addEventListener('click', async () => {
        const id = item.getAttribute('data-id');
        if (state.selectedServiceIds.has(id)) {
          if (state.selectedServiceIds.size > 1) {
            state.selectedServiceIds.delete(id);
          }
        } else {
          state.selectedServiceIds.add(id);
        }
        state.selectedTime = null;
        renderRescheduleServices();
        await loadRescheduleAvailability();
      });
    });
  }

  async function loadRescheduleAvailability() {
    const duration = Math.max(30, state.selectedServiceIds.size * 30);
    try {
      const data = await ApiClient.get(
        `/api/public/schedule?week_start=${encodeURIComponent(state.weekStart)}&duration=${duration}&exclude_appointment_id=${encodeURIComponent(state.appointment.id)}`
      );
      state.availability = data;
      if (!state.selectedDate && data.days && data.days.length) {
        const firstWork = data.days.find((d) => d.is_working && d.available_slots.length > 0) || data.days[0];
        state.selectedDate = firstWork.work_date;
      }
      renderRescheduleDaysAndSlots();
    } catch (err) {
      UI.toast(err.message, 'error');
    }
  }

  function renderRescheduleDaysAndSlots() {
    const strip = document.getElementById('reschedule-days-strip');
    const slotsBox = document.getElementById('reschedule-slots-grid');
    const avail = state.availability;

    if (!avail || avail.situation === 'nao_publicada') {
      strip.innerHTML = '';
      slotsBox.innerHTML = `<div class="alert alert-yellow">Aguarde a confirmação dos dias e horários disponíveis para esta semana.</div>`;
      return;
    }

    strip.innerHTML = avail.days
      .map((d) => {
        const isSel = d.work_date === state.selectedDate;
        const disabled = !d.is_working;
        return `
          <div class="day-pill ${isSel ? 'active' : ''} ${disabled ? 'disabled' : ''}" data-date="${d.work_date}">
            <span class="day-pill-name">${UI.escapeHtml(d.dayShortName)}</span>
            <span class="day-pill-date">${UI.escapeHtml(d.dateBR.slice(0, 5))}</span>
            <span class="day-pill-slots">${d.is_working ? `${d.available_slots.length} livres` : 'Fechado'}</span>
          </div>
        `;
      })
      .join('');

    strip.querySelectorAll('.day-pill').forEach((pill) => {
      pill.addEventListener('click', () => {
        const dt = pill.getAttribute('data-date');
        const dayObj = avail.days.find((d) => d.work_date === dt);
        if (!dayObj || !dayObj.is_working) return;
        state.selectedDate = dt;
        state.selectedTime = null;
        renderRescheduleDaysAndSlots();
      });
    });

    const dayObj = avail.days.find((d) => d.work_date === state.selectedDate);
    if (!dayObj || !dayObj.is_working || dayObj.available_slots.length === 0) {
      slotsBox.innerHTML = `<p class="text-muted">Nenhum horário compatível disponível neste dia.</p>`;
      return;
    }

    slotsBox.innerHTML = `
      <div class="slots-grid">
        ${dayObj.available_slots
          .map(
            (slot) => `
          <button type="button" class="slot-btn ${state.selectedTime === slot.start_time ? 'selected' : ''}" data-time="${slot.start_time}">
            ${UI.escapeHtml(slot.start_time)}
          </button>
        `
          )
          .join('')}
      </div>
    `;

    slotsBox.querySelectorAll('.slot-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.selectedTime = btn.getAttribute('data-time');
        renderRescheduleDaysAndSlots();
      });
    });
  }

  async function submitReschedule() {
    if (!state.selectedDate || !state.selectedTime || state.selectedServiceIds.size === 0) {
      UI.toast('Selecione a data, o horário e pelo menos um serviço.', 'error');
      return;
    }

    const btn = document.getElementById('btn-save-reschedule');
    btn.disabled = true;

    try {
      const res = await ApiClient.put(`/api/public/appointments/${state.token}`, {
        appointment_date: state.selectedDate,
        start_time: state.selectedTime,
        service_ids: Array.from(state.selectedServiceIds)
      });
      UI.toast(res.message, 'success');
      document.getElementById('reschedule-panel').classList.add('hidden');
      await loadAppointmentDetails();
    } catch (err) {
      UI.toast(err.message || 'Erro ao alterar agendamento.', 'error');
      await loadAppointmentDetails();
    } finally {
      btn.disabled = false;
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();

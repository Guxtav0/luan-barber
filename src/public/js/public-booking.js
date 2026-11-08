(function () {
  const state = {
    weekStart: UI.getMondayISO(UI.getTodayISO()),
    services: [],
    selectedServiceIds: new Set(),
    scheduleAvailability: null,
    selectedDate: null,
    selectedSlot: null, // { start_time, end_time }
    confirmedAppointment: null
  };

  async function init() {
    UI.attachPhoneMask(document.getElementById('client-phone'));
    bindEvents();
    await loadPublicServices();
    await loadScheduleForWeek(state.weekStart);
  }

  function bindEvents() {
    document.getElementById('pub-prev-week').addEventListener('click', () => {
      loadScheduleForWeek(UI.addDaysISO(state.weekStart, -7));
    });
    document.getElementById('pub-curr-week').addEventListener('click', () => {
      loadScheduleForWeek(UI.getMondayISO(UI.getTodayISO()));
    });
    document.getElementById('pub-next-week').addEventListener('click', () => {
      loadScheduleForWeek(UI.addDaysISO(state.weekStart, 7));
    });

    document.getElementById('client-name').addEventListener('input', renderSummarySection);
    document.getElementById('client-phone').addEventListener('input', renderSummarySection);

    document.getElementById('btn-confirm-booking').addEventListener('click', submitBooking);

    document.getElementById('btn-open-waitlist-closed').addEventListener('click', openWaitlistModal);
    document.getElementById('btn-open-waitlist-inline').addEventListener('click', openWaitlistModal);

    document.getElementById('btn-copy-manage-link').addEventListener('click', () => {
      const inp = document.getElementById('success-manage-link-input');
      inp.select();
      navigator.clipboard?.writeText(inp.value);
      UI.toast('Link copiado para a área de transferência!', 'success');
    });

    document.getElementById('btn-new-booking-reset').addEventListener('click', () => {
      state.confirmedAppointment = null;
      state.selectedSlot = null;
      state.selectedServiceIds.clear();
      document.getElementById('booking-success-card').classList.add('hidden');
      renderServicesList();
      loadScheduleForWeek(state.weekStart);
    });

    // Atualiza disponibilidade automaticamente quando o usuário volta da aba do Admin para a aba pública
    window.addEventListener('focus', () => {
      if (!state.confirmedAppointment) {
        loadScheduleForWeek(state.weekStart, true, true);
      }
    });
  }

  async function loadPublicServices() {
    try {
      const data = await ApiClient.get('/api/public/services');
      state.services = data.services || [];
      renderServicesList();
    } catch (err) {
      UI.toast(err.message || 'Erro ao carregar serviços.', 'error');
    }
  }

  function getSelectedTotals() {
    const selected = state.services.filter((s) => state.selectedServiceIds.has(s.id));
    const totalDuration = Math.max(30, selected.length * 30);
    const totalPrice = selected.reduce((sum, s) => sum + Number(s.price || 0), 0);
    return { selected, totalDuration, totalPrice };
  }

  function renderServicesList() {
    const container = document.getElementById('public-services-list');
    const { selected, totalDuration, totalPrice } = getSelectedTotals();

    const badge = document.getElementById('services-totals-badge');
    if (selected.length > 0) {
      badge.className = 'badge badge-green';
      badge.textContent = `${selected.length} serviço(s) • ${totalDuration} min • ${UI.formatBRL(totalPrice)}`;
    } else {
      badge.className = 'badge badge-yellow';
      badge.textContent = 'Clique nos serviços desejados';
    }

    const hint = document.getElementById('slot-duration-hint');
    if (hint) {
      hint.textContent =
        selected.length > 0
          ? `Exibindo horários com ${totalDuration} minutos consecutivos disponíveis para ${selected.length} serviço(s).`
          : 'Exibindo blocos de 30 minutos disponíveis. Selecione os serviços acima.';
    }

    if (state.services.length === 0) {
      container.innerHTML = `<p class="text-muted">Nenhum serviço ativo disponível no momento.</p>`;
      return;
    }

    container.innerHTML = state.services
      .map((svc) => {
        const isSelected = state.selectedServiceIds.has(svc.id);
        return `
          <div
            class="service-item ${isSelected ? 'selected' : ''}"
            data-service-id="${svc.id}"
            role="button"
            tabindex="0"
            style="${isSelected ? 'border: 2px solid var(--green-action); background: rgba(22, 163, 74, 0.1);' : ''}"
          >
            <div class="service-check">${isSelected ? '✓' : ''}</div>
            <div class="service-info">
              <div class="flex-gap">
                <span class="service-name">${UI.escapeHtml(svc.name)}</span>
                ${
                  isSelected
                    ? '<span class="badge badge-green" style="font-size: 0.7rem;">Selecionado</span>'
                    : ''
                }
              </div>
              ${
                svc.description
                  ? `<div class="service-desc">${UI.escapeHtml(svc.description)}</div>`
                  : ''
              }
            </div>
            <div class="service-price-box">
              <div class="service-price">${UI.escapeHtml(svc.price_formatted)}</div>
              <div class="service-duration">30 min</div>
            </div>
          </div>
        `;
      })
      .join('');

    container.querySelectorAll('.service-item').forEach((item) => {
      item.addEventListener('click', () => {
        const id = item.getAttribute('data-service-id');
        if (state.selectedServiceIds.has(id)) {
          state.selectedServiceIds.delete(id);
        } else {
          state.selectedServiceIds.add(id);
        }

        // Recalcula os horários compatíveis localmente em memória (0ms, sem fetch de rede!)
        recalculateSlotsInMemory();
        renderServicesList();
        renderDaysStrip();
        renderSlotsForSelectedDay();
        renderSummarySection();
      });
    });
  }

  function recalculateSlotsInMemory() {
    if (!state.scheduleAvailability || !Array.isArray(state.scheduleAvailability.days)) return;
    const { totalDuration } = getSelectedTotals();

    for (const day of state.scheduleAvailability.days) {
      day.available_slots = UI.computeAvailableSlotsForDay(day, totalDuration);
    }

    // Se já havia um horário selecionado, verifica se ele continua válido para a nova duração
    if (state.selectedDate && state.selectedSlot) {
      const currentDay = state.scheduleAvailability.days.find(
        (d) => d.work_date === state.selectedDate
      );
      const matchingSlot = currentDay?.available_slots?.find(
        (s) => s.start_time === state.selectedSlot.start_time
      );
      if (matchingSlot) {
        state.selectedSlot = {
          start_time: matchingSlot.start_time,
          end_time: matchingSlot.end_time
        };
      } else {
        state.selectedSlot = null;
      }
    }
  }

  async function loadScheduleForWeek(
    weekStart,
    preserveSelectedDate = false,
    silent = false
  ) {
    try {
      const normalized = UI.getMondayISO(weekStart);
      state.weekStart = normalized;
      if (!preserveSelectedDate) {
        state.selectedDate = null;
        state.selectedSlot = null;
      }

      const { totalDuration } = getSelectedTotals();
      const data = await ApiClient.get(
        `/api/public/schedule?week_start=${encodeURIComponent(normalized)}&duration=${totalDuration}`
      );
      state.scheduleAvailability = data;
      recalculateSlotsInMemory();

      document.getElementById('public-week-label').textContent =
        `${UI.formatDateBR(data.week_start)} a ${UI.formatDateBR(data.week_end)}`;

      renderSituationView();
    } catch (err) {
      if (!silent) {
        UI.toast(err.message || 'Erro ao consultar disponibilidade da agenda.', 'error');
      }
    }
  }

  function renderSituationView() {
    const unpubCard = document.getElementById('situation-unpublished');
    const closedCard = document.getElementById('situation-closed');
    const flowBox = document.getElementById('situation-booking-flow');
    const successCard = document.getElementById('booking-success-card');

    if (state.confirmedAppointment) {
      unpubCard.classList.add('hidden');
      closedCard.classList.add('hidden');
      flowBox.classList.add('hidden');
      successCard.classList.remove('hidden');
      return;
    }

    successCard.classList.add('hidden');
    const avail = state.scheduleAvailability;
    if (!avail) return;

    // Situação 1 — Agenda não publicada
    if (avail.situation === 'nao_publicada') {
      unpubCard.classList.remove('hidden');
      closedCard.classList.add('hidden');
      flowBox.classList.add('hidden');
      return;
    }

    // Situação 3 — Agenda publicada, mas completamente ocupada
    if (avail.situation === 'fechada') {
      unpubCard.classList.add('hidden');
      closedCard.classList.remove('hidden');
      flowBox.classList.add('hidden');
      return;
    }

    // Situação 2 — Agenda publicada com horários disponíveis
    unpubCard.classList.add('hidden');
    closedCard.classList.add('hidden');
    flowBox.classList.remove('hidden');

    if (!state.selectedDate) {
      const firstWithSlots =
        avail.days.find((d) => d.is_working && d.available_slots.length > 0) ||
        avail.days.find((d) => d.is_working) ||
        avail.days[0];
      if (firstWithSlots) {
        state.selectedDate = firstWithSlots.work_date;
      }
    }

    renderDaysStrip();
    renderSlotsForSelectedDay();
    renderSummarySection();
  }

  function renderDaysStrip() {
    const strip = document.getElementById('public-days-strip');
    const days = state.scheduleAvailability?.days || [];

    strip.innerHTML = days
      .map((day) => {
        const isSelected = day.work_date === state.selectedDate;
        const disabled = !day.is_working;
        const count = day.available_slots.length;
        return `
          <div class="day-pill ${isSelected ? 'active' : ''} ${disabled ? 'disabled' : ''}" data-date="${day.work_date}">
            <span class="day-pill-name">${UI.escapeHtml(day.dayShortName)}</span>
            <span class="day-pill-date">${UI.escapeHtml(day.dateBR.slice(0, 5))}</span>
            <span class="day-pill-slots">
              ${!day.is_working ? 'Fechado' : count > 0 ? `${count} livres` : 'Esgotado'}
            </span>
          </div>
        `;
      })
      .join('');

    strip.querySelectorAll('.day-pill').forEach((pill) => {
      pill.addEventListener('click', () => {
        const dt = pill.getAttribute('data-date');
        const dayObj = days.find((d) => d.work_date === dt);
        if (!dayObj || !dayObj.is_working) return;
        state.selectedDate = dt;
        state.selectedSlot = null;
        renderDaysStrip();
        renderSlotsForSelectedDay();
        renderSummarySection();
      });
    });
  }

  function renderSlotsForSelectedDay() {
    const container = document.getElementById('public-slots-container');
    const days = state.scheduleAvailability?.days || [];
    const dayObj = days.find((d) => d.work_date === state.selectedDate);

    if (!dayObj || !dayObj.is_working) {
      container.innerHTML = `<p class="text-muted">O Luan não trabalha neste dia. Selecione um dos dias habilitados acima.</p>`;
      return;
    }

    const slots = dayObj.available_slots || [];
    if (slots.length === 0) {
      state.selectedSlot = null;
      container.innerHTML = `
        <div style="padding: 16px; text-align: center; color: var(--text-gray); background: var(--bg-surface); border-radius: var(--radius-md); border: 1px solid var(--border-gray);">
          Não há horários consecutivos disponíveis em <strong>${UI.escapeHtml(dayObj.dayName)} (${UI.escapeHtml(dayObj.dateBR)})</strong> para a duração selecionada. Escolha outro dia acima ou entre na lista de espera abaixo.
        </div>
      `;
      return;
    }

    // Pré-seleciona automaticamente o primeiro horário liberado do dia
    if (
      !state.selectedSlot ||
      !slots.some((s) => s.start_time === state.selectedSlot.start_time)
    ) {
      state.selectedSlot = {
        start_time: slots[0].start_time,
        end_time: slots[0].end_time
      };
    }

    container.innerHTML = `
      <div style="margin-bottom: 10px; font-size: 0.85rem; color: var(--text-gray);">
        Horários livres em <strong style="color: var(--text-white);">${UI.escapeHtml(dayObj.dayName)} (${UI.escapeHtml(dayObj.dateBR)})</strong> — Expediente das ${UI.escapeHtml(dayObj.start_time)} às ${UI.escapeHtml(dayObj.end_time)}:
      </div>
      <div class="slots-grid">
        ${slots
          .map((slot) => {
            const isSel =
              state.selectedSlot && state.selectedSlot.start_time === slot.start_time;
            return `
              <button type="button" class="slot-btn ${isSel ? 'selected' : ''}" data-start="${slot.start_time}" data-end="${slot.end_time}">
                ${UI.escapeHtml(slot.start_time)}
              </button>
            `;
          })
          .join('')}
      </div>
    `;

    container.querySelectorAll('.slot-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.selectedSlot = {
          start_time: btn.getAttribute('data-start'),
          end_time: btn.getAttribute('data-end')
        };
        renderSlotsForSelectedDay();
        renderSummarySection();
      });
    });
  }

  function renderSummarySection() {
    const detailsBox = document.getElementById('booking-summary-details');
    if (!detailsBox) return;

    const { selected, totalDuration, totalPrice } = getSelectedTotals();
    const nameVal = document.getElementById('client-name').value.trim();
    const phoneVal = document.getElementById('client-phone').value.trim();
    const days = state.scheduleAvailability?.days || [];
    const dayObj = days.find((d) => d.work_date === state.selectedDate);

    detailsBox.innerHTML = `
      <div class="flex-between" style="padding-bottom: 6px; border-bottom: 1px solid var(--border-gray);">
        <span class="text-muted">Cliente:</span>
        <strong style="color: ${nameVal ? 'var(--text-white)' : 'var(--yellow-text)'};">
          ${UI.escapeHtml(nameVal || 'Preencha seu nome no Passo 1')}
        </strong>
      </div>
      <div class="flex-between" style="padding-bottom: 6px; border-bottom: 1px solid var(--border-gray);">
        <span class="text-muted">WhatsApp:</span>
        <strong>${UI.escapeHtml(phoneVal || 'Não informado (opcional)')}</strong>
      </div>
      <div class="flex-between" style="padding-bottom: 6px; border-bottom: 1px solid var(--border-gray);">
        <span class="text-muted">Serviços:</span>
        <strong style="color: ${selected.length ? 'var(--text-white)' : 'var(--yellow-text)'};">
          ${UI.escapeHtml(selected.length ? selected.map((s) => s.name).join(', ') : 'Selecione no Passo 2')}
        </strong>
      </div>
      <div class="flex-between" style="padding-bottom: 6px; border-bottom: 1px solid var(--border-gray);">
        <span class="text-muted">Data:</span>
        <strong>${UI.escapeHtml(dayObj ? `${dayObj.dayName}, ${dayObj.dateBR}` : state.selectedDate ? UI.formatDateBR(state.selectedDate) : 'Selecione no Passo 3')}</strong>
      </div>
      <div class="flex-between" style="padding-bottom: 6px; border-bottom: 1px solid var(--border-gray);">
        <span class="text-muted">Horário:</span>
        <strong style="color: ${state.selectedSlot ? 'var(--text-white)' : 'var(--yellow-text)'};">
          ${state.selectedSlot ? `${UI.escapeHtml(state.selectedSlot.start_time)} às ${UI.escapeHtml(state.selectedSlot.end_time)}` : 'Selecione um horário no Passo 3'}
        </strong>
      </div>
      <div class="flex-between" style="padding-bottom: 6px; border-bottom: 1px solid var(--border-gray);">
        <span class="text-muted">Duração total:</span>
        <strong>${selected.length ? `${totalDuration} minutos` : '—'}</strong>
      </div>
      <div class="flex-between" style="padding-top: 4px; font-size: 1.15rem;">
        <span>Valor total:</span>
        <strong style="color: var(--green-text);">${UI.formatBRL(totalPrice)}</strong>
      </div>
    `;
  }

  async function submitBooking() {
    const name = document.getElementById('client-name').value.trim();
    const phone = document.getElementById('client-phone').value.trim();
    const serviceIds = Array.from(state.selectedServiceIds);

    if (!name || name.length < 2) {
      UI.toast('Por favor, informe seu nome no Passo 1.', 'error');
      document.getElementById('client-name').focus();
      return;
    }
    if (serviceIds.length === 0) {
      UI.toast('Por favor, clique em pelo menos um serviço no Passo 2.', 'error');
      document.getElementById('public-services-list').scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (!state.selectedDate || !state.selectedSlot) {
      UI.toast('Por favor, clique em um horário disponível no Passo 3.', 'error');
      document.getElementById('public-slots-container').scrollIntoView({ behavior: 'smooth' });
      return;
    }

    const btn = document.getElementById('btn-confirm-booking');
    btn.disabled = true;
    btn.textContent = 'Confirmando agendamento...';

    try {
      const res = await ApiClient.post('/api/public/appointments', {
        client_name: name,
        client_phone: phone,
        appointment_date: state.selectedDate,
        start_time: state.selectedSlot.start_time,
        service_ids: serviceIds
      });

      state.confirmedAppointment = res.appointment;
      showSuccessScreen(res.appointment);
      UI.toast(res.message, 'success');
    } catch (err) {
      UI.toast(err.message || 'Não foi possível concluir o agendamento.', 'error');
      state.selectedSlot = null;
      await loadScheduleForWeek(state.weekStart, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Confirmar agendamento';
    }
  }

  function showSuccessScreen(app) {
    const fullManageUrl = `${window.location.origin}${app.management_url}`;
    document.getElementById('success-manage-link-input').value = fullManageUrl;
    document.getElementById('btn-go-manage-link').href = app.management_url;

    document.getElementById('success-appointment-summary').innerHTML = `
      <div><strong>Cliente:</strong> ${UI.escapeHtml(app.client_name)} (${UI.escapeHtml(app.client_phone_formatted)})</div>
      <div><strong>Serviços:</strong> ${UI.escapeHtml(app.services_summary)}</div>
      <div><strong>Data e Horário:</strong> ${UI.escapeHtml(app.dayName)}, ${UI.escapeHtml(app.dateBR)} — ${UI.escapeHtml(app.start_time)} às ${UI.escapeHtml(app.end_time)} (${app.total_duration} min)</div>
      <div><strong>Valor Total:</strong> ${UI.escapeHtml(app.total_price_formatted)}</div>
    `;

    renderSituationView();
  }

  // ==================== MODAL LISTA DE ESPERA ====================
  function openWaitlistModal() {
    const root = document.getElementById('waitlist-modal-root');
    const prefillName = document.getElementById('client-name')?.value || '';
    const prefillPhone = document.getElementById('client-phone')?.value || '';
    const days = state.scheduleAvailability?.days || [];

    const servicesHtml = state.services
      .map((s) => {
        const checked = state.selectedServiceIds.has(s.id);
        return `
          <label class="toggle-switch" style="display:flex; justify-content:space-between; padding: 8px 10px; background: var(--bg-surface); border: 1px solid var(--border-gray); border-radius: var(--radius-sm);">
            <span>
              <input type="checkbox" class="wl-service-cb" value="${s.id}" ${checked ? 'checked' : ''} />
              <span style="margin-left: 6px;">${UI.escapeHtml(s.name)}</span>
            </span>
            <span class="text-muted">${UI.escapeHtml(s.price_formatted)}</span>
          </label>
        `;
      })
      .join('');

    const daysHtml = days
      .map(
        (d) => `
        <label class="toggle-switch" style="padding: 6px 10px; background: var(--bg-surface); border: 1px solid var(--border-gray); border-radius: var(--radius-sm); font-size: 0.85rem;">
          <input type="checkbox" class="wl-day-cb" value="${d.work_date}" />
          <span>${UI.escapeHtml(d.dayShortName)} (${UI.escapeHtml(d.dateBR.slice(0, 5))})</span>
        </label>
      `
      )
      .join('');

    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal-content">
          <div class="modal-header">
            <h3 class="modal-title">Entrar na Lista de Espera</h3>
            <button type="button" class="btn btn-sm btn-outline" id="wl-modal-close">✕</button>
          </div>

          <form id="wl-form">
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Seu Nome *</label>
                <input type="text" id="wl-name" class="form-control" value="${UI.escapeHtml(prefillName)}" required />
              </div>
              <div class="form-group">
                <label class="form-label">Seu WhatsApp (opcional)</label>
                <input type="tel" id="wl-phone" class="form-control" value="${UI.escapeHtml(prefillPhone)}" />
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">Serviços desejados</label>
              <div style="display: grid; gap: 6px;">
                ${servicesHtml}
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">Dias de preferência</label>
              <div class="flex-gap">
                ${daysHtml}
              </div>
            </div>

            <div class="form-group">
              <label class="form-label">Períodos de preferência</label>
              <div class="flex-gap">
                <label class="toggle-switch" style="padding: 6px 12px; background: var(--bg-surface); border: 1px solid var(--border-gray); border-radius: var(--radius-sm);">
                  <input type="checkbox" class="wl-period-cb" value="manha" checked />
                  <span>Manhã</span>
                </label>
                <label class="toggle-switch" style="padding: 6px 12px; background: var(--bg-surface); border: 1px solid var(--border-gray); border-radius: var(--radius-sm);">
                  <input type="checkbox" class="wl-period-cb" value="tarde" checked />
                  <span>Tarde</span>
                </label>
                <label class="toggle-switch" style="padding: 6px 12px; background: var(--bg-surface); border: 1px solid var(--border-gray); border-radius: var(--radius-sm);">
                  <input type="checkbox" class="wl-period-cb" value="noite" checked />
                  <span>Noite</span>
                </label>
              </div>
            </div>

            <div class="modal-footer">
              <button type="button" class="btn btn-outline" id="wl-modal-cancel">Cancelar</button>
              <button type="submit" class="btn btn-green" id="wl-submit-btn">Entrar na Lista de Espera</button>
            </div>
          </form>
        </div>
      </div>
    `;

    UI.attachPhoneMask(document.getElementById('wl-phone'));

    const closeModal = () => {
      root.innerHTML = '';
    };
    document.getElementById('wl-modal-close').addEventListener('click', closeModal);
    document.getElementById('wl-modal-cancel').addEventListener('click', closeModal);

    document.getElementById('wl-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const serviceIds = Array.from(root.querySelectorAll('.wl-service-cb:checked')).map(
        (cb) => cb.value
      );
      const preferredDays = Array.from(root.querySelectorAll('.wl-day-cb:checked')).map(
        (cb) => cb.value
      );
      const preferredPeriods = Array.from(root.querySelectorAll('.wl-period-cb:checked')).map(
        (cb) => cb.value
      );

      if (serviceIds.length === 0) {
        UI.toast('Selecione pelo menos um serviço desejado.', 'error');
        return;
      }

      const btn = document.getElementById('wl-submit-btn');
      btn.disabled = true;

      try {
        const res = await ApiClient.post('/api/public/waitlist', {
          week_start: state.weekStart,
          name: document.getElementById('wl-name').value.trim(),
          phone: document.getElementById('wl-phone').value.trim(),
          service_ids: serviceIds,
          preferred_days: preferredDays,
          preferred_periods: preferredPeriods
        });
        UI.toast(res.message, 'success');
        closeModal();
      } catch (err) {
        UI.toast(err.message || 'Erro ao registrar na lista de espera.', 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();

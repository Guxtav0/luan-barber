const UI = {
  escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  formatBRL(value) {
    return Number(value || 0).toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    });
  },

  formatDateBR(isoDate) {
    if (!isoDate || typeof isoDate !== 'string') return '';
    const parts = isoDate.split('-');
    if (parts.length !== 3) return isoDate;
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  },

  formatPhoneValue(val) {
    const digits = String(val || '').replace(/\D/g, '').slice(0, 11);
    if (digits.length === 0) return '';
    if (digits.length <= 2) return `(${digits}`;
    if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
    if (digits.length <= 10) {
      return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
    }
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  },

  attachPhoneMask(inputEl) {
    if (!inputEl) return;
    inputEl.addEventListener('input', (e) => {
      e.target.value = this.formatPhoneValue(e.target.value);
    });
  },

  getTodayISO() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  },

  getMondayISO(dateStr) {
    const base = dateStr ? new Date(`${dateStr}T12:00:00`) : new Date();
    const day = base.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    base.setDate(base.getDate() + diff);
    const y = base.getFullYear();
    const m = String(base.getMonth() + 1).padStart(2, '0');
    const d = String(base.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  },

  addDaysISO(dateStr, days) {
    const dt = new Date(`${dateStr}T12:00:00`);
    dt.setDate(dt.getDate() + days);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  },

  timeToMinutes(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') return 0;
    const [h, m] = timeStr.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  },

  minutesToTime(totalMinutes) {
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  },

  getTimeOptions30Min() {
    const options = [];
    for (let h = 6; h <= 23; h++) {
      const hh = String(h).padStart(2, '0');
      options.push(`${hh}:00`);
      options.push(`${hh}:30`);
    }
    return options;
  },

  /**
   * Gera todos os blocos de 30 minutos do expediente do dia, começando exatamente
   * em `dayConfig.start_time` até `dayConfig.end_time` (descontando intervalos).
   */
  generateDayWorkBlocks(dayConfig) {
    if (!dayConfig || !dayConfig.is_working) return [];
    const startMin = this.timeToMinutes(dayConfig.start_time);
    const endMin = this.timeToMinutes(dayConfig.end_time);
    if (endMin <= startMin) return [];

    const breaks = Array.isArray(dayConfig.breaks) ? dayConfig.breaks : [];
    const parsedBreaks = breaks
      .filter((b) => b && b.start && b.end)
      .map((b) => ({
        start: this.timeToMinutes(b.start),
        end: this.timeToMinutes(b.end)
      }));

    const blocks = [];
    for (let t = startMin; t + 30 <= endMin; t += 30) {
      const bStart = t;
      const bEnd = t + 30;
      const inBreak = parsedBreaks.some((brk) => bStart < brk.end && bEnd > brk.start);
      if (!inBreak) {
        blocks.push(this.minutesToTime(bStart));
      }
    }
    return blocks;
  },

  /**
   * Calcula no navegador os horários iniciais disponíveis para `requiredDurationMinutes` (30, 60, 90...)
   * sem precisar fazer requisição de rede ao trocar os serviços selecionados.
   */
  computeAvailableSlotsForDay(dayConfig, requiredDurationMinutes = 30) {
    if (!dayConfig || !dayConfig.is_working) return [];
    const duration = Math.max(30, Number(requiredDurationMinutes) || 30);
    const blocksNeeded = Math.ceil(duration / 30);
    const baseBlocks = this.generateDayWorkBlocks(dayConfig);
    const baseSet = new Set(baseBlocks);

    const occupied = (dayConfig.occupied_ranges || []).map((occ) => ({
      start: this.timeToMinutes(occ.start_time),
      end: this.timeToMinutes(occ.end_time)
    }));

    const slots = [];
    for (const candidate of baseBlocks) {
      const startMin = this.timeToMinutes(candidate);
      let ok = true;
      for (let i = 0; i < blocksNeeded; i++) {
        const subStart = startMin + i * 30;
        const subEnd = subStart + 30;
        const subTime = this.minutesToTime(subStart);
        if (!baseSet.has(subTime)) {
          ok = false;
          break;
        }
        if (occupied.some((o) => subStart < o.end && subEnd > o.start)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        slots.push({
          start_time: candidate,
          end_time: this.minutesToTime(startMin + duration)
        });
      }
    }
    return slots;
  },

  toast(message, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }

    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `
      <span>${this.escapeHtml(message)}</span>
      <button type="button" class="btn btn-sm btn-outline" style="padding:2px 7px;">✕</button>
    `;
    el.querySelector('button').addEventListener('click', () => el.remove());
    container.appendChild(el);

    setTimeout(() => {
      if (el.parentNode) el.remove();
    }, 4500);
  },

  confirm({
    title = 'Confirmar ação',
    message = 'Tem certeza que deseja continuar?',
    confirmText = 'Confirmar',
    cancelText = 'Voltar',
    danger = true
  } = {}) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `
        <div class="modal-content" role="dialog" aria-modal="true">
          <div class="modal-header">
            <h3 class="modal-title">${this.escapeHtml(title)}</h3>
          </div>
          <p style="color: var(--text-light); font-size: 0.95rem;">${this.escapeHtml(message)}</p>
          <div class="modal-footer">
            <button type="button" class="btn btn-outline" id="confirm-cancel-btn">${this.escapeHtml(cancelText)}</button>
            <button type="button" class="btn ${danger ? 'btn-red' : 'btn-green'}" id="confirm-ok-btn">${this.escapeHtml(confirmText)}</button>
          </div>
        </div>
      `;

      const cleanup = (result) => {
        backdrop.remove();
        resolve(result);
      };

      backdrop.querySelector('#confirm-cancel-btn').addEventListener('click', () => cleanup(false));
      backdrop.querySelector('#confirm-ok-btn').addEventListener('click', () => cleanup(true));
      document.body.appendChild(backdrop);
    });
  }
};

window.UI = UI;

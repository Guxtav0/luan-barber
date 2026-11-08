const { getConfig } = require('../config');
const { hashPassword, generateUUID } = require('../utils/auth');

/**
 * Adaptador oficial para Supabase (PostgreSQL via PostgREST + RPC + Supabase Auth).
 * Utiliza as tabelas e a função RPC `book_appointment_atomic` definidas em
 * `supabase/migrations/001_initial_schema.sql`.
 */
class SupabaseAdapter {
  constructor() {
    const config = getConfig();
    // Aceita tanto https://xyz.supabase.co quanto https://xyz.supabase.co/rest/v1/
    this.url = config.supabase.url
      .trim()
      .replace(/\/rest\/v1\/?$/i, '')
      .replace(/\/$/, '');
    this.apiKey = config.supabase.serviceRoleKey || config.supabase.anonKey;
    this.anonKey = config.supabase.anonKey || this.apiKey;
    this._lockPromise = Promise.resolve();
    this._seeded = false;
  }

  async _ensureSeeded() {
    if (this._seeded) return;
    this._seeded = true;
    try {
      const config = getConfig();
      const admins = await this._rest('admins?select=id&limit=1');
      if (!admins || admins.length === 0) {
        await this._rest('admins', {
          method: 'POST',
          body: {
            name: config.auth.adminDefaultName,
            email: config.auth.adminDefaultEmail.toLowerCase(),
            password_hash: hashPassword(config.auth.adminDefaultPassword)
          }
        });
      }
    } catch {
      // Se a tabela ainda não foi criada ou sem permissão, não bloqueia o boot
      this._seeded = false;
    }
  }

  async _withLock(fn) {
    const prev = this._lockPromise;
    let release;
    this._lockPromise = new Promise((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async _rest(endpoint, { method = 'GET', body = null, headers = {} } = {}) {
    const res = await fetch(`${this.url}/rest/v1/${endpoint}`, {
      method,
      headers: {
        apikey: this.apiKey,
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...headers
      },
      body: body !== null ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Supabase REST error (${res.status}): ${errText}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async authenticateWithSupabaseAuth(email, password) {
    const res = await fetch(`${this.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        apikey: this.anonKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email, password })
    });
    if (!res.ok) return null;
    return res.json();
  }

  async findAdminByEmail(email) {
    await this._ensureSeeded();
    const rows = await this._rest(
      `admins?email=ilike.${encodeURIComponent(String(email || '').trim())}&limit=1`
    );
    return rows && rows[0] ? rows[0] : null;
  }

  async findAdminById(id) {
    const rows = await this._rest(`admins?id=eq.${encodeURIComponent(id)}&limit=1`);
    return rows && rows[0] ? rows[0] : null;
  }

  // ==================== SERVICES ====================
  async listServices({ activeOnly = false } = {}) {
    const filter = activeOnly ? 'active=eq.true&' : '';
    const rows = await this._rest(`services?${filter}order=sort_order.asc,created_at.asc`);
    return (rows || []).map((r) => ({
      ...r,
      price: Number(r.price),
      duration: Number(r.duration || 30),
      active: Boolean(r.active)
    }));
  }

  async getServiceById(id) {
    const rows = await this._rest(`services?id=eq.${encodeURIComponent(id)}&limit=1`);
    if (!rows || !rows[0]) return null;
    const r = rows[0];
    return { ...r, price: Number(r.price), duration: Number(r.duration || 30), active: Boolean(r.active) };
  }

  async getServicesByIds(ids = []) {
    if (!ids.length) return [];
    const inList = ids.map((x) => `"${x}"`).join(',');
    const rows = await this._rest(`services?id=in.(${encodeURIComponent(inList)})&order=sort_order.asc`);
    return (rows || []).map((r) => ({
      ...r,
      price: Number(r.price),
      duration: Number(r.duration || 30),
      active: Boolean(r.active)
    }));
  }

  async createService({ name, description = '', price, active = true }) {
    const rows = await this._rest('services', {
      method: 'POST',
      body: {
        name: name.trim(),
        description: description.trim(),
        price: Number(price),
        duration: 30,
        active: Boolean(active)
      }
    });
    return this.getServiceById(rows[0].id);
  }

  async updateService(id, { name, description, price, active }) {
    const patch = { updated_at: new Date().toISOString() };
    if (name !== undefined) patch.name = String(name).trim();
    if (description !== undefined) patch.description = String(description).trim();
    if (price !== undefined) patch.price = Number(price);
    if (active !== undefined) patch.active = Boolean(active);

    await this._rest(`services?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch
    });
    return this.getServiceById(id);
  }

  async deleteService(id) {
    await this._rest(`services?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    return true;
  }

  // ==================== SCHEDULE ====================
  async getWeeklyScheduleRecord(weekStart) {
    const weeks = await this._rest(
      `weekly_schedules?week_start=eq.${encodeURIComponent(weekStart)}&limit=1`
    );
    if (!weeks || !weeks[0]) return null;
    const week = weeks[0];
    const days = await this._rest(
      `schedule_days?weekly_schedule_id=eq.${encodeURIComponent(week.id)}&order=work_date.asc`
    );
    return {
      ...week,
      days: (days || []).map((d) => ({
        ...d,
        day_of_week: Number(d.day_of_week),
        is_working: Boolean(d.is_working),
        breaks: Array.isArray(d.breaks) ? d.breaks : []
      }))
    };
  }

  async getScheduleDayByDate(workDate) {
    const rows = await this._rest(
      `schedule_days?work_date=eq.${encodeURIComponent(workDate)}&limit=1`
    );
    if (!rows || !rows[0]) return null;
    const d = rows[0];
    return {
      ...d,
      day_of_week: Number(d.day_of_week),
      is_working: Boolean(d.is_working),
      breaks: Array.isArray(d.breaks) ? d.breaks : []
    };
  }

  async upsertWeeklySchedule(weekStart, status, daysArray, publishedAt = null) {
    const now = new Date().toISOString();
    let existing = await this.getWeeklyScheduleRecord(weekStart);
    let weekId;
    if (!existing) {
      const created = await this._rest('weekly_schedules', {
        method: 'POST',
        body: { week_start: weekStart, status, published_at: publishedAt, updated_at: now }
      });
      weekId = created[0].id;
    } else {
      weekId = existing.id;
      await this._rest(`weekly_schedules?id=eq.${encodeURIComponent(weekId)}`, {
        method: 'PATCH',
        body: {
          status,
          published_at: publishedAt !== null ? publishedAt : existing.published_at,
          updated_at: now
        }
      });
    }

    for (const day of daysArray) {
      const existingDay = await this.getScheduleDayByDate(day.work_date);
      const payload = {
        weekly_schedule_id: weekId,
        work_date: day.work_date,
        day_of_week: day.day_of_week,
        is_working: Boolean(day.is_working),
        start_time: day.start_time || '09:00',
        end_time: day.end_time || '18:00',
        breaks: Array.isArray(day.breaks) ? day.breaks : [],
        status,
        published_at: publishedAt !== null ? publishedAt : existingDay?.published_at || null,
        updated_at: now
      };
      if (!existingDay) {
        await this._rest('schedule_days', { method: 'POST', body: payload });
      } else {
        await this._rest(`schedule_days?id=eq.${encodeURIComponent(existingDay.id)}`, {
          method: 'PATCH',
          body: payload
        });
      }
    }
    return this.getWeeklyScheduleRecord(weekStart);
  }

  // ==================== APPOINTMENTS ====================
  async getAppointmentById(id) {
    const rows = await this._rest(
      `appointments?id=eq.${encodeURIComponent(id)}&select=*,items:appointment_items(*)&limit=1`
    );
    if (!rows || !rows[0]) return null;
    const r = rows[0];
    return {
      ...r,
      total_duration: Number(r.total_duration),
      total_price: Number(r.total_price),
      items: (r.items || []).map((i) => ({ ...i, price: Number(i.price), duration: Number(i.duration || 30) }))
    };
  }

  async getAppointmentByToken(token) {
    if (!token) return null;
    const rows = await this._rest(
      `appointments?management_token=eq.${encodeURIComponent(String(token).trim())}&select=*,items:appointment_items(*)&limit=1`
    );
    if (!rows || !rows[0]) return null;
    const r = rows[0];
    return {
      ...r,
      total_duration: Number(r.total_duration),
      total_price: Number(r.total_price),
      items: (r.items || []).map((i) => ({ ...i, price: Number(i.price), duration: Number(i.duration || 30) }))
    };
  }

  async listAppointments({ startDate, endDate, date, status, paymentStatus } = {}) {
    const q = ['select=*,items:appointment_items(*)'];
    if (date) q.push(`appointment_date=eq.${encodeURIComponent(date)}`);
    if (startDate) q.push(`appointment_date=gte.${encodeURIComponent(startDate)}`);
    if (endDate) q.push(`appointment_date=lte.${encodeURIComponent(endDate)}`);
    if (status) q.push(`status=eq.${encodeURIComponent(status)}`);
    if (paymentStatus) q.push(`payment_status=eq.${encodeURIComponent(paymentStatus)}`);
    q.push('order=appointment_date.asc,start_time.asc');

    const rows = await this._rest(`appointments?${q.join('&')}`);
    return (rows || []).map((r) => ({
      ...r,
      total_duration: Number(r.total_duration),
      total_price: Number(r.total_price),
      items: (r.items || []).map((i) => ({ ...i, price: Number(i.price), duration: Number(i.duration || 30) }))
    }));
  }

  async createAppointmentAtomic({
    clientName,
    clientPhone,
    appointmentDate,
    startTime,
    endTime,
    totalDuration,
    totalPrice,
    managementToken,
    items,
    isAdmin = false
  }) {
    const rpcResult = await this._rest('rpc/book_appointment_atomic', {
      method: 'POST',
      body: {
        p_client_name: clientName,
        p_client_phone: clientPhone || '',
        p_appointment_date: appointmentDate,
        p_start_time: startTime,
        p_end_time: endTime,
        p_total_duration: totalDuration,
        p_total_price: totalPrice,
        p_management_token: managementToken,
        p_items: items,
        p_is_admin: isAdmin
      }
    });
    return this.getAppointmentById(rpcResult.appointment_id);
  }

  async updateAppointmentAtomic(appointmentId, updateEvaluatorFn) {
    return this._withLock(async () => {
      const existing = await this.getAppointmentById(appointmentId);
      if (!existing) return null;

      const dayConfigs = new Map();
      const activeByDate = new Map();

      const preloadDate = async (dt) => {
        if (!dayConfigs.has(dt)) {
          dayConfigs.set(dt, await this.getScheduleDayByDate(dt));
        }
        if (!activeByDate.has(dt)) {
          const all = await this.listAppointments({ date: dt });
          activeByDate.set(
            dt,
            all.filter((a) => a.status !== 'cancelado' && a.id !== appointmentId)
          );
        }
      };

      await preloadDate(existing.appointment_date);

      const nextData = updateEvaluatorFn(existing, {
        getDayConfig: (dt) => dayConfigs.get(dt) || null,
        getActiveAppointmentsOnDate: (dt) => activeByDate.get(dt) || []
      });

      const now = new Date().toISOString();
      await this._rest(`appointments?id=eq.${encodeURIComponent(appointmentId)}`, {
        method: 'PATCH',
        body: {
          client_name: nextData.client_name,
          client_phone: nextData.client_phone,
          appointment_date: nextData.appointment_date,
          start_time: nextData.start_time,
          end_time: nextData.end_time,
          total_duration: nextData.total_duration,
          total_price: nextData.total_price,
          status: nextData.status,
          payment_status: nextData.payment_status,
          notes: nextData.notes ?? existing.notes ?? '',
          cancelled_by: nextData.cancelled_by ?? existing.cancelled_by ?? null,
          cancelled_at: nextData.cancelled_at ?? existing.cancelled_at ?? null,
          completed_at: nextData.completed_at ?? existing.completed_at ?? null,
          paid_at: nextData.paid_at ?? existing.paid_at ?? null,
          updated_at: now
        }
      });

      if (Array.isArray(nextData.newItems)) {
        await this._rest(
          `appointment_items?appointment_id=eq.${encodeURIComponent(appointmentId)}`,
          { method: 'DELETE' }
        );
        for (const item of nextData.newItems) {
          await this._rest('appointment_items', {
            method: 'POST',
            body: {
              appointment_id: appointmentId,
              service_id: item.service_id || null,
              service_name: item.service_name,
              price: Number(item.price),
              duration: Number(item.duration || 30)
            }
          });
        }
      }

      return this.getAppointmentById(appointmentId);
    });
  }

  // ==================== WAITLIST ====================
  async createWaitlistEntry({
    weekStart,
    name,
    phone,
    desiredServices,
    preferredDays,
    preferredPeriods
  }) {
    const rows = await this._rest('waitlist', {
      method: 'POST',
      body: {
        week_start: weekStart || null,
        name,
        phone: phone || '',
        desired_services: desiredServices || [],
        preferred_days: preferredDays || [],
        preferred_periods: preferredPeriods || [],
        status: 'aguardando',
        matched_opportunity: false,
        matched_details: ''
      }
    });
    return rows[0];
  }

  async listWaitlist({ status } = {}) {
    const q = ['order=matched_opportunity.desc,created_at.asc'];
    if (status) q.push(`status=eq.${encodeURIComponent(status)}`);
    return (await this._rest(`waitlist?${q.join('&')}`)) || [];
  }

  async getWaitlistById(id) {
    const rows = await this._rest(`waitlist?id=eq.${encodeURIComponent(id)}&limit=1`);
    return rows && rows[0] ? rows[0] : null;
  }

  async updateWaitlistEntry(id, { status, matchedOpportunity, matchedDetails }) {
    const patch = { updated_at: new Date().toISOString() };
    if (status !== undefined) patch.status = status;
    if (matchedOpportunity !== undefined) patch.matched_opportunity = Boolean(matchedOpportunity);
    if (matchedDetails !== undefined) patch.matched_details = matchedDetails;
    const rows = await this._rest(`waitlist?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch
    });
    return rows && rows[0] ? rows[0] : null;
  }

  async deleteWaitlistEntry(id) {
    await this._rest(`waitlist?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    return true;
  }

  // ==================== NOTIFICATIONS ====================
  async getNotificationByEventKey(eventKey) {
    if (!eventKey) return null;
    const rows = await this._rest(
      `notifications?event_key=eq.${encodeURIComponent(eventKey)}&limit=1`
    );
    return rows && rows[0] ? rows[0] : null;
  }

  async getNotificationById(id) {
    const rows = await this._rest(`notifications?id=eq.${encodeURIComponent(id)}&limit=1`);
    return rows && rows[0] ? rows[0] : null;
  }

  async createNotification({ eventKey, type, recipient, content, status = 'pendente' }) {
    if (eventKey) {
      const existing = await this.getNotificationByEventKey(eventKey);
      if (existing) return { notification: existing, alreadyExisted: true };
    }
    const rows = await this._rest('notifications', {
      method: 'POST',
      body: {
        id: generateUUID(),
        event_key: eventKey || null,
        type,
        recipient,
        content,
        status,
        attempts: 0
      }
    });
    return { notification: rows[0], alreadyExisted: false };
  }

  async updateNotification(id, { status, attempts, error, sentAt }) {
    const patch = {};
    if (status !== undefined) patch.status = status;
    if (attempts !== undefined) patch.attempts = attempts;
    if (error !== undefined) patch.error = error;
    if (sentAt !== undefined) patch.sent_at = sentAt;
    const rows = await this._rest(`notifications?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch
    });
    return rows && rows[0] ? rows[0] : null;
  }

  async listNotifications(limit = 50) {
    return (
      (await this._rest(`notifications?order=created_at.desc&limit=${Number(limit || 50)}`)) || []
    );
  }
}

module.exports = { SupabaseAdapter };

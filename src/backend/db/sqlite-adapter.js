const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { getConfig } = require('../config');
const { hashPassword, generateUUID } = require('../utils/auth');

class SqliteAdapter {
  constructor(customDbPath = null) {
    const config = getConfig();
    this.dbPath = customDbPath || config.sqliteDbPath;
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.initSchema();
  }

  initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS admins (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS clients (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);

      CREATE TABLE IF NOT EXISTS services (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        price REAL NOT NULL,
        duration INTEGER NOT NULL DEFAULT 30,
        active INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS weekly_schedules (
        id TEXT PRIMARY KEY,
        week_start TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'rascunho',
        published_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS schedule_days (
        id TEXT PRIMARY KEY,
        weekly_schedule_id TEXT NOT NULL REFERENCES weekly_schedules(id) ON DELETE CASCADE,
        work_date TEXT NOT NULL UNIQUE,
        day_of_week INTEGER NOT NULL,
        is_working INTEGER NOT NULL DEFAULT 0,
        start_time TEXT NOT NULL DEFAULT '09:00',
        end_time TEXT NOT NULL DEFAULT '18:00',
        breaks TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'rascunho',
        published_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_schedule_days_date ON schedule_days(work_date);

      CREATE TABLE IF NOT EXISTS appointments (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
        client_name TEXT NOT NULL,
        client_phone TEXT NOT NULL,
        appointment_date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        total_duration INTEGER NOT NULL,
        total_price REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'confirmado',
        payment_status TEXT NOT NULL DEFAULT 'pendente',
        management_token TEXT NOT NULL UNIQUE,
        notes TEXT DEFAULT '',
        cancelled_by TEXT,
        cancelled_at TEXT,
        completed_at TEXT,
        paid_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_appointments_date_status ON appointments(appointment_date, status);
      CREATE INDEX IF NOT EXISTS idx_appointments_token ON appointments(management_token);
      CREATE INDEX IF NOT EXISTS idx_appointments_client ON appointments(client_id);

      CREATE TABLE IF NOT EXISTS appointment_items (
        id TEXT PRIMARY KEY,
        appointment_id TEXT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
        service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
        service_name TEXT NOT NULL,
        price REAL NOT NULL,
        duration INTEGER NOT NULL DEFAULT 30,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_appointment_items_app ON appointment_items(appointment_id);

      CREATE TABLE IF NOT EXISTS waitlist (
        id TEXT PRIMARY KEY,
        week_start TEXT,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        desired_services TEXT NOT NULL DEFAULT '[]',
        preferred_days TEXT NOT NULL DEFAULT '[]',
        preferred_periods TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'aguardando',
        matched_opportunity INTEGER NOT NULL DEFAULT 0,
        matched_details TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_waitlist_status ON waitlist(status);

      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        event_key TEXT UNIQUE,
        type TEXT NOT NULL,
        recipient TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pendente',
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        sent_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status);
    `);

    this.seedDefaults();
  }

  seedDefaults() {
    const config = getConfig();
    const now = new Date().toISOString();

    // Seed Admin padrão se não existir
    const adminCount = this.db.prepare('SELECT COUNT(*) as cnt FROM admins').get().cnt;
    if (adminCount === 0) {
      this.db
        .prepare(
          'INSERT INTO admins (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(
          generateUUID(),
          config.auth.adminDefaultName,
          config.auth.adminDefaultEmail.toLowerCase(),
          hashPassword(config.auth.adminDefaultPassword),
          now
        );
    }

    // Seed Serviços iniciais editáveis se não existirem
    const serviceCount = this.db.prepare('SELECT COUNT(*) as cnt FROM services').get().cnt;
    if (serviceCount === 0) {
      const initialServices = [
        {
          name: 'Corte tradicional',
          description: 'Corte clássico na tesoura ou máquina com acabamento completo.',
          price: 35.0,
          sort_order: 1
        },
        {
          name: 'Degradê',
          description: 'Corte degradê (fade) navalhado ou disfarçado com acabamento na navalha.',
          price: 40.0,
          sort_order: 2
        },
        {
          name: 'Barba',
          description: 'Modelagem e alinhamento de barba com toalha quente e navalha.',
          price: 25.0,
          sort_order: 3
        },
        {
          name: 'Corte + barba',
          description: 'Combo promocional de corte tradicional mais alinhamento de barba.',
          price: 55.0,
          sort_order: 4
        }
      ];

      const insertSvc = this.db.prepare(`
        INSERT INTO services (id, name, description, price, duration, active, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, 30, 1, ?, ?, ?)
      `);
      for (const s of initialServices) {
        insertSvc.run(generateUUID(), s.name, s.description, s.price, s.sort_order, now, now);
      }
    }
  }

  runInTransaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore rollback error if already rolled back
      }
      throw err;
    }
  }

  // ==================== ADMIN ====================
  async findAdminByEmail(email) {
    const row = this.db
      .prepare('SELECT * FROM admins WHERE lower(email) = lower(?) LIMIT 1')
      .get(String(email || '').trim());
    return row || null;
  }

  async findAdminById(id) {
    const row = this.db.prepare('SELECT * FROM admins WHERE id = ? LIMIT 1').get(id);
    return row || null;
  }

  // ==================== SERVICES ====================
  _mapService(row) {
    if (!row) return null;
    return {
      ...row,
      price: Number(row.price),
      duration: Number(row.duration || 30),
      active: Boolean(row.active)
    };
  }

  async listServices({ activeOnly = false } = {}) {
    const sql = activeOnly
      ? 'SELECT * FROM services WHERE active = 1 ORDER BY sort_order ASC, created_at ASC'
      : 'SELECT * FROM services ORDER BY sort_order ASC, created_at ASC';
    return this.db.prepare(sql).all().map((r) => this._mapService(r));
  }

  async getServiceById(id) {
    const row = this.db.prepare('SELECT * FROM services WHERE id = ?').get(id);
    return this._mapService(row);
  }

  async getServicesByIds(ids = []) {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM services WHERE id IN (${placeholders}) ORDER BY sort_order ASC`)
      .all(...ids);
    return rows.map((r) => this._mapService(r));
  }

  async createService({ name, description = '', price, active = true }) {
    const id = generateUUID();
    const now = new Date().toISOString();
    const maxSort = this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM services').get().m;
    this.db
      .prepare(`
        INSERT INTO services (id, name, description, price, duration, active, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, 30, ?, ?, ?, ?)
      `)
      .run(id, name.trim(), description.trim(), Number(price), active ? 1 : 0, maxSort + 1, now, now);
    return this.getServiceById(id);
  }

  async updateService(id, { name, description, price, active }) {
    const current = await this.getServiceById(id);
    if (!current) return null;
    const now = new Date().toISOString();
    const nextName = name !== undefined ? String(name).trim() : current.name;
    const nextDesc = description !== undefined ? String(description).trim() : current.description;
    const nextPrice = price !== undefined ? Number(price) : current.price;
    const nextActive = active !== undefined ? (active ? 1 : 0) : (current.active ? 1 : 0);

    this.db
      .prepare(`
        UPDATE services
        SET name = ?, description = ?, price = ?, active = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(nextName, nextDesc, nextPrice, nextActive, now, id);
    return this.getServiceById(id);
  }

  async deleteService(id) {
    const current = await this.getServiceById(id);
    if (!current) return false;
    this.db.prepare('DELETE FROM services WHERE id = ?').run(id);
    return true;
  }

  async reorderServices(orderedIds = []) {
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return this.listServices({ activeOnly: false });
    }
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      'UPDATE services SET sort_order = ?, updated_at = ? WHERE id = ?'
    );
    this.runInTransaction(() => {
      orderedIds.forEach((id, idx) => {
        stmt.run(idx + 1, now, id);
      });
    });
    return this.listServices({ activeOnly: false });
  }

  // ==================== SCHEDULE ====================
  _mapScheduleDay(row) {
    if (!row) return null;
    let breaks = [];
    try {
      breaks = typeof row.breaks === 'string' ? JSON.parse(row.breaks) : row.breaks || [];
    } catch {
      breaks = [];
    }
    return {
      ...row,
      day_of_week: Number(row.day_of_week),
      is_working: Boolean(row.is_working),
      breaks
    };
  }

  async getWeeklyScheduleRecord(weekStart) {
    const week = this.db
      .prepare('SELECT * FROM weekly_schedules WHERE week_start = ?')
      .get(weekStart);
    if (!week) return null;
    const days = this.db
      .prepare('SELECT * FROM schedule_days WHERE weekly_schedule_id = ? ORDER BY work_date ASC')
      .all(week.id)
      .map((d) => this._mapScheduleDay(d));
    return { ...week, days };
  }

  async getScheduleDayByDate(workDate) {
    const row = this.db.prepare('SELECT * FROM schedule_days WHERE work_date = ?').get(workDate);
    return this._mapScheduleDay(row);
  }

  async upsertWeeklySchedule(weekStart, status, daysArray, publishedAt = null) {
    const now = new Date().toISOString();
    return this.runInTransaction(() => {
      let week = this.db
        .prepare('SELECT * FROM weekly_schedules WHERE week_start = ?')
        .get(weekStart);
      if (!week) {
        const weekId = generateUUID();
        this.db
          .prepare(`
            INSERT INTO weekly_schedules (id, week_start, status, published_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `)
          .run(weekId, weekStart, status, publishedAt, now, now);
        week = { id: weekId, week_start: weekStart, status, published_at: publishedAt };
      } else {
        const nextPub = publishedAt !== null ? publishedAt : week.published_at;
        this.db
          .prepare(`
            UPDATE weekly_schedules
            SET status = ?, published_at = ?, updated_at = ?
            WHERE id = ?
          `)
          .run(status, nextPub, now, week.id);
      }

      for (const day of daysArray) {
        const existingDay = this.db
          .prepare('SELECT * FROM schedule_days WHERE work_date = ?')
          .get(day.work_date);
        const breaksJson = JSON.stringify(Array.isArray(day.breaks) ? day.breaks : []);
        const isWorkingInt = day.is_working ? 1 : 0;

        if (!existingDay) {
          this.db
            .prepare(`
              INSERT INTO schedule_days (
                id, weekly_schedule_id, work_date, day_of_week, is_working,
                start_time, end_time, breaks, status, published_at, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .run(
              generateUUID(),
              week.id,
              day.work_date,
              day.day_of_week,
              isWorkingInt,
              day.start_time || '09:00',
              day.end_time || '18:00',
              breaksJson,
              status,
              publishedAt,
              now,
              now
            );
        } else {
          this.db
            .prepare(`
              UPDATE schedule_days
              SET weekly_schedule_id = ?,
                  day_of_week = ?,
                  is_working = ?,
                  start_time = ?,
                  end_time = ?,
                  breaks = ?,
                  status = ?,
                  published_at = COALESCE(?, published_at),
                  updated_at = ?
              WHERE id = ?
            `)
            .run(
              week.id,
              day.day_of_week,
              isWorkingInt,
              day.start_time || '09:00',
              day.end_time || '18:00',
              breaksJson,
              status,
              publishedAt,
              now,
              existingDay.id
            );
        }
      }

      return this.getWeeklyScheduleRecord(weekStart);
    });
  }

  // ==================== APPOINTMENTS ====================
  _hydrateAppointments(rows) {
    if (!rows || !rows.length) return [];
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const items = this.db
      .prepare(
        `SELECT * FROM appointment_items WHERE appointment_id IN (${placeholders}) ORDER BY created_at ASC`
      )
      .all(...ids);

    const itemsByApp = new Map();
    for (const item of items) {
      const list = itemsByApp.get(item.appointment_id) || [];
      list.push({
        ...item,
        price: Number(item.price),
        duration: Number(item.duration || 30)
      });
      itemsByApp.set(item.appointment_id, list);
    }

    return rows.map((row) => ({
      ...row,
      total_duration: Number(row.total_duration),
      total_price: Number(row.total_price),
      items: itemsByApp.get(row.id) || []
    }));
  }

  async getAppointmentById(id) {
    const row = this.db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
    if (!row) return null;
    return this._hydrateAppointments([row])[0];
  }

  async getAppointmentByToken(token) {
    if (!token) return null;
    const row = this.db
      .prepare('SELECT * FROM appointments WHERE management_token = ?')
      .get(String(token).trim());
    if (!row) return null;
    return this._hydrateAppointments([row])[0];
  }

  async listAppointments({ startDate, endDate, date, status, paymentStatus } = {}) {
    const clauses = [];
    const params = [];

    if (date) {
      clauses.push('appointment_date = ?');
      params.push(date);
    }
    if (startDate) {
      clauses.push('appointment_date >= ?');
      params.push(startDate);
    }
    if (endDate) {
      clauses.push('appointment_date <= ?');
      params.push(endDate);
    }
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    if (paymentStatus) {
      clauses.push('payment_status = ?');
      params.push(paymentStatus);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM appointments ${where} ORDER BY appointment_date ASC, start_time ASC`
      )
      .all(...params);
    return this._hydrateAppointments(rows);
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
    isAdmin = false,
    notes = '',
    validateSlotFn
  }) {
    const now = new Date().toISOString();
    return this.runInTransaction(() => {
      const dayRow = this.db
        .prepare('SELECT * FROM schedule_days WHERE work_date = ?')
        .get(appointmentDate);
      const dayConfig = this._mapScheduleDay(dayRow);

      const activeOnDay = this.db
        .prepare("SELECT * FROM appointments WHERE appointment_date = ? AND status != 'cancelado'")
        .all(appointmentDate);

      // Executa validação atômica dentro da transação exclusiva
      validateSlotFn(dayConfig, activeOnDay);

      // Localiza ou cria cliente (se telefone foi informado, busca por telefone; senão busca por nome sem telefone)
      let client = null;
      if (clientPhone) {
        client = this.db
          .prepare('SELECT * FROM clients WHERE phone = ? LIMIT 1')
          .get(clientPhone);
      } else {
        client = this.db
          .prepare("SELECT * FROM clients WHERE lower(name) = lower(?) AND (phone = '' OR phone IS NULL) LIMIT 1")
          .get(clientName);
      }

      if (!client) {
        const clientId = generateUUID();
        this.db
          .prepare('INSERT INTO clients (id, name, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(clientId, clientName, clientPhone || '', now, now);
        client = { id: clientId, name: clientName, phone: clientPhone || '' };
      } else if (client.name !== clientName) {
        this.db
          .prepare('UPDATE clients SET name = ?, updated_at = ? WHERE id = ?')
          .run(clientName, now, client.id);
      }

      const appointmentId = generateUUID();
      this.db
        .prepare(`
          INSERT INTO appointments (
            id, client_id, client_name, client_phone,
            appointment_date, start_time, end_time,
            total_duration, total_price,
            status, payment_status, management_token, notes,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmado', 'pendente', ?, ?, ?, ?)
        `)
        .run(
          appointmentId,
          client.id,
          clientName,
          clientPhone,
          appointmentDate,
          startTime,
          endTime,
          totalDuration,
          totalPrice,
          managementToken,
          notes || '',
          now,
          now
        );

      const insertItem = this.db.prepare(`
        INSERT INTO appointment_items (id, appointment_id, service_id, service_name, price, duration, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of items) {
        insertItem.run(
          generateUUID(),
          appointmentId,
          item.service_id || null,
          item.service_name,
          Number(item.price),
          Number(item.duration || 30),
          now
        );
      }

      const row = this.db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointmentId);
      return this._hydrateAppointments([row])[0];
    });
  }

  async updateAppointmentAtomic(appointmentId, updateEvaluatorFn) {
    const now = new Date().toISOString();
    return this.runInTransaction(() => {
      const existingRow = this.db
        .prepare('SELECT * FROM appointments WHERE id = ?')
        .get(appointmentId);
      if (!existingRow) return null;
      const existing = this._hydrateAppointments([existingRow])[0];

      const nextData = updateEvaluatorFn(existing, {
        getDayConfig: (dt) => {
          const r = this.db.prepare('SELECT * FROM schedule_days WHERE work_date = ?').get(dt);
          return this._mapScheduleDay(r);
        },
        getActiveAppointmentsOnDate: (dt) =>
          this.db
            .prepare(
              "SELECT * FROM appointments WHERE appointment_date = ? AND status != 'cancelado' AND id != ?"
            )
            .all(dt, appointmentId)
      });

      // Atualiza cliente se nome ou telefone mudaram
      if (
        nextData.client_name !== existing.client_name ||
        nextData.client_phone !== existing.client_phone
      ) {
        this.db
          .prepare('UPDATE clients SET name = ?, phone = ?, updated_at = ? WHERE id = ?')
          .run(nextData.client_name, nextData.client_phone, now, existing.client_id);
      }

      this.db
        .prepare(`
          UPDATE appointments
          SET client_name = ?,
              client_phone = ?,
              appointment_date = ?,
              start_time = ?,
              end_time = ?,
              total_duration = ?,
              total_price = ?,
              status = ?,
              payment_status = ?,
              notes = ?,
              cancelled_by = ?,
              cancelled_at = ?,
              completed_at = ?,
              paid_at = ?,
              updated_at = ?
          WHERE id = ?
        `)
        .run(
          nextData.client_name,
          nextData.client_phone,
          nextData.appointment_date,
          nextData.start_time,
          nextData.end_time,
          nextData.total_duration,
          nextData.total_price,
          nextData.status,
          nextData.payment_status,
          nextData.notes ?? existing.notes ?? '',
          nextData.cancelled_by ?? existing.cancelled_by ?? null,
          nextData.cancelled_at ?? existing.cancelled_at ?? null,
          nextData.completed_at ?? existing.completed_at ?? null,
          nextData.paid_at ?? existing.paid_at ?? null,
          now,
          appointmentId
        );

      if (Array.isArray(nextData.newItems)) {
        this.db
          .prepare('DELETE FROM appointment_items WHERE appointment_id = ?')
          .run(appointmentId);
        const insertItem = this.db.prepare(`
          INSERT INTO appointment_items (id, appointment_id, service_id, service_name, price, duration, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const item of nextData.newItems) {
          insertItem.run(
            generateUUID(),
            appointmentId,
            item.service_id || null,
            item.service_name,
            Number(item.price),
            Number(item.duration || 30),
            now
          );
        }
      }

      const updatedRow = this.db
        .prepare('SELECT * FROM appointments WHERE id = ?')
        .get(appointmentId);
      return this._hydrateAppointments([updatedRow])[0];
    });
  }

  // ==================== WAITLIST ====================
  _mapWaitlist(row) {
    if (!row) return null;
    const parseJson = (val) => {
      try {
        return typeof val === 'string' ? JSON.parse(val) : val || [];
      } catch {
        return [];
      }
    };
    return {
      ...row,
      desired_services: parseJson(row.desired_services),
      preferred_days: parseJson(row.preferred_days),
      preferred_periods: parseJson(row.preferred_periods),
      matched_opportunity: Boolean(row.matched_opportunity)
    };
  }

  async createWaitlistEntry({
    weekStart,
    name,
    phone,
    desiredServices,
    preferredDays,
    preferredPeriods
  }) {
    const id = generateUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO waitlist (
          id, week_start, name, phone, desired_services, preferred_days, preferred_periods,
          status, matched_opportunity, matched_details, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'aguardando', 0, '', ?, ?)
      `)
      .run(
        id,
        weekStart || null,
        name,
        phone,
        JSON.stringify(desiredServices || []),
        JSON.stringify(preferredDays || []),
        JSON.stringify(preferredPeriods || []),
        now,
        now
      );
    const row = this.db.prepare('SELECT * FROM waitlist WHERE id = ?').get(id);
    return this._mapWaitlist(row);
  }

  async listWaitlist({ status, weekStart } = {}) {
    const clauses = [];
    const params = [];
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    if (weekStart) {
      clauses.push('(week_start = ? OR week_start IS NULL)');
      params.push(weekStart);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM waitlist ${where} ORDER BY matched_opportunity DESC, created_at ASC`
      )
      .all(...params);
    return rows.map((r) => this._mapWaitlist(r));
  }

  async getWaitlistById(id) {
    const row = this.db.prepare('SELECT * FROM waitlist WHERE id = ?').get(id);
    return this._mapWaitlist(row);
  }

  async updateWaitlistEntry(id, { status, matchedOpportunity, matchedDetails }) {
    const current = await this.getWaitlistById(id);
    if (!current) return null;
    const now = new Date().toISOString();
    const nextStatus = status !== undefined ? status : current.status;
    const nextMatch =
      matchedOpportunity !== undefined
        ? matchedOpportunity
          ? 1
          : 0
        : current.matched_opportunity
          ? 1
          : 0;
    const nextDetails =
      matchedDetails !== undefined ? matchedDetails : current.matched_details;

    this.db
      .prepare(`
        UPDATE waitlist
        SET status = ?, matched_opportunity = ?, matched_details = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(nextStatus, nextMatch, nextDetails, now, id);
    return this.getWaitlistById(id);
  }

  async deleteWaitlistEntry(id) {
    const current = await this.getWaitlistById(id);
    if (!current) return false;
    this.db.prepare('DELETE FROM waitlist WHERE id = ?').run(id);
    return true;
  }

  // ==================== NOTIFICATIONS ====================
  async getNotificationByEventKey(eventKey) {
    if (!eventKey) return null;
    const row = this.db
      .prepare('SELECT * FROM notifications WHERE event_key = ?')
      .get(eventKey);
    return row || null;
  }

  async getNotificationById(id) {
    const row = this.db.prepare('SELECT * FROM notifications WHERE id = ?').get(id);
    return row || null;
  }

  async createNotification({ eventKey, type, recipient, content, status = 'pendente' }) {
    if (eventKey) {
      const existing = await this.getNotificationByEventKey(eventKey);
      if (existing) return { notification: existing, alreadyExisted: true };
    }
    const id = generateUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO notifications (id, event_key, type, recipient, content, status, attempts, error, created_at, sent_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, NULL)
      `)
      .run(id, eventKey || null, type, recipient, content, status, now);
    const created = await this.getNotificationById(id);
    return { notification: created, alreadyExisted: false };
  }

  async updateNotification(id, { status, attempts, error, sentAt }) {
    const current = await this.getNotificationById(id);
    if (!current) return null;
    this.db
      .prepare(`
        UPDATE notifications
        SET status = ?,
            attempts = ?,
            error = ?,
            sent_at = ?
        WHERE id = ?
      `)
      .run(
        status ?? current.status,
        attempts ?? current.attempts,
        error !== undefined ? error : current.error,
        sentAt !== undefined ? sentAt : current.sent_at,
        id
      );
    return this.getNotificationById(id);
  }

  async listNotifications(limit = 50) {
    return this.db
      .prepare(
        "SELECT * FROM notifications WHERE event_key IS NULL OR event_key != '__system_settings__' ORDER BY created_at DESC LIMIT ?"
      )
      .all(Number(limit || 50));
  }

  async getSystemSettings() {
    const row = this.db
      .prepare("SELECT content FROM notifications WHERE event_key = '__system_settings__' LIMIT 1")
      .get();
    if (!row || !row.content) return {};
    try {
      return JSON.parse(row.content);
    } catch {
      return {};
    }
  }

  async saveSystemSettings(patch = {}) {
    const current = await this.getSystemSettings();
    const merged = { ...current, ...patch };
    const jsonStr = JSON.stringify(merged);
    const existing = this.db
      .prepare("SELECT id FROM notifications WHERE event_key = '__system_settings__' LIMIT 1")
      .get();
    if (existing) {
      this.db
        .prepare("UPDATE notifications SET content = ? WHERE id = ?")
        .run(jsonStr, existing.id);
    } else {
      const id = generateUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(`
          INSERT INTO notifications (id, event_key, type, recipient, content, status, attempts, error, created_at, sent_at)
          VALUES (?, '__system_settings__', 'publicacao_agenda', 'system', ?, 'enviada', 0, NULL, ?, ?)
        `)
        .run(id, jsonStr, now, now);
    }
    return merged;
  }
}

module.exports = { SqliteAdapter };

const { URL } = require('node:url');
const { getDb } = require('../db');
const { getConfig } = require('../config');
const {
  verifyPassword,
  signAdminToken,
  verifyAdminToken
} = require('../utils/auth');
const { getTodayISO, getMondayOfDate } = require('../utils/time');
const {
  getWeeklyScheduleForAdmin,
  saveWeeklySchedule,
  getPublicScheduleAvailability
} = require('../services/schedule-service');
const {
  createAppointment,
  getAppointmentByToken,
  cancelAppointmentByClientToken,
  updateAppointmentByClientToken,
  updateAppointmentByAdmin,
  listAppointmentsForAdmin
} = require('../services/appointment-service');
const {
  addClientToWaitlist,
  listWaitlistForAdmin,
  updateWaitlistStatus,
  removeWaitlistEntry
} = require('../services/waitlist-service');
const { getFinancialDashboard } = require('../services/finance-service');
const {
  listServices,
  createService,
  updateService,
  deleteService
} = require('../services/service-catalog');
const {
  getWhatsAppIntegrationStatus,
  attemptSendNotification
} = require('../services/whatsapp-service');

function sendJson(res, statusCode, data, extraHeaders = {}) {
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(payload);
}

function parseCookies(cookieHeader = '') {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = decodeURIComponent(part.slice(idx + 1).trim());
    out[k] = v;
  }
  return out;
}

function getAuthenticatedAdmin(req) {
  let token = null;
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.luan_admin_token) {
      token = cookies.luan_admin_token;
    }
  }
  if (!token) return null;
  return verifyAdminToken(token);
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Payload muito grande.'));
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        const err = new Error('JSON inválido no corpo da requisição.');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function handleApiRequest(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();

  try {
    // ========================================================================
    // 1. AUTENTICAÇÃO ADMINISTRATIVA
    // ========================================================================
    if (pathname === '/api/auth/login' && method === 'POST') {
      const body = await parseJsonBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');

      if (!email || !password) {
        return sendJson(res, 400, { error: 'Informe e-mail e senha.' });
      }

      const db = getDb();
      let admin = await db.findAdminByEmail(email);
      let authenticated = false;

      if (admin && admin.password_hash) {
        authenticated = verifyPassword(password, admin.password_hash);
      } else if (typeof db.authenticateWithSupabaseAuth === 'function') {
        const sbSession = await db.authenticateWithSupabaseAuth(email, password);
        if (sbSession && sbSession.user) {
          authenticated = true;
          admin = admin || {
            id: sbSession.user.id,
            name: sbSession.user.user_metadata?.name || 'Luan Barber',
            email: sbSession.user.email
          };
        }
      }

      if (!authenticated || !admin) {
        return sendJson(res, 401, { error: 'E-mail ou senha incorretos.' });
      }

      const token = signAdminToken({
        id: admin.id,
        name: admin.name,
        email: admin.email,
        role: 'admin'
      });

      return sendJson(
        res,
        200,
        {
          token,
          admin: {
            id: admin.id,
            name: admin.name,
            email: admin.email
          }
        },
        {
          'Set-Cookie': `luan_admin_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`
        }
      );
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      return sendJson(
        res,
        200,
        { ok: true },
        {
          'Set-Cookie': 'luan_admin_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
        }
      );
    }

    if (pathname === '/api/auth/me' && method === 'GET') {
      const admin = getAuthenticatedAdmin(req);
      if (!admin) {
        return sendJson(res, 401, { error: 'Não autenticado.' });
      }
      const config = getConfig();
      return sendJson(res, 200, {
        admin,
        integrations: {
          whatsapp: getWhatsAppIntegrationStatus(),
          database: {
            provider: config.supabase.isConfigured ? 'Supabase PostgreSQL' : 'SQLite Relacional Local (Fallback)',
            supabase_configured: config.supabase.isConfigured
          }
        }
      });
    }

    // ========================================================================
    // 2. ROTAS PÚBLICAS (ÁREA DO CLIENTE)
    // ========================================================================
    if (pathname === '/api/public/services' && method === 'GET') {
      const services = await listServices({ activeOnly: true });
      return sendJson(res, 200, { services });
    }

    if (pathname === '/api/public/schedule' && method === 'GET') {
      const weekStart = parsedUrl.searchParams.get('week_start') || getMondayOfDate(getTodayISO());
      const duration = Number(parsedUrl.searchParams.get('duration') || 30);
      const excludeId = parsedUrl.searchParams.get('exclude_appointment_id') || null;
      const availability = await getPublicScheduleAvailability({
        weekStart,
        durationMinutes: duration,
        excludeAppointmentId: excludeId
      });
      return sendJson(res, 200, availability);
    }

    if (pathname === '/api/public/appointments' && method === 'POST') {
      const body = await parseJsonBody(req);
      const appointment = await createAppointment({
        clientName: body.client_name || body.name,
        clientPhone: body.client_phone || body.phone,
        appointmentDate: body.appointment_date || body.date,
        startTime: body.start_time,
        serviceIds: body.service_ids || body.services,
        isAdmin: false
      });

      return sendJson(res, 201, {
        message: 'Agendamento realizado com sucesso! Esperamos você na Luan Barber.',
        appointment
      });
    }

    const publicTokenMatch = pathname.match(/^\/api\/public\/appointments\/([a-zA-Z0-9_-]+)(\/cancel)?$/);
    if (publicTokenMatch) {
      const token = publicTokenMatch[1];
      const isCancelAction = Boolean(publicTokenMatch[2]);

      if (!isCancelAction && method === 'GET') {
        const appointment = await getAppointmentByToken(token);
        const activeServices = await listServices({ activeOnly: true });
        return sendJson(res, 200, { appointment, active_services: activeServices });
      }

      if (!isCancelAction && method === 'PUT') {
        const body = await parseJsonBody(req);
        const updated = await updateAppointmentByClientToken(token, {
          appointmentDate: body.appointment_date || body.date,
          startTime: body.start_time,
          serviceIds: body.service_ids || body.services
        });
        return sendJson(res, 200, {
          message: 'Agendamento atualizado com sucesso!',
          appointment: updated
        });
      }

      if (isCancelAction && method === 'POST') {
        const result = await cancelAppointmentByClientToken(token);
        return sendJson(res, 200, {
          message: 'Agendamento cancelado com sucesso. O horário foi liberado na agenda.',
          appointment: result.appointment
        });
      }
    }

    if (pathname === '/api/public/waitlist' && method === 'POST') {
      const body = await parseJsonBody(req);
      const entry = await addClientToWaitlist({
        weekStart: body.week_start,
        name: body.name || body.client_name,
        phone: body.phone || body.client_phone,
        serviceIds: body.service_ids || body.services,
        preferredDays: body.preferred_days,
        preferredPeriods: body.preferred_periods
      });
      return sendJson(res, 201, {
        message: 'Você foi adicionado à lista de espera! Caso surja uma vaga compatível, o Luan entrará em contato pelo WhatsApp.',
        entry
      });
    }

    // ========================================================================
    // 3. ROTAS ADMINISTRATIVAS (PROTEGIDAS POR LOGIN DO LUAN)
    // ========================================================================
    if (pathname.startsWith('/api/admin/')) {
      const admin = getAuthenticatedAdmin(req);
      if (!admin) {
        return sendJson(res, 401, {
          error: 'Acesso restrito ao administrador. Faça login para continuar.'
        });
      }

      // --- ABA 1: AGENDA SEMANAL ---
      if (pathname === '/api/admin/schedule' && method === 'GET') {
        const weekStart =
          parsedUrl.searchParams.get('week_start') || getMondayOfDate(getTodayISO());
        const schedule = await getWeeklyScheduleForAdmin(weekStart);
        const appointments = await listAppointmentsForAdmin({
          startDate: schedule.week_start,
          endDate: schedule.week_end
        });
        const waitlist = await listWaitlistForAdmin({ status: 'aguardando' });
        return sendJson(res, 200, {
          schedule,
          appointments,
          waitlist
        });
      }

      if (pathname === '/api/admin/schedule/save' && method === 'POST') {
        const body = await parseJsonBody(req);
        const publish = Boolean(body.publish);
        const result = await saveWeeklySchedule({
          weekStart: body.week_start,
          days: body.days,
          publish
        });
        return sendJson(res, 200, {
          message: publish
            ? 'Sua agenda semanal foi publicada com sucesso e já está disponível para os clientes.'
            : 'Programação semanal salva como rascunho.',
          schedule: result
        });
      }

      // --- AGENDAMENTOS (ADMIN) ---
      if (pathname === '/api/admin/appointments' && method === 'GET') {
        const startDate = parsedUrl.searchParams.get('start_date') || undefined;
        const endDate = parsedUrl.searchParams.get('end_date') || undefined;
        const date = parsedUrl.searchParams.get('date') || undefined;
        const status = parsedUrl.searchParams.get('status') || undefined;
        const paymentStatus = parsedUrl.searchParams.get('payment_status') || undefined;
        const appointments = await listAppointmentsForAdmin({
          startDate,
          endDate,
          date,
          status,
          paymentStatus
        });
        return sendJson(res, 200, { appointments });
      }

      if (pathname === '/api/admin/appointments' && method === 'POST') {
        const body = await parseJsonBody(req);
        const appointment = await createAppointment({
          clientName: body.client_name || body.name,
          clientPhone: body.client_phone || body.phone,
          appointmentDate: body.appointment_date || body.date,
          startTime: body.start_time,
          serviceIds: body.service_ids || body.services,
          notes: body.notes || '',
          isAdmin: true
        });
        return sendJson(res, 201, {
          message: 'Agendamento registrado com sucesso!',
          appointment
        });
      }

      const adminAppMatch = pathname.match(/^\/api\/admin\/appointments\/([a-zA-Z0-9-]+)$/);
      if (adminAppMatch && method === 'PUT') {
        const appId = adminAppMatch[1];
        const body = await parseJsonBody(req);
        const result = await updateAppointmentByAdmin(appId, {
          clientName: body.client_name,
          clientPhone: body.client_phone,
          appointmentDate: body.appointment_date,
          startTime: body.start_time,
          serviceIds: body.service_ids,
          status: body.status,
          paymentStatus: body.payment_status,
          notes: body.notes
        });
        return sendJson(res, 200, {
          message: 'Agendamento atualizado com sucesso!',
          appointment: result.appointment,
          waitlist_matches: result.waitlist_matches
        });
      }

      // --- LISTA DE ESPERA (ADMIN) ---
      if (pathname === '/api/admin/waitlist' && method === 'GET') {
        const status = parsedUrl.searchParams.get('status') || undefined;
        const weekStart = parsedUrl.searchParams.get('week_start') || undefined;
        const waitlist = await listWaitlistForAdmin({ status, weekStart });
        return sendJson(res, 200, { waitlist });
      }

      const adminWaitlistMatch = pathname.match(/^\/api\/admin\/waitlist\/([a-zA-Z0-9-]+)$/);
      if (adminWaitlistMatch) {
        const entryId = adminWaitlistMatch[1];
        if (method === 'PUT') {
          const body = await parseJsonBody(req);
          const updated = await updateWaitlistStatus(entryId, body.status);
          return sendJson(res, 200, {
            message: 'Status da lista de espera atualizado.',
            entry: updated
          });
        }
        if (method === 'DELETE') {
          await removeWaitlistEntry(entryId);
          return sendJson(res, 200, {
            message: 'Cliente removido da lista de espera.'
          });
        }
      }

      // --- ABA 2: FINANCEIRO ---
      if (pathname === '/api/admin/finance' && method === 'GET') {
        const period = parsedUrl.searchParams.get('period') || 'este_mes';
        const startDate = parsedUrl.searchParams.get('start_date') || undefined;
        const endDate = parsedUrl.searchParams.get('end_date') || undefined;
        const statusFilter = parsedUrl.searchParams.get('status') || '';
        const paymentFilter = parsedUrl.searchParams.get('payment_status') || '';
        const searchQuery = parsedUrl.searchParams.get('q') || '';

        const dashboard = await getFinancialDashboard({
          period,
          startDate,
          endDate,
          statusFilter,
          paymentFilter,
          searchQuery
        });
        return sendJson(res, 200, dashboard);
      }

      // --- ABA 3: PREÇOS (SERVIÇOS) ---
      if (pathname === '/api/admin/services' && method === 'GET') {
        const services = await listServices({ activeOnly: false });
        return sendJson(res, 200, { services });
      }

      if (pathname === '/api/admin/services' && method === 'POST') {
        const body = await parseJsonBody(req);
        const service = await createService({
          name: body.name,
          description: body.description,
          price: body.price,
          active: body.active !== undefined ? body.active : true
        });
        return sendJson(res, 201, {
          message: 'Serviço cadastrado com sucesso!',
          service
        });
      }

      const adminServiceMatch = pathname.match(/^\/api\/admin\/services\/([a-zA-Z0-9-]+)$/);
      if (adminServiceMatch) {
        const serviceId = adminServiceMatch[1];
        if (method === 'PUT') {
          const body = await parseJsonBody(req);
          const service = await updateService(serviceId, {
            name: body.name,
            description: body.description,
            price: body.price,
            active: body.active
          });
          return sendJson(res, 200, {
            message: 'Serviço atualizado com sucesso!',
            service
          });
        }
        if (method === 'DELETE') {
          await deleteService(serviceId);
          return sendJson(res, 200, {
            message: 'Serviço excluído com sucesso!'
          });
        }
      }

      // --- NOTIFICAÇÕES WHATSAPP ---
      if (pathname === '/api/admin/notifications' && method === 'GET') {
        const db = getDb();
        const notifications = await db.listNotifications(50);
        return sendJson(res, 200, {
          integration: getWhatsAppIntegrationStatus(),
          notifications
        });
      }

      const notifRetryMatch = pathname.match(/^\/api\/admin\/notifications\/([a-zA-Z0-9-]+)\/retry$/);
      if (notifRetryMatch && method === 'POST') {
        const notifId = notifRetryMatch[1];
        const updated = await attemptSendNotification(notifId);
        if (!updated) {
          return sendJson(res, 404, { error: 'Notificação não encontrada.' });
        }
        return sendJson(res, 200, {
          message:
            updated.status === 'enviada'
              ? 'Notificação reenviada com sucesso!'
              : `Tentativa registrada (${updated.status}): ${updated.error || ''}`,
          notification: updated
        });
      }

      // --- ABA 4: CONFIGURAÇÕES DO ADMINISTRADOR ---
      if (pathname === '/api/admin/settings' && method === 'GET') {
        return sendJson(res, 200, {
          whatsapp: getWhatsAppIntegrationStatus()
        });
      }

      if (pathname === '/api/admin/settings' && method === 'PUT') {
        const body = await parseJsonBody(req);
        if (body.luan_whatsapp_number !== undefined) {
          const digits = String(body.luan_whatsapp_number || '').replace(/\D/g, '');
          if (digits) {
            process.env.LUAN_WHATSAPP_NUMBER = digits.startsWith('55') ? digits : `55${digits}`;
          } else {
            process.env.LUAN_WHATSAPP_NUMBER = '';
          }
        }
        return sendJson(res, 200, {
          message: 'Configurações salvas com sucesso!',
          whatsapp: getWhatsAppIntegrationStatus()
        });
      }
    }

    return sendJson(res, 404, { error: 'Endpoint não encontrado.' });
  } catch (err) {
    const statusCode = err.statusCode || 500;
    return sendJson(res, statusCode, {
      error: err.message || 'Erro interno no servidor.',
      code: err.code || 'INTERNAL_ERROR',
      conflicts: err.conflicts || undefined
    });
  }
}

module.exports = { handleApiRequest };

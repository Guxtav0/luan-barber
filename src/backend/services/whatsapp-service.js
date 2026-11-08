const { getConfig } = require('../config');
const { getDb } = require('../db');
const { formatDateBR } = require('../utils/time');
const { formatPhoneBR, formatCurrencyBR } = require('../utils/validators');

/**
 * Camada independente de envio de mensagens WhatsApp Business.
 * Permite trocar o provedor (Meta Cloud API Oficial, Evolution API, Z-API, Webhook)
 * apenas via variáveis de ambiente, sem acoplamento com o restante do sistema.
 */
class WhatsAppProviderClient {
  constructor(whatsappConfig, fetchImpl = global.fetch) {
    this.config = whatsappConfig;
    this.fetchImpl = fetchImpl;
  }

  async sendMessage(recipientNumber, textContent) {
    if (!this.config.isConfigured) {
      return {
        ok: false,
        unconfigured: true,
        error:
          'Integração WhatsApp pendente de configuração (defina WHATSAPP_API_URL, WHATSAPP_API_TOKEN e WHATSAPP_PHONE_NUMBER_ID no arquivo .env).'
      };
    }

    const cleanPhone = String(recipientNumber).replace(/\D/g, '');
    const provider = this.config.provider;

    let endpoint = this.config.apiUrl.replace(/\/$/, '');
    let headers = {
      'Content-Type': 'application/json'
    };
    let payload = {};

    if (provider === 'meta_cloud') {
      endpoint = `${endpoint}/${this.config.phoneNumberId}/messages`;
      headers.Authorization = `Bearer ${this.config.apiToken}`;
      payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanPhone,
        type: 'text',
        text: {
          preview_url: false,
          body: textContent
        }
      };
    } else if (provider === 'evolution') {
      endpoint = `${endpoint}/message/sendText`;
      headers.apikey = this.config.apiToken;
      payload = {
        number: cleanPhone,
        text: textContent
      };
    } else if (provider === 'zapi') {
      endpoint = `${endpoint}/send-text`;
      headers['Client-Token'] = this.config.apiToken;
      payload = {
        phone: cleanPhone,
        message: textContent
      };
    } else {
      headers.Authorization = `Bearer ${this.config.apiToken}`;
      payload = {
        to: cleanPhone,
        message: textContent
      };
    }

    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        return {
          ok: false,
          unconfigured: false,
          error: `HTTP ${response.status}: ${errBody || response.statusText}`
        };
      }

      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        unconfigured: false,
        error: err.message || 'Erro de conexão com a API do WhatsApp.'
      };
    }
  }
}

let customFetchImpl = null;
function setWhatsAppFetchForTest(fn) {
  customFetchImpl = fn;
}

const DEFAULT_MESSAGE_TEMPLATES = {
  mensagem_cliente:
    'Olá {cliente}! Passando para confirmar seu agendamento na Luan Barber no dia {data} às {horario} ({servicos} - {valor}).',
  novo_agendamento: [
    'Novo agendamento na Luan Barber!',
    '',
    'Cliente: {cliente}',
    'Telefone: {telefone}',
    'Serviços: {servicos}',
    'Data: {data}',
    'Horário: {horario}',
    'Valor: {valor}'
  ].join('\n'),
  cancelamento_cliente: [
    'Um cliente desistiu do agendamento.',
    '',
    'Cliente: {cliente}',
    'Data: {data}',
    'Horário: {horario}',
    'Serviços: {servicos}',
    '',
    'O horário foi liberado na agenda.'
  ].join('\n'),
  atendimento_concluido: [
    'Atendimento finalizado na Luan Barber!',
    '',
    'Cliente: {cliente}',
    'Serviços: {servicos}',
    'Valor: {valor}'
  ].join('\n'),
  publicacao_agenda:
    'Sua agenda semanal foi publicada com sucesso e já está disponível para os clientes.'
};

let cachedMessageTemplates = { ...DEFAULT_MESSAGE_TEMPLATES };

function renderMessageTemplate(templateStr, vars = {}) {
  let result = String(templateStr || '');
  const map = {
    '{cliente}': vars.cliente || '',
    '{telefone}': vars.telefone || 'Não informado',
    '{servicos}': vars.servicos || '',
    '{data}': vars.data || '',
    '{horario}': vars.horario || '',
    '{valor}': vars.valor || ''
  };
  for (const [key, val] of Object.entries(map)) {
    result = result.split(key).join(val);
  }
  return result;
}

async function loadSavedSettingsIntoRuntime() {
  try {
    const db = getDb();
    if (typeof db.getSystemSettings !== 'function') {
      return { templates: { ...cachedMessageTemplates } };
    }
    const saved = await db.getSystemSettings();
    if (saved && saved.luan_whatsapp_number) {
      const config = getConfig();
      config.whatsapp.luanNumber = saved.luan_whatsapp_number;
      process.env.LUAN_WHATSAPP_NUMBER = saved.luan_whatsapp_number;
    }
    if (saved && saved.message_templates && typeof saved.message_templates === 'object') {
      cachedMessageTemplates = {
        ...DEFAULT_MESSAGE_TEMPLATES,
        ...saved.message_templates
      };
    }
  } catch {
    // fallback silencioso caso o banco ainda esteja inicializando
  }
  return {
    templates: { ...cachedMessageTemplates },
    defaults: { ...DEFAULT_MESSAGE_TEMPLATES }
  };
}

function getMessageTemplatesSync() {
  return { ...cachedMessageTemplates };
}

function setMessageTemplatesSync(customTemplates = {}) {
  cachedMessageTemplates = {
    ...DEFAULT_MESSAGE_TEMPLATES,
    ...customTemplates
  };
  return { ...cachedMessageTemplates };
}

async function dispatchNotification({ eventKey, type, content }) {
  await loadSavedSettingsIntoRuntime();
  const db = getDb();
  const config = getConfig();
  const recipient = config.whatsapp.luanNumber || '5511999999999';

  const { notification, alreadyExisted } = await db.createNotification({
    eventKey,
    type,
    recipient,
    content,
    status: 'pendente'
  });

  // Regra: Não duplicar notificações por causa de atualizações repetidas
  if (alreadyExisted && notification.status === 'enviada') {
    return { ...notification, deduplicated: true };
  }

  return attemptSendNotification(notification.id);
}

async function attemptSendNotification(notificationId) {
  const db = getDb();
  const config = getConfig();
  const notification = await db.getNotificationById(notificationId);
  if (!notification) return null;

  if (notification.status === 'enviada') {
    return notification;
  }

  const providerClient = new WhatsAppProviderClient(
    config.whatsapp,
    customFetchImpl || global.fetch
  );

  // Se não estiver configurado, registra como pendente_configuracao na primeira tentativa sem bloquear o sistema
  if (!config.whatsapp.isConfigured) {
    return db.updateNotification(notification.id, {
      status: 'pendente_configuracao',
      attempts: notification.attempts + 1,
      error:
        'Credenciais do WhatsApp Business API ainda não configuradas no ambiente (.env).',
      sentAt: null
    });
  }

  const maxRetries = Math.max(1, config.whatsapp.maxRetries || 3);
  let lastError = null;
  let attemptsDone = notification.attempts;

  for (let i = 0; i < maxRetries; i++) {
    attemptsDone += 1;
    const res = await providerClient.sendMessage(notification.recipient, notification.content);
    if (res.ok) {
      return db.updateNotification(notification.id, {
        status: 'enviada',
        attempts: attemptsDone,
        error: null,
        sentAt: new Date().toISOString()
      });
    }
    lastError = res.error;
  }

  // Regra: Não considerar uma notificação enviada quando a API retornar erro
  return db.updateNotification(notification.id, {
    status: 'falha',
    attempts: attemptsDone,
    error: lastError || 'Falha no envio após tentativas.',
    sentAt: null
  });
}

function formatServicesList(items = []) {
  return items.map((i) => i.service_name || i.name).join(', ');
}

/**
 * Evento 1 — Novo agendamento
 */
async function notifyNewAppointment(appointment) {
  await loadSavedSettingsIntoRuntime();
  const servicesStr = formatServicesList(appointment.items);
  const dateStr = formatDateBR(appointment.appointment_date);
  const timeStr = `${appointment.start_time} às ${appointment.end_time}`;
  const valueStr = formatCurrencyBR(appointment.total_price);
  const phoneStr = formatPhoneBR(appointment.client_phone);

  const content = renderMessageTemplate(cachedMessageTemplates.novo_agendamento, {
    cliente: appointment.client_name,
    telefone: phoneStr,
    servicos: servicesStr,
    data: dateStr,
    horario: timeStr,
    valor: valueStr
  });

  return dispatchNotification({
    eventKey: `novo_agendamento:${appointment.id}`,
    type: 'novo_agendamento',
    content
  });
}

/**
 * Evento 2 — Cancelamento pelo cliente
 */
async function notifyClientCancellation(appointment) {
  await loadSavedSettingsIntoRuntime();
  const servicesStr = formatServicesList(appointment.items);
  const dateStr = formatDateBR(appointment.appointment_date);
  const timeStr = `${appointment.start_time} às ${appointment.end_time}`;
  const valueStr = formatCurrencyBR(appointment.total_price);
  const phoneStr = formatPhoneBR(appointment.client_phone);

  const content = renderMessageTemplate(cachedMessageTemplates.cancelamento_cliente, {
    cliente: appointment.client_name,
    telefone: phoneStr,
    servicos: servicesStr,
    data: dateStr,
    horario: timeStr,
    valor: valueStr
  });

  return dispatchNotification({
    eventKey: `cancelamento_cliente:${appointment.id}`,
    type: 'cancelamento_cliente',
    content
  });
}

/**
 * Evento 3 — Publicação da agenda semanal
 */
async function notifySchedulePublished(weekStart, publishedAt) {
  await loadSavedSettingsIntoRuntime();
  const content = renderMessageTemplate(cachedMessageTemplates.publicacao_agenda, {
    data: formatDateBR(weekStart)
  });
  // Chave única por semana + publicação
  return dispatchNotification({
    eventKey: `publicacao_agenda:${weekStart}:${publishedAt || 'initial'}`,
    type: 'publicacao_agenda',
    content
  });
}

/**
 * Evento 4 — Atendimento concluído
 */
async function notifyAppointmentCompleted(appointment) {
  await loadSavedSettingsIntoRuntime();
  const servicesStr = formatServicesList(appointment.items);
  const dateStr = formatDateBR(appointment.appointment_date);
  const timeStr = `${appointment.start_time} às ${appointment.end_time}`;
  const valueStr = formatCurrencyBR(appointment.total_price);
  const phoneStr = formatPhoneBR(appointment.client_phone);

  const content = renderMessageTemplate(cachedMessageTemplates.atendimento_concluido, {
    cliente: appointment.client_name,
    telefone: phoneStr,
    servicos: servicesStr,
    data: dateStr,
    horario: timeStr,
    valor: valueStr
  });

  return dispatchNotification({
    eventKey: `atendimento_concluido:${appointment.id}`,
    type: 'atendimento_concluido',
    content
  });
}

function getWhatsAppIntegrationStatus() {
  const config = getConfig();
  return {
    configured: config.whatsapp.isConfigured,
    provider: config.whatsapp.provider,
    recipient: formatPhoneBR(config.whatsapp.luanNumber),
    rawRecipient: config.whatsapp.luanNumber,
    statusLabel: config.whatsapp.isConfigured
      ? 'Configurada e ativa'
      : 'Pendente de configuração (.env)'
  };
}

module.exports = {
  DEFAULT_MESSAGE_TEMPLATES,
  renderMessageTemplate,
  loadSavedSettingsIntoRuntime,
  getMessageTemplatesSync,
  setMessageTemplatesSync,
  notifyNewAppointment,
  notifyClientCancellation,
  notifySchedulePublished,
  notifyAppointmentCompleted,
  attemptSendNotification,
  getWhatsAppIntegrationStatus,
  setWhatsAppFetchForTest
};

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

async function dispatchNotification({ eventKey, type, content }) {
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
  const servicesStr = formatServicesList(appointment.items);
  const dateStr = formatDateBR(appointment.appointment_date);
  const timeStr = `${appointment.start_time} às ${appointment.end_time}`;
  const valueStr = formatCurrencyBR(appointment.total_price);
  const phoneStr = formatPhoneBR(appointment.client_phone);

  const content = [
    'Novo agendamento na Luan Barber!',
    '',
    `Cliente: ${appointment.client_name}`,
    `Telefone: ${phoneStr}`,
    `Serviços: ${servicesStr}`,
    `Data: ${dateStr}`,
    `Horário: ${timeStr}`,
    `Valor: ${valueStr}`
  ].join('\n');

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
  const servicesStr = formatServicesList(appointment.items);
  const dateStr = formatDateBR(appointment.appointment_date);
  const timeStr = `${appointment.start_time} às ${appointment.end_time}`;

  const content = [
    'Um cliente desistiu do agendamento.',
    '',
    `Cliente: ${appointment.client_name}`,
    `Data: ${dateStr}`,
    `Horário: ${timeStr}`,
    `Serviços: ${servicesStr}`,
    '',
    'O horário foi liberado na agenda.'
  ].join('\n');

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
  const content =
    'Sua agenda semanal foi publicada com sucesso e já está disponível para os clientes.';
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
  const servicesStr = formatServicesList(appointment.items);
  const valueStr = formatCurrencyBR(appointment.total_price);

  const content = [
    'Atendimento finalizado na Luan Barber!',
    '',
    `Cliente: ${appointment.client_name}`,
    `Serviços: ${servicesStr}`,
    `Valor: ${valueStr}`
  ].join('\n');

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
  notifyNewAppointment,
  notifyClientCancellation,
  notifySchedulePublished,
  notifyAppointmentCompleted,
  attemptSendNotification,
  getWhatsAppIntegrationStatus,
  setWhatsAppFetchForTest
};

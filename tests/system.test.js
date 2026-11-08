const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { SqliteAdapter } = require('../src/backend/db/sqlite-adapter');
const { setDbInstance } = require('../src/backend/db');
const { handleApiRequest } = require('../src/backend/routes/api');
const { setWhatsAppFetchForTest } = require('../src/backend/services/whatsapp-service');
const { cancelAppointmentByClientToken } = require('../src/backend/services/appointment-service');

const TEST_DB_PATH = path.resolve(__dirname, '../data/test_luan_barber.db');

describe('LUAN BARBER — Suite Completa de Testes Funcionais, Segurança e Regras de Negócio', () => {
  let testDb;
  let adminToken;
  let services = [];
  const testWeekStart = '2026-11-16'; // Segunda-feira futura
  const testWorkDate = '2026-11-17';  // Terça-feira futura

  before(async () => {
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    testDb = new SqliteAdapter(TEST_DB_PATH);
    setDbInstance(testDb);
  });

  after(async () => {
    try {
      if (testDb && testDb.db) testDb.db.close();
      if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    } catch {
      // ignore cleanup lock on Windows
    }
  });

  async function api(endpoint, { method = 'GET', body = null, token = null } = {}) {
    const payloadStr = body !== null ? JSON.stringify(body) : '';
    const req = Readable.from(payloadStr ? [Buffer.from(payloadStr)] : []);
    req.url = endpoint;
    req.method = method;
    req.headers = {
      host: 'localhost:3000',
      'content-type': 'application/json'
    };
    if (token) {
      req.headers.authorization = `Bearer ${token}`;
    }

    return new Promise((resolve, reject) => {
      let statusCode = 200;
      let responseHeaders = {};
      let responseBody = '';

      const res = {
        writeHead(code, headers = {}) {
          statusCode = code;
          responseHeaders = headers;
        },
        end(chunk = '') {
          responseBody += chunk ? String(chunk) : '';
          let parsed = {};
          try {
            parsed = responseBody ? JSON.parse(responseBody) : {};
          } catch {
            parsed = { raw: responseBody };
          }
          resolve({ status: statusCode, headers: responseHeaders, data: parsed });
        }
      };

      handleApiRequest(req, res).catch(reject);
    });
  }

  // 1. Login Administrativo e Segurança
  it('1. Deve bloquear acesso administrativo sem autenticação e autenticar o Luan com credenciais válidas', async () => {
    const unauth = await api('/api/admin/services');
    assert.equal(unauth.status, 401);

    const badLogin = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'luan@luanbarber.com.br', password: 'wrong-password' }
    });
    assert.equal(badLogin.status, 401);

    const goodLogin = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'luan@luanbarber.com.br', password: 'LuanBarber@2026' }
    });
    assert.equal(goodLogin.status, 200);
    assert.ok(goodLogin.data.token);
    adminToken = goodLogin.data.token;
  });

  // 2. Cadastro e edição de serviços
  it('2. Deve listar os serviços iniciais, cadastrar novo serviço, editar, ativar/desativar e preservar preços históricos', async () => {
    const listRes = await api('/api/admin/services', { token: adminToken });
    assert.equal(listRes.status, 200);
    assert.ok(listRes.data.services.length >= 4);

    // Criar novo serviço
    const createRes = await api('/api/admin/services', {
      method: 'POST',
      token: adminToken,
      body: {
        name: 'Sobrancelha na Navalha',
        description: 'Alinhamento na navalha',
        price: 15,
        active: true
      }
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.data.service.duration, 30);
    assert.equal(createRes.data.service.price, 15);

    const newServiceId = createRes.data.service.id;

    // Editar serviço (alterar valor e desativar)
    const editRes = await api(`/api/admin/services/${newServiceId}`, {
      method: 'PUT',
      token: adminToken,
      body: {
        name: 'Sobrancelha Completa',
        price: 20,
        active: false
      }
    });
    assert.equal(editRes.status, 200);
    assert.equal(editRes.data.service.name, 'Sobrancelha Completa');
    assert.equal(editRes.data.service.price, 20);
    assert.equal(editRes.data.service.active, false);

    // Consulta pública não deve listar serviço inativo
    const pubServicesRes = await api('/api/public/services');
    assert.equal(pubServicesRes.status, 200);
    assert.ok(!pubServicesRes.data.services.some((s) => s.id === newServiceId));

    // Excluir serviço de teste
    const delRes = await api(`/api/admin/services/${newServiceId}`, {
      method: 'DELETE',
      token: adminToken
    });
    assert.equal(delRes.status, 200);

    services = pubServicesRes.data.services;
  });

  // 3. Bloqueio de acesso aos horários antes da publicação
  it('3. Deve bloquear agendamento e exibir "Aguarde a confirmação dos dias e horários disponíveis." antes da publicação da agenda', async () => {
    const pubAvail = await api(`/api/public/schedule?week_start=${testWeekStart}`);
    assert.equal(pubAvail.status, 200);
    assert.equal(pubAvail.data.situation, 'nao_publicada');
    assert.equal(pubAvail.data.can_book, false);
    assert.equal(
      pubAvail.data.message,
      'Aguarde a confirmação dos dias e horários disponíveis.'
    );

    // Tentativa direta de agendamento antes da publicação deve falhar
    const attemptRes = await api('/api/public/appointments', {
      method: 'POST',
      body: {
        client_name: 'Carlos Teste',
        client_phone: '11988887777',
        appointment_date: testWorkDate,
        start_time: '09:00',
        service_ids: [services[0].id]
      }
    });
    assert.ok(attemptRes.status === 400 || attemptRes.status === 403);
  });

  // 4. Rascunho, Publicação da agenda e Geração de horários de 30 minutos
  it('4. Deve salvar agenda como rascunho, publicar agenda e gerar corretamente blocos de 30 minutos (09h às 12h = 6 blocos)', async () => {
    const adminWeek = await api(`/api/admin/schedule?week_start=${testWeekStart}`, {
      token: adminToken
    });
    assert.equal(adminWeek.status, 200);

    // Configura apenas Terça-feira (2026-11-17) das 09:00 às 12:00 (como no exemplo da seção 3.2)
    const customDays = adminWeek.data.schedule.days.map((d) => ({
      ...d,
      is_working: d.work_date === testWorkDate,
      start_time: '09:00',
      end_time: '12:00',
      breaks: []
    }));

    // Salvar primeiro como rascunho
    const draftRes = await api('/api/admin/schedule/save', {
      method: 'POST',
      token: adminToken,
      body: {
        week_start: testWeekStart,
        days: customDays,
        publish: false
      }
    });
    assert.equal(draftRes.status, 200);
    assert.equal(draftRes.data.schedule.status, 'rascunho');

    // Ainda não deve estar visível para o público
    const stillUnpub = await api(`/api/public/schedule?week_start=${testWeekStart}`);
    assert.equal(stillUnpub.data.situation, 'nao_publicada');

    // Agora Publicar a agenda
    const pubRes = await api('/api/admin/schedule/save', {
      method: 'POST',
      token: adminToken,
      body: {
        week_start: testWeekStart,
        days: customDays,
        publish: true
      }
    });
    assert.equal(pubRes.status, 200);
    assert.equal(pubRes.data.schedule.status, 'publicada');

    // Verificar os horários gerados de 30 minutos (09:00, 09:30, 10:00, 10:30, 11:00, 11:30)
    const pubAvail = await api(`/api/public/schedule?week_start=${testWeekStart}&duration=30`);
    assert.equal(pubAvail.status, 200);
    assert.equal(pubAvail.data.situation, 'disponivel');

    const tuesday = pubAvail.data.days.find((d) => d.work_date === testWorkDate);
    assert.ok(tuesday);
    const slotTimes = tuesday.available_slots.map((s) => s.start_time);
    assert.deepEqual(slotTimes, ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
  });

  // 5. Agendamento de um serviço e ocultação automática do horário ocupado
  let firstBooking;
  it('5. Deve agendar um serviço (30 min), gerar link com token seguro e remover o horário da disponibilidade pública', async () => {
    const res = await api('/api/public/appointments', {
      method: 'POST',
      body: {
        client_name: 'Rafael Almeida',
        client_phone: '(11) 99111-2222',
        appointment_date: testWorkDate,
        start_time: '09:00',
        service_ids: [services[0].id] // 30 min
      }
    });
    assert.equal(res.status, 201);
    assert.equal(
      res.data.message,
      'Agendamento realizado com sucesso! Esperamos você na Luan Barber.'
    );
    assert.equal(res.data.appointment.start_time, '09:00');
    assert.equal(res.data.appointment.end_time, '09:30');
    assert.equal(res.data.appointment.total_duration, 30);
    assert.ok(res.data.appointment.management_token.length >= 32);

    firstBooking = res.data.appointment;

    // Verificar que 09:00 desapareceu da disponibilidade pública
    const availAfter = await api(`/api/public/schedule?week_start=${testWeekStart}&duration=30`);
    const tuesday = availAfter.data.days.find((d) => d.work_date === testWorkDate);
    const slotTimes = tuesday.available_slots.map((s) => s.start_time);
    assert.ok(!slotTimes.includes('09:00'));
    assert.ok(slotTimes.includes('09:30'));
  });

  // 6. Agendamento de múltiplos serviços (60 min / 90 min consecutivos)
  let secondBooking;
  it('6. Deve reservar blocos consecutivos para múltiplos serviços (2 serviços = 60 min) e bloquear horários sem blocos consecutivos suficientes', async () => {
    // Reserva 09:30 às 10:30 (2 serviços = 60 min)
    const res = await api('/api/public/appointments', {
      method: 'POST',
      body: {
        client_name: 'Bruno Costa',
        client_phone: '(11) 99222-3333',
        appointment_date: testWorkDate,
        start_time: '09:30',
        service_ids: [services[0].id, services[2].id] // Corte + Barba = 60 min
      }
    });
    assert.equal(res.status, 201);
    assert.equal(res.data.appointment.start_time, '09:30');
    assert.equal(res.data.appointment.end_time, '10:30');
    assert.equal(res.data.appointment.total_duration, 60);
    assert.equal(
      res.data.appointment.total_price,
      Number(services[0].price) + Number(services[2].price)
    );
    secondBooking = res.data.appointment;

    // Agora restam livres: 10:30, 11:00, 11:30.
    // Para 60 minutos (2 blocos consecutivos), 11:30 NÃO pode ser permitido porque o expediente acaba às 12:00!
    const avail60 = await api(`/api/public/schedule?week_start=${testWeekStart}&duration=60`);
    const tuesday60 = avail60.data.days.find((d) => d.work_date === testWorkDate);
    const slots60 = tuesday60.available_slots.map((s) => s.start_time);
    assert.deepEqual(slots60, ['10:30', '11:00']);
    assert.ok(!slots60.includes('11:30'));
  });

  // 7. Concorrência: Tentativas simultâneas de agendamento no mesmo horário
  it('7. Deve impedir reservas duplicadas em tentativas simultâneas para o mesmo horário (Concorrência Atômica)', async () => {
    const payloadA = {
      client_name: 'Cliente Concorrente A',
      client_phone: '11977771111',
      appointment_date: testWorkDate,
      start_time: '10:30',
      service_ids: [services[0].id]
    };
    const payloadB = {
      client_name: 'Cliente Concorrente B',
      client_phone: '11977772222',
      appointment_date: testWorkDate,
      start_time: '10:30',
      service_ids: [services[1].id]
    };

    const [resA, resB] = await Promise.all([
      api('/api/public/appointments', { method: 'POST', body: payloadA }),
      api('/api/public/appointments', { method: 'POST', body: payloadB })
    ]);

    const statuses = [resA.status, resB.status].sort();
    // Exatamente um deve retornar 201 (Created) e o outro 409 (Conflict - HORARIO_OCUPADO)
    assert.deepEqual(statuses, [201, 409]);

    const conflictResponse = resA.status === 409 ? resA : resB;
    assert.equal(conflictResponse.data.code, 'HORARIO_OCUPADO');
  });

  // 8. Situação 3 — Agenda semanal fechada quando todos os horários estão ocupados
  it('8. Deve apresentar "Agenda semanal fechada." e habilitar lista de espera quando todos os horários publicados estiverem ocupados', async () => {
    // Ocupa os últimos 2 blocos restantes (11:00 e 11:30)
    const fillRest = await api('/api/public/appointments', {
      method: 'POST',
      body: {
        client_name: 'Lucas Mendes',
        client_phone: '11966665555',
        appointment_date: testWorkDate,
        start_time: '11:00',
        service_ids: [services[0].id, services[1].id] // 60 min (11:00 às 12:00)
      }
    });
    assert.equal(fillRest.status, 201);

    // Consulta pública agora deve retornar Situação 3: 'fechada' -> "Agenda semanal fechada."
    const closedCheck = await api(`/api/public/schedule?week_start=${testWeekStart}&duration=30`);
    assert.equal(closedCheck.status, 200);
    assert.equal(closedCheck.data.situation, 'fechada');
    assert.equal(closedCheck.data.message, 'Agenda semanal fechada.');
    assert.equal(closedCheck.data.allow_waitlist, true);
  });

  // 9. Lista de Espera e Destaque de Oportunidade ao Cancelar
  let waitlistEntryId;
  it('9. Deve cadastrar cliente na lista de espera e destacar oportunidade quando um horário compatível é liberado por cancelamento', async () => {
    const wlRes = await api('/api/public/waitlist', {
      method: 'POST',
      body: {
        week_start: testWeekStart,
        name: 'Pedro Espera',
        phone: '11955554444',
        service_ids: [services[0].id, services[2].id], // 60 min
        preferred_days: [testWorkDate],
        preferred_periods: ['manha']
      }
    });
    assert.equal(wlRes.status, 201);
    waitlistEntryId = wlRes.data.entry.id;
    assert.equal(wlRes.data.entry.matched_opportunity, false);

    // Agora o cliente Bruno (secondBooking: 09:30 às 10:30, 60 min pela manhã) cancela pelo seu link exclusivo!
    const cancelRes = await api(
      `/api/public/appointments/${secondBooking.management_token}/cancel`,
      { method: 'POST', body: {} }
    );
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.data.appointment.status, 'cancelado');

    // 1. Verificar que os horários 09:30 e 10:00 voltaram para a disponibilidade pública
    const availAfterCancel = await api(
      `/api/public/schedule?week_start=${testWeekStart}&duration=30`
    );
    assert.equal(availAfterCancel.data.situation, 'disponivel');
    const tuesdaySlots = availAfterCancel.data.days
      .find((d) => d.work_date === testWorkDate)
      .available_slots.map((s) => s.start_time);
    assert.ok(tuesdaySlots.includes('09:30'));
    assert.ok(tuesdaySlots.includes('10:00'));

    // 2. Verificar que Pedro Espera na lista de espera foi destacado com oportunidade compatível, mas NÃO agendado automaticamente!
    const adminWl = await api('/api/admin/waitlist', { token: adminToken });
    const pedro = adminWl.data.waitlist.find((w) => w.id === waitlistEntryId);
    assert.ok(pedro);
    assert.equal(pedro.status, 'aguardando');
    assert.equal(pedro.matched_opportunity, true);
    assert.ok(pedro.matched_details.includes('09:30'));
  });

  // 10. Regra de Cancelamento com menos de 2 horas de antecedência
  it('10. Deve bloquear cancelamento pelo cliente com menos de 2 horas de antecedência com a mensagem oficial', async () => {
    // firstBooking é em 2026-11-17 às 09:00.
    // Simulamos "agora" como 2026-11-17 às 07:30 (faltando 1h30m, ou seja, < 2 horas)
    const simulatedNow = new Date(2026, 10, 17, 7, 30, 0);

    await assert.rejects(
      async () => {
        await cancelAppointmentByClientToken(firstBooking.management_token, simulatedNow);
      },
      (err) => {
        assert.equal(err.code, 'BLOQUEIO_2_HORAS');
        assert.equal(
          err.message,
          'Para alterações ou cancelamentos com menos de 2 horas de antecedência, entre em contato diretamente com a barbearia.'
        );
        return true;
      }
    );
  });

  // 11. Regra 14: Bloqueio de redução de expediente com agendamentos confirmados em conflito
  it('11. Deve impedir que o Luan reduza o expediente prejudicando agendamentos confirmados sem antes resolver os conflitos', async () => {
    const adminWeek = await api(`/api/admin/schedule?week_start=${testWeekStart}`, {
      token: adminToken
    });

    // Tenta encurtar a Terça-feira para encerrar às 10:00 (conflitando com os agendamentos das 10:30 e 11:00)
    const conflictingDays = adminWeek.data.schedule.days.map((d) =>
      d.work_date === testWorkDate
        ? { ...d, is_working: true, start_time: '09:00', end_time: '10:00' }
        : d
    );

    const saveConflictRes = await api('/api/admin/schedule/save', {
      method: 'POST',
      token: adminToken,
      body: {
        week_start: testWeekStart,
        days: conflictingDays,
        publish: true
      }
    });

    assert.equal(saveConflictRes.status, 409);
    assert.equal(saveConflictRes.data.code, 'CONFLITO_EXPEDIENTE');
    assert.ok(Array.isArray(saveConflictRes.data.conflicts));
    assert.ok(saveConflictRes.data.conflicts.length >= 2);
  });

  // 12. Edição manual pelo administrador, conclusão de atendimento, controle de pagamento, faturamento e ranking
  it('12. Deve permitir edição manual pelo admin, conclusão de atendimento, controle de inadimplência, cálculo de faturamento e ranking de clientes', async () => {
    // 1. Alterar preço do serviço no catálogo e garantir que firstBooking mantém seu preço original (Regra 12)
    const originalPrice = firstBooking.total_price;
    await api(`/api/admin/services/${services[0].id}`, {
      method: 'PUT',
      token: adminToken,
      body: { price: 99.0 }
    });

    // 2. Admin marca firstBooking como concluído, mas pagamento pendente (inadimplência)
    const completeUnpaid = await api(`/api/admin/appointments/${firstBooking.id}`, {
      method: 'PUT',
      token: adminToken,
      body: { status: 'concluido', payment_status: 'pendente' }
    });
    assert.equal(completeUnpaid.status, 200);
    assert.equal(completeUnpaid.data.appointment.total_price, originalPrice);

    // Restaura preço original do serviço
    await api(`/api/admin/services/${services[0].id}`, {
      method: 'PUT',
      token: adminToken,
      body: { price: originalPrice }
    });

    // 3. Consultar Financeiro no período personalizado cobrindo a semana de teste
    const fin1 = await api(
      `/api/admin/finance?period=personalizado&start_date=${testWeekStart}&end_date=2026-11-22`,
      { token: adminToken }
    );
    assert.equal(fin1.status, 200);
    // firstBooking está concluído e pendente -> Faturamento pendente = originalPrice, Faturamento recebido = 0
    assert.equal(fin1.data.cards.faturamento_pendente, originalPrice);
    assert.equal(fin1.data.cards.faturamento_recebido, 0);
    assert.equal(fin1.data.cards.total_cortes_realizados, 1);
    // Existem outros 2 agendamentos confirmados futuros na semana (10:30 e 11:00) -> não contam como receita nem inadimplência!
    assert.equal(fin1.data.cards.agendamentos_futuros, 2);
    assert.equal(fin1.data.pending_payments.length, 1);
    assert.equal(fin1.data.pending_payments[0].id, firstBooking.id);

    // 4. Confirmar pagamento do firstBooking
    const markPaid = await api(`/api/admin/appointments/${firstBooking.id}`, {
      method: 'PUT',
      token: adminToken,
      body: { payment_status: 'pago' }
    });
    assert.equal(markPaid.status, 200);

    const fin2 = await api(
      `/api/admin/finance?period=personalizado&start_date=${testWeekStart}&end_date=2026-11-22`,
      { token: adminToken }
    );
    assert.equal(fin2.data.cards.faturamento_recebido, originalPrice);
    assert.equal(fin2.data.cards.faturamento_pendente, 0);
    assert.equal(fin2.data.pending_payments.length, 0);
    assert.equal(fin2.data.top_clients.length, 1);
    assert.equal(fin2.data.top_clients[0].name, 'Rafael Almeida');
    assert.equal(fin2.data.top_clients[0].cuts_count, 1);
  });

  // 13. Integração WhatsApp, registro de histórico, falha e reenvio
  it('13. Deve registrar histórico de notificações WhatsApp, não considerar erro da API como enviada e permitir reenvio com sucesso', async () => {
    const notifRes = await api('/api/admin/notifications', { token: adminToken });
    assert.equal(notifRes.status, 200);
    assert.ok(notifRes.data.notifications.length >= 4); // publicacao, novos agendamentos, cancelamento, concluido

    // Como o .env padrão de teste não tem token de API preenchido, devem estar como 'pendente_configuracao' (nunca 'enviada' falsamente)
    const sampleNotif = notifRes.data.notifications[0];
    assert.notEqual(sampleNotif.status, 'enviada');

    // Agora configuramos credenciais de teste em memória e simulamos:
    // 1º uma falha HTTP 500 da API do WhatsApp -> deve registrar status 'falha'
    process.env.WHATSAPP_API_URL = 'https://graph.facebook.com/v20.0';
    process.env.WHATSAPP_PHONE_NUMBER_ID = '123456789';
    process.env.WHATSAPP_API_TOKEN = 'test-secret-token';
    process.env.WHATSAPP_MAX_RETRIES = '2';

    setWhatsAppFetchForTest(async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'Gateway Timeout'
    }));

    const retryFail = await api(`/api/admin/notifications/${sampleNotif.id}/retry`, {
      method: 'POST',
      token: adminToken
    });
    assert.equal(retryFail.status, 200);
    assert.equal(retryFail.data.notification.status, 'falha');
    assert.ok(retryFail.data.notification.error.includes('HTTP 500'));

    // 2º Agora simulamos resposta 200 OK da API oficial do WhatsApp -> deve marcar 'enviada'
    setWhatsAppFetchForTest(async () => ({
      ok: true,
      status: 200,
      text: async () => '{"messages":[{"id":"wamid.123"}]}'
    }));

    const retrySuccess = await api(`/api/admin/notifications/${sampleNotif.id}/retry`, {
      method: 'POST',
      token: adminToken
    });
    assert.equal(retrySuccess.status, 200);
    assert.equal(retrySuccess.data.notification.status, 'enviada');
    assert.ok(retrySuccess.data.notification.sent_at);
  });

  // 14. Intervalos de descanso, 3 serviços (90 min), remarcação pelo cliente e recorrência no ranking
  it('14. Deve respeitar intervalos de descanso, permitir agendamento de 3 serviços (90 min), remarcação pelo cliente e identificar clientes recorrentes', async () => {
    const adminWeek = await api(`/api/admin/schedule?week_start=${testWeekStart}`, {
      token: adminToken
    });

    const wednesdayDate = '2026-11-18';
    // Ativa Quarta-feira das 13:00 às 17:00 com intervalo das 14:30 às 15:00
    const updatedDays = adminWeek.data.schedule.days.map((d) =>
      d.work_date === wednesdayDate
        ? {
            ...d,
            is_working: true,
            start_time: '13:00',
            end_time: '17:00',
            breaks: [{ start: '14:30', end: '15:00' }]
          }
        : d
    );

    const saveWed = await api('/api/admin/schedule/save', {
      method: 'POST',
      token: adminToken,
      body: {
        week_start: testWeekStart,
        days: updatedDays,
        publish: true
      }
    });
    assert.equal(saveWed.status, 200);

    // Para 90 minutos (3 serviços), antes do intervalo (13:00 às 14:30) cabe apenas 13:00!
    // E depois do intervalo (15:00 às 17:00) cabem 15:00 e 15:30!
    const avail90 = await api(`/api/public/schedule?week_start=${testWeekStart}&duration=90`);
    const wed90 = avail90.data.days.find((d) => d.work_date === wednesdayDate);
    assert.deepEqual(
      wed90.available_slots.map((s) => s.start_time),
      ['13:00', '15:00', '15:30']
    );

    // Agendar 3 serviços (90 min) às 13:00 para o mesmo cliente Rafael Almeida
    const threeSvcRes = await api('/api/public/appointments', {
      method: 'POST',
      body: {
        client_name: 'Rafael Almeida',
        client_phone: '(11) 99111-2222',
        appointment_date: wednesdayDate,
        start_time: '13:00',
        service_ids: [services[0].id, services[1].id, services[2].id]
      }
    });
    assert.equal(threeSvcRes.status, 201);
    assert.equal(threeSvcRes.data.appointment.total_duration, 90);
    assert.equal(threeSvcRes.data.appointment.end_time, '14:30');

    // Cliente remarca seu próprio agendamento de 13:00 para 15:00 usando o link individual
    const token = threeSvcRes.data.appointment.management_token;
    const reschedRes = await api(`/api/public/appointments/${token}`, {
      method: 'PUT',
      body: {
        appointment_date: wednesdayDate,
        start_time: '15:00',
        service_ids: [services[0].id, services[1].id, services[2].id]
      }
    });
    assert.equal(reschedRes.status, 200);
    assert.equal(reschedRes.data.appointment.start_time, '15:00');
    assert.equal(reschedRes.data.appointment.end_time, '16:30');

    // Concluir este segundo atendimento do Rafael Almeida e verificar cliente recorrente no ranking
    await api(`/api/admin/appointments/${threeSvcRes.data.appointment.id}`, {
      method: 'PUT',
      token: adminToken,
      body: { status: 'concluido', payment_status: 'pago' }
    });

    const finRanking = await api(
      `/api/admin/finance?period=personalizado&start_date=${testWeekStart}&end_date=2026-11-22`,
      { token: adminToken }
    );
    assert.equal(finRanking.status, 200);
    const topClient = finRanking.data.top_clients[0];
    assert.equal(topClient.name, 'Rafael Almeida');
    assert.equal(topClient.cuts_count, 2);
    assert.equal(topClient.is_recurring, true);
  });

  // 15. Agendamento sem preenchimento do campo WhatsApp (opcional)
  it('15. Deve permitir agendamento público e administrativo sem preencher o campo de WhatsApp (opcional)', async () => {
    const wednesdayDate = '2026-11-18';
    const noPhoneBooking = await api('/api/public/appointments', {
      method: 'POST',
      body: {
        client_name: 'Cliente Sem WhatsApp',
        client_phone: '',
        appointment_date: wednesdayDate,
        start_time: '13:00',
        service_ids: [services[0].id, services[1].id] // 2 serviços = 60 min (13:00 às 14:00)
      }
    });
    assert.equal(noPhoneBooking.status, 201);
    assert.equal(noPhoneBooking.data.appointment.client_name, 'Cliente Sem WhatsApp');
    assert.equal(noPhoneBooking.data.appointment.client_phone, '');
    assert.equal(noPhoneBooking.data.appointment.total_duration, 60);
    assert.equal(noPhoneBooking.data.appointment.start_time, '13:00');
    assert.equal(noPhoneBooking.data.appointment.end_time, '14:00');
  });
});

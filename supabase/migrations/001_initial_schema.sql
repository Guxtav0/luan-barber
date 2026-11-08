-- ============================================================================
-- LUAN BARBER — MIGRAÇÃO INICIAL DO BANCO DE DADOS (SUPABASE / POSTGRESQL)
-- ============================================================================

-- Extensões necessárias
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. TABELA DE ADMINISTRADORES
CREATE TABLE IF NOT EXISTS public.admins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_user_id UUID UNIQUE, -- Referência opcional ao auth.users do Supabase
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT, -- Utilizado apenas no modo fallback local; no Supabase Auth usa auth.users
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. TABELA DE CLIENTES
CREATE TABLE IF NOT EXISTS public.clients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clients_phone ON public.clients(phone);

-- 3. TABELA DE SERVIÇOS (TABELA DE PREÇOS)
CREATE TABLE IF NOT EXISTS public.services (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    price NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
    duration INTEGER NOT NULL DEFAULT 30 CHECK (duration = 30),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. TABELA DE SEMANAS DA AGENDA (CONTROLE DE PUBLICAÇÃO SEMANAL)
CREATE TABLE IF NOT EXISTS public.weekly_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    week_start DATE NOT NULL UNIQUE, -- Segunda-feira da semana correspondente (YYYY-MM-DD)
    status TEXT NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho', 'publicada', 'fechada')),
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_weekly_schedules_week_start ON public.weekly_schedules(week_start);

-- 5. TABELA DE DIAS DA AGENDA SEMANAL
CREATE TABLE IF NOT EXISTS public.schedule_days (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    weekly_schedule_id UUID NOT NULL REFERENCES public.weekly_schedules(id) ON DELETE CASCADE,
    work_date DATE NOT NULL UNIQUE,
    day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    is_working BOOLEAN NOT NULL DEFAULT FALSE,
    start_time TEXT NOT NULL DEFAULT '09:00', -- Formato HH:mm
    end_time TEXT NOT NULL DEFAULT '18:00',   -- Formato HH:mm
    breaks JSONB NOT NULL DEFAULT '[]'::jsonb, -- Array de objetos [{"start": "12:00", "end": "13:00"}]
    status TEXT NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho', 'publicada', 'fechada')),
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_schedule_days_work_date ON public.schedule_days(work_date);

-- 6. TABELA DE AGENDAMENTOS
CREATE TABLE IF NOT EXISTS public.appointments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
    client_name TEXT NOT NULL,
    client_phone TEXT NOT NULL,
    appointment_date DATE NOT NULL,
    start_time TEXT NOT NULL, -- Formato HH:mm
    end_time TEXT NOT NULL,   -- Formato HH:mm
    total_duration INTEGER NOT NULL CHECK (total_duration >= 30 AND total_duration % 30 = 0),
    total_price NUMERIC(10, 2) NOT NULL CHECK (total_price >= 0),
    status TEXT NOT NULL DEFAULT 'confirmado' CHECK (status IN ('confirmado', 'concluido', 'cancelado')),
    payment_status TEXT NOT NULL DEFAULT 'pendente' CHECK (payment_status IN ('pendente', 'pago')),
    management_token TEXT NOT NULL UNIQUE,
    notes TEXT DEFAULT '',
    cancelled_by TEXT,
    cancelled_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_appointments_date_status ON public.appointments(appointment_date, status);
CREATE INDEX IF NOT EXISTS idx_appointments_token ON public.appointments(management_token);
CREATE INDEX IF NOT EXISTS idx_appointments_client ON public.appointments(client_id);

-- 7. TABELA DE ITENS DO AGENDAMENTO (HISTÓRICO IMUTÁVEL DE PREÇO E SERVIÇO NA CONTRATAÇÃO)
CREATE TABLE IF NOT EXISTS public.appointment_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    appointment_id UUID NOT NULL REFERENCES public.appointments(id) ON DELETE CASCADE,
    service_id UUID REFERENCES public.services(id) ON DELETE SET NULL,
    service_name TEXT NOT NULL,
    price NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
    duration INTEGER NOT NULL DEFAULT 30 CHECK (duration = 30),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_appointment_items_appointment ON public.appointment_items(appointment_id);

-- 8. TABELA DE LISTA DE ESPERA
CREATE TABLE IF NOT EXISTS public.waitlist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    week_start DATE,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    desired_services JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{id, name, price, duration}]
    preferred_days JSONB NOT NULL DEFAULT '[]'::jsonb,   -- ["2026-11-03", ...] ou nomes dos dias
    preferred_periods JSONB NOT NULL DEFAULT '[]'::jsonb, -- ["manha", "tarde", "noite"]
    status TEXT NOT NULL DEFAULT 'aguardando' CHECK (status IN ('aguardando', 'atendido', 'removido')),
    matched_opportunity BOOLEAN NOT NULL DEFAULT FALSE,
    matched_details TEXT DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_waitlist_status ON public.waitlist(status);

-- 9. TABELA DE NOTIFICAÇÕES WHATSAPP
CREATE TABLE IF NOT EXISTS public.notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_key TEXT UNIQUE, -- Chave de idempotência para evitar duplicidade
    type TEXT NOT NULL CHECK (type IN ('novo_agendamento', 'cancelamento_cliente', 'publicacao_agenda', 'atendimento_concluido')),
    recipient TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'enviada', 'falha', 'pendente_configuracao')),
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON public.notifications(status);

-- ============================================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================================
ALTER TABLE public.admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointment_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Políticas para Serviços: Clientes públicos podem ler apenas serviços ativos; Admin pode tudo
CREATE POLICY "Public read active services" ON public.services
    FOR SELECT USING (active = true OR auth.role() = 'authenticated' OR auth.role() = 'service_role');

CREATE POLICY "Admin full access services" ON public.services
    FOR ALL USING (auth.role() = 'authenticated' OR auth.role() = 'service_role');

-- Políticas para Agenda Semanal: Público lê apenas agendas publicadas/fechadas; Admin acesso total
CREATE POLICY "Public read published weekly schedules" ON public.weekly_schedules
    FOR SELECT USING (status IN ('publicada', 'fechada') OR auth.role() = 'authenticated' OR auth.role() = 'service_role');

CREATE POLICY "Admin full access weekly schedules" ON public.weekly_schedules
    FOR ALL USING (auth.role() = 'authenticated' OR auth.role() = 'service_role');

CREATE POLICY "Public read published schedule days" ON public.schedule_days
    FOR SELECT USING (status IN ('publicada', 'fechada') OR auth.role() = 'authenticated' OR auth.role() = 'service_role');

CREATE POLICY "Admin full access schedule days" ON public.schedule_days
    FOR ALL USING (auth.role() = 'authenticated' OR auth.role() = 'service_role');

-- Políticas para Clientes, Agendamentos, Lista de Espera e Notificações:
-- O acesso público nunca consulta diretamente a tabela de agendamentos ou clientes de terceiros;
-- toda operação pública passa pelas funções RPC seguras com SECURITY DEFINER ou pelo backend seguro.
CREATE POLICY "Admin full access admins" ON public.admins
    FOR ALL USING (auth.role() = 'authenticated' OR auth.role() = 'service_role');

CREATE POLICY "Admin full access clients" ON public.clients
    FOR ALL USING (auth.role() = 'authenticated' OR auth.role() = 'service_role');

CREATE POLICY "Admin full access appointments" ON public.appointments
    FOR ALL USING (auth.role() = 'authenticated' OR auth.role() = 'service_role');

CREATE POLICY "Admin full access appointment_items" ON public.appointment_items
    FOR ALL USING (auth.role() = 'authenticated' OR auth.role() = 'service_role');

CREATE POLICY "Admin full access waitlist" ON public.waitlist
    FOR ALL USING (auth.role() = 'authenticated' OR auth.role() = 'service_role');

CREATE POLICY "Admin full access notifications" ON public.notifications
    FOR ALL USING (auth.role() = 'authenticated' OR auth.role() = 'service_role');

-- ============================================================================
-- FUNÇÃO RPC ATÔMICA PARA RESERVA DE AGENDAMENTO (CONCORRÊNCIA SEGURA)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.book_appointment_atomic(
    p_client_name TEXT,
    p_client_phone TEXT,
    p_appointment_date DATE,
    p_start_time TEXT,
    p_end_time TEXT,
    p_total_duration INTEGER,
    p_total_price NUMERIC,
    p_management_token TEXT,
    p_items JSONB,
    p_is_admin BOOLEAN DEFAULT FALSE
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_day_record RECORD;
    v_conflict_count INTEGER;
    v_client_id UUID;
    v_appointment_id UUID;
    v_item JSONB;
BEGIN
    -- Bloqueio transacional por data do agendamento para impedir reservas simultâneas no mesmo horário
    PERFORM pg_advisory_xact_lock(hashtext('luan_barber_date_' || p_appointment_date::text));

    -- 1. Verificar se o dia existe e está publicado (caso não seja admin forçando encaixe)
    SELECT * INTO v_day_record
    FROM public.schedule_days
    WHERE work_date = p_appointment_date;

    IF NOT FOUND OR v_day_record.is_working = FALSE THEN
        RAISE EXCEPTION 'DIA_INDISPONIVEL: O barbeiro não atende nesta data.';
    END IF;

    IF NOT p_is_admin AND v_day_record.status != 'publicada' THEN
        RAISE EXCEPTION 'AGENDA_NAO_PUBLICADA: Aguarde a confirmação dos dias e horários disponíveis.';
    END IF;

    -- 2. Verificar se está dentro do horário de expediente do dia
    IF p_start_time < v_day_record.start_time OR p_end_time > v_day_record.end_time THEN
        RAISE EXCEPTION 'FORA_DO_EXPEDIENTE: Horário fora do expediente definido para este dia.';
    END IF;

    -- 3. Verificar conflito com intervalos de descanso
    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_day_record.breaks) AS brk
        WHERE p_start_time < (brk->>'end') AND p_end_time > (brk->>'start')
    ) THEN
        RAISE EXCEPTION 'CONFLITO_INTERVALO: O horário selecionado conflita com um intervalo de descanso.';
    END IF;

    -- 4. Verificar sobreposição com outros agendamentos ativos (confirmado ou concluido)
    SELECT COUNT(*) INTO v_conflict_count
    FROM public.appointments
    WHERE appointment_date = p_appointment_date
      AND status != 'cancelado'
      AND p_start_time < end_time
      AND p_end_time > start_time;

    IF v_conflict_count > 0 THEN
        RAISE EXCEPTION 'HORARIO_OCUPADO: Este horário acabou de ser ocupado por outro cliente. Por favor, escolha outro horário.';
    END IF;

    -- 5. Localizar ou criar cliente (por telefone se informado, ou por nome quando sem telefone)
    IF p_client_phone IS NOT NULL AND p_client_phone != '' THEN
        SELECT id INTO v_client_id
        FROM public.clients
        WHERE phone = p_client_phone
        LIMIT 1;
    ELSE
        SELECT id INTO v_client_id
        FROM public.clients
        WHERE lower(name) = lower(p_client_name) AND (phone = '' OR phone IS NULL)
        LIMIT 1;
    END IF;

    IF v_client_id IS NULL THEN
        INSERT INTO public.clients (name, phone)
        VALUES (p_client_name, COALESCE(p_client_phone, ''))
        RETURNING id INTO v_client_id;
    ELSE
        UPDATE public.clients
        SET name = p_client_name, updated_at = NOW()
        WHERE id = v_client_id;
    END IF;

    -- 6. Inserir o agendamento
    INSERT INTO public.appointments (
        client_id, client_name, client_phone,
        appointment_date, start_time, end_time,
        total_duration, total_price,
        status, payment_status, management_token
    ) VALUES (
        v_client_id, p_client_name, p_client_phone,
        p_appointment_date, p_start_time, p_end_time,
        p_total_duration, p_total_price,
        'confirmado', 'pendente', p_management_token
    ) RETURNING id INTO v_appointment_id;

    -- 7. Inserir os itens do agendamento (preservando nome e preço contratados)
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
        INSERT INTO public.appointment_items (
            appointment_id,
            service_id,
            service_name,
            price,
            duration
        ) VALUES (
            v_appointment_id,
            NULLIF(v_item->>'service_id', '')::UUID,
            v_item->>'service_name',
            (v_item->>'price')::NUMERIC,
             COALESCE((v_item->>'duration')::INTEGER, 30)
        );
    END LOOP;

    RETURN jsonb_build_object(
        'appointment_id', v_appointment_id,
        'client_id', v_client_id,
        'management_token', p_management_token
    );
END;
$$;

-- ============================================================================
-- DADOS INICIAIS DE DEMONSTRAÇÃO (TABELA DE PREÇOS INICIAL EDITÁVEL)
-- ============================================================================
INSERT INTO public.services (name, description, price, duration, active, sort_order)
SELECT * FROM (VALUES
    ('Corte tradicional', 'Corte clássico na tesoura ou máquina com acabamento completo.', 35.00, 30, TRUE, 1),
    ('Degradê', 'Corte degradê (fade) navalhado ou disfarçado com acabamento na navalha.', 40.00, 30, TRUE, 2),
    ('Barba', 'Modelagem e alinhamento de barba com toalha quente e navalha.', 25.00, 30, TRUE, 3),
    ('Corte + barba', 'Combo promocional de corte tradicional mais alinhamento de barba.', 55.00, 30, TRUE, 4)
) AS seed(name, description, price, duration, active, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM public.services LIMIT 1);

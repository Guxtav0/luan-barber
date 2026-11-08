# Luan Barber — Sistema de Agendamento e Gestão de Barbearia

Aplicação web completa, responsiva e funcional para agendamento de cortes, gestão de disponibilidade semanal, controle financeiro, tabela de preços, lista de espera e notificações pelo WhatsApp da barbearia **Luan Barber**.

---

## 1. Como Executar o Projeto

### Iniciar o Servidor
No Windows, basta executar o arquivo `start.bat` (dois cliques) ou rodar no terminal:

```powershell
agy-node src/server.js
# ou, caso possua Node.js global no PATH:
node src/server.js
```

O servidor iniciará por padrão em `http://localhost:3000`:
- **Área Pública (Agendamento do Cliente):** `http://localhost:3000/`
- **Painel Administrativo (Luan):** `http://localhost:3000/admin`
- **Link Individual do Cliente:** `http://localhost:3000/agendamento/:token`

### Credenciais Administrativas Padrão (Configuráveis no `.env`)
- **E-mail:** `luan@luanbarber.com.br`
- **Senha:** `LuanBarber@2026`

### Executar os Testes Automatizados
```powershell
agy-node --test tests/system.test.js
```

---

## 2. Estrutura do Projeto

- [`supabase/migrations/001_initial_schema.sql`](supabase/migrations/001_initial_schema.sql): Migração SQL completa para PostgreSQL / Supabase com tabelas relacionais, índices, políticas de Row Level Security (RLS) e função RPC atômica (`book_appointment_atomic`) com `pg_advisory_xact_lock` para controle de concorrência.
- [`src/server.js`](src/server.js): Servidor HTTP da aplicação.
- [`src/backend/config.js`](src/backend/config.js): Carregamento e validação de variáveis de ambiente (`.env`).
- [`src/backend/db/`](src/backend/db/index.js): Camada de persistência com adaptador oficial para **Supabase PostgreSQL** ([`supabase-adapter.js`](src/backend/db/supabase-adapter.js)) e banco relacional persistente local SQLite ([`sqlite-adapter.js`](src/backend/db/sqlite-adapter.js)) com transações `BEGIN IMMEDIATE`.
- [`src/backend/services/`](src/backend/services/): Regras de negócio desacopladas da interface:
  - [`schedule-service.js`](src/backend/services/schedule-service.js): Gestão da disponibilidade semanal, rascunho vs. publicação, geração de blocos de 30 minutos e detecção de conflitos de expediente.
  - [`appointment-service.js`](src/backend/services/appointment-service.js): Reserva atômica de blocos consecutivos, gerenciamento por token individual, regra de antecedência de 2 horas e edição manual pelo administrador.
  - [`waitlist-service.js`](src/backend/services/waitlist-service.js): Lista de espera e identificação automática de oportunidades quando um horário compatível é liberado.
  - [`finance-service.js`](src/backend/services/finance-service.js): Indicadores financeiros (faturamento recebido, pendente, cortes realizados, agendamentos futuros), filtros de período, inadimplência, ranking de clientes recorrentes e histórico.
  - [`service-catalog.js`](src/backend/services/service-catalog.js): Gestão da tabela de preços e serviços.
  - [`whatsapp-service.js`](src/backend/services/whatsapp-service.js): Camada independente de notificações WhatsApp Business (Meta Cloud API Oficial, Evolution API, Z-API, Webhook) com histórico, idempotência e retentativas.
- [`src/public/`](src/public/): Frontend responsivo mobile-first em Português Brasileiro (Preto, Branco, Cinza e cores semânticas Verde, Vermelho, Amarelo e Azul).

---

## 3. Variáveis de Ambiente (`.env`)

Consulte o arquivo [`.env.example`](.env.example) para a documentação detalhada de todas as variáveis:

| Variável | Descrição |
|---|---|
| `PORT` | Porta HTTP do servidor (padrão `3000`) |
| `SUPABASE_URL` | URL do projeto Supabase (ex: `https://xyz.supabase.co`) |
| `SUPABASE_ANON_KEY` | Chave pública `anon` do projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave administrativa `service_role` do Supabase (uso exclusivo no backend) |
| `SQLITE_DB_PATH` | Caminho do banco relacional local usado quando `SUPABASE_URL` não está preenchido |
| `AUTH_SECRET` | Chave secreta para assinatura de tokens de sessão administrativa |
| `ADMIN_DEFAULT_EMAIL` | E-mail inicial do administrador Luan |
| `ADMIN_DEFAULT_PASSWORD` | Senha inicial do administrador Luan |
| `WHATSAPP_PROVIDER` | Provedor WhatsApp (`meta_cloud`, `evolution`, `zapi` ou `webhook`) |
| `LUAN_WHATSAPP_NUMBER` | Telefone do Luan que recebe as notificações (ex: `5511999999999`) |
| `WHATSAPP_API_URL` | URL base da API do provedor WhatsApp |
| `WHATSAPP_PHONE_NUMBER_ID` | ID do número na Meta Cloud API Oficial |
| `WHATSAPP_API_TOKEN` | Token de autenticação da API do WhatsApp |
| `WHATSAPP_MAX_RETRIES` | Número máximo de tentativas automáticas de envio (padrão `3`) |

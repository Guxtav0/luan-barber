const fs = require('node:fs');
const path = require('node:path');

function loadEnvFile() {
  const envPath = path.resolve(__dirname, '../../.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex).trim();
    let val = line.slice(eqIndex + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

loadEnvFile();

function getConfig() {
  return {
    port: Number(process.env.PORT || 3000),
    tz: process.env.TZ || 'America/Sao_Paulo',
    supabase: {
      url: (process.env.SUPABASE_URL || '').trim(),
      anonKey: (process.env.SUPABASE_ANON_KEY || '').trim(),
      serviceRoleKey: (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
      get isConfigured() {
        return Boolean(this.url && (this.serviceRoleKey || this.anonKey));
      }
    },
    sqliteDbPath: process.env.SQLITE_DB_PATH
      ? path.resolve(process.cwd(), process.env.SQLITE_DB_PATH)
      : path.resolve(__dirname, '../../data/luan_barber.db'),
    auth: {
      secret: process.env.AUTH_SECRET || 'luan-barber-secret-key-change-in-production-2026',
      adminDefaultName: process.env.ADMIN_DEFAULT_NAME || 'Luan Barber',
      adminDefaultEmail: process.env.ADMIN_DEFAULT_EMAIL || 'luan@luanbarber.com.br',
      adminDefaultPassword: process.env.ADMIN_DEFAULT_PASSWORD || 'LuanBarber@2026'
    },
    whatsapp: {
      provider: (process.env.WHATSAPP_PROVIDER || 'meta_cloud').trim(),
      luanNumber: (process.env.LUAN_WHATSAPP_NUMBER || '5511999999999').replace(/\D/g, ''),
      apiUrl: (process.env.WHATSAPP_API_URL || '').trim(),
      phoneNumberId: (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim(),
      apiToken: (process.env.WHATSAPP_API_TOKEN || '').trim(),
      maxRetries: Number(process.env.WHATSAPP_MAX_RETRIES || 3),
      get isConfigured() {
        if (!this.luanNumber || !this.apiUrl || !this.apiToken) return false;
        if (this.provider === 'meta_cloud' && !this.phoneNumberId) return false;
        return true;
      }
    }
  };
}

module.exports = { getConfig, loadEnvFile };

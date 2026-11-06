const { getConfig } = require('../config');
const { SqliteAdapter } = require('./sqlite-adapter');
const { SupabaseAdapter } = require('./supabase-adapter');

let dbInstance = null;

function getDb() {
  if (dbInstance) return dbInstance;
  const config = getConfig();
  if (config.supabase.isConfigured) {
    dbInstance = new SupabaseAdapter();
  } else {
    dbInstance = new SqliteAdapter();
  }
  return dbInstance;
}

function setDbInstance(customAdapter) {
  dbInstance = customAdapter;
}

module.exports = { getDb, setDbInstance };

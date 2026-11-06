const { getDb } = require('../db');
const { formatCurrencyBR } = require('../utils/validators');

function enrichService(svc) {
  if (!svc) return null;
  return {
    ...svc,
    duration: 30,
    price_formatted: formatCurrencyBR(svc.price)
  };
}

async function listServices({ activeOnly = false } = {}) {
  const db = getDb();
  const list = await db.listServices({ activeOnly });
  return list.map(enrichService);
}

async function createService({ name, description = '', price, active = true }) {
  const db = getDb();
  const cleanName = String(name || '').trim();
  if (!cleanName) {
    const err = new Error('O nome do serviço é obrigatório.');
    err.statusCode = 400;
    throw err;
  }
  const numPrice = Number(price);
  if (Number.isNaN(numPrice) || numPrice < 0) {
    const err = new Error('Informe um valor válido para o serviço.');
    err.statusCode = 400;
    throw err;
  }

  const created = await db.createService({
    name: cleanName,
    description: String(description || '').trim(),
    price: numPrice,
    active: Boolean(active)
  });
  return enrichService(created);
}

async function updateService(id, { name, description, price, active }) {
  const db = getDb();
  if (name !== undefined && !String(name).trim()) {
    const err = new Error('O nome do serviço não pode ficar vazio.');
    err.statusCode = 400;
    throw err;
  }
  if (price !== undefined) {
    const numPrice = Number(price);
    if (Number.isNaN(numPrice) || numPrice < 0) {
      const err = new Error('Informe um valor válido para o serviço.');
      err.statusCode = 400;
      throw err;
    }
  }

  const updated = await db.updateService(id, { name, description, price, active });
  if (!updated) {
    const err = new Error('Serviço não encontrado.');
    err.statusCode = 404;
    throw err;
  }
  return enrichService(updated);
}

async function deleteService(id) {
  const db = getDb();
  const ok = await db.deleteService(id);
  if (!ok) {
    const err = new Error('Serviço não encontrado.');
    err.statusCode = 404;
    throw err;
  }
  return { deleted: true };
}

module.exports = {
  listServices,
  createService,
  updateService,
  deleteService
};

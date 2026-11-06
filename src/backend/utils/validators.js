function normalizePhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('55')) {
    return digits.slice(2);
  }
  if (digits.length === 12 && digits.startsWith('55')) {
    return digits.slice(2);
  }
  return digits;
}

function formatPhoneBR(phone) {
  const digits = normalizePhone(phone);
  if (!digits) return 'Não informado';
  if (digits.length === 11) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  return digits;
}

function formatCurrencyBR(value) {
  const num = Number(value || 0);
  return num.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });
}

function validateClientInput(name, phone) {
  const cleanName = String(name || '').trim();
  const cleanPhone = normalizePhone(phone);
  if (cleanName.length < 2) {
    return { valid: false, error: 'Por favor, informe o nome do cliente.' };
  }
  // O WhatsApp é opcional: se preenchido, armazenamos os dígitos normalizados; se vazio, segue normalmente.
  return { valid: true, name: cleanName, phone: cleanPhone };
}

module.exports = {
  normalizePhone,
  formatPhoneBR,
  formatCurrencyBR,
  validateClientInput
};

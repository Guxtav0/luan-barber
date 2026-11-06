const crypto = require('node:crypto');
const { getConfig } = require('../config');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${derivedKey}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.startsWith('scrypt$')) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3) return false;
  const [, salt, originalHex] = parts;
  const derivedHex = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(originalHex, 'hex');
  const b = Buffer.from(derivedHex, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function signAdminToken(payload, expiresInSeconds = 86400 * 7) {
  const { auth } = getConfig();
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(
    JSON.stringify({
      ...payload,
      iat: now,
      exp: now + expiresInSeconds
    })
  ).toString('base64url');
  const signature = crypto
    .createHmac('sha256', auth.secret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const { auth } = getConfig();
  const expectedSig = crypto
    .createHmac('sha256', auth.secret)
    .update(`${header}.${body}`)
    .digest('base64url');

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (decoded.exp && decoded.exp < now) return null;
    return decoded;
  } catch {
    return null;
  }
}

function generateManagementToken() {
  return crypto.randomBytes(24).toString('hex');
}

function generateUUID() {
  return crypto.randomUUID();
}

module.exports = {
  hashPassword,
  verifyPassword,
  signAdminToken,
  verifyAdminToken,
  generateManagementToken,
  generateUUID
};

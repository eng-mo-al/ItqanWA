'use strict';
const crypto = require('crypto');

const PREFIX = 'enc:v1:';

function keyFrom(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encrypt(plain, secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function decrypt(blob, secret) {
  if (typeof blob !== 'string' || !blob.startsWith(PREFIX)) return null;
  try {
    const raw = Buffer.from(blob.slice(PREFIX.length), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = { encrypt, decrypt, safeEqual };

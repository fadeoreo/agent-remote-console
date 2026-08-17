import crypto from 'node:crypto';

const KEY_BYTES = 32;
let generatedPassword = null;

function decodeHash(value) {
  const [saltHex, hashHex] = String(value || '').split(':');
  if (!/^[a-f0-9]{32,}$/i.test(saltHex || '') || !/^[a-f0-9]{64}$/i.test(hashHex || '')) return null;
  return { salt: Buffer.from(saltHex, 'hex'), hash: Buffer.from(hashHex, 'hex') };
}

function derive(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password || ''), salt, KEY_BYTES, (error, key) => error ? reject(error) : resolve(key));
  });
}

export function encodePassword(password) {
  const salt = crypto.randomBytes(16);
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, KEY_BYTES, (error, key) => {
      if (error) reject(error);
      else resolve(`${salt.toString('hex')}:${key.toString('hex')}`);
    });
  });
}

export function authenticationConfig() {
  const configuredHash = decodeHash(process.env.REMOTE_PASSWORD_HASH);
  const plainPassword = process.env.REMOTE_PASSWORD;
  if (configuredHash) return { ...configuredHash, source: 'hash' };
  if (plainPassword) return { password: plainPassword, source: 'environment' };
  generatedPassword ||= crypto.randomBytes(12).toString('base64url');
  return { password: generatedPassword, source: 'generated' };
}

export async function verifyConfiguredPassword(password, config) {
  if (config.password !== undefined) {
    const expected = Buffer.from(config.password);
    const actual = Buffer.from(String(password || ''));
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }
  const key = await derive(password, config.salt);
  return crypto.timingSafeEqual(key, config.hash);
}

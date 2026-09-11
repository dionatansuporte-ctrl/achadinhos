import crypto from 'node:crypto';

function key() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error('TOKEN_ENCRYPTION_KEY não configurada.');
  const k = Buffer.from(raw, 'base64');
  if (k.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY deve ser base64 de 32 bytes.');
  return k;
}

export function encryptSecret(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
}

export function decryptSecret(value: string) {
  const [ivB64, tagB64, dataB64] = value.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Segredo criptografado inválido.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

import { prisma } from '../db';
import { encryptSecret, decryptSecret } from './crypto';

/**
 * Credenciais das plataformas.
 * Ordem de precedência: valor salvo pela tela (banco, criptografado) > variável do .env.
 * O cache evita uma consulta por envio; o TTL curto faz a API e o worker
 * enxergarem em poucos segundos o que foi salvo pela interface.
 */

export const SETTING_KEYS = [
  'ML_CLIENT_ID', 'ML_CLIENT_SECRET', 'ML_REDIRECT_URI',
  'SHOPEE_APP_ID', 'SHOPEE_SECRET', 'SHOPEE_AFFILIATE_SUFFIX', 'ML_AFFILIATE_SUFFIX',
  'META_ACCESS_TOKEN', 'META_PHONE_NUMBER_ID', 'META_WABA_ID', 'META_IG_USER_ID', 'META_API_VERSION',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

const TTL_MS = 10_000;
let cache = new Map<string, string>();
let loadedAt = 0;

async function refresh() {
  const rows = await prisma.appSetting.findMany();
  const next = new Map<string, string>();
  for (const row of rows) {
    try {
      next.set(row.key, decryptSecret(row.valueEnc));
    } catch {
      // Valor gravado com outra TOKEN_ENCRYPTION_KEY: ignora e mantém o .env como fonte.
    }
  }
  cache = next;
  loadedAt = Date.now();
}

async function ensureFresh() {
  if (Date.now() - loadedAt > TTL_MS) await refresh();
}

/** Valor efetivo da credencial: o que foi salvo na tela, senão o .env. */
export async function getSecret(key: SettingKey): Promise<string | undefined> {
  await ensureFresh();
  const stored = cache.get(key);
  if (stored) return stored;
  const fromEnv = process.env[key];
  return fromEnv || undefined;
}

/** De onde veio o valor — usado pela tela de Configurações. */
export async function describeSecret(key: SettingKey) {
  await ensureFresh();
  const stored = cache.get(key);
  const fromEnv = process.env[key];
  const value = stored || fromEnv || '';
  return {
    key,
    filled: !!value,
    source: stored ? 'painel' : fromEnv ? 'env' : 'vazio',
    masked: mask(key, value)
  };
}

/** Nunca devolve o segredo inteiro para o navegador. */
function mask(key: SettingKey, value: string) {
  if (!value) return '';
  // Identificadores públicos podem aparecer por extenso; segredos, não.
  const publicKeys: string[] = ['SHOPEE_AFFILIATE_SUFFIX', 'ML_AFFILIATE_SUFFIX', 'ML_REDIRECT_URI', 'META_API_VERSION', 'ML_CLIENT_ID', 'SHOPEE_APP_ID', 'META_PHONE_NUMBER_ID', 'META_WABA_ID', 'META_IG_USER_ID', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_FROM'];
  if (publicKeys.includes(key)) return value;
  return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`;
}

/** Grava as credenciais enviadas pela tela. String vazia remove o valor salvo. */
export async function saveSecrets(values: Partial<Record<SettingKey, string>>, userId?: string) {
  for (const [key, raw] of Object.entries(values)) {
    if (!SETTING_KEYS.includes(key as SettingKey)) continue;
    const value = (raw ?? '').trim();
    if (!value) {
      await prisma.appSetting.deleteMany({ where: { key } });
      continue;
    }
    const valueEnc = encryptSecret(value);
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, valueEnc, updatedBy: userId },
      update: { valueEnc, updatedBy: userId }
    });
  }
  await refresh();
}

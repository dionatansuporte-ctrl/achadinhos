import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getSecret } from '../services/settings';
import { prisma } from '../db';
import { decryptSecret, encryptSecret } from '../services/crypto';

const base = 'https://auth.mercadolivre.com.br/authorization';
const api = 'https://api.mercadolibre.com/oauth/token';

/**
 * URL de retorno do OAuth. O DevCenter do Mercado Livre exige endereço público em HTTPS
 * (recusa localhost), então o OfertasDaHora.bat (opção Conectar Mercado Livre) abre um túnel temporário e grava a URL
 * em apps/api/ml-redirect.txt. Enquanto esse arquivo existir, ele manda; senão vale o que foi
 * salvo em Configurações; por último, o HTTPS local.
 */
// Página pública do usuário (GitHub Pages) que repassa ?code&state para a API local.
// Aceita pelo DevCenter porque é HTTPS num domínio público; não muda nunca.
export const DEFAULT_ML_REDIRECT = process.env.ML_REDIRECT_DEFAULT || 'https://dionatansuporte-ctrl.github.io/boot-link/ml-callback.html';
const TUNNEL_FILE = path.resolve(process.cwd(), 'ml-redirect.txt');
export async function mlRedirectUri() {
  try {
    if (fs.existsSync(TUNNEL_FILE)) {
      const v = fs.readFileSync(TUNNEL_FILE, 'utf8').trim();
      if (/^https:\/\/[^\s]+\/api\/integrations\/mercadolivre\/callback$/.test(v)) return v;
    }
  } catch { /* sem túnel */ }
  return (await getSecret('ML_REDIRECT_URI')) || DEFAULT_ML_REDIRECT;
}

export function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export async function buildMercadoLivreAuthorizationUrl(state: string, challenge?: string) {
  const p = new URLSearchParams({ response_type: 'code', client_id: (await getSecret('ML_CLIENT_ID')) || '', redirect_uri: await mlRedirectUri(), state });
  if (challenge) { p.set('code_challenge', challenge); p.set('code_challenge_method', 'S256'); }
  return `${base}?${p.toString()}`;
}

export async function exchangeMercadoLivreCode(code: string, verifier?: string) {
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: (await getSecret('ML_CLIENT_ID')) || '', client_secret: (await getSecret('ML_CLIENT_SECRET')) || '', code, redirect_uri: await mlRedirectUri() });
  if (verifier) body.set('code_verifier', verifier);
  const r = await fetch(api, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.message || data?.error || 'Falha ao trocar código do Mercado Livre.');
  return data as { access_token: string; refresh_token: string; expires_in: number; user_id: number; scope: string };
}

export async function refreshMercadoLivreToken(refreshToken: string) {
  const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: (await getSecret('ML_CLIENT_ID')) || '', client_secret: (await getSecret('ML_CLIENT_SECRET')) || '', refresh_token: refreshToken });
  const r = await fetch(api, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.message || data?.error || 'Falha ao renovar token do Mercado Livre.');
  return data as { access_token: string; refresh_token: string; expires_in: number; user_id: number; scope: string };
}

/**
 * Token de acesso pronto para uso: se estiver vencido (ou a menos de 2 min de vencer),
 * renova na hora com o refresh_token e grava. Assim a busca não depende do worker estar vivo.
 */
export async function getMercadoLivreAccessToken(userId: string): Promise<string> {
  const acc = await prisma.affiliateAccount.findUnique({ where: { userId_marketplace: { userId, marketplace: 'MERCADO_LIVRE' } } });
  if (!acc?.accessToken) throw new Error('Mercado Livre não conectado: clique em "Conectar" no card do Mercado Livre em Configurações.');
  let access: string; let refresh: string | undefined;
  try { access = decryptSecret(acc.accessToken); refresh = acc.refreshToken ? decryptSecret(acc.refreshToken) : undefined; }
  catch { throw new Error('Token do Mercado Livre ilegível: reconecte a conta em Configurações.'); }
  const vencido = !acc.expiresAt || acc.expiresAt.getTime() < Date.now() + 2 * 60 * 1000;
  if (!vencido) return access;
  if (!refresh) throw new Error('Token do Mercado Livre vencido e sem renovação: reconecte a conta em Configurações.');
  let r: Awaited<ReturnType<typeof refreshMercadoLivreToken>>;
  try { r = await refreshMercadoLivreToken(refresh); }
  catch (e: any) { throw new Error(`Não consegui renovar o token do Mercado Livre (${e?.message || 'erro'}). Reconecte a conta em Configurações.`); }
  await prisma.affiliateAccount.update({ where: { id: acc.id }, data: { accessToken: encryptSecret(r.access_token), refreshToken: encryptSecret(r.refresh_token), expiresAt: new Date(Date.now() + r.expires_in * 1000), externalUserId: String(r.user_id) } });
  return r.access_token;
}

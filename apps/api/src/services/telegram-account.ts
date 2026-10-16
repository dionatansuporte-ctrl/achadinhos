import path from 'node:path';
import bigInt from 'big-integer';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Logger, LogLevel } from 'telegram/extensions/Logger';
import { prisma } from '../db';
import { getSecret, saveSecrets } from './settings';
import { readJson, writeJsonAtomic } from './json-file';
import { groupMembersForGuard } from '../integrations/whatsapp-web';

/**
 * Conta do Telegram do usuário (pedido em 2026-10-16: "colocar contato salvo dentro do Telegram" e "copiar contato de um
 * grupo para outro"). O bot não consegue colocar ninguém em grupo; só uma conta de pessoa consegue. Então, igual ao
 * WhatsApp (Baileys), aqui o sistema entra com o número do usuário (MTProto, biblioteca GramJS): telefone → código que
 * chega no app do Telegram → senha de duas etapas, se tiver. A sessão fica criptografada em TELEGRAM_USER_SESSION.
 * Precisa de api_id/api_hash de https://my.telegram.org (Configurações → Telegram).
 *
 * Importação para um grupo do Telegram do próprio usuário, com origem em:
 *   - telefones colados ou contatos salvos (importa na agenda do Telegram e vê quem tem conta);
 *   - outro grupo do Telegram de que o usuário participa (lista de membros);
 *   - um grupo do WhatsApp conectado (telefones dos membros);
 *   - os clientes do WhatsApp (tela Clientes).
 * Regras fixas, porque o Telegram suspende conta que adiciona gente em excesso: uma pessoa por vez com pausa mínima de
 * 20 s, no máximo 100 por dia (soma de todas as importações, em disco), respeita a espera que o Telegram pedir
 * (FLOOD_WAIT) e para no bloqueio do dia (PEER_FLOOD). Quem já foi adicionado num grupo nunca é tentado de novo nele.
 * Quem tem a privacidade "só contatos podem me adicionar" simplesmente não entra: o sistema não manda mensagem a ninguém.
 */

const SESSION_KEY = 'TELEGRAM_USER_SESSION';
const COPIES_FILE = path.resolve(__dirname, '../../.cache/telegram-copies.json');
const ADDS_FILE = path.resolve(__dirname, '../../.cache/telegram-adds.json');
const ADDED_FILE = path.resolve(__dirname, '../../.cache/telegram-added.json');
export const MIN_PAUSE_SEC = 20;
export const MAX_DAILY = 100;
const spDay = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
function nextSpMidnight() { const [y, m, d] = spDay().split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + 1, 3, 0, 5)); }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------- conexão ----------
export type AccountStatus = 'disconnected' | 'connecting' | 'code_sent' | 'password_needed' | 'connected' | 'error';
export type AccountState = { status: AccountStatus; phone: string | null; me: { id: string; name: string; username: string | null; phone: string | null } | null; error: string | null; hasApi: boolean };
const state: AccountState = { status: 'disconnected', phone: null, me: null, error: null, hasApi: false };
let client: TelegramClient | null = null;
let pending: { client: TelegramClient; phone: string; phoneCodeHash: string } | null = null;

async function apiCreds() {
  const id = Number((await getSecret('TELEGRAM_API_ID') || '').trim());
  const hash = (await getSecret('TELEGRAM_API_HASH') || '').trim();
  state.hasApi = !!(id && hash);
  if (!id || !hash) throw new Error('Informe o api_id e o api_hash do Telegram em Configurações → Telegram (crie em https://my.telegram.org, "API development tools").');
  return { apiId: id, apiHash: hash };
}
function newClient(session: string, apiId: number, apiHash: string) {
  return new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 3, baseLogger: new Logger(LogLevel.ERROR), deviceModel: 'Robô das Ofertas', appVersion: '1.0' });
}
function meInfo(u: any) {
  return { id: String(u.id), name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || String(u.id), username: u.username || null, phone: u.phone ? `+${u.phone}` : null };
}

export async function getAccountState(): Promise<AccountState> {
  try { await apiCreds(); } catch { /* hasApi já ficou false */ }
  return { ...state };
}

/** Entra com a sessão salva (ao ligar o sistema e quando alguma rota precisa do cliente). */
export async function connectSavedAccount(): Promise<TelegramClient | null> {
  if (client?.connected) return client;
  const saved = (await getSecret(SESSION_KEY) || '').trim();
  if (!saved) { if (!pending) state.status = 'disconnected'; return null; }
  let creds; try { creds = await apiCreds(); } catch (e: any) { state.status = 'error'; state.error = e.message; return null; }
  state.status = 'connecting'; state.error = null;
  try {
    const c = client || newClient(saved, creds.apiId, creds.apiHash);
    await c.connect();
    const me: any = await c.getMe();
    client = c; state.me = meInfo(me); state.phone = state.me.phone; state.status = 'connected';
    return c;
  } catch (e: any) {
    const msg = String(e?.errorMessage || e?.message || e);
    const dead = /AUTH_KEY|SESSION_REVOKED|USER_DEACTIVATED/i.test(msg);
    state.status = 'error'; state.error = dead ? 'A sessão do Telegram foi encerrada no celular. Conecte de novo.' : `Não consegui conectar ao Telegram: ${msg}`;
    if (dead) { await saveSecrets({ [SESSION_KEY]: '' }).catch(() => {}); client = null; }
    return null;
  }
}
async function needClient() {
  const c = await connectSavedAccount();
  if (!c) throw new Error(state.error || 'Conecte a sua conta do Telegram primeiro (telefone e código).');
  return c;
}

/** Passo 1 do login: manda o código para o app do Telegram (ou SMS) do telefone informado. */
export async function startLogin(phoneRaw: string) {
  const phone = '+' + phoneRaw.replace(/\D/g, '');
  if (phone.length < 9) throw new Error('Informe o telefone com DDI e DDD, ex.: 5544999999999.');
  const { apiId, apiHash } = await apiCreds();
  if (pending) { try { await pending.client.disconnect(); } catch { /* segue */ } pending = null; }
  const c = newClient('', apiId, apiHash);
  await c.connect();
  try {
    const r = await c.sendCode({ apiId, apiHash }, phone);
    pending = { client: c, phone, phoneCodeHash: r.phoneCodeHash };
    state.status = 'code_sent'; state.phone = phone; state.error = null;
    return { viaApp: r.isCodeViaApp };
  } catch (e: any) {
    try { await c.disconnect(); } catch { /* segue */ }
    const msg = String(e?.errorMessage || e?.message || e);
    if (/PHONE_NUMBER_INVALID/.test(msg)) throw new Error('Telefone inválido para o Telegram. Use DDI + DDD + número, só dígitos.');
    if (/PHONE_NUMBER_BANNED/.test(msg)) throw new Error('Esse número está banido do Telegram.');
    if (/FLOOD/.test(msg)) throw new Error('O Telegram pediu para esperar antes de mandar outro código. Tente mais tarde.');
    if (/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/.test(msg)) throw new Error('api_id/api_hash inválidos. Confira em Configurações → Telegram.');
    throw new Error(`Não consegui pedir o código: ${msg}`);
  }
}

/** Passo 2: código (e a senha de duas etapas, se o Telegram pedir). Salva a sessão e deixa conectado. */
export async function finishLogin(code: string, password?: string) {
  if (!pending) throw new Error('Peça o código primeiro.');
  const { client: c, phone, phoneCodeHash } = pending;
  const { apiId, apiHash } = await apiCreds();
  const withPassword = async (pwd: string) => c.signInWithPassword({ apiId, apiHash }, { password: async () => pwd, onError: async (err: any) => { throw err; } });
  try {
    if (state.status === 'password_needed') {
      if (!password) throw new Error('Informe a senha de duas etapas do Telegram.');
      await withPassword(password);
    } else {
      try { await c.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code.replace(/\D/g, '') })); }
      catch (e: any) {
        if (!String(e?.errorMessage || '').includes('SESSION_PASSWORD_NEEDED')) throw e;
        if (!password) { state.status = 'password_needed'; return { passwordNeeded: true }; }
        await withPassword(password);
      }
    }
    const session = String((c.session as StringSession).save());
    await saveSecrets({ [SESSION_KEY]: session });
    const me: any = await c.getMe();
    if (client && client !== c) { try { await client.disconnect(); } catch { /* segue */ } }
    client = c; pending = null;
    state.me = meInfo(me); state.phone = state.me.phone || phone; state.status = 'connected'; state.error = null;
    return { passwordNeeded: false, me: state.me };
  } catch (e: any) {
    const msg = String(e?.errorMessage || e?.message || e);
    if (/PHONE_CODE_INVALID/.test(msg)) throw new Error('Código errado. Confira no app do Telegram e tente de novo.');
    if (/PHONE_CODE_EXPIRED/.test(msg)) { pending = null; state.status = 'disconnected'; throw new Error('O código venceu. Peça outro.'); }
    if (/PASSWORD_HASH_INVALID|PASSWORD_INVALID/.test(msg)) throw new Error('Senha de duas etapas errada.');
    if (/SESSION_PASSWORD_NEEDED/.test(msg)) { state.status = 'password_needed'; return { passwordNeeded: true }; }
    throw new Error(msg);
  }
}

export async function logoutAccount() {
  if (client) { try { await client.invoke(new Api.auth.LogOut()); } catch { /* já saiu */ } try { await client.disconnect(); } catch { /* segue */ } }
  if (pending) { try { await pending.client.disconnect(); } catch { /* segue */ } }
  client = null; pending = null;
  await saveSecrets({ [SESSION_KEY]: '' });
  Object.assign(state, { status: 'disconnected', phone: null, me: null, error: null });
}

// ---------- grupos e membros ----------
export type TgGroup = { id: string; title: string; username: string | null; members: number | null; kind: 'grupo' | 'supergrupo' | 'canal'; canInvite: boolean };
const entityCache = new Map<string, any>();

/** Grupos, supergrupos e canais de que a conta participa. */
export async function listAccountGroups(): Promise<TgGroup[]> {
  const c = await needClient();
  const dialogs = await c.getDialogs({ limit: 400 });
  const out: TgGroup[] = [];
  for (const d of dialogs) {
    const e: any = d.entity;
    if (!e || !(d.isGroup || d.isChannel)) continue;
    if (e.className === 'ChatForbidden' || e.className === 'ChannelForbidden' || e.left || e.kicked || e.deactivated) continue;
    const id = String(d.id);
    entityCache.set(id, e);
    const kind: TgGroup['kind'] = e.className === 'Chat' ? 'grupo' : e.broadcast ? 'canal' : 'supergrupo';
    const canInvite = !!(e.creator || e.adminRights?.inviteUsers || (kind !== 'canal' && e.defaultBannedRights && !e.defaultBannedRights.inviteUsers));
    out.push({ id, title: d.title || e.title || id, username: e.username || null, members: e.participantsCount ?? null, kind, canInvite });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
}
async function resolveGroup(id: string) {
  if (!entityCache.has(id)) await listAccountGroups();
  const e = entityCache.get(id);
  if (!e) throw new Error('Grupo não encontrado entre os seus grupos do Telegram. Atualize a lista.');
  return e;
}

export type Candidate = { key: string; name: string; phone?: string; userId?: string; accessHash?: string };
function userCandidate(u: any): Candidate | null {
  if (!u || u.className !== 'User' || u.bot || u.deleted || u.self) return null;
  return { key: String(u.id), name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || String(u.id), userId: String(u.id), accessHash: u.accessHash ? String(u.accessHash) : undefined };
}
/** Membros de um grupo do Telegram (sem bots, sem contas apagadas, sem a própria conta). */
export async function groupMembers(groupId: string, limit = 20000): Promise<{ title: string; members: Candidate[] }> {
  const c = await needClient();
  const e = await resolveGroup(groupId);
  let users: any[] = [];
  try { users = await c.getParticipants(e, { limit }); }
  catch (err: any) {
    const msg = String(err?.errorMessage || err?.message || err);
    if (/CHAT_ADMIN_REQUIRED|CHANNEL_PRIVATE/.test(msg)) throw new Error('O Telegram não mostra a lista de membros desse grupo para a sua conta (precisa ser administrador, ou o grupo esconde os membros).');
    throw new Error(`Não consegui ler os membros: ${msg}`);
  }
  const members = users.map(userCandidate).filter((x): x is Candidate => !!x);
  return { title: e.title || groupId, members };
}
const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');
export const phoneCandidate = (p: string, name?: string | null): Candidate | null => { const d = digits(p); return d.length >= 10 && d.length <= 15 ? { key: 'p' + d, name: name || `+${d}`, phone: d } : null; };

/** Telefones dos membros de um grupo do WhatsApp conectado. */
export async function whatsappGroupCandidates(groupId: string) {
  const g = await groupMembersForGuard(groupId);
  return { title: g.name, members: g.members.filter(m => !m.mine && m.phone).map(m => phoneCandidate(m.phone!, m.name)).filter((x): x is Candidate => !!x) };
}
/** Telefones dos clientes do WhatsApp (tela Clientes) deste usuário. */
export async function customerCandidates(userId: string) {
  const rows = await prisma.customer.findMany({ where: { userId, blocked: false, optedOut: false, phone: { not: null } }, select: { phone: true, givenName: true, name: true } });
  return rows.map(r => phoneCandidate(r.phone!, r.givenName || r.name)).filter((x): x is Candidate => !!x);
}

// ---------- importação ----------
export type TgCopy = {
  toId: string; toName: string; fromLabel: string; sourceType: 'phones' | 'telegram' | 'whatsapp' | 'customers';
  pauseSec: number; dailyLimit: number;
  total: number; done: number; added: number; noTelegram: number; privacy: number; already: number; failed: number;
  running: boolean; stopped: boolean; error: string | null; waitingUntil: string | null; startedAt: string; finishedAt: string | null;
  log: { name: string; result: string; at: string }[];
};
type Entry = { job: TgCopy; rest: Candidate[] };
const copies = new Map<string, Entry>();
for (const e of readJson<Entry[]>(COPIES_FILE, [])) {
  if (!e?.job?.toId) continue;
  e.job.running = false;
  if (e.rest?.length && !e.job.stopped && !e.job.error) e.job.error = 'O sistema foi reiniciado no meio. Clique em Continuar.';
  copies.set(e.job.toId, e);
}
function saveCopies() { try { writeJsonAtomic(COPIES_FILE, [...copies.values()]); } catch (e: any) { console.warn('[telegram conta] não salvou o progresso:', e?.message || e); } }

function readAdds() { const j = readJson<any>(ADDS_FILE, {}); return j.day === spDay() ? Number(j.count) || 0 : 0; }
export const addsToday = () => readAdds();
function countAdd() { try { writeJsonAtomic(ADDS_FILE, { day: spDay(), count: readAdds() + 1 }); } catch { /* segue */ } }
function addedBefore(toId: string) { return new Set(readJson<Record<string, string[]>>(ADDED_FILE, {})[toId] || []); }
function rememberAdded(toId: string, key: string) {
  try { const all = readJson<Record<string, string[]>>(ADDED_FILE, {}); all[toId] = [...new Set([...(all[toId] || []), key])]; writeJsonAtomic(ADDED_FILE, all); } catch { /* segue */ }
}
const clampPace = (p: { pauseSec?: number; dailyLimit?: number }) => ({
  ...(p.pauseSec != null ? { pauseSec: Math.max(MIN_PAUSE_SEC, Math.min(3600, Math.round(p.pauseSec))) } : {}),
  ...(p.dailyLimit != null ? { dailyLimit: Math.max(1, Math.min(MAX_DAILY, Math.round(p.dailyLimit))) } : {})
});

export const copyPayload = () => ({ addedToday: addsToday(), maxDaily: MAX_DAILY, minPauseSec: MIN_PAUSE_SEC, jobs: [...copies.values()].sort((a, b) => b.job.startedAt.localeCompare(a.job.startedAt)).map(e => ({ ...e.job, left: e.rest.length, log: e.job.log.slice(-60).reverse() })) });

function logLine(job: TgCopy, name: string, result: string) { job.log.push({ name, result, at: new Date().toISOString() }); if (job.log.length > 300) job.log.splice(0, job.log.length - 300); }

/** Monta e começa uma importação. `candidates` já vem resolvido pela rota conforme a origem. */
export async function startCopy(opts: { toId: string; fromLabel: string; sourceType: TgCopy['sourceType']; candidates: Candidate[]; pauseSec?: number; dailyLimit?: number }) {
  await needClient();
  const old = copies.get(opts.toId);
  if (old?.job.running) throw new Error(`Já existe uma importação rodando para "${old.job.toName}". Pare ela antes.`);
  const target = await resolveGroup(opts.toId);
  const g = (await listAccountGroups()).find(x => x.id === opts.toId);
  if (g && !g.canInvite) throw new Error(`A sua conta não tem permissão para adicionar pessoas em "${g.title}". Peça para ser administrador com "Adicionar membros".`);
  // Pula quem já foi adicionado por aqui e quem já está no grupo (lista de membros do destino, quando dá para ler).
  const skip = addedBefore(opts.toId);
  let inTarget = new Set<string>();
  try { inTarget = new Set((await groupMembers(opts.toId)).members.map(m => m.key)); } catch { /* sem lista: o Telegram avisa na hora (USER_ALREADY_PARTICIPANT) */ }
  const seen = new Set<string>();
  const rest = opts.candidates.filter(x => { if (seen.has(x.key) || skip.has(x.key) || inTarget.has(x.key)) return false; seen.add(x.key); return true; });
  const already = opts.candidates.length - rest.length;
  if (!rest.length) throw new Error(already ? 'Todo mundo dessa origem já está no grupo (ou já foi adicionado por aqui).' : 'A origem não tem ninguém para adicionar.');
  const pace = { pauseSec: 30, dailyLimit: 40, ...clampPace(opts) };
  const job: TgCopy = { toId: opts.toId, toName: target.title || opts.toId, fromLabel: opts.fromLabel, sourceType: opts.sourceType, ...pace,
    total: rest.length, done: 0, added: 0, noTelegram: 0, privacy: 0, already, failed: 0, running: true, stopped: false, error: null, waitingUntil: null, startedAt: new Date().toISOString(), finishedAt: null, log: [] };
  const entry: Entry = { job, rest };
  copies.set(opts.toId, entry); saveCopies();
  runCopy(entry);
  return copyPayload();
}

export function stopCopy(toId: string) { const e = copies.get(toId); if (!e) throw new Error('Não achei essa importação.'); if (!e.job.running) throw new Error('Essa importação não está rodando.'); e.job.stopped = true; saveCopies(); return copyPayload(); }
export async function resumeCopy(toId: string, patch: { pauseSec?: number; dailyLimit?: number }) {
  const e = copies.get(toId); if (!e) throw new Error('Não achei essa importação.');
  if (e.job.running) throw new Error('Essa importação ainda está rodando.');
  if (!e.rest.length) throw new Error('Não falta ninguém nessa importação.');
  await needClient();
  Object.assign(e.job, clampPace(patch), { stopped: false, error: null, finishedAt: null, running: true, waitingUntil: null }); saveCopies();
  runCopy(e); return copyPayload();
}
export function updateCopy(toId: string, patch: { pauseSec?: number; dailyLimit?: number }) { const e = copies.get(toId); if (!e) throw new Error('Não achei essa importação.'); Object.assign(e.job, clampPace(patch)); saveCopies(); return copyPayload(); }
export function removeCopy(toId: string) { const e = copies.get(toId); if (!e) throw new Error('Não achei essa importação.'); if (e.job.running) throw new Error('Pare a importação antes de tirar da lista.'); copies.delete(toId); saveCopies(); return copyPayload(); }

const inputUser = (x: Candidate) => new Api.InputUser({ userId: bigInt(x.userId!), accessHash: bigInt(x.accessHash || '0') });

/** Adiciona uma pessoa (já com userId) ao grupo. Devolve o resultado em palavras. */
async function addOne(c: TelegramClient, target: any, x: Candidate): Promise<string> {
  try {
    if (target.className === 'Chat') {
      await c.invoke(new Api.messages.AddChatUser({ chatId: target.id, userId: inputUser(x), fwdLimit: 0 }));
      return 'added';
    }
    const r: any = await c.invoke(new Api.channels.InviteToChannel({ channel: target, users: [inputUser(x)] }));
    // Camadas novas: quem não deixa ser adicionado vem em missingInvitees em vez de erro.
    if (r?.missingInvitees?.length) return 'privacy';
    return 'added';
  } catch (e: any) {
    const msg = String(e?.errorMessage || e?.message || e);
    if (/USER_PRIVACY_RESTRICTED|USER_NOT_MUTUAL_CONTACT/.test(msg)) return 'privacy';
    if (/USER_ALREADY_PARTICIPANT/.test(msg)) return 'already';
    if (/USER_KICKED|USER_BANNED_IN_CHANNEL/.test(msg)) return 'failed:foi removido/banido desse grupo antes';
    if (/USER_CHANNELS_TOO_MUCH/.test(msg)) return 'failed:a pessoa já está em grupos demais';
    if (/USER_BOT|USER_ID_INVALID|INPUT_USER_DEACTIVATED|USER_BLOCKED/.test(msg)) return 'failed:conta inválida ou apagada';
    throw e; // FLOOD_WAIT, PEER_FLOOD, CHAT_ADMIN_REQUIRED, USERS_TOO_MUCH...: quem chama decide
  }
}

/** Importa telefones na agenda do Telegram e devolve quem tem conta (em lotes de até 10). */
async function importPhones(c: TelegramClient, batch: Candidate[]): Promise<Map<string, Candidate>> {
  const contacts = batch.map((x, i) => new Api.InputPhoneContact({ clientId: bigInt(i), phone: '+' + x.phone!, firstName: x.name.startsWith('+') ? 'Contato' : x.name.slice(0, 60), lastName: '' }));
  const r: any = await c.invoke(new Api.contacts.ImportContacts({ contacts }));
  const found = new Map<string, Candidate>();
  const byId = new Map<string, any>((r.users || []).map((u: any) => [String(u.id), u]));
  for (const imp of r.imported || []) {
    const src = batch[Number(imp.clientId)]; const u = byId.get(String(imp.userId));
    const cand = u ? userCandidate(u) : null;
    if (src && cand) found.set(src.key, { ...cand, key: src.key, phone: src.phone, name: src.name.startsWith('+') ? cand.name : src.name });
  }
  if (r.retryContacts?.length) throw Object.assign(new Error('FLOOD_WAIT_60'), { errorMessage: 'FLOOD_WAIT_60', seconds: 60 });
  return found;
}

async function waitOrStop(job: TgCopy, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (job.stopped) return false; await sleep(Math.min(5000, until - Date.now())); }
  return !job.stopped;
}

function runCopy(entry: Entry) {
  const { job } = entry;
  (async () => {
    const c = await needClient();
    const target = await resolveGroup(job.toId);
    const finish = (err: string | null) => { job.running = false; job.error = err; job.waitingUntil = null; if (!err && !entry.rest.length) job.finishedAt = new Date().toISOString(); saveCopies(); };
    const pendingPhones: Candidate[] = [];
    while (entry.rest.length || pendingPhones.length) {
      if (job.stopped) return finish(null);
      // Limite do dia: espera a meia-noite de Brasília (continua sozinho), a menos que a pessoa pare.
      if (addsToday() >= job.dailyLimit) {
        job.waitingUntil = nextSpMidnight().toISOString(); saveCopies();
        if (!await waitOrStop(job, nextSpMidnight().getTime() - Date.now())) return finish(null);
        job.waitingUntil = null; continue;
      }
      let x: Candidate | undefined;
      try {
        // Telefones: resolve de 10 em 10 pela agenda, depois adiciona um por um.
        if (!pendingPhones.length && entry.rest[0]?.phone && !entry.rest[0]?.userId) {
          const batch = entry.rest.splice(0, Math.min(10, entry.rest.length));
          let found: Map<string, Candidate>;
          try { found = await importPhones(c, batch); }
          catch (e) { entry.rest.unshift(...batch); throw e; }
          for (const b of batch) {
            if (found.has(b.key)) pendingPhones.push(found.get(b.key)!);
            else { job.done++; job.noTelegram++; logLine(job, b.name, 'sem Telegram nesse número'); }
          }
          saveCopies();
          if (!pendingPhones.length) continue;
        }
        x = pendingPhones.length ? pendingPhones.shift()! : entry.rest.shift()!;
        if (!x.userId) { job.done++; job.failed++; logLine(job, x.name, 'sem identificação no Telegram'); continue; }
        countAdd();
        const r = await addOne(c, target, x);
        job.done++;
        if (r === 'added') { job.added++; rememberAdded(job.toId, x.key); logLine(job, x.name, 'adicionado ✅'); }
        else if (r === 'already') { job.already++; rememberAdded(job.toId, x.key); logLine(job, x.name, 'já estava no grupo'); }
        else if (r === 'privacy') { job.privacy++; logLine(job, x.name, 'não deixa ser adicionado (privacidade do Telegram)'); }
        else { job.failed++; logLine(job, x.name, r.replace(/^failed:/, '')); }
        saveCopies();
        if (!await waitOrStop(job, job.pauseSec * 1000)) return finish(null);
      } catch (e: any) {
        const msg = String(e?.errorMessage || e?.message || e);
        const m = /FLOOD_WAIT_(\d+)/.exec(msg); const secs = m ? Number(m[1]) : e?.seconds;
        if (x) entry.rest.unshift(x);
        if (secs) {
          // O Telegram pediu para esperar: espera o que ele mandou (e mais um pouco) e segue.
          const ms = (Number(secs) + 15) * 1000;
          job.waitingUntil = new Date(Date.now() + ms).toISOString(); logLine(job, 'Telegram', `pediu para esperar ${Math.ceil(ms / 60000)} min`); saveCopies();
          if (!await waitOrStop(job, ms)) return finish(null);
          job.waitingUntil = null; continue;
        }
        if (/PEER_FLOOD/.test(msg)) return finish('O Telegram limitou a sua conta por hoje (PEER_FLOOD). Amanhã clique em Continuar, com um ritmo mais lento.');
        if (/CHAT_ADMIN_REQUIRED|CHAT_WRITE_FORBIDDEN|RIGHT_FORBIDDEN/.test(msg)) return finish('A sua conta não tem permissão para adicionar pessoas nesse grupo.');
        if (/USERS_TOO_MUCH|CHANNELS_TOO_MUCH/.test(msg)) return finish('O grupo chegou ao limite de membros do Telegram.');
        if (/AUTH_KEY|SESSION_REVOKED|USER_DEACTIVATED/.test(msg)) { client = null; return finish('A sessão do Telegram foi encerrada. Conecte de novo e clique em Continuar.'); }
        return finish(`Erro do Telegram: ${msg}`);
      }
    }
    finish(null);
  })().catch(e => { job.running = false; job.error = e?.message || String(e); saveCopies(); });
}

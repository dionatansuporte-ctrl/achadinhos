import path from 'node:path';
import fs from 'node:fs';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WASocket
} from '@whiskeysockets/baileys';

/**
 * Sessão do WhatsApp via WhatsApp Web (Baileys), para envio em grupos.
 * A API oficial da Meta não lista nem envia para grupos; este caminho conecta o
 * número do usuário como um aparelho pareado, por QR code.
 *
 * Só pode existir UMA sessão por número, então este módulo roda apenas no
 * processo da API. O worker envia por meio do endpoint interno /internal/whatsapp/send.
 */

export type WaStatus = 'disconnected' | 'connecting' | 'qr' | 'connected';

export type WaGroup = { id: string; name: string; participants: number };

const AUTH_DIR = path.resolve(process.cwd(), '.wa-auth');
const logger = pino({ level: 'silent' });

let sock: WASocket | null = null;
let status: WaStatus = 'disconnected';
let qrDataUrl: string | null = null;
let me: { id: string; name?: string } | null = null;
let lastError: string | null = null;
let starting: Promise<void> | null = null;

export function getWaState() {
  return { status, qr: qrDataUrl, me, error: lastError };
}

/** Mensagem de texto recebida no privado (grupos, status e as próprias mensagens ficam de fora). */
// text vazio = mensagem sem texto (áudio, foto, figurinha...); `media` diz o que era.
export type WaMedia = 'audio' | 'image' | 'video' | 'sticker' | 'document' | 'contact' | 'location';
export type WaIncoming = { jid: string; phone: string | null; name: string | null; text: string; media: WaMedia | null; at: Date };
type IncomingHandler = (m: WaIncoming) => Promise<void> | void;
const incomingHandlers: IncomingHandler[] = [];

/** Registra quem trata mensagens recebidas (o atendimento a clientes usa isto). */
export function onWhatsAppMessage(handler: IncomingHandler) {
  incomingHandlers.push(handler);
}

function messageText(msg: any): string {
  const m = msg?.message;
  if (!m) return '';
  const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m;
  return String(inner.conversation || inner.extendedTextMessage?.text || inner.imageMessage?.caption || inner.videoMessage?.caption || '').trim();
}

/** Tipo de mídia de uma mensagem sem texto (áudio, foto...). null = nada que mereça resposta (reação, apagada, protocolo). */
function messageMedia(msg: any): WaMedia | null {
  const m = msg?.message;
  if (!m) return null;
  const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m;
  if (inner.audioMessage) return 'audio';
  if (inner.imageMessage) return 'image';
  if (inner.videoMessage) return 'video';
  if (inner.stickerMessage) return 'sticker';
  if (inner.documentMessage || inner.documentWithCaptionMessage) return 'document';
  if (inner.contactMessage || inner.contactsArrayMessage) return 'contact';
  if (inner.locationMessage || inner.liveLocationMessage) return 'location';
  return null;
}

// Manter conectado (pedido do usuário em 2026-10-06): qualquer queda tenta voltar sozinha, sem desistir,
// com esperas que vão crescendo (2s, 5s, 10s, 30s e depois a cada 1 min).
const RETRY_DELAYS = [2, 5, 10, 30, 60];
let failures = 0;            // tentativas seguidas sem conseguir abrir a conexão
let loggedOutStrikes = 0;    // vezes seguidas que o WhatsApp disse "sessão encerrada"
let manualLogout = false;    // a pessoa clicou em Desconectar: aí não reconecta sozinho
let retryTimer: ReturnType<typeof setTimeout> | null = null;

const nextDelay = () => RETRY_DELAYS[Math.min(failures++, RETRY_DELAYS.length - 1)];

function scheduleReconnect(sec: number, why: string) {
  if (manualLogout || retryTimer) return;
  status = 'connecting';
  console.log(`[whatsapp] ${why} Tentando reconectar em ${sec}s.`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (manualLogout || starting) return;
    starting = start().catch(onStartError).finally(() => { starting = null; });
  }, sec * 1000);
}

/** Não deu nem para abrir o socket (sem internet, por exemplo): tenta de novo mais tarde em vez de desistir. */
function onStartError(e: any) {
  sock = null;
  lastError = e?.message || String(e);
  status = 'disconnected';
  scheduleReconnect(nextDelay(), `Falha ao conectar: ${lastError}.`);
}

export async function connectWhatsAppWeb(): Promise<void> {
  manualLogout = false;
  // Pedido de conectar enquanto espera uma nova tentativa: tenta já.
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  else if (sock && status !== 'disconnected') return;
  if (starting) return starting;
  starting = start().catch(onStartError).finally(() => { starting = null; });
  return starting;
}

// Vigia: se por algum motivo ficou desconectado com a sessão salva e sem nova tentativa marcada, reconecta.
setInterval(() => {
  if (!manualLogout && status === 'disconnected' && !retryTimer && !starting && hasSavedSession()) {
    console.log('[whatsapp] Estava desconectado com a sessão salva; reconectando.');
    connectWhatsAppWeb().catch(() => {});
  }
}, 60_000).unref();

/** Guarda a sessão encerrada ao lado (em vez de apagar), para dar para investigar se precisar. */
function archiveSession() {
  const old = `${AUTH_DIR}-encerrada`;
  try { fs.rmSync(old, { recursive: true, force: true }); fs.renameSync(AUTH_DIR, old); }
  catch { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); }
}

async function start() {
  status = 'connecting';
  qrDataUrl = null;
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  // Nunca dois sockets com a mesma sessão: o WhatsApp derruba um deles ("conexão substituída").
  const old = sock;
  sock = null;
  try { old?.end(undefined); } catch { /* já fechado */ }

  const s = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['Robô das Ofertas', 'Chrome', '1.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false
  });
  sock = s;

  s.ev.on('creds.update', saveCreds);

  // Mensagens novas no privado: quem quiser tratá-las se registra em onWhatsAppMessage.
  s.ev.on('messages.upsert', ({ messages, type }) => {
    if (sock !== s || type !== 'notify' || !incomingHandlers.length) return;
    for (const msg of messages) {
      const jid = msg.key?.remoteJid || '';
      // Só conversa individual: nada de grupo (@g.us), status (@broadcast) nem mensagem enviada por nós.
      if (msg.key?.fromMe || !jid || !(jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'))) continue;
      const text = messageText(msg);
      // Sem texto: áudio, foto, figurinha etc. também são entregues, para o cliente nunca ficar sem resposta.
      const media = text ? null : messageMedia(msg);
      if (!text && !media) continue;
      const phone = jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0].split(':')[0] : null;
      const at = msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000) : new Date();
      // Mensagem antiga (sincronização ao reconectar) não pode disparar resposta agora.
      if (Date.now() - at.getTime() > 5 * 60_000) continue;
      const m: WaIncoming = { jid, phone, name: msg.pushName || null, text, media, at };
      for (const h of incomingHandlers) Promise.resolve(h(m)).catch(e => console.error('[whatsapp] mensagem recebida:', e?.message || e));
    }
  });

  s.ev.on('connection.update', async (u) => {
    // Evento de um socket antigo (já trocado por outro): ignora, senão derrubaria o atual.
    if (sock !== s) return;
    if (u.qr) {
      status = 'qr';
      qrDataUrl = await QRCode.toDataURL(u.qr, { margin: 1, width: 280 });
    }
    if (u.connection === 'open') {
      status = 'connected';
      qrDataUrl = null;
      lastError = null;
      failures = 0;
      loggedOutStrikes = 0;
      const id = s.user?.id || '';
      me = { id: id.split(':')[0]?.replace('@s.whatsapp.net', '') || id, name: s.user?.name };
      console.log(`[whatsapp] Conectado (+${me.id}).`);
    }
    if (u.connection === 'close') {
      const err = u.lastDisconnect?.error as any;
      const code = err?.output?.statusCode;
      const wasQr = status === 'qr';
      sock = null;
      qrDataUrl = null;
      console.log(`[whatsapp] Conexão caiu (código ${code ?? '?'}${err?.message ? `: ${err.message}` : ''}).`);
      if (manualLogout) { status = 'disconnected'; return; }
      if (code === DisconnectReason.loggedOut) {
        // Antes a sessão era apagada no primeiro aviso, e um aviso passageiro obrigava a escanear o QR de novo.
        // Agora confere mais duas vezes; só se continuar encerrada é que pede o QR.
        if (++loggedOutStrikes < 3) return scheduleReconnect(loggedOutStrikes * 15, 'O WhatsApp disse que a sessão foi encerrada; conferindo de novo.');
        loggedOutStrikes = 0;
        status = 'disconnected';
        me = null;
        archiveSession();
        lastError = 'O WhatsApp encerrou a sessão (o aparelho foi desconectado no celular ou o celular ficou muito tempo sem internet). Escaneie o QR code de novo em Canais.';
        console.log(`[whatsapp] ${lastError}`);
        return;
      }
      // QR code expirou sem ninguém escanear (ainda não há sessão): para de gerar QR até clicarem em Conectar.
      if (wasQr && !hasSavedSession()) {
        status = 'disconnected';
        lastError = 'O QR code expirou. Clique em Conectar para gerar outro.';
        return;
      }
      if (code === DisconnectReason.restartRequired) return scheduleReconnect(1, 'O WhatsApp pediu para reiniciar a conexão.');
      if (code === DisconnectReason.connectionReplaced) return scheduleReconnect(60, 'Outra conexão com a mesma sessão foi aberta (o sistema está aberto em dois lugares?).');
      scheduleReconnect(nextDelay(), 'Queda de conexão.');
    }
  });
}

export async function logoutWhatsAppWeb() {
  manualLogout = true;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  const s = sock;
  status = 'disconnected';
  qrDataUrl = null;
  me = null;
  lastError = null;
  sock = null;
  try { await s?.logout(); } catch { /* já desconectado */ }
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
}

/** Tem sessão pareada salva? (o creds.json só ganha o "me" depois que o QR code é escaneado). */
export function hasSavedSession() {
  try { return !!JSON.parse(fs.readFileSync(path.join(AUTH_DIR, 'creds.json'), 'utf8'))?.me; } catch { return false; }
}

export async function listGroups(): Promise<WaGroup[]> {
  if (!sock || status !== 'connected') throw new Error('WhatsApp não conectado. Escaneie o QR code em Canais.');
  const all = await sock.groupFetchAllParticipating();
  return Object.values(all)
    .map(g => ({ id: g.id, name: g.subject || g.id, participants: g.participants?.length || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

/** Mostra "digitando..." por alguns segundos antes de responder um cliente, para parecer natural. */
export async function showTyping(jid: string, ms = 1500) {
  if (!sock || status !== 'connected') return;
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise(r => setTimeout(r, ms));
    await sock.sendPresenceUpdate('paused', jid);
  } catch { /* só cosmético */ }
}

export async function sendWhatsAppWebText(jid: string, text: string, imageUrl?: string) {
  if (!sock || status !== 'connected') throw new Error('WhatsApp não conectado. Escaneie o QR code em Canais.');
  // Aceita JID de grupo (@g.us), JID de contato ou só o telefone.
  const to = jid.includes('@') ? jid : `${jid.replace(/\D/g, '')}@s.whatsapp.net`;
  // Só imagem da internet: com outro valor ("C:/...") o Baileys lê o arquivo do PC e manda no grupo.
  if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
    // Foto do produto com o texto como legenda. Se a imagem falhar (link expirado,
    // bloqueio da CDN), a oferta ainda sai em texto.
    try {
      return await sock.sendMessage(to, { image: { url: imageUrl }, caption: text });
    } catch { /* cai para texto puro */ }
  }
  return sock.sendMessage(to, { text });
}

export type WaMember = { jid: string; phone: string | null; admin: boolean };

/** Membros de um grupo. Em grupos "anônimos" (@lid) o WhatsApp pode não informar o telefone. */
export async function listGroupMembers(groupId: string): Promise<{ name: string; members: WaMember[] }> {
  if (!sock || status !== 'connected') throw new Error('WhatsApp não conectado. Escaneie o QR code em Canais.');
  const meta = await sock.groupMetadata(groupId);
  const myPhone = me?.id || '';
  const members = meta.participants
    .map(p => {
      const pn = p.jid && p.jid.endsWith('@s.whatsapp.net') ? p.jid : p.id.endsWith('@s.whatsapp.net') ? p.id : '';
      const phone = pn ? pn.split('@')[0].split(':')[0] : null;
      return { jid: pn || p.id, phone, admin: !!p.admin };
    })
    .filter(m => m.phone !== myPhone);
  return { name: meta.subject || groupId, members };
}

/** Link de convite do grupo (é preciso ser administrador dele). */
export async function groupInviteLink(groupId: string): Promise<string> {
  if (!sock || status !== 'connected') throw new Error('WhatsApp não conectado. Escaneie o QR code em Canais.');
  const code = await sock.groupInviteCode(groupId);
  if (!code) throw new Error('O WhatsApp não devolveu o link de convite deste grupo.');
  return `https://chat.whatsapp.com/${code}`;
}

/** Resultado de adicionar um contato: ok, já estava, privacidade (só entra por convite) ou outro erro (com o motivo). */
export type WaAddResult = { jid: string; result: 'added' | 'already' | 'privacy' | 'failed'; reason?: string };

/** O que cada código de erro do WhatsApp quer dizer, em português, para mostrar na tela. */
function addErrorReason(code: string) {
  if (code === '400') return 'número inválido';
  if (code === '401') return 'o contato bloqueou o seu número';
  if (code === '404') return 'número sem WhatsApp';
  if (code === '408') return 'saiu do grupo há pouco (o WhatsApp não deixa adicionar de volta logo)';
  if (code === '500') return 'grupo cheio';
  if (!code) return 'o WhatsApp não respondeu sobre este número';
  return `o WhatsApp recusou (código ${code})`;
}

/**
 * Adiciona contatos a um grupo (é preciso ser administrador dele).
 * Antes confere se o número tem WhatsApp: além de achar quem não tem, isso devolve o número do jeito que o
 * WhatsApp guarda (celulares antigos do Brasil ficam sem o 9 na frente, e adicionar "com o 9" falha).
 */
export async function addGroupMembers(groupId: string, jids: string[]): Promise<WaAddResult[]> {
  if (!sock || status !== 'connected') throw new Error('WhatsApp não conectado. Escaneie o QR code em Canais.');
  const out = new Map<string, WaAddResult>();
  const real = new Map<string, string>(); // jid do WhatsApp → jid como veio da lista
  for (const [i, jid] of jids.entries()) {
    // Uma folga de 1 a 3s entre as consultas, para não sair tudo no mesmo instante.
    if (i) await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
    try {
      const [hit] = (await sock.onWhatsApp(jid.split('@')[0])) || [];
      if (hit?.exists && hit.jid) real.set(hit.jid, jid);
      else out.set(jid, { jid, result: 'failed', reason: 'número sem WhatsApp' });
    } catch { real.set(jid, jid); } // se a conferência falhar, tenta adicionar assim mesmo
  }
  if (real.size) {
    const list = [...real.keys()];
    const res = await sock.groupParticipantsUpdate(groupId, list, 'add');
    list.forEach((rj, i) => {
      const jid = real.get(rj)!;
      const r = res.find(x => x.jid === rj) ?? (res.length === list.length ? res[i] : undefined);
      const code = String(r?.status || '');
      // 200 = entrou; 409 = já é membro; 403 = a privacidade do contato não deixa adicionar (precisa de convite).
      if (code === '200') out.set(jid, { jid, result: 'added' });
      else if (code === '409') out.set(jid, { jid, result: 'already' });
      else if (code === '403') out.set(jid, { jid, result: 'privacy' });
      else {
        console.warn(`[grupo] não adicionou ${jid.split('@')[0]}: código ${code || '(vazio)'}`);
        out.set(jid, { jid, result: 'failed', reason: addErrorReason(code) });
      }
    });
  }
  return jids.map(jid => out.get(jid)!);
}

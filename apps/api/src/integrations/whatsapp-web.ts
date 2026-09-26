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

export async function connectWhatsAppWeb(): Promise<void> {
  if (status === 'connected' || status === 'qr' || status === 'connecting') return;
  if (starting) return starting;
  starting = start().finally(() => { starting = null; });
  return starting;
}

async function start() {
  status = 'connecting';
  lastError = null;
  qrDataUrl = null;
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['Robô das Ofertas', 'Chrome', '1.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false
  });

  sock.ev.on('creds.update', saveCreds);

  // Mensagens novas no privado: quem quiser tratá-las se registra em onWhatsAppMessage.
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify' || !incomingHandlers.length) return;
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

  sock.ev.on('connection.update', async (u) => {
    if (u.qr) {
      status = 'qr';
      qrDataUrl = await QRCode.toDataURL(u.qr, { margin: 1, width: 280 });
    }
    if (u.connection === 'open') {
      status = 'connected';
      qrDataUrl = null;
      const id = sock?.user?.id || '';
      me = { id: id.split(':')[0]?.replace('@s.whatsapp.net', '') || id, name: sock?.user?.name };
    }
    if (u.connection === 'close') {
      const code = (u.lastDisconnect?.error as any)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      sock = null;
      qrDataUrl = null;
      if (loggedOut) {
        // Sessão removida no celular: limpa as credenciais para permitir novo pareamento.
        status = 'disconnected';
        me = null;
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        lastError = 'Sessão encerrada no celular. Conecte novamente.';
      } else if (status !== 'disconnected') {
        // Queda de rede ou reinício: tenta voltar sozinho.
        status = 'connecting';
        setTimeout(() => { start().catch(e => { lastError = e.message; status = 'disconnected'; }); }, 2000);
      }
    }
  });
}

export async function logoutWhatsAppWeb() {
  const s = sock;
  status = 'disconnected';
  qrDataUrl = null;
  me = null;
  sock = null;
  try { await s?.logout(); } catch { /* já desconectado */ }
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
}

export function hasSavedSession() {
  return fs.existsSync(path.join(AUTH_DIR, 'creds.json'));
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
  if (imageUrl) {
    // Foto do produto com o texto como legenda. Se a imagem falhar (link expirado,
    // bloqueio da CDN), a oferta ainda sai em texto.
    try {
      return await sock.sendMessage(to, { image: { url: imageUrl }, caption: text });
    } catch { /* cai para texto puro */ }
  }
  return sock.sendMessage(to, { text });
}

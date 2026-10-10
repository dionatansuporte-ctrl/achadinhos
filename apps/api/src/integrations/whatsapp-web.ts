import path from 'node:path';
import fs from 'node:fs';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  WAMessageStubType,
  type WASocket
} from '@whiskeysockets/baileys';

/**
 * Sessões do WhatsApp via WhatsApp Web (Baileys), para envio em grupos.
 * A API oficial da Meta não lista nem envia para grupos; este caminho conecta o
 * número do usuário como um aparelho pareado, por QR code.
 *
 * Vários números (pedido do usuário em 2026-10-08): cada um é uma sessão com o seu QR code e a sua pasta.
 * O primeiro é o "principal" (pasta .wa-auth, a de sempre); os outros ficam em .wa-auth-n2, .wa-auth-n3...
 * Mensagem para grupo sai pelo número que está no grupo; resposta no privado sai pelo número que recebeu.
 *
 * Número descartável (pedido do usuário em 2026-10-09): uma sessão fixa à parte (pasta .wa-auth-descartavel) usada
 * SÓ para adicionar contatos nos grupos (e mandar o link de convite a quem a privacidade barrar). Ele nunca manda
 * oferta, nunca responde cliente e não conta no limite de 4 números: se o WhatsApp bloquear esse chip, troca-se
 * por outro sem mexer no principal.
 *
 * Só pode existir UM socket por sessão, então este módulo roda apenas no
 * processo da API. O worker envia por meio do endpoint interno /internal/whatsapp/send.
 */

export type WaStatus = 'disconnected' | 'connecting' | 'qr' | 'connected';

// session: o número que manda as ofertas no grupo; sessions: todos os números conectados que estão nele;
// admins: quais desses são administradores (só eles conseguem adicionar gente).
export type WaGroup = { id: string; name: string; participants: number; session: string; sessions: string[]; admins: string[] };

export const MAIN_SESSION = 'principal';
export const DISPOSABLE_SESSION = 'descartavel';
export const isDisposable = (id: string) => id === DISPOSABLE_SESSION;
const BASE_DIR = path.resolve(process.cwd(), '.wa-auth');
const authDir = (id: string) => id === MAIN_SESSION ? BASE_DIR : `${BASE_DIR}-${id}`;
const logger = pino({ level: 'silent' });

/** Mensagem de texto recebida no privado (grupos, status e as próprias mensagens ficam de fora). */
// text vazio = mensagem sem texto (áudio, foto, figurinha...); `media` diz o que era.
export type WaMedia = 'audio' | 'image' | 'video' | 'sticker' | 'document' | 'contact' | 'location';
export type WaIncoming = { jid: string; phone: string | null; name: string | null; text: string; media: WaMedia | null; at: Date; session: string };
type IncomingHandler = (m: WaIncoming) => Promise<void> | void;
const incomingHandlers: IncomingHandler[] = [];

/** Registra quem trata mensagens recebidas (o atendimento a clientes usa isto). */
export function onWhatsAppMessage(handler: IncomingHandler) {
  incomingHandlers.push(handler);
}

/** Alguém entrou ou saiu de um grupo. at = hora do aviso do WhatsApp (vale também para o que chegou com o sistema desligado). */
export type WaGroupMove = { groupId: string; groupName: string | null; member: string; kind: 'LINK' | 'ADDED' | 'LEFT' | 'REMOVED'; at: Date };
type GroupMoveHandler = (m: WaGroupMove) => Promise<void> | void;
const groupMoveHandlers: GroupMoveHandler[] = [];
const groupNames = new Map<string, string>();

/** Registra quem guarda as entradas e saídas dos grupos (a contagem por dia/semana usa isto). */
export function onGroupMembers(handler: GroupMoveHandler) {
  groupMoveHandlers.push(handler);
}

// Por qual número cada contato falou por último: a resposta no privado sai pelo mesmo número.
// Fica em disco para valer também depois de reiniciar o sistema.
const CONTACTS_FILE = path.resolve(__dirname, '../../.cache/wa-contacts.json');
const lastSessionByJid = new Map<string, string>(Object.entries((() => { try { return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8')) || {}; } catch { return {}; } })()));
let contactsTimer: ReturnType<typeof setTimeout> | null = null;
function rememberContact(jid: string, id: string) {
  if (lastSessionByJid.get(jid) === id) return;
  lastSessionByJid.set(jid, id);
  contactsTimer ||= setTimeout(() => {
    contactsTimer = null;
    try { fs.mkdirSync(path.dirname(CONTACTS_FILE), { recursive: true }); fs.writeFileSync(CONTACTS_FILE, JSON.stringify(Object.fromEntries(lastSessionByJid))); } catch { /* sem disco, segue */ }
  }, 5_000);
}

// Uma exceção solta (de qualquer número) derrubaria o sistema inteiro e, junto, a conexão dos outros números.
process.on('unhandledRejection', (e: any) => console.error('[whatsapp] erro não tratado (o sistema segue no ar):', e?.message || e));

/** Tipo de entrada/saída de uma mensagem de sistema do grupo (null = não é entrada nem saída). */
function groupMoveKind(stub: number | null | undefined, author: string | null | undefined, members: string[] | null | undefined): WaGroupMove['kind'] | null {
  const self = !!author && (members || []).some(j => j.split('@')[0].split(':')[0] === author.split('@')[0].split(':')[0]);
  switch (stub) {
    case WAMessageStubType.GROUP_PARTICIPANT_INVITE:
    case WAMessageStubType.GROUP_PARTICIPANT_ADD_REQUEST_JOIN: return 'LINK';
    // "Adicionou" a si mesmo = entrou pelo link.
    case WAMessageStubType.GROUP_PARTICIPANT_ADD: return self || !author ? 'LINK' : 'ADDED';
    case WAMessageStubType.GROUP_PARTICIPANT_LEAVE: return 'LEFT';
    case WAMessageStubType.GROUP_PARTICIPANT_REMOVE: return self ? 'LEFT' : 'REMOVED';
    default: return null;
  }
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
const NOT_CONNECTED = 'WhatsApp não conectado. Escaneie o QR code em Canais.';

class WaSession {
  sock: WASocket | null = null;
  status: WaStatus = 'disconnected';
  qrDataUrl: string | null = null;
  me: { id: string; name?: string } | null = null;
  lastError: string | null = null;
  starting: Promise<void> | null = null;
  // Quando a conexão atual abriu, quando o QR code foi escaneado pela última vez (fica em disco, junto da sessão)
  // e quando o WhatsApp removeu o aparelho. A importação para grupos usa isso para não adicionar gente
  // logo depois de conectar — foi o que fez o WhatsApp remover o aparelho em 2026-10-06.
  connectedAt: number | null = null;
  removedAt: number | null = null;
  sawQr = false;
  failures = 0;            // tentativas seguidas sem conseguir abrir a conexão
  loggedOutStrikes = 0;    // vezes seguidas que o WhatsApp disse "sessão encerrada"
  manualLogout = false;    // a pessoa clicou em Desconectar: aí não reconecta sozinho
  retryTimer: ReturnType<typeof setTimeout> | null = null;
  groupIds = new Set<string>(); // grupos em que este número está (para saber por qual número mandar)
  groupsAt = 0;

  constructor(readonly id: string) {
    // A lista de grupos fica em disco: com o número fora do ar (ou logo depois de reiniciar), o grupo continua
    // sendo dele, e o envio espera esse número voltar em vez de cair em outro.
    try { this.groupIds = new Set(JSON.parse(fs.readFileSync(this.groupsFile, 'utf8'))); } catch { /* ainda sem lista */ }
  }

  get dir() { return authDir(this.id); }
  get groupsFile() { return path.join(this.dir, 'groups.json'); }
  get pairedFile() { return path.join(this.dir, 'paired-at.txt'); }
  pairedAt(): number | null {
    try { return Number(fs.readFileSync(this.pairedFile, 'utf8')) || null; } catch { return null; }
  }
  log(text: string) { console.log(`[whatsapp${this.id === MAIN_SESSION ? '' : ` ${this.id}`}] ${text}`); }

  state() {
    const { id, status, me, connectedAt, removedAt } = this;
    return { id, main: id === MAIN_SESSION, disposable: isDisposable(id), status, qr: this.qrDataUrl, me, error: this.lastError, connectedAt, pairedAt: this.pairedAt(), removedAt, hasSession: this.hasSavedSession() };
  }

  /** Tem sessão pareada salva? (o creds.json só ganha o "me" depois que o QR code é escaneado). */
  hasSavedSession() {
    try { return !!JSON.parse(fs.readFileSync(path.join(this.dir, 'creds.json'), 'utf8'))?.me; } catch { return false; }
  }

  nextDelay() { return RETRY_DELAYS[Math.min(this.failures++, RETRY_DELAYS.length - 1)]; }

  scheduleReconnect(sec: number, why: string) {
    if (this.manualLogout || this.retryTimer) return;
    this.status = 'connecting';
    this.log(`${why} Tentando reconectar em ${sec}s.`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.manualLogout || this.starting) return;
      this.starting = this.start().catch(e => this.onStartError(e)).finally(() => { this.starting = null; });
    }, sec * 1000);
  }

  /** Não deu nem para abrir o socket (sem internet, por exemplo): tenta de novo mais tarde em vez de desistir. */
  onStartError(e: any) {
    this.sock = null;
    this.lastError = e?.message || String(e);
    this.status = 'disconnected';
    this.scheduleReconnect(this.nextDelay(), `Falha ao conectar: ${this.lastError}.`);
  }

  async connect(): Promise<void> {
    this.manualLogout = false;
    // Pedido de conectar enquanto espera uma nova tentativa: tenta já.
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    else if (this.sock && this.status !== 'disconnected') return;
    if (this.starting) return this.starting;
    this.starting = this.start().catch(e => this.onStartError(e)).finally(() => { this.starting = null; });
    return this.starting;
  }

  /** Guarda a sessão encerrada ao lado (em vez de apagar), para dar para investigar se precisar. */
  archiveSession() {
    const old = `${this.dir}-encerrada`;
    try { fs.rmSync(old, { recursive: true, force: true }); fs.renameSync(this.dir, old); }
    catch { fs.rmSync(this.dir, { recursive: true, force: true }); }
  }

  async start() {
    this.status = 'connecting';
    this.qrDataUrl = null;
    fs.mkdirSync(this.dir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(this.dir);
    const { version } = await fetchLatestBaileysVersion();

    // Nunca dois sockets com a mesma sessão: o WhatsApp derruba um deles ("conexão substituída").
    const old = this.sock;
    this.sock = null;
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
    this.sock = s;

    s.ev.on('creds.update', saveCreds);

    // Mensagens novas no privado: quem quiser tratá-las se registra em onWhatsAppMessage.
    s.ev.on('messages.upsert', ({ messages, type }) => {
      if (this.sock !== s || type !== 'notify' || !incomingHandlers.length) return;
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
        // O descartável não atende ninguém: quem responder a ele fica sem resposta do robô.
        if (isDisposable(this.id)) continue;
        rememberContact(jid, this.id);
        const m: WaIncoming = { jid, phone, name: msg.pushName || null, text, media, at, session: this.id };
        for (const h of incomingHandlers) Promise.resolve(h(m)).catch(e => console.error('[whatsapp] mensagem recebida:', e?.message || e));
      }
    });

    // Entradas e saídas nos grupos chegam como mensagens de sistema (as "fulano entrou usando o link").
    s.ev.on('messages.upsert', ({ messages }) => {
      if (this.sock !== s || !groupMoveHandlers.length) return;
      for (const msg of messages) {
        const groupId = msg.key?.remoteJid || '';
        const kind = groupMoveKind(msg.messageStubType, msg.participant || msg.key?.participant, msg.messageStubParameters);
        if (!groupId.endsWith('@g.us') || !kind) continue;
        const at = msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000) : new Date();
        for (const member of msg.messageStubParameters || []) {
          const m: WaGroupMove = { groupId, groupName: groupNames.get(groupId) || null, member, kind, at };
          for (const h of groupMoveHandlers) Promise.resolve(h(m)).catch(e => console.error('[whatsapp] entrada/saída de grupo:', e?.message || e));
        }
      }
    });

    // Erro aqui dentro não pode virar exceção solta: derrubaria o sistema e, com ele, os outros números.
    s.ev.on('connection.update', (u) => void (async () => {
      // Evento de um socket antigo (já trocado por outro): ignora, senão derrubaria o atual.
      if (this.sock !== s) return;
      if (u.qr) {
        this.status = 'qr';
        this.sawQr = true;
        this.qrDataUrl = await QRCode.toDataURL(u.qr, { margin: 1, width: 280 });
      }
      if (u.connection === 'open') {
        this.status = 'connected';
        this.qrDataUrl = null;
        this.lastError = null;
        this.failures = 0;
        this.loggedOutStrikes = 0;
        this.connectedAt = Date.now();
        // Abriu depois de mostrar QR: é um pareamento novo.
        if (this.sawQr || !this.pairedAt()) { try { fs.writeFileSync(this.pairedFile, String(Date.now())); } catch { /* sem disco, segue */ } }
        this.sawQr = false;
        const id = s.user?.id || '';
        this.me = { id: id.split(':')[0]?.replace('@s.whatsapp.net', '') || id, name: s.user?.name };
        this.log(`Conectado (+${this.me.id}).`);
        // O mesmo número pareado em duas sessões só dá "conexão substituída" sem fim: fica só a mais antiga.
        const twin = [...sessions.values()].find(o => o !== this && o.me?.id === this.me!.id && o.status === 'connected');
        if (twin) {
          this.lastError = `O número +${twin.me!.id} já estava conectado. Escaneie o QR code com outro número.`;
          this.log(this.lastError);
          await this.logout(false);
          return;
        }
        this.refreshGroups().catch(() => {});
      }
      if (u.connection === 'close') {
        const err = u.lastDisconnect?.error as any;
        const code = err?.output?.statusCode;
        const wasQr = this.status === 'qr';
        this.sock = null;
        this.qrDataUrl = null;
        this.connectedAt = null;
        this.log(`Conexão caiu (código ${code ?? '?'}${err?.message ? `: ${err.message}` : ''}).`);
        if (this.manualLogout) { this.status = 'disconnected'; return; }
        if (code === DisconnectReason.loggedOut) {
          // Antes a sessão era apagada no primeiro aviso, e um aviso passageiro obrigava a escanear o QR de novo.
          // Agora confere mais duas vezes; só se continuar encerrada é que pede o QR.
          // "conflict" com 401 é o WhatsApp removendo o aparelho: aí não adianta conferir.
          this.removedAt = Date.now();
          const removed = /conflict/i.test(String(err?.message || ''));
          if (!removed && ++this.loggedOutStrikes < 3) return this.scheduleReconnect(this.loggedOutStrikes * 15, 'O WhatsApp disse que a sessão foi encerrada; conferindo de novo.');
          this.loggedOutStrikes = 0;
          this.status = 'disconnected';
          const who = this.me?.id ? ` (+${this.me.id})` : '';
          this.me = null;
          this.groupIds.clear();
          this.archiveSession();
          this.lastError = removed
            ? `O próprio WhatsApp removeu o aparelho conectado${who}. Isso costuma ser proteção contra spam (por exemplo, adicionar muita gente em grupo). Escaneie o QR code de novo em Canais e vá com calma nas importações.`
            : `O WhatsApp encerrou a sessão${who} (o aparelho foi desconectado no celular ou o celular ficou muito tempo sem internet). Escaneie o QR code de novo em Canais.`;
          this.log(this.lastError);
          return;
        }
        // QR code expirou sem ninguém escanear (ainda não há sessão): para de gerar QR até clicarem em Conectar.
        if (wasQr && !this.hasSavedSession()) {
          this.status = 'disconnected';
          this.lastError = 'O QR code expirou. Clique em Conectar para gerar outro.';
          return;
        }
        if (code === DisconnectReason.restartRequired) return this.scheduleReconnect(1, 'O WhatsApp pediu para reiniciar a conexão.');
        if (code === DisconnectReason.connectionReplaced) return this.scheduleReconnect(60, 'Outra conexão com a mesma sessão foi aberta (o sistema está aberto em dois lugares?).');
        this.scheduleReconnect(this.nextDelay(), 'Queda de conexão.');
      }
    })().catch(e => this.log(`Erro ao tratar a conexão: ${e?.message || e}`)));
  }

  /** Desconecta e apaga a sessão (será preciso escanear o QR de novo). clearError=false mantém o aviso na tela. */
  async logout(clearError = true) {
    this.manualLogout = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    const s = this.sock;
    this.status = 'disconnected';
    this.qrDataUrl = null;
    this.me = null;
    if (clearError) this.lastError = null;
    this.sock = null;
    this.groupIds.clear();
    try { await s?.logout(); } catch { /* já desconectado */ }
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  socket(): WASocket {
    if (!this.sock || this.status !== 'connected') throw new Error(this.id === MAIN_SESSION ? NOT_CONNECTED : isDisposable(this.id) ? 'O número descartável não está conectado. Escaneie o QR code dele na tela Número descartável.' : `WhatsApp do número ${this.id} não conectado. Escaneie o QR code dele em Canais.`);
    return this.sock;
  }

  async listGroups(): Promise<WaGroup[]> {
    const all = await this.socket().groupFetchAllParticipating();
    // O número aparece na lista de membros pelo telefone ou pelo @lid, conforme o grupo.
    const mine = new Set([this.me?.id, (this.sock?.user as any)?.lid].filter(Boolean).map(j => String(j).split('@')[0].split(':')[0]));
    const isMe = (j?: string) => !!j && mine.has(j.split('@')[0].split(':')[0]);
    const list = Object.values(all).map(g => {
      const admin = (g.participants || []).some((p: any) => !!p.admin && (isMe(p.id) || isMe(p.jid) || isMe(p.lid)));
      return { id: g.id, name: g.subject || g.id, participants: g.participants?.length || 0, session: this.id, sessions: [this.id], admins: admin ? [this.id] : [] };
    });
    for (const g of list) groupNames.set(g.id, g.name);
    this.groupIds = new Set(list.map(g => g.id));
    this.groupsAt = Date.now();
    try { fs.writeFileSync(this.groupsFile, JSON.stringify([...this.groupIds])); } catch { /* sem disco, segue */ }
    return list;
  }

  async refreshGroups() { await this.listGroups(); }
}

const sessions = new Map<string, WaSession>();
function session(id: string = MAIN_SESSION) {
  let s = sessions.get(id);
  if (!s) { s = new WaSession(id); sessions.set(id, s); }
  return s;
}
session(MAIN_SESSION);
// O descartável fica sempre na lista (como o principal), pronto para parear quando a pessoa quiser.
session(DISPOSABLE_SESSION);

// Números extras já pareados antes (pastas .wa-auth-n2, .wa-auth-n3...).
try {
  for (const name of fs.readdirSync(path.dirname(BASE_DIR))) {
    const m = /^\.wa-auth-(n\d+)$/.exec(name);
    if (m) session(m[1]);
  }
} catch { /* pasta ainda não existe */ }

// Ordem: principal, n2, n3..., e o descartável por último.
const rank = (id: string) => id === MAIN_SESSION ? -1 : isDisposable(id) ? Infinity : Number(id.slice(1)) || 0;
const ordered = () => [...sessions.values()].sort((a, b) => rank(a.id) - rank(b.id));
// Números "de serviço": os que mandam ofertas e atendem clientes (o descartável fica de fora).
const service = () => ordered().filter(s => !isDisposable(s.id));

/** Estado de um número (sem id: o principal). */
export function getWaState(id: string = MAIN_SESSION) {
  // Número que já saiu da lista: devolve "desconectado" sem colocá-lo de volta na lista.
  return (sessions.get(id) || new WaSession(id)).state();
}

/** Números conectados que estão no grupo (pela última lista de grupos de cada um). */
export function waGroupSessions(groupId: string) {
  return ordered().filter(s => s.status === 'connected' && s.groupIds.has(groupId)).map(s => s.id);
}

/** Estado de todos os números, o principal primeiro. */
export function listWaSessions() {
  return ordered().map(s => s.state());
}

/** Algum número de serviço conectado? (o descartável não conta: ele não manda oferta nem atende) */
export function anyWaConnected() {
  return service().some(s => s.status === 'connected');
}

/** Cria a sessão de um número novo e já começa a gerar o QR code. */
export function addWaSession(): string {
  // Reaproveita um número extra que ficou sem pareamento, em vez de acumular sessões vazias.
  const idle = service().find(s => s.id !== MAIN_SESSION && s.status === 'disconnected' && !s.hasSavedSession());
  let id = idle?.id;
  if (!id) { let n = 2; while (sessions.has(`n${n}`)) n++; id = `n${n}`; }
  session(id).connect().catch(() => {});
  return id;
}

export async function connectWhatsAppWeb(id: string = MAIN_SESSION): Promise<void> {
  return session(id).connect();
}

/** Ao ligar o sistema: reconecta todos os números que já estavam pareados. */
export function connectSavedSessions() {
  for (const s of sessions.values()) if (s.hasSavedSession()) s.connect().catch(e => console.error(`WhatsApp Web (${s.id}):`, e?.message || e));
}

/** Desconecta um número. O principal e o descartável continuam na lista (desconectados); um número extra some da lista. */
export async function logoutWhatsAppWeb(id: string = MAIN_SESSION) {
  const s = sessions.get(id);
  if (!s) return;
  await s.logout();
  if (id !== MAIN_SESSION && !isDisposable(id)) sessions.delete(id);
}

// Vigia: se por algum motivo ficou desconectado com a sessão salva e sem nova tentativa marcada, reconecta.
setInterval(() => {
  for (const s of sessions.values()) {
    if (!s.manualLogout && s.status === 'disconnected' && !s.retryTimer && !s.starting && s.hasSavedSession()) {
      s.log('Estava desconectado com a sessão salva; reconectando.');
      s.connect().catch(() => {});
    }
  }
}, 60_000).unref();

/** Tem sessão pareada salva em algum número? */
export function hasSavedSession() {
  return [...sessions.values()].some(s => s.hasSavedSession());
}

/**
 * Por qual número falar com este contato/grupo:
 * grupo → um número conectado que está no grupo; contato → o número pelo qual ele falou por último.
 * Cada número trabalha sozinho (pedido do usuário em 2026-10-08): se o número do grupo/contato estiver fora do ar,
 * devolve ele mesmo assim — o envio dá "não conectado" e espera ele voltar, sem jogar o serviço em cima de outro.
 * Só quando nenhum número conhece o grupo/contato é que vai pelo principal (ou o primeiro conectado). Devolve o id da sessão.
 * O descartável nunca é escolhido aqui: ele só trabalha quando é pedido de propósito (via) na importação de contatos.
 */
export async function sessionForJid(jid: string): Promise<string> {
  const all = service();
  const connected = all.filter(s => s.status === 'connected');
  if (jid.endsWith('@g.us')) {
    let hit = connected.find(s => s.groupIds.has(jid));
    if (!hit && connected.length > 1) {
      // Grupo novo que ainda não estava na lista de nenhum número: atualiza as listas (no máximo 1 vez por minuto).
      await Promise.all(connected.filter(s => Date.now() - s.groupsAt > 60_000).map(s => s.refreshGroups().catch(() => {})));
      hit = connected.find(s => s.groupIds.has(jid));
    }
    hit ||= all.find(s => s.groupIds.has(jid));
    if (hit) return hit.id;
  } else {
    const last = lastSessionByJid.get(jid);
    if (last && sessions.has(last)) return last;
  }
  return sessions.get(MAIN_SESSION)?.status === 'connected' || !connected.length ? MAIN_SESSION : connected[0].id;
}
const sockFor = async (jid: string) => session(await sessionForJid(jid)).socket();

/** Grupos de todos os números conectados. Grupo em que dois números estão aparece uma vez só, com a lista dos números dele. */
export async function listGroups(): Promise<WaGroup[]> {
  const connected = ordered().filter(s => s.status === 'connected');
  if (!connected.length) throw new Error(NOT_CONNECTED);
  const lists = await Promise.all(connected.map(s => s.listGroups().catch(() => [] as WaGroup[])));
  const byId = new Map<string, WaGroup>();
  for (const g of lists.flat()) {
    const have = byId.get(g.id);
    if (!have) { byId.set(g.id, g); continue; }
    have.sessions.push(...g.sessions);
    have.admins.push(...g.admins);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

/** Número que deve cuidar do grupo: o escolhido (via) — que precisa estar conectado — ou o que sessionForJid achar. */
async function groupSession(groupId: string, via?: string) {
  if (!via) return session(await sessionForJid(groupId));
  const s = sessions.get(via);
  if (!s) throw new Error('Esse número não está mais na lista. Escolha outro em Canais.');
  return s;
}

/** Mostra "digitando..." por alguns segundos antes de responder um cliente, para parecer natural. */
export async function showTyping(jid: string, ms = 1500) {
  const s = session(await sessionForJid(jid));
  if (!s.sock || s.status !== 'connected') return;
  try {
    await s.sock.sendPresenceUpdate('composing', jid);
    await new Promise(r => setTimeout(r, ms));
    await s.sock.sendPresenceUpdate('paused', jid);
  } catch { /* só cosmético */ }
}

/**
 * Endereço real de um telefone no WhatsApp. Mandar direto para `telefone@s.whatsapp.net` "dá certo" mesmo
 * quando o número não existe ou está cadastrado de outro jeito (celular do Brasil sem o nono dígito, conta
 * nova que só responde pelo @lid): a mensagem some sem erro. Por isso pergunta ao WhatsApp antes.
 * Devolve null quando o número não tem WhatsApp.
 */
export async function resolvePhoneJid(phone: string, via?: string): Promise<string | null> {
  const digits = phone.replace(/\D/g, '');
  const sock = via ? session(via).socket() : await sockFor(`${digits}@s.whatsapp.net`);
  const tries = [digits];
  // Brasil: muita conta antiga está registrada sem o 9 na frente do celular (55 DD 9XXXX-XXXX → 55 DD XXXX-XXXX).
  const br = /^55(\d{2})9(\d{8})$/.exec(digits);
  if (br) tries.push(`55${br[1]}${br[2]}`);
  for (const t of tries) {
    const [hit] = (await sock.onWhatsApp(t)) || [];
    if (hit?.exists && hit.jid) return hit.jid;
  }
  return null;
}

/** Envia texto (ou foto com legenda). `via`: id do número que deve mandar; sem ele, escolhe por sessionForJid. */
export async function sendWhatsAppWebText(jid: string, text: string, imageUrl?: string, via?: string) {
  // Aceita JID de grupo (@g.us), JID de contato ou só o telefone.
  const to = jid.includes('@') ? jid : `${jid.replace(/\D/g, '')}@s.whatsapp.net`;
  const sock = via ? session(via).socket() : await sockFor(to);
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
export async function listGroupMembers(groupId: string, via?: string): Promise<{ name: string; members: WaMember[] }> {
  const s = await groupSession(groupId, via);
  const sock = s.socket();
  const meta = await sock.groupMetadata(groupId);
  const myPhone = s.me?.id || '';
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
export async function groupInviteLink(groupId: string, via?: string): Promise<string> {
  const s = await groupSession(groupId, via);
  const sock = s.socket();
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

const sleep = (min: number, max: number) => new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
// Nome do contato temporário na agenda: fácil de reconhecer se algum ficar para trás.
const tempContactName = (jid: string) => `Oferta +${jid.split('@')[0]}`;

/**
 * Adiciona contatos a um grupo (é preciso ser administrador dele).
 * Antes confere se o número tem WhatsApp: além de achar quem não tem, isso devolve o número do jeito que o
 * WhatsApp guarda (celulares antigos do Brasil ficam sem o 9 na frente, e adicionar "com o 9" falha).
 * tempContacts (pedido do usuário em 2026-10-08): salva cada número na agenda do celular antes de adicionar e tira
 * logo depois. Quem tem a privacidade "só meus contatos" aceita ser adicionado por quem o tem na agenda.
 */
export async function addGroupMembers(groupId: string, jids: string[], via?: string, tempContacts = true): Promise<WaAddResult[]> {
  const s = await groupSession(groupId, via);
  const sock = s.socket();
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
    // Agenda temporária: salva um por um, com uma folga, e espera o celular sincronizar antes de adicionar.
    const saved: string[] = [];
    if (tempContacts) {
      for (const rj of list) {
        try {
          const name = tempContactName(rj);
          await sock.addOrEditContact(rj, { fullName: name, firstName: name, saveOnPrimaryAddressbook: true });
          saved.push(rj);
        } catch (e: any) { console.warn(`[grupo] não salvou ${rj.split('@')[0]} na agenda: ${e?.message || e}`); }
        await sleep(400, 900);
      }
      if (saved.length) await sleep(3000, 5000);
    }
    let res;
    try { res = await sock.groupParticipantsUpdate(groupId, list, 'add'); }
    finally {
      // Tira da agenda o que foi salvo, dando certo ou não (é temporário).
      for (const rj of saved) {
        try { await sock.removeContact(rj); } catch (e: any) { console.warn(`[grupo] não tirou ${rj.split('@')[0]} da agenda: ${e?.message || e}`); }
        await sleep(200, 500);
      }
    }
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

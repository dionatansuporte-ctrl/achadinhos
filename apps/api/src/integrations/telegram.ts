import path from 'node:path';
import { getSecret } from '../services/settings';
import { readJson, writeJsonAtomic } from '../services/json-file';

/**
 * Envio de ofertas para canais e grupos do Telegram pelo Bot API oficial (pedido do usuário em 2026-10-16).
 * Fluxo: o usuário cria um bot no @BotFather, cola o token em Telegram → "Bot do Telegram", coloca o bot como
 * administrador do canal (ou membro do grupo) e cadastra o canal pelo @nome ou pelo ID numérico.
 * Não há login de usuário nem scraping: só o bot fala, e só onde ele foi colocado.
 */

const TIMEOUT_MS = 25_000;
const CAPTION_MAX = 1024;   // limite do Telegram para legenda de foto
const TEXT_MAX = 4096;      // limite para mensagem de texto

export type TelegramChat = { id: number; type: string; title: string; username?: string };

async function botToken() {
  const token = (await getSecret('TELEGRAM_BOT_TOKEN') || '').trim();
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) throw new Error('Token do bot do Telegram não configurado. Cole o token do @BotFather na tela Telegram.');
  return token;
}

/** Erros do Telegram vêm como {ok:false, description}. Traduz os mais comuns para o painel. */
function friendly(desc: string) {
  const d = desc || '';
  if (/chat not found/i.test(d)) return 'Canal ou contato não encontrado. Confira o @nome (ou o ID). Canal: o bot precisa ter sido adicionado nele. Contato: a pessoa precisa abrir o bot no Telegram e tocar em "Iniciar" primeiro.';
  if (/bot is not a member|not enough rights|have no rights|CHAT_WRITE_FORBIDDEN|need administrator rights/i.test(d)) return 'O bot não tem permissão para publicar aí. Coloque o bot como administrador do canal (com "Publicar mensagens").';
  if (/bot was blocked/i.test(d)) return 'O contato bloqueou o bot no Telegram. Peça para ele desbloquear e tocar em "Iniciar" de novo.';
  if (/bot can't initiate conversation|bot can not initiate/i.test(d)) return 'O bot só fala com quem abriu a conversa primeiro. Peça ao contato para abrir o bot e tocar em "Iniciar".';
  if (/bot was kicked|user is deactivated/i.test(d)) return 'O bot foi removido desse canal ou grupo (ou a conta do contato foi desativada). Adicione-o de novo.';
  if (/Unauthorized/i.test(d)) return 'Token do bot inválido ou revogado. Gere um novo no @BotFather e salve na tela Telegram.';
  if (/wrong file identifier|failed to get HTTP URL content|IMAGE_PROCESS_FAILED|PHOTO_INVALID_DIMENSIONS|wrong type of the web page content/i.test(d)) return 'PHOTO:' + d;
  if (/Too Many Requests|retry after (\d+)/i.test(d)) return 'O Telegram pediu para esperar um pouco (limite de envios). A fila tenta de novo.';
  if (/message is too long|caption is too long/i.test(d)) return 'Mensagem longa demais para o Telegram.';
  return d || 'O Telegram não aceitou o pedido.';
}

async function call<T = any>(method: string, body?: Record<string, unknown> | FormData): Promise<T> {
  const token = await botToken();
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  let r: Response;
  try {
    r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: isForm ? undefined : { 'content-type': 'application/json' },
      body: isForm ? (body as FormData) : JSON.stringify(body || {}),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (e: any) {
    throw new Error(`Telegram sem resposta (${e?.name === 'TimeoutError' ? 'tempo esgotado' : e?.message || 'fetch failed'}).`);
  }
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok || !data?.ok) throw new Error(friendly(data?.description || `HTTP ${r.status}`));
  return data.result as T;
}

/** "@canal", "t.me/canal", "https://t.me/canal", "canal" → "@canal"; "-1001234" fica como está. */
export function normalizeTelegramChat(raw: string) {
  const s = (raw || '').trim().replace(/^https?:\/\//i, '').replace(/^(web\.)?t(elegram)?\.me\/(s\/)?/i, '').replace(/[/?#].*$/, '').trim();
  if (/^-?\d{5,}$/.test(s)) return s;
  const name = s.replace(/^@/, '');
  if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(name)) throw new Error('Informe o @nome público do canal (ex.: @meucanal), o link t.me/... ou o ID numérico (ex.: -1001234567890).');
  return '@' + name;
}

let botCache: { at: number; token: string; info: { id: number; username: string; name: string } } | null = null;
/** Dados do bot (getMe). Fica em cache por 10 min: a tela pede a cada carregamento para montar o link t.me/bot. */
export async function telegramBotInfo() {
  const token = await botToken();
  if (botCache && botCache.token === token && Date.now() - botCache.at < 10 * 60_000) return botCache.info;
  const me = await call<{ id: number; username: string; first_name: string }>('getMe');
  const info = { id: me.id, username: me.username, name: me.first_name };
  botCache = { at: Date.now(), token, info };
  return info;
}

/** Nome de exibição de um chat: título do canal/grupo ou nome da pessoa (contato no privado). */
function chatTitle(chat: any) {
  return chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || (chat.username ? `@${chat.username}` : String(chat.id));
}

/**
 * Dados do canal/grupo (ou contato) e se o bot pode publicar nele.
 * Contato (chat "private", pedido do usuário em 2026-10-16): o bot só consegue falar com quem já abriu a conversa com ele e
 * tocou em "Iniciar"; se a pessoa ainda não fez isso, o getChat devolve "chat not found".
 */
export async function telegramChatInfo(chatId: string) {
  const chat = await call<any>('getChat', { chat_id: chatId });
  const base: TelegramChat = { id: chat.id, type: chat.type, title: chatTitle(chat), username: chat.username };
  if (chat.type === 'private') return { ...base, role: 'contato', canPost: true } as TelegramChat & { role: string; canPost: boolean; members?: number };
  const me = await telegramBotInfo();
  let role = 'desconhecido';
  try { role = (await call<any>('getChatMember', { chat_id: chat.id, user_id: me.id }))?.status || role; } catch { /* grupo sem permissão de ler membros: segue */ }
  const canPost = chat.type === 'channel' ? ['administrator', 'creator'].includes(role) : !['left', 'kicked'].includes(role);
  const info: TelegramChat & { role: string; canPost: boolean; members?: number } = { ...base, role, canPost };
  try { info.members = await call<number>('getChatMemberCount', { chat_id: chat.id }); } catch { /* opcional */ }
  return info;
}

/**
 * Chats que o bot já viu (canal/grupo em que foi adicionado, contato que tocou em "Iniciar"...), guardados em .cache.
 * O Telegram só entrega cada atualização uma vez depois de confirmada (offset) e descarta as de mais de 24 h, então
 * em vez de reler sempre a fila crua, cada leitura confirma o que leu e grava aqui o que descobriu. Assim a tela
 * "Descobrir" continua mostrando canais antigos e o cadastro automático de contatos (telegram-contacts.ts) nunca perde ninguém.
 */
export type SeenChat = TelegramChat & { seenAt: string; blocked?: boolean; isNew?: boolean };
type ChatState = { offset: number; chats: Record<string, SeenChat> };
const CHATS_FILE = path.resolve(__dirname, '../../.cache/telegram-chats.json');
let chatState: ChatState | null = null;
function loadChatState(): ChatState {
  if (!chatState) { const j = readJson<Partial<ChatState>>(CHATS_FILE, {}); chatState = { offset: Number(j.offset) || 0, chats: j.chats && typeof j.chats === 'object' ? j.chats : {} }; }
  return chatState;
}
function saveChatState() { try { if (chatState) writeJsonAtomic(CHATS_FILE, chatState); } catch (e: any) { console.warn('[telegram] não salvou a lista de chats:', e?.message || e); } }

let polling: Promise<SeenChat[]> | null = null;
/** Lê as atualizações novas do bot, atualiza a lista de chats vistos e devolve os chats que apareceram agora. */
export function telegramPollUpdates(): Promise<SeenChat[]> {
  if (polling) return polling;
  polling = (async () => {
    const st = loadChatState();
    const fresh = new Map<number, SeenChat>();
    for (let round = 0; round < 10; round++) {
      const updates = await call<any[]>('getUpdates', { offset: st.offset || undefined, limit: 100, timeout: 0, allowed_updates: ['message', 'channel_post', 'my_chat_member'] });
      if (!updates?.length) break;
      for (const u of updates) {
        st.offset = Math.max(st.offset, Number(u.update_id) + 1);
        const chat = u.message?.chat || u.channel_post?.chat || u.my_chat_member?.chat;
        if (!chat) continue;
        const key = String(chat.id);
        const status = u.my_chat_member?.new_chat_member?.status;
        const was = st.chats[key];
        const seen: SeenChat = { id: chat.id, type: chat.type, title: chatTitle(chat), username: chat.username, seenAt: new Date((Number(u.message?.date || u.channel_post?.date || u.my_chat_member?.date) || Date.now() / 1000) * 1000).toISOString() };
        // Bot bloqueado pelo contato ou expulso do grupo: fica marcado, para a tela não oferecer e o automático não insistir.
        if (status === 'kicked' || status === 'left') { st.chats[key] = { ...seen, blocked: true }; fresh.delete(chat.id); continue; }
        st.chats[key] = seen;
        if (!was || was.blocked) fresh.set(chat.id, seen);
      }
      if (updates.length < 100) break;
    }
    saveChatState();
    return [...fresh.values()];
  })().finally(() => { polling = null; });
  return polling;
}

/** Tudo que o bot já viu e ainda pode receber mensagem (mais recente primeiro). Contato tem type "private". */
export function telegramKnownChats(): SeenChat[] {
  return Object.values(loadChatState().chats).filter(c => !c.blocked).sort((a, b) => (b.seenAt || '').localeCompare(a.seenAt || ''));
}

/** Canais, grupos e contatos conhecidos do bot, depois de ler o que chegou de novo. Ajuda a achar o ID. */
export async function telegramDiscoverChats(): Promise<SeenChat[]> {
  await telegramPollUpdates();
  return telegramKnownChats();
}

/**
 * Link de convite do grupo/canal para o bot mandar aos contatos (pedido do usuário em 2026-10-16: "adicionar contato no
 * grupo de ofertas em lote"). O Bot API não deixa um bot colocar pessoas dentro de um grupo; o que ele pode é criar o
 * link de convite (sendo administrador com "Convidar usuários via link") e mandar para cada contato entrar com um toque.
 */
export async function telegramInviteLink(chatId: string, username?: string | null) {
  try {
    const r = await call<any>('createChatInviteLink', { chat_id: chatId, name: 'Robô das Ofertas' });
    if (r?.invite_link) return String(r.invite_link);
  } catch (e: any) {
    if (username) return `https://t.me/${username.replace(/^@/, '')}`;
    throw new Error(`Não consegui criar o link de convite: ${e?.message || e} Coloque o bot como administrador do grupo com a permissão "Convidar usuários via link".`);
  }
  if (username) return `https://t.me/${username.replace(/^@/, '')}`;
  throw new Error('O Telegram não devolveu o link de convite do grupo.');
}

/** Formatação do WhatsApp (*negrito*, ~riscado~, _itálico_) → HTML do Telegram, com o resto escapado. */
export function whatsappToTelegramHtml(text: string) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return (text || '').split('\n').map(line => {
    // Links ficam fora da conversão de markup, senão um "_" dentro do link vira itálico.
    return line.split(/(https?:\/\/[^\s<>"']+)/gi).map((part, i) => i % 2 ? esc(part) : esc(part)
      .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
      .replace(/~([^~\n]+)~/g, '<s>$1</s>')
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>')
    ).join('');
  }).join('\n');
}

async function sendPhotoByUrl(chatId: string, imageUrl: string, caption?: string) {
  return call<any>('sendPhoto', { chat_id: chatId, photo: imageUrl, ...(caption ? { caption, parse_mode: 'HTML' } : {}) });
}

/** O Telegram não conseguiu baixar a foto (CDN que bloqueia robô, webp...): baixa aqui e envia o arquivo. */
async function sendPhotoByUpload(chatId: string, imageUrl: string, caption?: string) {
  const r = await fetch(imageUrl, { headers: { 'user-agent': 'Mozilla/5.0', accept: 'image/*' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`Não consegui baixar a foto do produto (HTTP ${r.status}).`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 10 * 1024 * 1024) throw new Error('Foto do produto acima de 10 MB; o Telegram não aceita.');
  const type = r.headers.get('content-type') || 'image/jpeg';
  const form = new FormData();
  form.append('chat_id', chatId);
  if (caption) { form.append('caption', caption); form.append('parse_mode', 'HTML'); }
  form.append('photo', new Blob([buf], { type }), 'oferta.' + (type.includes('png') ? 'png' : 'jpg'));
  return call<any>('sendPhoto', form);
}

/** Texto puro para o Telegram: *negrito* vira negrito de verdade; foto do produto vai junto quando houver. */
export async function sendTelegramOffer(chatId: string, text: string, imageUrl?: string) {
  const html = whatsappToTelegramHtml(text);
  if (imageUrl) {
    const caption = html.length <= CAPTION_MAX ? html : undefined;
    let sent: any;
    try { sent = await sendPhotoByUrl(chatId, imageUrl, caption); }
    catch (e: any) {
      if (!String(e?.message || '').startsWith('PHOTO:')) throw e;
      try { sent = await sendPhotoByUpload(chatId, imageUrl, caption); }
      catch { sent = null; } // sem foto não é motivo para perder a oferta: manda só o texto
    }
    if (sent && caption) return { messageId: sent.message_id, chatId: sent.chat?.id, photo: true };
    const msg = await call<any>('sendMessage', { chat_id: chatId, text: html.slice(0, TEXT_MAX), parse_mode: 'HTML', link_preview_options: { is_disabled: !!sent } });
    return { messageId: msg.message_id, chatId: msg.chat?.id, photo: !!sent };
  }
  const msg = await call<any>('sendMessage', { chat_id: chatId, text: html.slice(0, TEXT_MAX), parse_mode: 'HTML' });
  return { messageId: msg.message_id, chatId: msg.chat?.id, photo: false };
}

/** Filtro Prisma: canal do Telegram marcado "automático" (recebe as ofertas de todas as automações e o listão de cupons). */
export const TELEGRAM_AUTO = { type: 'TELEGRAM' as const, enabled: true, configJson: { path: ['allAutomations'], equals: true } };

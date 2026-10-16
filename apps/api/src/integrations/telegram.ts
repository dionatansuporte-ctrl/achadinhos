import { getSecret } from '../services/settings';

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
  if (/chat not found/i.test(d)) return 'Canal não encontrado. Confira o @nome (ou o ID) e se o bot já foi adicionado nele.';
  if (/bot is not a member|not enough rights|have no rights|CHAT_WRITE_FORBIDDEN|need administrator rights/i.test(d)) return 'O bot não tem permissão para publicar aí. Coloque o bot como administrador do canal (com "Publicar mensagens").';
  if (/bot was kicked|bot was blocked|user is deactivated/i.test(d)) return 'O bot foi removido desse canal ou grupo. Adicione-o de novo.';
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

export async function telegramBotInfo() {
  const me = await call<{ id: number; username: string; first_name: string }>('getMe');
  return { id: me.id, username: me.username, name: me.first_name };
}

/** Dados do canal/grupo e se o bot pode publicar nele. */
export async function telegramChatInfo(chatId: string) {
  const chat = await call<any>('getChat', { chat_id: chatId });
  const me = await telegramBotInfo();
  let role = 'desconhecido';
  try { role = (await call<any>('getChatMember', { chat_id: chat.id, user_id: me.id }))?.status || role; } catch { /* grupo sem permissão de ler membros: segue */ }
  const canPost = chat.type === 'channel' ? ['administrator', 'creator'].includes(role) : !['left', 'kicked'].includes(role);
  const info: TelegramChat & { role: string; canPost: boolean; members?: number } = { id: chat.id, type: chat.type, title: chat.title || chat.first_name || chat.username || String(chat.id), username: chat.username, role, canPost };
  try { info.members = await call<number>('getChatMemberCount', { chat_id: chat.id }); } catch { /* opcional */ }
  return info;
}

/** Canais e grupos em que o bot recebeu alguma atualização recente (adicionado, mensagem...). Ajuda a achar o ID. */
export async function telegramDiscoverChats(): Promise<TelegramChat[]> {
  const updates = await call<any[]>('getUpdates', { limit: 100, allowed_updates: ['message', 'channel_post', 'my_chat_member'] });
  const map = new Map<number, TelegramChat>();
  for (const u of updates || []) {
    const chat = u.message?.chat || u.channel_post?.chat || u.my_chat_member?.chat;
    if (!chat || chat.type === 'private') continue;
    map.set(chat.id, { id: chat.id, type: chat.type, title: chat.title || String(chat.id), username: chat.username });
  }
  return [...map.values()];
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

import path from 'node:path';
import { prisma } from '../db';
import { getSecret } from './settings';
import { readJson, writeJsonAtomic } from './json-file';
import { sendTelegramOffer, telegramInviteLink, telegramKnownChats, telegramPollUpdates, type SeenChat } from '../integrations/telegram';

/**
 * Contatos do Telegram → grupo de ofertas (pedido do usuário em 2026-10-16: "adicionar contato no grupo de ofertas,
 * em lote"; e "não para enviar oferta no bot, somente no grupo").
 *
 * Um bot não consegue colocar ninguém dentro de um grupo (a API do Telegram não permite) e só fala com quem abriu a
 * conversa com ele e tocou em "Iniciar". Então o fluxo é: o usuário divulga o link t.me/<bot>; quem toca em Iniciar
 * vira "contato" (fica em .cache/telegram-chats.json, lido do bot a cada minuto); o robô manda para ele o convite do
 * grupo de ofertas escolhido, sozinho (assim que entra) e em lote pelo botão da tela. Oferta nenhuma vai no privado:
 * contato não é canal, e a tela de Telegram só manda promoção para canais e grupos.
 * Cada contato recebe o convite de um grupo uma vez só (controle em .cache/telegram-invites.json).
 */

export type ContactsConfig = { autoInvite: boolean; inviteGroupId: string | null };
const CONFIG_FILE = path.resolve(__dirname, '../../.cache/telegram-contacts.json');
const INVITES_FILE = path.resolve(__dirname, '../../.cache/telegram-invites.json');
const DEFAULT: ContactsConfig = { autoInvite: true, inviteGroupId: null };
const POLL_EVERY = 60_000;
const GAP_MS = 1200;       // folga entre convites no lote: o Telegram limita mensagens a pessoas diferentes por segundo

export function getContactsConfig(): ContactsConfig {
  const j = readJson<Partial<ContactsConfig>>(CONFIG_FILE, {});
  return { autoInvite: j.autoInvite ?? DEFAULT.autoInvite, inviteGroupId: j.inviteGroupId || null };
}
export function saveContactsConfig(patch: Partial<ContactsConfig>): ContactsConfig {
  const next = { ...getContactsConfig(), ...patch };
  writeJsonAtomic(CONFIG_FILE, next);
  return next;
}

// Convites já mandados: { [groupChannelId]: { [idDoContato]: dataISO } }
type Invites = Record<string, Record<string, string>>;
const invites = () => readJson<Invites>(INVITES_FILE, {});
function markInvited(groupId: string, ids: string[]) {
  const all = invites(); all[groupId] = all[groupId] || {};
  const now = new Date().toISOString();
  for (const d of ids) all[groupId][d] = now;
  writeJsonAtomic(INVITES_FILE, all);
}

const firstName = (name: string) => (name || '').trim().split(' ')[0] || 'tudo bem';
const inviteText = (name: string, groupName: string, link: string) =>
  `Oi, ${firstName(name)}! 👋 Que bom ter você por aqui.\nEntre no nosso grupo *${groupName}* no Telegram: lá saem as *melhores ofertas do dia*, com foto, preço e link. É só tocar aqui:\n${link}\n\nTe espero lá! 🛍️`;

/** Grupo de ofertas escolhido para convidar (um canal TELEGRAM que não seja contato). */
async function offerGroup(userId: string | null, groupId: string) {
  const g = await prisma.channel.findFirst({ where: { id: groupId, ...(userId ? { userId } : {}), type: 'TELEGRAM' } });
  if (!g) throw new Error('Grupo de ofertas não encontrado. Escolha um grupo do Telegram cadastrado.');
  if ((g.configJson as any)?.chatType === 'private') throw new Error('Esse destino é um contato, não um grupo. Escolha um grupo ou canal.');
  return g;
}

/** Link de convite do grupo, criado uma vez e guardado no canal. */
export async function groupInviteLink(group: { id: string; destination: string; configJson: unknown }) {
  const cfg = ((group.configJson as any) || {}) as Record<string, unknown>;
  if (typeof cfg.inviteLink === 'string' && cfg.inviteLink) return cfg.inviteLink;
  const link = await telegramInviteLink(group.destination, (cfg.username as string) || (group.destination.startsWith('@') ? group.destination : null));
  await prisma.channel.update({ where: { id: group.id }, data: { configJson: { ...cfg, inviteLink: link } } });
  return link;
}

export type ContactRow = SeenChat & { invitedAt: string | null };
/** Contatos que o bot conhece (quem tocou em Iniciar e não bloqueou), com a data do convite do grupo escolhido. */
export function listContacts(groupId: string | null): ContactRow[] {
  const done = groupId ? invites()[groupId] || {} : {};
  return telegramKnownChats().filter(c => c.type === 'private').map(c => ({ ...c, invitedAt: done[String(c.id)] || null }));
}

// Lote em andamento (um por vez): a tela acompanha pelo GET /api/telegram.
export type InviteProgress = { running: boolean; groupName: string; total: number; sent: number; failed: number; startedAt: string | null; finishedAt: string | null; errors: string[] };
const progress: InviteProgress = { running: false, groupName: '', total: 0, sent: 0, failed: 0, startedAt: null, finishedAt: null, errors: [] };
export const inviteProgress = () => progress;

async function sendInvite(c: SeenChat, groupId: string, groupName: string, link: string) {
  try { await sendTelegramOffer(String(c.id), inviteText(c.title, groupName, link)); }
  catch (e: any) {
    // Limite de ritmo: espera um pouco e tenta uma vez mais.
    if (!/esperar um pouco/i.test(e?.message || '')) throw e;
    await new Promise(r => setTimeout(r, 4000));
    await sendTelegramOffer(String(c.id), inviteText(c.title, groupName, link));
  }
  markInvited(groupId, [String(c.id)]);
}

/**
 * Em lote: manda o convite do grupo de ofertas para todos os contatos que ainda não o receberam (ou só para `ids`).
 * Roda em segundo plano, um convite por vez, com folga; devolve na hora quantos entraram no lote.
 */
export async function inviteContactsToGroup(userId: string, groupId: string, ids?: string[], again = false) {
  if (progress.running) throw new Error('Já tem um lote de convites em andamento. Aguarde terminar.');
  const g = await offerGroup(userId, groupId);
  const link = await groupInviteLink(g);
  await telegramPollUpdates().catch(() => { /* usa o que já conhecemos */ });
  let people = listContacts(g.id);
  if (ids?.length) { const set = new Set(ids.map(String)); people = people.filter(p => set.has(String(p.id))); }
  const todo = again ? people : people.filter(p => !p.invitedAt);
  Object.assign(progress, { running: todo.length > 0, groupName: g.name, total: todo.length, sent: 0, failed: 0, startedAt: new Date().toISOString(), finishedAt: todo.length ? null : new Date().toISOString(), errors: [] });
  if (todo.length) {
    (async () => {
      for (const [i, c] of todo.entries()) {
        if (i) await new Promise(r => setTimeout(r, GAP_MS));
        try { await sendInvite(c, g.id, g.name, link); progress.sent++; }
        catch (e: any) { progress.failed++; if (progress.errors.length < 20) progress.errors.push(`${c.title}: ${e?.message || e}`); }
      }
      progress.running = false; progress.finishedAt = new Date().toISOString();
      console.log(`[telegram] lote de convites para "${g.name}": ${progress.sent} enviado(s), ${progress.failed} falha(s).`);
    })().catch(() => { progress.running = false; progress.finishedAt = new Date().toISOString(); });
  }
  return { queued: todo.length, alreadyInvited: people.length - todo.length, total: people.length, link, groupName: g.name };
}

let running = false;
/** Lê o bot; quem acabou de tocar em Iniciar recebe o convite do grupo de ofertas, se o automático estiver ligado. */
async function tick() {
  if (running) return;
  running = true;
  try {
    if (!(await getSecret('TELEGRAM_BOT_TOKEN'))) return;
    const fresh = (await telegramPollUpdates()).filter(c => c.type === 'private');
    const cfg = getContactsConfig();
    if (!fresh.length || !cfg.autoInvite || !cfg.inviteGroupId || progress.running) return;
    const g = await offerGroup(null, cfg.inviteGroupId);
    const link = await groupInviteLink(g);
    const done = invites()[g.id] || {};
    for (const [i, c] of fresh.entries()) {
      if (done[String(c.id)]) continue;
      if (i) await new Promise(r => setTimeout(r, GAP_MS));
      try { await sendInvite(c, g.id, g.name, link); console.log(`[telegram] convite do grupo "${g.name}" enviado sozinho para ${c.title}.`); }
      catch (e: any) { console.warn(`[telegram] convite para ${c.title} falhou: ${e?.message || e}`); }
    }
  } catch (e: any) {
    // Sem token, sem internet ou Telegram fora do ar: tenta de novo no próximo minuto, sem encher o log.
    if (!/não configurado/i.test(e?.message || '')) console.warn(`[telegram] leitura automática do bot falhou: ${e?.message || e}`);
  } finally { running = false; }
}

/** Liga a leitura do bot a cada minuto (contatos novos e convite automático do grupo). */
export function startTelegramContacts() {
  setTimeout(() => { tick().catch(() => {}); }, 15_000).unref();
  setInterval(() => { tick().catch(() => {}); }, POLL_EVERY).unref();
}

import { prisma } from '../db';
import { getGroupInfo, setGroupDescription, sendWhatsAppWebCard, pinGroupMessage, anyWaConnected } from '../integrations/whatsapp-web';
import { marketplaceChannelIds, marketplaceName } from './coupons';
import type { Marketplace } from '@prisma/client';

/**
 * Link principal do grupo (pedido do usuário em 2026-10-28): o link de cupons/ofertas da loja com o rastreio do
 * afiliado, para a venda indireta (quem entra por ele e compra qualquer coisa nas ~24 h seguintes). Entra em dois
 * lugares: na descrição do grupo (bloco no fim, trocado inteiro ao reaplicar) e numa mensagem fixada no topo.
 * Como os grupos têm mensagem temporária (7 dias), a fixada some junto: o robô renova sozinho antes de vencer,
 * olhando o prazo de temporária de cada grupo (7 dias → nova fixada a cada 6; sem temporária → a cada 29 dias).
 * Os links são os cadastrados na tela Cupons; a loja de cada grupo vem das automações que usam o grupo.
 */
const HEADER = '🛒 *Compre pelos links do grupo e garanta as ofertas:*';
const ICON: Record<string, string> = { MERCADO_LIVRE: '🟡', SHOPEE: '🛍️', AMAZON: '📦' };
const MARKETPLACES: Marketplace[] = ['MERCADO_LIVRE', 'SHOPEE', 'AMAZON'];
const DAY = 86_400_000;
const CHECK_EVERY = 60 * 60_000;

type StoreLink = { marketplace: Marketplace; link: string };
/** Guardado em channel.configJson.mainLinkPin: quando fixou, quando renovar e as chaves das mensagens fixadas. */
type PinState = { at: number; renewAt: number; keys: any[] };

/** Links da loja de cada grupo: { canalId → [{ marketplace, link }] }. Só lojas com link cadastrado em Cupons. */
async function linksByChannel(userId: string) {
  const out = new Map<string, StoreLink[]>();
  const schedules = await prisma.couponSchedule.findMany({ where: { userId }, select: { marketplace: true, link: true } });
  for (const m of MARKETPLACES) {
    const link = schedules.find(s => s.marketplace === m)?.link?.trim();
    if (!link) continue;
    for (const id of await marketplaceChannelIds(userId, m)) {
      const list = out.get(id) || [];
      list.push({ marketplace: m, link });
      out.set(id, list);
    }
  }
  return out;
}

export function mainLinkBlock(links: StoreLink[]) {
  return [HEADER, ...links.map(l => `${ICON[l.marketplace] || '🔗'} ${marketplaceName(l.marketplace)} 👉 ${l.link}`)].join('\n');
}

/** Descrição nova: o que já havia (sem um bloco nosso anterior) + o bloco de links. */
export function mergeDescription(current: string, block: string) {
  const idx = current.indexOf(HEADER);
  const kept = (idx >= 0 ? current.slice(0, idx) : current).trim();
  return kept ? `${kept}\n\n${block}` : block;
}

/** Prazo da fixada e quando renovar, conforme a mensagem temporária do grupo (segundos; 0 = sem temporária). */
export function pinPlan(ephemeralSeconds: number): { pinFor: 86400 | 604800 | 2592000; renewMs: number } {
  const eph = ephemeralSeconds * 1000;
  if (eph > 0 && eph <= 7 * DAY) return { pinFor: eph <= DAY ? 86400 : 604800, renewMs: Math.max(eph - DAY, 12 * 60 * 60_000) };
  if (eph > 0 && eph < 30 * DAY) return { pinFor: 604800, renewMs: Math.min(eph, 7 * DAY) - DAY };
  return { pinFor: 2592000, renewMs: 29 * DAY };
}

/** Mensagem fixada: um cartão por loja, com o link. */
function pinMessage(l: StoreLink) {
  const store = marketplaceName(l.marketplace);
  return {
    text: `📌 *Link oficial do grupo – ${store}*\nCompre por aqui e garanta as ofertas e cupons 👇\n${l.link}`,
    card: { url: l.link, title: `Ofertas e cupons ${store}`, description: 'Toque para abrir pelo link do grupo' }
  };
}

export type MainLinkResult = { channelId: string; name: string; ok: boolean; message: string };

export type MainLinkStatus = {
  groups: { channelId: string; name: string; enabled: boolean; stores: string[]; pinnedAt: number | null; renewAt: number | null }[];
  /** Grupos em que o robô está mas que ainda não são canal (ex.: grupo recém-criado). */
  unregistered: { id: string; name: string; admin: boolean }[];
};

/** Quadro da tela Canais: cada grupo com a loja e o estado da fixada, e os grupos ainda não cadastrados. */
export async function mainLinkStatus(userId: string, waGroups: { id: string; name: string; admins: string[] }[]): Promise<MainLinkStatus> {
  const channels = await prisma.channel.findMany({ where: { userId, type: 'WHATSAPP_GROUP', destination: { endsWith: '@g.us' } }, orderBy: { name: 'asc' } });
  const links = await linksByChannel(userId);
  const groups = channels.map(c => {
    const p = (c.configJson as any)?.mainLinkPin as PinState | undefined;
    return { channelId: c.id, name: c.name, enabled: c.enabled, stores: (links.get(c.id) || []).map(l => marketplaceName(l.marketplace)), pinnedAt: p?.at ?? null, renewAt: p?.renewAt ?? null };
  });
  const known = new Set(channels.map(c => c.destination));
  const unregistered = waGroups.filter(g => !known.has(g.id)).map(g => ({ id: g.id, name: g.name, admin: g.admins.length > 0 }));
  return { groups, unregistered };
}

/** Descrição + mensagem fixada nos grupos informados (ou em todos os ativos). */
export async function applyMainLink(userId: string, channelIds?: string[]): Promise<MainLinkResult[]> {
  const channels = await prisma.channel.findMany({ where: { userId, type: 'WHATSAPP_GROUP', destination: { endsWith: '@g.us' }, ...(channelIds?.length ? { id: { in: channelIds } } : { enabled: true }) }, orderBy: { name: 'asc' } });
  const links = await linksByChannel(userId);
  const results: MainLinkResult[] = [];
  for (const c of channels) {
    const mine = links.get(c.id) || [];
    if (!mine.length) { results.push({ channelId: c.id, name: c.name, ok: false, message: 'Nenhum link cadastrado em Cupons para a loja deste grupo.' }); continue; }
    try {
      const info = await getGroupInfo(c.destination);
      const next = mergeDescription(info.desc, mainLinkBlock(mine));
      if (next !== info.desc.trim()) await setGroupDescription(c.destination, next);
      const plan = await pinLinks(c, mine, info.ephemeral);
      const stores = mine.map(l => marketplaceName(l.marketplace)).join(' e ');
      results.push({ channelId: c.id, name: c.name, ok: true, message: `Link de ${stores} na descrição e fixado no topo; renova sozinho a cada ${Math.round(plan.renewMs / DAY)} dia(s).` });
    } catch (e: any) {
      const m = String(e?.message || e);
      results.push({ channelId: c.id, name: c.name, ok: false, message: /not-authorized|forbidden|403/i.test(m) ? 'O robô precisa ser administrador do grupo para mudar a descrição e fixar mensagem.' : m });
    }
  }
  return results;
}

/** Solta a fixada anterior (se ainda existir), manda o cartão de cada loja e fixa; guarda no canal quando renovar. */
async function pinLinks(c: { id: string; destination: string; configJson: any }, mine: StoreLink[], ephemeral: number) {
  const plan = pinPlan(ephemeral);
  const prev = (c.configJson as any)?.mainLinkPin as PinState | undefined;
  for (const key of prev?.keys || []) { try { await pinGroupMessage(c.destination, key, plan.pinFor, true); } catch { /* já venceu ou sumiu */ } }
  const keys: any[] = [];
  for (const l of mine) {
    const m = pinMessage(l);
    const sent: any = await sendWhatsAppWebCard(c.destination, m.text, m.card);
    if (!sent?.key) continue;
    await pinGroupMessage(c.destination, sent.key, plan.pinFor);
    keys.push(sent.key);
  }
  const state: PinState = { at: Date.now(), renewAt: Date.now() + plan.renewMs, keys };
  await prisma.channel.update({ where: { id: c.id }, data: { configJson: { ...((c.configJson as any) || {}), mainLinkPin: state } } });
  return plan;
}

/** Renovação automática: de hora em hora, refaz a fixada dos grupos cujo prazo chegou. */
export function startMainLinkRenewal() {
  const tick = async () => {
    if (!anyWaConnected()) return;
    const channels = await prisma.channel.findMany({ where: { type: 'WHATSAPP_GROUP', enabled: true, destination: { endsWith: '@g.us' } } });
    const due = channels.filter(c => { const p = (c.configJson as any)?.mainLinkPin as PinState | undefined; return p && Date.now() >= p.renewAt; });
    for (const c of due) {
      const [r] = await applyMainLink(c.userId, [c.id]);
      console.log(`[link principal] ${c.name}: ${r?.ok ? 'fixada renovada' : 'não renovou: ' + r?.message}`);
      if (!r?.ok) {
        // Falhou (WhatsApp fora, sem admin...): tenta de novo na próxima hora, sem martelar.
        const p = (c.configJson as any)?.mainLinkPin as PinState;
        await prisma.channel.update({ where: { id: c.id }, data: { configJson: { ...(c.configJson as any), mainLinkPin: { ...p, renewAt: Date.now() + CHECK_EVERY } } } }).catch(() => {});
      }
    }
  };
  setInterval(() => { tick().catch(e => console.error('[link principal]', e?.message || e)); }, CHECK_EVERY).unref();
  setTimeout(() => { tick().catch(() => {}); }, 90_000);
}

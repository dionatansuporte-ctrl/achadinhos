import { prisma } from '../db';
import { getGroupDescription, setGroupDescription } from '../integrations/whatsapp-web';
import { marketplaceChannelIds, marketplaceName } from './coupons';
import type { Marketplace } from '@prisma/client';

/**
 * Link principal na descrição do grupo (pedido do usuário em 2026-10-28): quem abre as informações do grupo
 * vê o link de cupons/ofertas da loja com o rastreio do afiliado. Quem entra por ele e compra qualquer coisa
 * nas ~24 h seguintes gera a venda indireta. Os links são os cadastrados na tela Cupons; a loja de cada grupo
 * vem das automações que usam o grupo (mesma regra do listão). O bloco fica no fim da descrição, abaixo do que
 * o usuário já escreveu, e é trocado inteiro quando reaplicado (não duplica).
 */
const HEADER = '🛒 *Compre pelos links do grupo e garanta as ofertas:*';
const ICON: Record<string, string> = { MERCADO_LIVRE: '🟡', SHOPEE: '🛍️', AMAZON: '📦' };
const MARKETPLACES: Marketplace[] = ['MERCADO_LIVRE', 'SHOPEE', 'AMAZON'];

/** Links da loja de cada grupo: { canalId → [{ marketplace, link }] }. Só lojas com link cadastrado em Cupons. */
async function linksByChannel(userId: string) {
  const out = new Map<string, { marketplace: Marketplace; link: string }[]>();
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

export function mainLinkBlock(links: { marketplace: Marketplace; link: string }[]) {
  return [HEADER, ...links.map(l => `${ICON[l.marketplace] || '🔗'} ${marketplaceName(l.marketplace)} 👉 ${l.link}`)].join('\n');
}

/** Descrição nova: o que já havia (sem um bloco nosso anterior) + o bloco de links. */
export function mergeDescription(current: string, block: string) {
  const idx = current.indexOf(HEADER);
  const kept = (idx >= 0 ? current.slice(0, idx) : current).trim();
  return kept ? `${kept}\n\n${block}` : block;
}

export type MainLinkResult = { channelId: string; name: string; ok: boolean; message: string };

/** Aplica o bloco de links na descrição dos grupos informados (ou de todos os grupos ativos). */
export async function applyMainLink(userId: string, channelIds?: string[]): Promise<MainLinkResult[]> {
  const channels = await prisma.channel.findMany({ where: { userId, type: 'WHATSAPP_GROUP', ...(channelIds?.length ? { id: { in: channelIds } } : { enabled: true }) }, orderBy: { name: 'asc' } });
  const links = await linksByChannel(userId);
  const results: MainLinkResult[] = [];
  for (const c of channels) {
    const mine = links.get(c.id) || [];
    if (!mine.length) { results.push({ channelId: c.id, name: c.name, ok: false, message: 'Nenhum link cadastrado em Cupons para a loja deste grupo.' }); continue; }
    try {
      const via = (c.configJson as any)?.session as string | undefined;
      const current = await getGroupDescription(c.destination, via);
      const next = mergeDescription(current, mainLinkBlock(mine));
      if (next === current.trim()) { results.push({ channelId: c.id, name: c.name, ok: true, message: 'Já estava com o link.' }); continue; }
      await setGroupDescription(c.destination, next, via);
      results.push({ channelId: c.id, name: c.name, ok: true, message: `Link de ${mine.map(l => marketplaceName(l.marketplace)).join(' e ')} na descrição.` });
    } catch (e: any) {
      const m = String(e?.message || e);
      results.push({ channelId: c.id, name: c.name, ok: false, message: /not-authorized|forbidden|403/i.test(m) ? 'O robô precisa ser administrador do grupo para mudar a descrição.' : m });
    }
  }
  return results;
}

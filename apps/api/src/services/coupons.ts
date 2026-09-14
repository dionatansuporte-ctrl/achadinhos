import type { Coupon, CouponSchedule, Marketplace } from '@prisma/client';
import { prisma } from '../db';
import { inWindow, minutesOfDay } from './scheduler';
import { importTelegramCoupons } from './coupon-import';
import { hasShopeeSearch, ruleMarketplaces } from './shopee-sync';

/**
 * Cupons da Shopee e do Mercado Livre.
 *
 * Nenhuma das duas plataformas expõe cupom pela API de afiliado, então o usuário cadastra
 * os cupons que pegou (portal do afiliado, grupos do Telegram...), com validade e compra
 * mínima. O sistema garante que só cupom válido sai para os grupos:
 *   - "listão": uma mensagem por marketplace com todos os cupons válidos, a cada
 *     `everyMinutes` (padrão 2 h) dentro da janela do dia, com o link do usuário;
 *   - opcionalmente, o cupom também entra na linha "🎟️ Cupom" das mensagens de produto
 *     (`inProducts`), quando o preço do produto atinge a compra mínima.
 * Cupom vencido para de sair sozinho; não precisa apagar.
 */

const TZ = 'America/Sao_Paulo';
const brl = (n: number) => `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const MARKETPLACES: Marketplace[] = ['SHOPEE', 'MERCADO_LIVRE'];
export const marketplaceName = (m: Marketplace) => (m === 'SHOPEE' ? 'Shopee' : 'Mercado Livre');

/** Fim do dia informado ("2026-09-30") no fuso de São Paulo. Aceita também ISO completo. */
export function parseValidUntil(v?: string | null): Date | null {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T23:59:59-03:00`);
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

export function isExpired(c: Pick<Coupon, 'validUntil'>, now = new Date()) {
  return !!c.validUntil && c.validUntil.getTime() < now.getTime();
}

/** Pode sair agora? Ligado e não vencido. */
export const isUsable = (c: Pick<Coupon, 'enabled' | 'validUntil'>, now = new Date()) => c.enabled && !isExpired(c, now);

const shortDate = (d: Date) => d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: TZ });

type CouponLine = Pick<Coupon, 'code' | 'description' | 'minPrice' | 'validUntil'>;

/** Uma linha do listão: "🏷️ *CODIGO*: 10% OFF acima de R$ 79 (até 30/09)". */
export function couponLine(c: CouponLine) {
  const desc = (c.description || '').trim()
    || (c.minPrice != null && Number(c.minPrice) > 0 ? `compra mínima ${brl(Number(c.minPrice))}` : '');
  const until = c.validUntil ? ` (até ${shortDate(c.validUntil)})` : '';
  return `🏷️ *${c.code}*${desc ? `: ${desc}` : ''}${until}`;
}

/** Texto do listão de cupons de um marketplace. */
export function couponListMessage(marketplace: Marketplace, coupons: CouponLine[], link?: string | null) {
  const lines = [
    `🎟️ *CUPONS ${marketplaceName(marketplace).toUpperCase()}*`,
    '',
    ...(coupons.length ? coupons.map(couponLine) : [marketplace === 'SHOPEE' ? '💛 Resgate seu cupom 👇' : '💛 Veja os cupons do dia:']),
    '',
    link ? (coupons.length ? '✅ Ative e compre por aqui:' : '👇 Pegue aqui:') : '',
    link || '',
    '',
    '⚠️ Cupons têm quantidade limitada e podem acabar antes do prazo.'
  ];
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Cupons válidos de um marketplace do usuário, na ordem de cadastro. */
export async function usableCoupons(userId: string, marketplace: Marketplace, now = new Date()) {
  const list = await prisma.coupon.findMany({ where: { userId, marketplace, enabled: true }, orderBy: { createdAt: 'asc' } });
  return list.filter(c => isUsable(c, now));
}

/** Cupons que podem entrar nas mensagens de produto do usuário, já filtrados por validade. */
export async function productCoupons(userId: string) {
  const list = await prisma.coupon.findMany({ where: { userId, enabled: true, inProducts: true } });
  const now = new Date();
  return list.filter(c => isUsable(c, now));
}

/**
 * Escolhe o cupom para um produto: mesmo marketplace, compra mínima atingida.
 * Entre vários, prefere o de maior compra mínima (normalmente o de maior desconto que ainda cabe).
 */
export function pickCoupon(coupons: Coupon[], product: { marketplace: Marketplace; price?: number | { toString(): string } | null }) {
  const price = product.price != null ? Number(product.price) : null;
  const ok = coupons.filter(c => c.marketplace === product.marketplace && (c.minPrice == null || (price != null && price >= Number(c.minPrice))));
  ok.sort((a, b) => Number(b.minPrice ?? 0) - Number(a.minPrice ?? 0));
  return ok[0]?.code;
}

/**
 * Grupos de um marketplace: os que as automações ativas daquele marketplace usam.
 * Assim cupom do Mercado Livre só vai para grupo do Mercado Livre, e Shopee só para Shopee,
 * sem o usuário precisar marcar grupo por grupo. Grupo novo entra sozinho assim que for usado numa
 * automação do marketplace. Automação sem grupo marcado (= manda para todos) conta todos os canais ativos.
 */
export async function marketplaceChannelIds(userId: string, marketplace: Marketplace): Promise<string[]> {
  const autos = await prisma.automation.findMany({ where: { userId, status: 'ACTIVE' }, select: { rulesJson: true, scheduleJson: true } });
  const ids = new Set<string>();
  let all = false;
  for (const a of autos) {
    const rules = (a.rulesJson || {}) as any;
    const mkts: string[] = hasShopeeSearch(rules) ? ruleMarketplaces(rules.shopeeSearch) : [rules?.marketplace];
    if (!mkts.includes(marketplace)) continue;
    const picked = (a.scheduleJson as any)?.channelIds;
    if (Array.isArray(picked) && picked.length) { for (const id of picked) if (typeof id === 'string') ids.add(id); }
    else all = true;
  }
  if (all) for (const c of await prisma.channel.findMany({ where: { userId, enabled: true }, select: { id: true } })) ids.add(c.id);
  return [...ids];
}

/** Grupos que recebem o listão: os marcados na agenda ou, sem marcação, os do marketplace. */
export async function scheduleChannels(sch: Pick<CouponSchedule, 'userId' | 'marketplace' | 'channelIds'>) {
  const picked = Array.isArray(sch.channelIds) && (sch.channelIds as string[]).length ? (sch.channelIds as string[]) : await marketplaceChannelIds(sch.userId, sch.marketplace);
  if (!picked.length) return [];
  return prisma.channel.findMany({ where: { userId: sch.userId, enabled: true, id: { in: picked } }, orderBy: { name: 'asc' } });
}

/** Agenda do listão por marketplace; cria com os padrões na primeira vez. */
export async function getSchedule(userId: string, marketplace: Marketplace) {
  return prisma.couponSchedule.upsert({ where: { userId_marketplace: { userId, marketplace } }, update: {}, create: { userId, marketplace } });
}

/** Toda mensagem enviada pertence a uma automação; os listões ficam agrupados numa fixa por usuário. */
async function couponAutomation(userId: string) {
  let a = await prisma.automation.findFirst({ where: { userId, name: 'Cupons' } });
  if (!a) a = await prisma.automation.create({ data: { userId, name: 'Cupons', description: 'Listões de cupom enviados pela tela Cupons', template: '{{title}}', status: 'ACTIVE' } });
  return a;
}

/** Coloca o listão na fila para os grupos da agenda (ou todos os ativos). Devolve quantos grupos. */
export async function sendCouponList(sch: CouponSchedule, source: 'manual' | 'scheduler') {
  const coupons = await usableCoupons(sch.userId, sch.marketplace);
  if (!coupons.length && !sch.link) throw new Error(`Nenhum cupom válido de ${marketplaceName(sch.marketplace)} e nenhum link para enviar.`);
  const channels = await scheduleChannels(sch);
  if (!channels.length) throw new Error(`Nenhum grupo de ${marketplaceName(sch.marketplace)}: marque os grupos na agenda do listão ou use-os numa automação ${marketplaceName(sch.marketplace)} ativa.`);
  const a = await couponAutomation(sch.userId);
  const text = couponListMessage(sch.marketplace, coupons, sch.link);
  for (const ch of channels) {
    const job = await prisma.promotionJob.create({ data: { automationId: a.id, channelId: ch.id, scheduledAt: new Date(), payloadJson: { title: `Cupons ${marketplaceName(sch.marketplace)}`, text, affiliateUrl: sch.link || '' } } });
  }
  await prisma.couponSchedule.update({ where: { id: sch.id }, data: { lastSentAt: new Date() } });
  await prisma.automationLog.create({ data: { automationId: a.id, action: 'RUN', status: 'OK', message: `Listão ${marketplaceName(sch.marketplace)} com ${coupons.length} cupom(ns) para ${channels.length} grupo(s)${source === 'manual' ? ', envio pelo botão' : ''}.` } });
  return channels.length;
}

/** Chamado pelo agendador a cada minuto: dispara os listões cujo intervalo venceu. */
export async function tickCoupons(now = new Date()) {
  const list = await prisma.couponSchedule.findMany({ where: { enabled: true, everyMinutes: { gt: 0 } } });
  for (const sch of list) {
    if (!inWindow(minutesOfDay(now, TZ), sch.startTime, sch.endTime)) continue;
    // Tolerância de 30s para o tick de 1 min não "perder" o intervalo.
    if (sch.lastSentAt && now.getTime() - sch.lastSentAt.getTime() < sch.everyMinutes * 60_000 - 30_000) continue;
    // Canal do Telegram configurado: atualiza os cupons antes de montar o listão.
    if (sch.telegramChannel) {
      try { await importTelegramCoupons(sch.userId, sch.marketplace, sch.telegramChannel); }
      catch (e: any) { console.error(`[cupons] importar @${sch.telegramChannel}: ${e.message}`); }
    }
    // Sem cupom válido e sem link não envia nada e não conta como disparo: assim que cadastrar um, sai no próximo minuto.
    if (!(await usableCoupons(sch.userId, sch.marketplace, now)).length && !sch.link) continue;
    try {
      const n = await sendCouponList(sch, 'scheduler');
      console.log(`[cupons] listão ${marketplaceName(sch.marketplace)}: ${n} grupo(s)`);
    } catch (e: any) {
      // Marca como enviado para respeitar o intervalo mesmo em erro (ex.: sem canal ativo).
      await prisma.couponSchedule.update({ where: { id: sch.id }, data: { lastSentAt: now } });
      console.error(`[cupons] ${marketplaceName(sch.marketplace)}: ${e.message}`);
    }
  }
}

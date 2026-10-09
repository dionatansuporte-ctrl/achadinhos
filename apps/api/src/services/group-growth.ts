import { prisma } from '../db';
import { onGroupMembers } from '../integrations/whatsapp-web';

/**
 * Quantas pessoas entraram e saíram de cada grupo de WhatsApp, por dia e por semana (pedido do usuário em 2026-10-09).
 * Cada aviso de entrada/saída vira uma linha em GroupMemberEvent; a conta é feita na hora de mostrar.
 * Só conta a partir de quando isto foi ligado: o WhatsApp não dá o histórico de antes.
 */

const TZ = 'America/Sao_Paulo';
const dayOf = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d); // AAAA-MM-DD no horário de Brasília
// Meia-noite (Brasília, sem horário de verão desde 2019) do dia `daysAgo` dias atrás.
const midnight = (daysAgo: number) => new Date(new Date(`${dayOf(new Date())}T00:00:00-03:00`).getTime() - daysAgo * 86_400_000);

export const GROWTH_PERIODS = { today: 'Hoje', yesterday: 'Ontem', '7d': 'Últimos 7 dias', '30d': 'Últimos 30 dias' } as const;
export type GrowthPeriod = keyof typeof GROWTH_PERIODS;

type Counts = { link: number; added: number; left: number; removed: number };
const empty = (): Counts => ({ link: 0, added: 0, left: 0, removed: 0 });
const KEY = { LINK: 'link', ADDED: 'added', LEFT: 'left', REMOVED: 'removed' } as const;

export function startGroupGrowth() {
  onGroupMembers(async m => {
    // skipDuplicates: o mesmo aviso chega por cada número nosso que está no grupo.
    await prisma.groupMemberEvent.createMany({ data: [{ groupId: m.groupId, groupName: m.groupName, member: m.member, kind: m.kind, at: m.at }], skipDuplicates: true });
  });
}

/** Totais por grupo no período e, dia a dia, de todos os grupos ou só de `groupId`. */
export async function groupGrowth(period: GrowthPeriod, groupId?: string, names: Map<string, string> = new Map()) {
  const from = midnight(period === 'today' ? 0 : period === 'yesterday' ? 1 : period === '7d' ? 6 : 29);
  const to = period === 'yesterday' ? midnight(0) : new Date(Date.now() + 60_000);
  const events = await prisma.groupMemberEvent.findMany({ where: { at: { gte: from, lt: to } }, select: { groupId: true, groupName: true, kind: true, at: true } });

  const byGroup = new Map<string, Counts & { name: string | null }>();
  const byDay = new Map<string, Counts>();
  for (let t = from.getTime(); t < to.getTime(); t += 86_400_000) byDay.set(dayOf(new Date(t)), empty());
  for (const e of events) {
    const k = KEY[e.kind as keyof typeof KEY];
    if (!k) continue;
    const g = byGroup.get(e.groupId) || { ...empty(), name: null };
    g.name = e.groupName || g.name;
    g[k]++;
    byGroup.set(e.groupId, g);
    if (groupId && e.groupId !== groupId) continue;
    const d = byDay.get(dayOf(e.at));
    if (d) d[k]++;
  }

  const groups = [...byGroup].map(([id, g]) => ({ id, ...g, name: names.get(id) || g.name || 'Grupo sem nome' }));
  // Grupos atuais sem nenhum movimento também aparecem, com zero.
  for (const [id, name] of names) if (!byGroup.has(id)) groups.push({ id, name, ...empty() });
  groups.sort((a, b) => (b.link + b.added) - (a.link + a.added) || a.name.localeCompare(b.name, 'pt-BR'));
  const since = await prisma.groupMemberEvent.findFirst({ orderBy: { at: 'asc' }, select: { at: true } });
  return { period, groups, days: [...byDay].map(([day, c]) => ({ day, ...c })).reverse(), trackingSince: since?.at || null };
}

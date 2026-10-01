/** Lojas do sistema, na mesma ordem da API (é a numeração das perguntas do robô de atendimento). */
export type Mkt = 'SHOPEE' | 'MERCADO_LIVRE' | 'AMAZON';
export const MKTS: Mkt[] = ['SHOPEE', 'MERCADO_LIVRE', 'AMAZON'];

const NAME: Record<Mkt, string> = { SHOPEE: 'Shopee', MERCADO_LIVRE: 'Mercado Livre', AMAZON: 'Amazon' };
const ICON: Record<Mkt, string> = { SHOPEE: '🛍️', MERCADO_LIVRE: '🟡', AMAZON: '📦' };

export const isMkt = (m: unknown): m is Mkt => MKTS.includes(m as Mkt);
export const mktName = (m?: string | null) => NAME[m as Mkt] || 'Shopee';
export const mktIcon = (m?: string | null) => ICON[m as Mkt] || '🛍️';
/** "Shopee", "Shopee + Amazon"... */
export const mktNames = (list: string[]) => list.map(mktName).join(' + ');

import type { Marketplace } from '@prisma/client';

/** As lojas que o sistema conhece, na ordem em que aparecem para o usuário e nas opções numeradas do robô. */
export const MARKETPLACE_LIST = ['SHOPEE', 'MERCADO_LIVRE', 'AMAZON'] as const satisfies readonly Marketplace[];
export type SearchMarketplace = (typeof MARKETPLACE_LIST)[number];

export const isMarketplace = (m: unknown): m is SearchMarketplace => MARKETPLACE_LIST.includes(m as SearchMarketplace);

const LABEL: Record<SearchMarketplace, string> = { SHOPEE: 'Shopee', MERCADO_LIVRE: 'Mercado Livre', AMAZON: 'Amazon' };
const ICON: Record<SearchMarketplace, string> = { SHOPEE: '🛍️', MERCADO_LIVRE: '🟡', AMAZON: '📦' };
/** "na Shopee", "no Mercado Livre", "na Amazon". */
const IN: Record<SearchMarketplace, string> = { SHOPEE: 'na Shopee', MERCADO_LIVRE: 'no Mercado Livre', AMAZON: 'na Amazon' };
/** "da Shopee", "do Mercado Livre", "da Amazon". */
const OF: Record<SearchMarketplace, string> = { SHOPEE: 'da Shopee', MERCADO_LIVRE: 'do Mercado Livre', AMAZON: 'da Amazon' };

export const marketplaceLabel = (m?: string | null) => LABEL[m as SearchMarketplace] || 'Shopee';
export const marketplaceIcon = (m?: string | null) => ICON[m as SearchMarketplace] || '🛍️';
export const storeIn = (m: SearchMarketplace) => IN[m];
export const storeOf = (m: SearchMarketplace) => OF[m];

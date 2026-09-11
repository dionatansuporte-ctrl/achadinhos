import { MarketplaceAdapter } from "./types";

/**
 * O Mercado Livre possui API pública e OAuth para aplicações.
 * A geração/gestão do link de afiliado deve usar o mecanismo disponibilizado
 * para o Programa de Afiliados/Criadores da conta, quando aplicável.
 */
export class MercadoLivreAdapter implements MarketplaceAdapter {
  async createAffiliateUrl(input: { productUrl: string; externalId?: string; tag?: string }) {
    // TODO: implementar conforme o recurso de afiliados habilitado na conta.
    // Não invente endpoint de afiliado: configure o endpoint oficial vigente.
    return input.productUrl;
  }

  async getProduct(input: { url?: string; externalId?: string }) {
    if (!input.url && !input.externalId) {
      throw new Error("Informe URL ou ID do produto.");
    }

    return {
      externalId: input.externalId,
      title: "Produto Mercado Livre",
      productUrl: input.url || `https://www.mercadolivre.com.br/`
    };
  }
}

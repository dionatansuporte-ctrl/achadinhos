export type PromotionPayload = {
  title: string;
  text: string;
  affiliateUrl: string;
  imageUrl?: string;
};

export interface MarketplaceAdapter {
  createAffiliateUrl(input: {
    productUrl: string;
    externalId?: string;
    tag?: string;
  }): Promise<string>;
  getProduct(input: { url?: string; externalId?: string }): Promise<{
    externalId?: string;
    title: string;
    imageUrl?: string;
    productUrl: string;
    price?: number;
    oldPrice?: number;
    discountPercent?: number;
  }>;
}

export interface ChannelAdapter {
  sendPromotion(payload: PromotionPayload): Promise<{ externalMessageId?: string }>;
}

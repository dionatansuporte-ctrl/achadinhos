-- Robô pergunta ao cliente em qual loja buscar (Shopee, Mercado Livre ou qualquer uma) antes de mandar as ofertas (pedido do usuário em 2026-09-26).
ALTER TABLE "CustomerBot" ADD COLUMN "askMarketplace" BOOLEAN NOT NULL DEFAULT true;

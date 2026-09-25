-- Robô pergunta o nome do cliente na primeira conversa (pedido do usuário em 2026-09-25).
-- givenName = nome que o cliente respondeu; nameAskedAt = quando foi perguntado (pergunta uma vez só).
ALTER TABLE "Customer" ADD COLUMN "givenName" TEXT;
ALTER TABLE "Customer" ADD COLUMN "nameAskedAt" TIMESTAMP(3);

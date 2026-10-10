-- Índices para as consultas que liam a tabela inteira (PromotionJob e CustomerRequest crescem todo dia).
CREATE INDEX IF NOT EXISTS "PromotionJob_channelId_createdAt_idx" ON "PromotionJob"("channelId", "createdAt");
CREATE INDEX IF NOT EXISTS "PromotionJob_automationId_createdAt_idx" ON "PromotionJob"("automationId", "createdAt");
CREATE INDEX IF NOT EXISTS "PromotionJob_createdAt_idx" ON "PromotionJob"("createdAt");
CREATE INDEX IF NOT EXISTS "PromotionJob_productId_idx" ON "PromotionJob"("productId");
CREATE INDEX IF NOT EXISTS "CustomerRequest_status_createdAt_idx" ON "CustomerRequest"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "CustomerRequest_createdAt_idx" ON "CustomerRequest"("createdAt");

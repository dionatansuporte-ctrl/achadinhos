-- Limite por tempo padrão do atendimento a clientes: 10 minutos (pedido do usuário).
ALTER TABLE "CustomerBot" ALTER COLUMN "everyMinutes" SET DEFAULT 10;
UPDATE "CustomerBot" SET "everyMinutes" = 10 WHERE "everyMinutes" = 30;

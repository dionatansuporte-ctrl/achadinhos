-- AlterTable: comissão de afiliado por produto (percentual e valor estimado por venda)
ALTER TABLE "Product" ADD COLUMN "commissionRate" DECIMAL(6,2),
                      ADD COLUMN "commissionValue" DECIMAL(12,2);

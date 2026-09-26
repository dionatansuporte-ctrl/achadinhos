-- Pedido que ficou esperando o limite por tempo guarda a loja escolhida; a entrega automática (deliverPendingSearches) usa (2026-09-26).
ALTER TABLE "CustomerRequest" ADD COLUMN "marketplace" "Marketplace";

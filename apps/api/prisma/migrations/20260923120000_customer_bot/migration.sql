-- CreateTable: clientes que falam com o robô no privado do WhatsApp
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jid" TEXT NOT NULL,
    "phone" TEXT,
    "name" TEXT,
    "notes" TEXT,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "requestCount" INTEGER NOT NULL DEFAULT 0,
    "lastRequestAt" TIMESTAMP(3),
    "lastNoticeAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable: pedidos de oferta de cada cliente
CREATE TABLE "CustomerRequest" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "keyword" TEXT,
    "status" TEXT NOT NULL,
    "replyText" TEXT,
    "offersJson" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable: configuração do atendimento (uma por usuário)
CREATE TABLE "CustomerBot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "everyMinutes" INTEGER NOT NULL DEFAULT 30,
    "maxOffers" INTEGER NOT NULL DEFAULT 3,
    "marketplaces" JSONB,
    "sendCoupons" BOOLEAN NOT NULL DEFAULT true,
    "welcomeText" TEXT,
    "linkText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerBot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_userId_jid_key" ON "Customer"("userId", "jid");
CREATE INDEX "Customer_userId_lastSeenAt_idx" ON "Customer"("userId", "lastSeenAt");
CREATE INDEX "CustomerRequest_customerId_createdAt_idx" ON "CustomerRequest"("customerId", "createdAt");
CREATE UNIQUE INDEX "CustomerBot_userId_key" ON "CustomerBot"("userId");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CustomerRequest" ADD CONSTRAINT "CustomerRequest_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

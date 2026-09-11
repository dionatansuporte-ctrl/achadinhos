-- CreateTable: cupons cadastrados pelo usuário (Shopee / Mercado Livre)
CREATE TABLE "Coupon" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "minPrice" DECIMAL(12,2),
    "validUntil" TIMESTAMP(3),
    "inProducts" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "sourceRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

-- CreateTable: agenda do "listão" de cupons por marketplace
CREATE TABLE "CouponSchedule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "everyMinutes" INTEGER NOT NULL DEFAULT 120,
    "startTime" TEXT NOT NULL DEFAULT '08:00',
    "endTime" TEXT NOT NULL DEFAULT '22:00',
    "channelIds" JSONB,
    "link" TEXT,
    "telegramChannel" TEXT,
    "lastSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CouponSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Coupon_userId_marketplace_idx" ON "Coupon"("userId", "marketplace");
CREATE UNIQUE INDEX "CouponSchedule_userId_marketplace_key" ON "CouponSchedule"("userId", "marketplace");

-- AddForeignKey
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CouponSchedule" ADD CONSTRAINT "CouponSchedule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

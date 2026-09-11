-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "valueEnc" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

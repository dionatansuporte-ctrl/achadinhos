CREATE TABLE "GroupGuard" (
    "id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sweep" BOOLEAN NOT NULL DEFAULT false,
    "allowedDdi" JSONB NOT NULL,
    "blocked" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GroupGuard_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GroupBlock" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "groupName" TEXT,
    "member" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "error" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GroupBlock_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GroupBlock_at_idx" ON "GroupBlock"("at");

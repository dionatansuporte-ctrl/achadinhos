-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING', 'ACTIVE', 'BLOCKED');

-- AlterTable: quem já existe continua com acesso (ACTIVE); cadastros novos nascem PENDING pela aplicação.
ALTER TABLE "User" ADD COLUMN "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
                   ADD COLUMN "approvedAt" TIMESTAMP(3);

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { applyDbSecret } from "./db-secret";

// Encaixa a senha do banco (criptografada em .db-secret) no DATABASE_URL antes de conectar.
applyDbSecret();
export const prisma = new PrismaClient();

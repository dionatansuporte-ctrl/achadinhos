import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../db';

// Sem JWT_SECRET os tokens seriam assinados com uma chave conhecida por qualquer um: melhor não subir.
const secret = () => {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET não definido em apps/api/.env. Defina uma chave longa e aleatória e reinicie.');
  return s;
};

export async function hashPassword(password: string) { return bcrypt.hash(password, 12); }
export async function verifyPassword(password: string, hash: string) { return bcrypt.compare(password, hash); }

export async function issueSession(userId: string) {
  const raw = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7);
  await prisma.session.create({ data: { userId, tokenHash, expiresAt } });
  const token = jwt.sign({ sid: tokenHash, sub: userId }, secret(), { expiresIn: '7d' });
  return token;
}

/**
 * Usuário do token, ou null se o token não vale (assinatura errada, expirado, sessão encerrada, usuário bloqueado).
 * Erro do banco NÃO vira null: antes um soluço no Postgres respondia 401 e o painel deslogava todo mundo.
 * Agora o erro sobe e o requireAuth responde 503 ("tente de novo"), sem apagar o login.
 */
export async function getUserFromToken(token?: string) {
  if (!token) return null;
  let payload: jwt.JwtPayload;
  try { payload = jwt.verify(token, secret()) as jwt.JwtPayload; } catch { return null; }
  if (!payload.sub || typeof payload.sid !== 'string') return null;
  const session = await prisma.session.findUnique({ where: { tokenHash: payload.sid }, include: { user: true } });
  if (!session || session.expiresAt < new Date()) return null;
  // Bloqueado ou ainda não aprovado: a sessão não vale, mesmo que exista.
  if (session.user.status !== 'ACTIVE') return null;
  return session.user;
}

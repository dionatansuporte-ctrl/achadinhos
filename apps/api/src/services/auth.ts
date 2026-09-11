import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../db';

const secret = () => process.env.JWT_SECRET || 'dev-only-change-me';

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

export async function getUserFromToken(token?: string) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, secret()) as jwt.JwtPayload;
    if (!payload.sub || typeof payload.sid !== 'string') return null;
    const session = await prisma.session.findUnique({ where: { tokenHash: payload.sid }, include: { user: true } });
    if (!session || session.expiresAt < new Date()) return null;
    // Bloqueado ou ainda não aprovado: a sessão não vale, mesmo que exista.
    if (session.user.status !== 'ACTIVE') return null;
    return session.user;
  } catch { return null; }
}

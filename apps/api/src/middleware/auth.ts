import { Request, Response, NextFunction } from 'express';
import { getUserFromToken } from '../services/auth';

declare global { namespace Express { interface Request { user?: any } } }

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ error: 'Não autenticado.' });
  req.user = user;
  next();
}

import { Request, Response, NextFunction } from 'express';
import { getUserFromToken } from '../services/auth';

declare global { namespace Express { interface Request { user?: any } } }

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
  let user;
  try { user = await getUserFromToken(token); }
  catch (e: any) {
    // Banco fora do ar (ou reiniciando): não é login inválido. 503 faz o painel esperar em vez de deslogar.
    console.warn('[login] não deu para conferir a sessão:', e?.message || e);
    return res.status(503).json({ error: 'O sistema está se reconectando ao banco de dados. Tente de novo em alguns segundos.' });
  }
  if (!user) return res.status(401).json({ error: 'Não autenticado.' });
  req.user = user;
  next();
}

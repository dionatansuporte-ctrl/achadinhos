import axios from 'axios';

export const TOKEN_KEY = 'ofertasdahora_token';

export const api = axios.create({ baseURL: import.meta.env.VITE_API_URL || 'http://localhost:3333' });
api.interceptors.request.use(c => {
  const t = localStorage.getItem(TOKEN_KEY);
  if (t) c.headers.Authorization = `Bearer ${t}`;
  return c;
});
// Sessão encerrada no servidor (senha trocada, usuário bloqueado, "Sair" em outro lugar): volta para o login
// em vez de deixar as telas falhando caladas. Login com senha errada também é 401, por isso /api/auth/ fica de fora.
api.interceptors.response.use(r => r, e => {
  if (e?.response?.status === 401 && localStorage.getItem(TOKEN_KEY) && !String(e.config?.url || '').startsWith('/api/auth/')) {
    localStorage.removeItem(TOKEN_KEY);
    window.location.reload();
  }
  return Promise.reject(e);
});

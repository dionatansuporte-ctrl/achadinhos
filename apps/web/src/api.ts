import axios from 'axios';

export const TOKEN_KEY = 'ofertasdahora_token';

export const api = axios.create({ baseURL: import.meta.env.VITE_API_URL || 'http://localhost:3333' });
api.interceptors.request.use(c => {
  const t = localStorage.getItem(TOKEN_KEY);
  if (t) c.headers.Authorization = `Bearer ${t}`;
  return c;
});

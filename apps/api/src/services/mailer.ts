import nodemailer from 'nodemailer';
import { getSecret } from './settings';

/**
 * Envio de e-mail por SMTP (Gmail com senha de app, Outlook, Zoho, etc.).
 * Configurado em Configurações → E-mail (SMTP) ou pelo .env.
 */
export async function isMailConfigured() {
  const [host, user, pass] = await Promise.all([getSecret('SMTP_HOST'), getSecret('SMTP_USER'), getSecret('SMTP_PASS')]);
  return !!(host && user && pass);
}

async function transport() {
  const [host, portRaw, user, pass] = await Promise.all([getSecret('SMTP_HOST'), getSecret('SMTP_PORT'), getSecret('SMTP_USER'), getSecret('SMTP_PASS')]);
  if (!host || !user || !pass) throw new Error('E-mail não configurado: preencha o SMTP em Configurações.');
  const port = Number(portRaw) || 587;
  return nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
}

export async function sendMail(to: string, subject: string, text: string, html?: string) {
  const t = await transport();
  const from = (await getSecret('SMTP_FROM')) || (await getSecret('SMTP_USER'))!;
  await t.sendMail({ from: from.includes('<') ? from : `OfertasDaHora <${from}>`, to, subject, text, html: html || `<pre style="font:15px system-ui">${text}</pre>` });
}

export async function sendPasswordResetCode(to: string, code: string, minutes: number) {
  const text = [
    'Recebemos um pedido para trocar a senha da sua conta OfertasDaHora.',
    '',
    `Seu código: ${code}`,
    '',
    `Ele vale por ${minutes} minutos. Se não foi você, ignore este e-mail: nada muda.`
  ].join('\n');
  const html = `
    <div style="font-family:system-ui,Segoe UI,sans-serif;max-width:480px;margin:auto;padding:24px;color:#222">
      <h2 style="margin:0 0 12px">Trocar senha · OfertasDaHora</h2>
      <p>Recebemos um pedido para trocar a senha da sua conta.</p>
      <p style="margin:20px 0">Seu código:</p>
      <div style="font-size:34px;font-weight:800;letter-spacing:8px;background:#f3f4f6;border-radius:12px;padding:16px;text-align:center">${code}</div>
      <p style="color:#666;margin-top:20px">Vale por ${minutes} minutos. Se não foi você, ignore este e-mail: nada muda.</p>
    </div>`;
  await sendMail(to, `Seu código para trocar a senha: ${code}`, text, html);
}

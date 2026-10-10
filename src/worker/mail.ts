import type { Env } from './env';

export class MailUnavailable extends Error {}

export interface OutgoingMail {
  to: string;
  subject: string;
  /** Plain-text body. Paragraphs are separated by blank lines. */
  body: string;
  /** Shown in the footer and set as List-Unsubscribe, so mail clients offer one-click opt-out. */
  unsubscribeUrl?: string;
}

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Send one message through the Email Service binding. Throws MailUnavailable when mail is not configured. */
export async function sendMail(env: Env, mail: OutgoingMail): Promise<void> {
  if (!env.EMAIL || !env.MAIL_FROM) throw new MailUnavailable('Email is not configured for this Worker yet.');
  const paragraphs = mail.body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const footer = mail.unsubscribeUrl ? `\n\nTo stop receiving these emails: ${mail.unsubscribeUrl}` : '';
  const text = paragraphs.join('\n\n') + footer;
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1d232b">`
    + paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('')
    + (mail.unsubscribeUrl ? `<p style="font-size:12px;color:#6b7480">To stop receiving these emails, <a href="${escapeHtml(mail.unsubscribeUrl)}">unsubscribe</a>.</p>` : '')
    + '</body></html>';
  await env.EMAIL.send({
    to: mail.to,
    from: { email: env.MAIL_FROM, name: env.MAIL_FROM_NAME ?? 'Habitat' },
    subject: mail.subject,
    text,
    html,
    headers: mail.unsubscribeUrl ? {
      'List-Unsubscribe': `<${mail.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    } : undefined,
  });
}

/**
 * website/functions/_lib/send.ts — hands one confirmation email to Resend (D-426).
 *
 * What it is: the single place the Resend "send email" call is made, used by
 * the signup handler and by the held-email drain (quota.ts).
 * What it does NOT do: count the send against the quota or touch the database;
 * the callers do, so a send that Resend rejected is never counted. The message
 * carries no List-Unsubscribe header: it is a one-off transactional mail (D-427).
 */
import { confirmationEmail } from './email.ts';

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export interface SendEnv {
  /** Pages secret. Absent in local dev: nothing is sent. */
  RESEND_API_KEY?: string;
  /** From header. Sent from a subdomain (mail.apelles.studio) to protect the root domain's reputation. */
  MAIL_FROM: string;
  /** Where replies go; absent = Resend's default (the From address). */
  MAIL_REPLY_TO?: string;
}

export interface ConfirmTarget {
  email: string;
  confirm_token: string;
}

/**
 * True when the email was handed over, or when sending is switched off (local
 * dev, no key). A Resend rejection or a network failure returns false.
 */
export async function sendConfirmation(env: SendEnv, origin: string, row: ConfirmTarget): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.warn('waitlist: RESEND_API_KEY is not set; stored the signup and skipped the email');
    return true;
  }
  const confirmUrl = `${origin}/api/confirm?token=${row.confirm_token}`;
  const mail = confirmationEmail(confirmUrl);
  let res: Response;
  try {
    res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [row.email],
        ...(env.MAIL_REPLY_TO ? { reply_to: env.MAIL_REPLY_TO } : {}),
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      }),
    });
  } catch (error) {
    console.error(`waitlist: could not reach Resend: ${error instanceof Error ? error.message : 'unknown error'}`);
    return false;
  }

  if (!res.ok) console.error(`waitlist: Resend answered ${res.status}`);
  return res.ok;
}

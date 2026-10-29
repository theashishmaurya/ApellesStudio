/**
 * website/functions/_lib/email.ts — the confirmation email (D-426).
 *
 * What it is: a pure function from two URLs to the subject, HTML and plain-text
 * bodies of the one message the waitlist sends before the launch email.
 * What it does NOT do: send anything (see waitlist.ts) or carry tracking — no
 * pixels, no rewritten links; Resend's open/click tracking is off for the domain.
 *
 * Colours come from the site's palette source of record (src/data/palette.ts),
 * not retyped hex literals; email clients cannot read CSS variables, so they
 * are inlined at render time.
 */
import { PIGMENTS } from '../../src/data/palette.ts';

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

export const CONFIRM_SUBJECT = 'Confirm your spot on the Apelles beta';

function pigment(token: string): string {
  const hex = PIGMENTS.find((p) => p.token === token)?.hex;
  if (!hex) throw new Error(`palette has no ${token}`);
  return hex;
}

export function confirmationEmail(confirmUrl: string, unsubscribeUrl: string): EmailContent {
  const ground = pigment('pigment-marble');
  const ink = pigment('pigment-basalt');
  const soft = pigment('pigment-basalt-soft');
  const serif = "Georgia, 'Times New Roman', serif";
  const sans = "-apple-system, 'Helvetica Neue', Arial, sans-serif";

  const text = [
    'Confirm your spot on the Apelles beta',
    '',
    'Someone, hopefully you, asked to hear when a new build of Apelles is ready.',
    'Confirm this address and that is the one message you will get from us:',
    '',
    confirmUrl,
    '',
    'If it was not you, ignore this email and nothing happens.',
    '',
    `Unsubscribe: ${unsubscribeUrl}`,
    '',
  ].join('\n');

  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:${ground};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${ground};">
<tr><td align="center" style="padding:40px 20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">
<tr><td style="font-family:${serif};font-size:26px;line-height:1.3;color:${ink};padding-bottom:16px;">Confirm your spot on the Apelles beta</td></tr>
<tr><td style="font-family:${sans};font-size:16px;line-height:1.6;color:${soft};padding-bottom:28px;">Someone, hopefully you, asked to hear when a new build of Apelles is ready. Confirm this address and that is the one message you will get from us.</td></tr>
<tr><td style="padding-bottom:28px;"><a href="${confirmUrl}" style="display:inline-block;background:${ink};color:${ground};font-family:${sans};font-size:16px;font-weight:500;text-decoration:none;padding:14px 24px;border-radius:8px;">Confirm my address</a></td></tr>
<tr><td style="font-family:${sans};font-size:13px;line-height:1.6;color:${soft};">If it was not you, ignore this email and nothing happens.<br><a href="${unsubscribeUrl}" style="color:${soft};">Unsubscribe</a></td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  return { subject: CONFIRM_SUBJECT, html, text };
}

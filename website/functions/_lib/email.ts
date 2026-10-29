/**
 * website/functions/_lib/email.ts — the confirmation email (D-426, D-427).
 *
 * What it is: a pure function from the confirm URL to the subject, HTML and
 * plain-text bodies of the one message the waitlist sends before the launch
 * email. It is written to read as a personal, transactional note from Ashish:
 * near-plain HTML (one sentence, a plain link, the expiry line), no button,
 * image, styling or tracking, and no unsubscribe link or List-Unsubscribe
 * header (those mark bulk mail; see D-427's addendum). Unconfirmed addresses
 * are never emailed again, so there is nothing to unsubscribe from.
 * What it does NOT do: send anything (see send.ts / waitlist.ts).
 */
export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

export const CONFIRM_SUBJECT = 'Confirm your email for the Apelles beta';
/** The first line of both parts, so it doubles as the inbox preview text. */
export const PREHEADER = 'Click to confirm. This link expires in 7 days.';

export function confirmationEmail(confirmUrl: string): EmailContent {
  const text = [
    PREHEADER,
    '',
    'Hi, it\'s Ashish. Someone, hopefully you, asked to hear when a new build of Apelles is ready. Please confirm this address:',
    '',
    confirmUrl,
    '',
    "Didn't ask for this? Ignore it — you won't hear from us.",
    '',
    'Ashish',
    '',
  ].join('\n');

  const html = `<!doctype html>
<html lang="en"><body>
<p>${PREHEADER}</p>
<p>Hi, it&rsquo;s Ashish. Someone, hopefully you, asked to hear when a new build of Apelles is ready. Please confirm this address:</p>
<p><a href="${confirmUrl}">${confirmUrl}</a></p>
<p>Didn't ask for this? Ignore it &mdash; you won't hear from us.</p>
<p>Ashish</p>
</body></html>`;

  return { subject: CONFIRM_SUBJECT, html, text };
}

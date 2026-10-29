/**
 * website/functions/_lib/turnstile.ts — Cloudflare Turnstile verification (D-427).
 *
 * What it is: the server half of the signup form's bot check. The widget in the
 * page puts a one-use token in the form post (`cf-turnstile-response`); this
 * sends it, with the secret key, to Cloudflare's siteverify endpoint and
 * accepts the signup only if Cloudflare says `success` and the token was issued
 * for one of our hostnames.
 * What it does NOT do: forward the visitor's IP (optional in the API, and the
 * site stores none), or ever accept a signup when it cannot verify one: no
 * secret configured, an unreachable endpoint and a malformed answer all fail
 * closed.
 */

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** The form field Turnstile's widget adds to the form it sits in. */
export const TURNSTILE_FIELD = 'cf-turnstile-response';
/** Cloudflare caps a token at 2048 characters. */
export const MAX_TOKEN_LENGTH = 2048;

export interface TurnstileEnv {
  /** Pages secret. Absent in production = every new signup is refused (and logged). */
  TURNSTILE_SECRET_KEY?: string;
  /** Comma-separated hostnames a token may have been issued for; default: the request's own. */
  TURNSTILE_ALLOWED_HOSTNAMES?: string;
}

export type TurnstileResult = 'ok' | 'rejected' | 'unavailable';

interface SiteverifyAnswer {
  success?: boolean;
  hostname?: string;
  'error-codes'?: string[];
}

function allowedHostnames(env: TurnstileEnv, requestHostname: string): string[] {
  const configured = (env.TURNSTILE_ALLOWED_HOSTNAMES ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== '');
  return configured.length > 0 ? configured : [requestHostname.toLowerCase()];
}

/**
 * `ok` — verified; `rejected` — the visitor's token is missing, wrong, reused
 * or for another site (a 4xx); `unavailable` — we could not ask (no secret, or
 * Cloudflare did not answer), so nobody can be admitted (a 5xx).
 */
export async function verifyTurnstile(
  token: string,
  env: TurnstileEnv,
  requestHostname: string,
): Promise<TurnstileResult> {
  if (!env.TURNSTILE_SECRET_KEY) {
    console.error('waitlist: TURNSTILE_SECRET_KEY is not set; refusing new signups (set it, see BETA_SIGNUP_SETUP.md)');
    return 'unavailable';
  }
  if (token === '' || token.length > MAX_TOKEN_LENGTH) return 'rejected';

  let answer: SiteverifyAnswer;
  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token }),
    });
    if (!res.ok) {
      console.error(`waitlist: Turnstile siteverify answered ${res.status}`);
      return 'unavailable';
    }
    answer = (await res.json()) as SiteverifyAnswer;
  } catch {
    console.error('waitlist: Turnstile siteverify was unreachable; refusing the signup');
    return 'unavailable';
  }

  if (answer.success !== true) return 'rejected';
  const hostname = (answer.hostname ?? '').toLowerCase();
  if (!allowedHostnames(env, requestHostname).includes(hostname)) {
    console.warn(`waitlist: Turnstile token was issued for ${hostname || 'no hostname'}, not an allowed host`);
    return 'rejected';
  }
  return 'ok';
}

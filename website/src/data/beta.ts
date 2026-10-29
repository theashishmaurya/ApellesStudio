/**
 * website/src/data/beta.ts — the beta waitlist's endpoint, validation and roles
 * (D-255; moved from FormSubmit.co to the site's own D1 + Resend waitlist by
 * D-426).
 *
 * Shared by the forms (Hero.astro, Beta.astro), the Pages Function that
 * receives them (functions/_lib/waitlist.ts) and the tests, so the browser and
 * the server cannot disagree about what a valid address or role is. See
 * website/BETA_SIGNUP_SETUP.md.
 */

/** The same-origin Pages Function that stores the signup and sends the confirmation email. */
export const BETA_FORM_ENDPOINT = '/api/waitlist';

/**
 * The one email rule the form applies. Deliberately permissive — it rejects the
 * mistakes people actually make (no @, no dot in the domain, stray spaces)
 * without rejecting valid-but-unusual addresses, which is the failure mode of
 * an over-strict pattern.
 */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

/**
 * What the signup asks. Kept short on purpose: an email is the only required
 * field.
 *
 * Order matters and is not alphabetical or arbitrary (D-264): the person this
 * product is actually for — someone who makes videos without editing being
 * their craft — reads first, because a list that opens with "I edit video
 * professionally" quietly tells everyone else they are in the wrong place.
 */
export const ROLES = [
  'I make videos, but editing is not my job',
  'I want to make videos and have never tried',
  'I edit video professionally',
  'I build with AI agents',
  'Something else',
] as const;

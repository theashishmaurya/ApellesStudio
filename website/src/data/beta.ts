/**
 * website/src/data/beta.ts — the beta-signup endpoint (D-255, moved from
 * Formspree to FormSubmit.co 2026-09-10 — see BETA_SIGNUP_SETUP.md).
 *
 * The endpoint contract, the placeholder guard and the validation are
 * infrastructure that already worked under Formspree and needed no rebuild —
 * only the URL shape and the honeypot field name changed to match FormSubmit's
 * own conventions (its honeypot field is `_honey`, not Formspree's `_gotcha`;
 * its JSON/AJAX endpoint needs a `/ajax/` path segment the plain one does not).
 * Only ROLES otherwise changed by D-264, and only its order — see the note on
 * it below.
 *
 * ONE named constant, and it is the only thing that has to change to point
 * the signup form at a different inbox or a different provider. See
 * website/BETA_SIGNUP_SETUP.md.
 *
 * The placeholder guard stays as infrastructure even though the endpoint below
 * is now real: `YOUR_FORM_ID` is a deliberate, obvious literal that never
 * matches a real endpoint of any provider, so `isPlaceholderEndpoint` keeps
 * working unchanged if this ever gets reset to a placeholder again (a fresh
 * clone of the repo, a different owner standing up their own instance).
 */

/** FormSubmit.co's AJAX endpoint, emailing submissions to ashish.1999vns@gmail.com. */
export const BETA_FORM_ENDPOINT = 'https://formsubmit.co/ajax/ashish.1999vns@gmail.com';

/** True while the endpoint above is still the shipped placeholder. */
export function isPlaceholderEndpoint(endpoint: string = BETA_FORM_ENDPOINT): boolean {
  return endpoint.includes('YOUR_FORM_ID');
}

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

/**
 * website/src/data/beta.ts — the beta-signup endpoint (D-255).
 *
 * ONE named constant, and it is the only thing that has to change to make the
 * signup form live. See website/BETA_SIGNUP_SETUP.md for the three steps.
 *
 * It is a deliberate, obvious placeholder: `YOUR_FORM_ID` is not a real
 * Formspree id, and the form detects that literal string and refuses to post
 * rather than firing a request at a URL that does not exist. Nothing here was
 * invented to look real.
 */

/** Replace `YOUR_FORM_ID` with the id from your own Formspree form. */
export const BETA_FORM_ENDPOINT = 'https://formspree.io/f/YOUR_FORM_ID';

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

/** What the signup asks. Kept short on purpose: an email is the only required field. */
export const ROLES = [
  'I edit video professionally',
  'I make videos, but editing is not my job',
  'I build with AI agents',
  'Something else',
] as const;

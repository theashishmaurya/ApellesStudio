/**
 * website/functions/_lib/resend-contacts.ts — keeps Resend's contact list in
 * step with the waitlist (D-426).
 *
 * What it is: three calls over Resend's Contacts API. D1 stays the master list;
 * Resend holds a copy only so the owner can send broadcasts from its dashboard.
 *  - `addConfirmedContact`: create the contact (or re-subscribe an existing
 *    one) and put it in the "Apelles Beta" segment. Called on confirm.
 *  - `unsubscribeContact`: mark the contact unsubscribed. Called on our own
 *    unsubscribe link.
 *  - `listUnsubscribedContacts`: the segment's unsubscribed contacts, for the
 *    reconcile script that copies Resend-side unsubscribes (broadcast footers)
 *    back into D1 (scripts/sync-resend.ts).
 * What it does NOT do: throw. A Resend failure must never fail the visitor's
 * confirmation, so each write returns `false` after logging, and the caller
 * leaves `resend_synced = 0` for the backfill to retry. It also does not copy
 * the visitor's role: Resend contact properties must be defined in the
 * dashboard first, and the role stays in D1.
 *
 * Shared by the Pages Functions and the script, so it takes only an API key and
 * a segment id, not the full Workers env.
 */

const CONTACTS = 'https://api.resend.com/contacts';
const PAGE_SIZE = 100;

export interface ResendConfig {
  RESEND_API_KEY?: string;
  RESEND_SEGMENT_ID?: string;
}

interface ListedContact {
  id: string;
  email: string;
  unsubscribed: boolean;
}
interface ContactPage {
  data: ListedContact[];
  has_more: boolean;
}

function call(config: ResendConfig, path: string, method: string, body?: Record<string, unknown>): Promise<Response> {
  return fetch(`${CONTACTS}${path}`, {
    method,
    headers: { authorization: `Bearer ${config.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const contactPath = (email: string) => `/${encodeURIComponent(email)}`;

/** Create or re-subscribe the contact and add it to the segment. */
export async function addConfirmedContact(config: ResendConfig, email: string): Promise<boolean> {
  if (!config.RESEND_API_KEY || !config.RESEND_SEGMENT_ID) {
    console.warn('waitlist: RESEND_API_KEY or RESEND_SEGMENT_ID is not set; skipped the Resend contact sync');
    return false;
  }
  try {
    let res = await call(config, '', 'POST', { email, unsubscribed: false });
    // Already a contact (an earlier attempt, or a returning address): make it subscribed again.
    if (!res.ok) res = await call(config, contactPath(email), 'PATCH', { unsubscribed: false });
    if (!res.ok) throw new Error(`contact upsert answered ${res.status}`);

    res = await call(config, `${contactPath(email)}/segments/${config.RESEND_SEGMENT_ID}`, 'POST');
    if (!res.ok) throw new Error(`segment add answered ${res.status}`);
    return true;
  } catch (error) {
    console.error(`waitlist: Resend contact sync failed (${String(error)})`);
    return false;
  }
}

/** Mark the contact unsubscribed. No contact at all (404) is already the desired state. */
export async function unsubscribeContact(config: ResendConfig, email: string): Promise<boolean> {
  if (!config.RESEND_API_KEY) {
    console.warn('waitlist: RESEND_API_KEY is not set; skipped the Resend unsubscribe sync');
    return false;
  }
  try {
    const res = await call(config, contactPath(email), 'PATCH', { unsubscribed: true });
    if (!res.ok && res.status !== 404) throw new Error(`unsubscribe answered ${res.status}`);
    return true;
  } catch (error) {
    console.error(`waitlist: Resend unsubscribe sync failed (${String(error)})`);
    return false;
  }
}

/** Emails of every unsubscribed contact in the segment. Throws on an API error (script use). */
export async function listUnsubscribedContacts(config: ResendConfig): Promise<string[]> {
  const emails: string[] = [];
  let after: string | undefined;
  for (;;) {
    const query = new URLSearchParams({ segment_id: config.RESEND_SEGMENT_ID ?? '', limit: String(PAGE_SIZE) });
    if (after) query.set('after', after);
    const res = await call(config, `?${query}`, 'GET');
    if (!res.ok) throw new Error(`listing contacts answered ${res.status}`);
    const page = (await res.json()) as ContactPage;
    for (const contact of page.data) if (contact.unsubscribed) emails.push(contact.email.toLowerCase());
    if (!page.has_more || page.data.length === 0) return emails;
    after = page.data[page.data.length - 1].id;
  }
}

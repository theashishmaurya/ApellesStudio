# Beta signup — how it is wired, and how to change it

The signup form on the home page is **fully built and live**: it validates the
address, disables while in flight, and renders real success and error states,
posting to a real endpoint that emails every submission straight to
`ashish.1999vns@gmail.com`.

## Provider: FormSubmit.co

Chosen 2026-09-10 over Formspree (D-255's original choice) for its free tier:
FormSubmit is free with unlimited forms and unlimited submissions, no account
or dashboard required — the destination email is the only thing you configure,
and it emails you directly. Formspree's free tier caps at 50 submissions/month.

The endpoint lives in the one named constant in `src/data/beta.ts`:

```ts
export const BETA_FORM_ENDPOINT = 'https://formsubmit.co/ajax/ashish.1999vns@gmail.com';
```

Two things about FormSubmit's own conventions that the code already accounts
for, worth knowing if you ever touch this again:

- **The endpoint needs the `/ajax/` path segment** for a JSON response the
  fetch-based submit code can read (`res.ok`, no page navigation). The plain
  `https://formsubmit.co/<email>` form (no `/ajax/`) is for a classic
  full-page POST instead, and does not fit this form's submit handling.
- **Its honeypot field is named `_honey`**, not Formspree's `_gotcha` — the
  hidden "Company" field in `Beta.astro` is named accordingly. A submission
  with that field filled in is silently discarded, never emailed.

## First-time confirmation (already done for the current address)

The **first** submission FormSubmit ever receives for a given destination
email triggers a one-time confirmation email to that address, asking the
owner to confirm they actually want submissions sent there — a real spam
safeguard, not busywork. Until that link is clicked, submissions to a new
address are not delivered. Once clicked, every submission after that arrives
as a normal email, permanently, no further action needed.

## Changing the destination email, or resetting to a placeholder

Edit the one constant above. To reset the site to its pre-launch placeholder
state (e.g. handing the repo to someone else who hasn't set up their own
inbox yet), set it back to a string containing the literal `YOUR_FORM_ID` —
`isPlaceholderEndpoint()` detects exactly that literal and the form refuses to
post at all while it is present, telling the visitor plainly that signup is
not open yet rather than silently dropping their address. Then re-run
`npm run verify`; `tests/build-output.test.ts`'s "ships a real beta endpoint"
case will fail on purpose until a real one is set again — update that test
case to match a placeholder-state assertion if you deliberately want the repo
to ship in that state.

## Privacy note on the address in source

FormSubmit has no hashed/obfuscated endpoint for the free tier — the
destination email sits in plain text in the page's HTML and this repo's
source (this is an AGPL/open-source repo, so that means publicly). FormSubmit
does offer, after the first confirmation above, a "random-like string" you can
swap in for the naked address in the `action`/endpoint (their "Invisible
emails" feature) — worth doing once that string arrives, to stop the address
being scrapable straight out of the page source. Swap it into the same one
constant when you have it.

## What the form sends

| field | value |
|---|---|
| `email` | the address, validated client-side before submit |
| `role` | one of the four options, or empty if the visitor skipped it |
| `_subject` | fixed to "New Apelles beta signup", so the email arrives labelled |
| `_honey` | FormSubmit's honeypot — filled in only by bots, discards the submission silently |

## Using a different provider

Any endpoint that accepts a `POST` and responds `2xx` with JSON (when asked
for `Accept: application/json`) works unchanged — Formspree, Getform, Basin,
Netlify Forms, or your own handler. The submit code sends
`Accept: application/json` and treats `res.ok` as success. Swap the URL in
the same constant; if the new provider has its own honeypot field name,
rename `Beta.astro`'s hidden `_honey` input to match.

## Privacy note (unrelated to the above)

The site loads no analytics and sets no cookies. D-287 removed the copy that
used to say so beside the form (the owner's own trim) — the underlying fact
hasn't changed, it's just no longer printed on the page. If that changes
(analytics or tracking gets added later), update this note, since it is the
one place that fact is recorded now.

# `website/` — Apelles's marketing + docs site

**What it is.** The public site for Apelles: who the product is for, what each of
the three rooms really does, why it is built local-first, how to connect an MCP
client to it, and a pre-launch beta signup. Static Astro plus a small waitlist API
(Pages Functions, a D1 database, Resend); no analytics of our own.

**What it does NOT do.** It does not talk to the desktop app or ship any app code.
`astro build` emits plain HTML and CSS plus two small client-side scripts (the
demonstration's scrub interaction and the signup form). The only request-time
code is the waitlist API in `functions/` (Cloudflare Pages Functions, D-426).

Created by **D-255** under the old brand. Rebuilt end to end by **D-264** — new
identity, new information architecture, new copy — which records why the visual
system is quarried from the Alexander Mosaic rather than invented, and why the
site's palette no longer simply mirrors the app's own theme.

## Run it

```bash
cd website
npm install
npm run dev        # http://localhost:4321
```

| script | what it does |
|---|---|
| `npm run dev` | dev server with HMR |
| `npm run build` | production build into `dist/` |
| `npm run preview` | serve the built `dist/` |
| `npm run check` | `astro check` — types and template diagnostics |
| `npm run test` | Vitest (needs a build first for the `dist/` checks) |
| `npm run dev:functions` | serve `dist/` with the waitlist API and a local D1 (`npm run db:migrate:local` first) |
| `npm run export:waitlist` / `sync:resend` | CSV export; Resend reconcile + backfill (`BETA_SIGNUP_SETUP.md`) |
| `npm run verify` | **check → build → test**, in that order. Run this before committing. |

## Why it is not in the repo's npm workspace

The root `package.json` lists `app` and `packages/*` as workspaces. This site is
deliberately outside them:

- Its dependency graph shares nothing with the app — Astro against React 19,
  Tauri and Remotion — and hoisting it into the same tree would put a
  marketing-site dependency in the same lockfile that has to stay stable for a
  desktop build.
- Its release cadence is different. The site ships when copy changes; the app
  ships when the app ships.
- Nothing in the site imports app code at runtime. Its tests read several repo
  sources **at test time only**, to assert the site has not drifted from them:
  `packages/tokens` (the app's theme values), `mcp/server.py` and
  `app/src-tauri/src/chroma/control.rs` (the MCP surface and its error text), and
  `packages/motion-engine` (the primitive catalog) — see below.

It is a sibling directory, matching the monorepo's existing convention of
top-level directories that are their own thing (`ai/`, `ai-media/`, `mcp/`,
`eval/`).

## The rules this site holds itself to

### Two colour sources, both real, both tested

`src/data/palette.ts` is the source of record for the **brand** palette. Every
value is tied to a real material in the Alexander Mosaic — Carrara marble,
Iberian basalt, iron-oxide red and yellow, and the pink imported from Portugal —
with the 2025 PLOS ONE analysis those claims rest on cited in the file and
printed in the site's own footer.

`src/styles/tokens.css` transcribes that file, and separately carries the six
`--app-*` tokens the site draws the **product** with, verbatim from the app's own
Dark theme — which since D-432 P1 is defined in `packages/tokens/src/themes.ts`
(`cssVariablesFor('dark')`), not in `app/src/utils/themes.ts`. Those are used only
inside a `.frame` — the one place the site is allowed to be dark, because that is
the application's own window colour.

`tests/palette.test.ts` reads both real sources — it calls `cssVariablesFor('dark')`
itself, rather than scraping values out of a file, which is what B-404 fixed — and
fails on any drift, on any
colour literal in a component that did not come through a token, on an `--app-*`
token that is declared but never used, and on either of the two "safe" default
typefaces appearing anywhere.

### One signature, spent once

In the mosaic, the Portugal pink was used on Alexander's face alone, out of
roughly two million tesserae. D-264 spent `--pigment-rose` the same way; D-284
retired the pigment (see `src/data/palette.ts`'s own header for why ink, already
this page's dominant colour, cannot be "spent once" like a scarce one) and kept
the discipline that outlived it. The site's one primary action is a solid
`--pigment-basalt` fill that is referenced by exactly one CSS rule (`.signature`
in `global.css`), emitted by exactly one component (`Signature.astro`), and
rendered at most once per page — on the single action that page exists for. All
three are asserted by tests, in `palette.test.ts` and `build-output.test.ts`,
because a signature treatment used twice has stopped being a signature.

### No claim the repo does not back up

- Feature copy comes from `docs/02-scope.md`'s shipped (✅) items only.
- Every MCP number in `src/data/mcp.ts` is counted from `mcp/server.py`, and
  `tests/mcp-data.test.ts` re-counts it on every run. **This has now caught a
  real drift twice**: it caught an invented tool name during the original build,
  and on D-264's first run it caught the site publishing 106 tools when the
  server had 144 — the Motion room's whole 37-tool gap had closed in the
  interval and the site had not noticed.
- The differentiation page claims a specific tool does each job it describes,
  and every one of those names is checked against the server too.
- The debug-only tools are disclosed separately and never folded into the
  shipped total, because they are compiled out of a production build.
- The site prints the MCP surface's **current** real gaps rather than only the
  ones that have been closed.
- There are no testimonials, user counts, download numbers or "trusted by"
  logos, because there are no users yet. A test asserts none appear.

### Real imagery only

`public/shots/` holds real screenshots of the running application, captured with
the repo's own `debug_screenshot` tooling. Every one was opened and confirmed to
be what its alt text says before use.

**No Edit, Motion, or Colorist room screenshot is shown on any page right
now** (D-288) — the Edit captures that do exist predate the rename
(`TODO-RECAPTURE-SHOTS.md`), and rather than keep showing them disclosed as
stale, the owner's own call was to hide them the same honest way the
Motion/Colorist rooms already handled having none: say so, and list real
capabilities instead of a screenshot. The home page's scrubbable
demonstration (`src/components/Demo.astro`) is similarly not rendered right
now for the same reason — the component itself is untouched, just not
currently imported on `index.astro`. There is also **no demo video** — see
`TODO-DEMO-VIDEO.md`.

## Beta signup

The form is real: it posts to the site's own waitlist (D-426) — a Cloudflare
Pages Function over a D1 table, a double-opt-in confirmation email through
Resend, confirmed addresses mirrored to a Resend segment for broadcasts. See
**`BETA_SIGNUP_SETUP.md`** for how it works, the secret and migration steps,
export and sending the launch email. It replaced FormSubmit.co; before that
Formspree (D-255).

## Structure

```
website/
  astro.config.mjs      site config; static output
  src/
    content.config.ts   the `releases` collection: docs/releases/v*.md (D-459)
    md/release-notes.ts the rehype pass that fits a release note under the page's own headings
    data/               the real, tested facts the site publishes
      palette.ts        the brand palette + its provenance and citation
      mcp.ts            tool counts, names and gaps, verified against mcp/server.py
      product.ts        per-room shipped features, the differentiation, the limits
      releases.ts       each release's version, date (from the tag) and GitHub URL
      beta.ts           the signup endpoint, its validation and the roles (shared with functions/)
    layouts/Base.astro  head, fonts, nav, footer
    components/         one file per section, plus Signature and PageHead
    pages/
      index.astro       home — the promise, the demonstration, the ask
      who-its-for.astro the full differentiation argument
      inside.astro      what each of the three rooms really does
      changelog.astro   every release, newest first, from docs/releases/
      docs/mcp.astro    connecting an agent (the one technical page)
      404.astro
    styles/
      tokens.css        THE colour + type source
      global.css        reset, base type, shared primitives, .signature
  functions/            the waitlist API (Pages Functions): api/ routes, _lib/ logic
  migrations/           D1 schema (wrangler d1 migrations)
  scripts/              waitlist CSV export, Resend reconcile + backfill
  workers/              waitlist-drain: hourly Cron Worker for held confirmation emails (D-427)
  wrangler.toml         Pages config: D1 binding, non-secret vars
  public/shots/         real application screenshots
  tests/                Vitest — see below
```

## Tests

| file | what it guards |
|---|---|
| `palette.test.ts` | the brand palette matches its source of record; the app tokens match the app; no stray colour literal; the signature is spent once; the banned typefaces appear nowhere |
| `mcp-data.test.ts` | every MCP number, tool name, port variable, file path and error fragment is real |
| `beta.test.ts` | email validation, the endpoint, and the role ordering |
| `waitlist.test.ts` | the waitlist handlers over real SQLite (the real migration) and a mocked Resend: signup, honeypot, no-leak duplicates, throttle, confirm, unsubscribe, Resend contact sync and its failure handling |
| `render.test.ts` | every section renders; the headline is benefit-led and under 30 words; the demonstration is genuinely interactive; the differentiation names the tools it names; the honest gaps survive; no fabricated social proof; no stray old-brand text |
| `changelog.test.ts` | runs over `dist/`: every `docs/releases/v*.md` has a section and none is invented, newest-first, the dates and the `releases/tag/` links are real, each note's own headings survive, the README is not published as a release, and no internal `D-NNN`/`B-NNN` shorthand leaks |
| `build-output.test.ts` | runs over `dist/`: every route built, no broken internal links or anchors, no missing images, one `h1` per page, at most one signature per page, no `TODO` or `console.*` in shipped output |

`build-output.test.ts` and `changelog.test.ts` need `dist/` to exist. `npm run verify` builds first;
running `npm run test` alone on a clean checkout will tell you to build.

## Deployment

Hosting is not set up yet, but the domain is real: `astro.config.mjs`'s `site`
is `https://apelles.studio`, the domain D-265 records the owner actually
buying — used for canonical/OG URLs and the sitemap (`@astrojs/sitemap`,
added D-288) that `astro build` emits at `/sitemap-index.xml`. (An earlier
placeholder, `apelles.video`, was left in this config after the real domain
was bought — D-288 caught and fixed the drift.) The build itself is a plain
static directory, so any static host serves it once one is chosen.

Each sitemap entry carries a `lastmod` (the last commit touching that page's own
content: the page plus the components and data it imports, not the shared
layout/nav/footer), image entries for the app captures it shows, and, on the home
page, video entries for the embedded YouTube videos. All of it is generated by
`src/seo/sitemap.ts` from the same data the pages render, and checked by
`tests/build-output.test.ts`. A `lastmod` is only as fresh as the last commit, so
build for deployment from a clean, committed tree.

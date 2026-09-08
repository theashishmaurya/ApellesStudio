# `website/` — Chroma's marketing + docs site

**What it is.** The public site for Chroma: what the product is, what each of the
three tabs really does, how to connect an MCP client to it, why it is built
local-first, and a pre-launch beta signup. Static Astro, no server, no database,
no analytics.

**What it does NOT do.** It does not talk to the desktop app, ship any app code,
or run anything at request time. `astro build` emits plain HTML and CSS plus two
small client-side scripts (the hero's scrub interaction and the signup form).

Created by **D-255**, which also records why it was built now rather than at the
end of the launch sequence.

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
| `npm run test` | Vitest (needs a build first for the link check) |
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
- Nothing in the site imports app code at runtime. It reads two app source files
  **at test time only**, to assert it has not drifted from them (see below).

It is a sibling directory, matching the monorepo's existing convention of
top-level directories that are their own thing (`ai/`, `ai-media/`, `mcp/`,
`eval/`).

## The rules this site holds itself to

### One token source

`src/styles/tokens.css` is a verbatim transcription of the app's own Dark theme
from `app/src/utils/themes.ts`, plus the shipped 16-swatch marker palette from
`packages/editor/src/timeline.ts`. There is no second, "marketing" palette, and
no invented colour anywhere.

`tests/tokens.test.ts` reads **both real app files** and fails if a single value
diverges, if a colour literal appears that came from neither source, or if the
display face stops being the app's own Poppins. If you restyle the app, this
test tells you the site is now lying.

### No claim the repo does not back up

- Feature copy comes from `docs/02-scope.md`'s shipped (✅) items only.
- Every MCP number in `src/data/mcp.ts` is counted from `mcp/server.py`, and
  `tests/mcp-data.test.ts` re-counts it on every run. It also asserts that every
  tool name printed on the site is really defined in that file — it already
  caught one invented name during the build.
- The Motion tab's **zero** MCP tools is printed next to the other counts rather
  than omitted.
- The debug-only tools are disclosed separately and never folded into the
  shipped total, because they are compiled out of a production build.
- There are no testimonials, user counts, download numbers or "trusted by" logos,
  because there are no users yet. A test asserts none appear.

### Real imagery only

`public/shots/` holds real screenshots of the running application, captured with
the repo's own `debug_screenshot` tooling. Every one was opened and confirmed to
be what its alt text says before use.

**There are no Motion-tab or Colorist-tab screenshots**, because none have been
captured. Those two sections say so on the page and list their real capabilities
instead of showing a mockup. There is also **no demo video** — see
`TODO-DEMO-VIDEO.md`.

## Beta signup

The form is real and working; the endpoint is a marked placeholder. Three steps
to make it live: **`BETA_SIGNUP_SETUP.md`**.

## Structure

```
website/
  astro.config.mjs      site config; static output
  src/
    data/               the real, tested facts the site publishes
      mcp.ts            tool counts + names, verified against mcp/server.py
      product.ts        per-tab shipped features + the positioning pillars
      beta.ts           the signup endpoint and its validation
    layouts/Base.astro  head, fonts, nav, footer
    components/         one file per section
    pages/
      index.astro       home
      docs/mcp.astro    connecting an agent
      404.astro
    styles/
      tokens.css        THE palette + type source
      global.css        reset, base type, shared primitives
  public/shots/         real application screenshots
  tests/                Vitest — see below
```

## Tests

| file | what it guards |
|---|---|
| `tokens.test.ts` | the palette and type have not drifted from the app |
| `mcp-data.test.ts` | every MCP number and tool name is real |
| `beta.test.ts` | email validation, and the endpoint placeholder guard |
| `render.test.ts` | every section renders; the hero is genuinely interactive; the honest "no screenshot" and "no demo video" notes survive; no fabricated social proof |
| `build-output.test.ts` | runs over `dist/`: no broken internal links or anchors, no missing images, one `h1` per page, titles and descriptions present, no `TODO` or `console.*` in shipped output |

`build-output.test.ts` needs `dist/` to exist. `npm run verify` builds first;
running `npm run test` alone on a clean checkout will tell you to build.

## Deployment

Not set up yet, deliberately — there is no domain. The build is a plain static
directory, so any static host serves it. `astro.config.mjs`'s `site` is a
placeholder (`https://chroma.video`) used for canonical and Open Graph URLs;
change it when the real domain exists.

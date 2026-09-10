# TODO — a real demo video

**Status: still not built. Tracked in `docs/04-roadmap.md` under the website
item (D-255); carried forward unchanged by D-264's rebuild. As of D-288 the
whole demonstration section is not rendered on the home page at all — see
below.**

The site currently has **no video of any kind**, deliberately. No recording of
the product in motion existed when the site was built, and a marketing site for a
video tool must not fake one — no stock footage, no screen recording of
something else, no motion mockup presented as the product.

## What the site did instead, and why it's off right now

The demonstration section (`src/components/Demo.astro`) is a **scrubbable
filmstrip of real screenshots** of the running application, with a working
playhead and timecode, and a caption that says so in plain language:

> Real screenshots of the running application, scrubbable. Apelles has no
> recorded product demo yet, and there is no stand-in for one on this page.

That sentence is still asserted by `tests/render.test.ts` against the
component directly — D-288 didn't touch `Demo.astro` itself, it just stopped
importing/rendering it on `index.astro`, because the screenshots that
filmstrip is built on predate the rename (`TODO-RECAPTURE-SHOTS.md`) and the
owner's own call was to hide stale imagery rather than show it disclosed.
Re-enable it the same way `TODO-RECAPTURE-SHOTS.md` describes, with real
post-rename captures, whenever that happens — that also resolves this file,
partly, by giving the filmstrip real current imagery even before a video
exists.

## What to do when a real recording exists

1. Record a genuine session — the strongest sequence is the one the site already
   claims: import footage, cut to a word from the transcript, stack a second
   track, key a dynamic zoom, then let an agent drive the same timeline over MCP
   so the sliders visibly move on their own. The last beat is the product's
   actual argument and nothing else on the page can show it.
2. Encode a poster frame plus H.264 and WebM, and keep it short. It should
   autoplay muted, loop, and carry `playsinline`.
3. Replace `Demo.astro`'s `.canvas` filmstrip with the video, keeping the playhead
   and the numeric fields wired to it — they become genuinely more impressive
   against moving footage than against stills, and the scrub interaction is
   already written against a frame count.
4. Delete the caption sentence above and the test that asserts it.
5. Keep a static fallback for `prefers-reduced-motion: reduce`.

## What must not happen

Do not ship a "demo" assembled from these same screenshots with a Ken Burns move
over them and call it a video. The honest still filmstrip that exists now is
better than a fake one.

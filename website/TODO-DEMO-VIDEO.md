# TODO — a real demo video

**Status: not built. Tracked in `docs/04-roadmap.md` under the website item
(D-255).**

The site currently has **no video of any kind**, deliberately. No recording of
Chroma in motion existed when the site was built, and a marketing site for a
video tool must not fake one — no stock footage, no screen recording of
something else, no motion mockup presented as the product.

## What the site does instead

The hero is a **scrubbable filmstrip of real screenshots** of the running
application (`public/shots/`), with a working playhead and timecode. Its caption
says so in plain language:

> Real screenshots of the running application, scrubbable. Chroma has no
> recorded product demo yet.

That sentence is asserted by a test (`tests/render.test.ts`), so it cannot be
quietly deleted while the video is still missing.

## What to do when a real recording exists

1. Record a genuine session — the strongest sequence is the one the site already
   claims: import footage, cut to a word from the transcript, stack a second
   track, key a dynamic zoom, then let an agent drive the same timeline over MCP
   so the sliders visibly move on their own. The last beat is the product's
   actual argument and nothing else on the page can show it.
2. Encode a poster frame plus H.264 and WebM, and keep it short. It should
   autoplay muted, loop, and carry `playsinline`.
3. Replace the hero's `.canvas` filmstrip with the video, keeping the playhead
   and the numeric fields wired to it — they become genuinely more impressive
   against moving footage than against stills, and the scrub interaction is
   already written against a frame count.
4. Delete the caption sentence above and the test that asserts it.
5. Keep a static fallback for `prefers-reduced-motion: reduce`.

## What must not happen

Do not ship a "demo" assembled from these same screenshots with a Ken Burns move
over them and call it a video. The honest still filmstrip that exists now is
better than a fake one.

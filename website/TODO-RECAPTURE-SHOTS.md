# TODO — retake the screenshots after the rename

**Status: open. Created by D-264 (the Apelles rebrand of `website/`).**

Every image in `public/shots/` is a genuine capture of the running application,
taken with the repo's own `debug_screenshot` tooling before the product was
renamed. So the application's own title bar in each of them still reads
**CHROMA**.

## What the site does about it right now

It says so, in two places, in the caption directly beneath the image:

- the home page's scrubbable demonstration (`src/components/Demo.astro`)
- the Edit room on `/inside/` (`src/pages/inside.astro`)

Both say the captures predate the rename and that they **will be retaken rather
than retouched**. `tests/render.test.ts` and `tests/build-output.test.ts` assert
that disclosure survives, so it cannot be quietly deleted while the images are
still the old ones.

## Why they were not simply edited

Painting a new wordmark over the title bar of a real screenshot would make it a
fabricated capture. This site's whole standing rule is that its imagery is real
— it ships no mockups, and it says out loud that the Motion and Colorist rooms
have no screenshots at all rather than inventing some. Retouching the one
capture it does have would be the same failure in a more deniable form.

## What to do

1. Once the rename has landed in the app (the sibling work to D-264, outside
   `website/`), run the desktop app and re-take the same four frames with
   `debug_screenshot`:
   - `edit-timeline.png` — the Edit tab, vertical preview, toolbar, one video
     track with a real filmstrip and a marker pinned above it
   - `edit-composite.png` — two video tracks composited, four audio tracks below
   - `edit-inspector.png` — the clip Inspector on Transform / Crop / Dynamic
     Zoom / Speed, keyframe diamonds visible
   - `edit-transform.png` — the on-canvas transform box with its corner handles
2. Keep the intrinsic sizes the same (the first three are 2692×1800, the fourth
   2560×1440) or update the `width`/`height` attributes that reserve their boxes
   in `Demo.astro` and `src/data/product.ts`. `astro build` will not catch a
   mismatch; the layout will just shift.
3. Open each one and confirm it is really what its alt text claims before it is
   used. That check is the site's convention, not a formality.
4. Delete the two disclosure sentences and the tests that assert them, and
   delete this file.

## Still open alongside this

`TODO-DEMO-VIDEO.md` — there is no recorded product demo of any kind. That is a
separate, larger gap and it is tracked separately.

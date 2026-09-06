/**
 * @chroma/motion — `LayerThumbnail` (D-176, owner: "we need thumblain for
 * layers so we know what are we working with"), a small per-row preview of
 * a layer's REAL primitive for `LayerList.tsx`.
 *
 * **The question this file answers first: what does "a thumbnail" even mean
 * for a procedural/vector primitive** (a text string, a scribble, a data
 * grid, a particle stream — `packages/motion-engine/src/primitives/*.tsx`,
 * read in full before writing this), as opposed to a photo/video frame,
 * where there's an obvious "grab a frame" answer. Decided: render the
 * layer's OWN real component (`lookup(layer.use).component`, `registry.ts`)
 * with its OWN current props, frozen at a settled frame, standalone — not
 * composited with the scene's camera or its sibling layers (the task's own
 * scope: a thumbnail of THIS layer, not a mini scene). This is a genuinely
 * live, correct preview (its color, its text, its preset — whatever the
 * layer's fields actually say right now) wherever it is legible — see the
 * "which primitives actually get a live preview" section below for the
 * real, empirically-checked limit on that.
 *
 * **How: `@remotion/player`'s `Thumbnail` component.** `CatalogPanel.tsx`'s
 * own (now corrected, see its doc comment) D-151 note claimed "`@remotion/
 * player` exposes no cheap render-one-still API to this package" — untrue,
 * found while building this: `Thumbnail` is exactly that, confirmed by
 * reading its own source (`node_modules/@remotion/player/dist/cjs/
 * Thumbnail.js` + `ThumbnailUI.js`) rather than assumed from its name alone:
 * `playing: false` and a FIXED `frame` in its timeline context, no
 * `requestAnimationFrame` loop anywhere in it — a genuinely static render,
 * not a paused player still holding a ticking loop in reserve. It sets up
 * the exact same `SharedPlayerContexts`/`IsPlayerContextProvider` the real
 * `<Player>` (`MotionPreview.tsx`) uses, which is the "lightweight way to
 * provide Remotion context for a tiny isolated render" the task asked to go
 * find — every primitive here calls `useCurrentFrame()`/`useVideoConfig()`
 * unconditionally (confirmed by grep across every file in `primitives/`),
 * which throws with no such context, so SOME provider is required; this is
 * it, at negligible cost (no WebGL, no video decode, no async
 * `React.lazy`/Suspense delay either — passing a plain `component` prop
 * resolves synchronously through `useLazyComponent`'s own `component`-prop
 * branch, confirmed by reading it, not the `lazyComponent` branch that
 * WOULD go through `React.lazy`).
 *
 * **Full canvas size, not thumbnail size, for the composition itself** —
 * `compositionWidth`/`compositionHeight` are the MANIFEST's own `width`/
 * `height` (e.g. 1920×1080), not the small on-screen box, so a primitive
 * positioned in absolute WORLD px (`x`/`y`, `box`) resolves to the exact
 * same place it would in the real scene; `Thumbnail`'s own `style` prop
 * is the small `THUMB_W`×`THUMB_H` box, and it letterbox-scales the
 * full-size composition down to fit it (the same `calculateCanvasTransformation`
 * math `<Player>`'s own preview scaling already uses).
 *
 * **Which primitives actually GET a live preview — checked empirically, not
 * assumed, and this is the real load-bearing decision in this file.** A
 * first pass rendered every 2D primitive this way and live-verified all of
 * them in the harness (`app/motion-harness.html`). Result: `matrix` (filled
 * grid cells) and `layers` (filled card rectangles) render as real,
 * recognizable shapes at `THUMB_W`×`THUMB_H` even after the roughly 60×
 * downscale from a 1920px canvas. `text` and `emphasis` did NOT — both draw
 * with a FIXED, small stroke width in canvas px (`Text.tsx`'s `stroke-on`
 * preset: a ~1.5px `WebkitTextStroke`; `Emphasis.tsx`'s scribble/ring
 * presets: comparably thin paths) — after a 60× downscale that stroke is a
 * small fraction of one device pixel and simply doesn't render, confirmed
 * visually (a blank box) and by the arithmetic: making a 1.5px stroke read
 * as even one real pixel at `THUMB_W=30` against a 1920px canvas needs
 * `1.5 × (30/1920) × zoom ≥ 1`, i.e. `zoom ≥ ~43` — magnifying the source
 * by over 40× before the final scale-down, which for `text` would mean
 * showing a few px of a single glyph, not "which layer is this." A CSS
 * zoom-into-the-layer's-own-bounding-box was built and tried as a fix
 * (`layerWorldPosition`/`layerWorldSize` from `manifestEdit.ts` gave a
 * crop box, magnified via `transform: scale()`) — it did not help `text`/
 * `emphasis` (the stroke-width problem is about the STROKE, not the
 * framing — cropping tighter doesn't thicken a hairline) and was reverted
 * rather than shipped as complexity with no real payoff. `graph` was left
 * OUT of the live set too, honestly for a different reason: it was not
 * empirically re-verified this pass (the sample manifest used for live
 * testing has no `graph` layer) — its nodes are filled circles (likely
 * legible, similar to `matrix`'s cells) but its edges are thin strokes
 * (likely not), and rather than ship an unverified guess either way, it
 * gets the same safe fallback as `text`/`emphasis` until someone actually
 * checks. So: `LIVE_PREVIEW_USES` below is the real, checked allowlist —
 * `matrix` and `layers` only — everything else (`text`, `emphasis`,
 * `graph`, and the 3D three below) gets the static `PrimitiveGlyph`
 * fallback, which is *always* legible regardless of scale. This is
 * precisely the task's own sanctioned fallback ("if a full, correct
 * live-render-per-row proves too heavy or fragile... a reasonable fallback
 * is a small, static, per-`use`-type icon") applied per-primitive rather
 * than all-or-nothing, once checking showed exactly where it applies.
 *
 * **Frozen at `THUMBNAIL_FRAME`, a fixed "long past any entrance" frame** —
 * not the layer's own scene-relative "current playhead frame," since this
 * mini composition has no scene/playhead concept of its own (it is
 * standalone, per the task's own scope: "not composited with the scene's
 * camera/other layers"). Every entrance/reveal helper this engine's
 * primitives share (`lib/draw.ts`'s `inAt`/`outAt`/`lifetime`, and
 * `spring()`-based `pop()`) clamps or settles rather than looping or going
 * negative for a frame past its own window (confirmed by reading
 * `draw.ts`) — so a big fixed frame reliably shows every primitive's fully-
 * revealed, nothing-still-animating-in state, regardless of that specific
 * layer's own `at`/`dur`/`stagger`. 300 frames (10s at a typical 30fps) is
 * comfortably past every default entrance/stagger schedule any primitive in
 * this catalog uses today (`Layers`' own worst case — many staggered items
 * — tops out in the low hundreds of frames even for an unusually long
 * `items` list), without declaring an absurd `durationInFrames`.
 *
 * **The 3D three (`particleflow`/`labelbox`/`layerstack`) NEVER get a live
 * thumbnail — the static `PrimitiveGlyph` fallback instead, unconditionally,
 * for a completely different reason than `text`/`emphasis`/`graph` above.**
 * This is the SAME real, already-documented constraint `CatalogPanel.tsx`'s
 * own D-151 doc comment established: those three only render inside a
 * `@remotion/three` `<ThreeCanvas>`, a real WebGL context per mount, and
 * browsers cap simultaneous WebGL contexts (commonly 8–16) while
 * `MotionPreview`'s own player already holds one. `LayerList` can show many
 * rows across many scenes at once — mounting a `<ThreeCanvas>` per 3D-child
 * row would risk exhausting that ceiling on a manifest with more than a
 * handful of 3D children. `catalogEntry(layer.use).in3d` is the routing
 * check — the SAME flag `addLayer`/`manifestEdit.ts` already use to decide
 * which array a primitive belongs in.
 *
 * **Performance: mount-on-visible, not always-mounted.** `LayerList` lists
 * EVERY scene's rows at once (unlike the on-canvas overlay, which only ever
 * has one scene mounted) — a manifest with many scenes/layers could mean
 * dozens of rows sitting in a scrollable panel most of which are scrolled
 * out of view at any moment. Mounting all of them unconditionally would pay
 * for that many `Thumbnail` mounts (each its own `IsPlayerContextProvider`/
 * `SharedPlayerContexts` tree, `ErrorBoundary`, `Suspense`, and a real
 * `ResizeObserver` via `useElementSize`) regardless of whether a single
 * pixel of any of them is ever seen. The alternative considered and
 * REJECTED — scope live thumbnails to "only the currently selected scene's
 * rows" — was rejected because it would make thumbnails disappear for a
 * scene simply scrolled into view but not selected, which is a strictly
 * worse answer to "so we know what we're working with" than showing a real
 * preview for whatever is actually on screen in the list, selected or not.
 * So: each thumbnail's own `IntersectionObserver` (rooted at the scrolling
 * `LayerList` container, `rootMargin: '200px'` to start rendering just
 * before a row scrolls fully into view, avoiding a visible pop-in) gates
 * whether it mounts `<Thumbnail>` at all; once it has been visible once, it
 * STAYS mounted (`visible` never resets to `false`) rather than
 * mounting/unmounting on every scroll in and out — a `<Thumbnail>` costs
 * nothing ongoing once mounted (no RAF loop, confirmed above), so there is
 * no ongoing cost to amortize by tearing it back down, and repeatedly
 * mounting/unmounting on every scroll would be strictly worse (real
 * mount/unmount churn) for zero benefit.
 */
import { useEffect, useRef, useState } from 'react';
import { Thumbnail } from '@remotion/player';
import type { Layer, Manifest } from '@chroma/motion-engine/src/engine/schema';
import { lookup } from '@chroma/motion-engine/src/engine/registry';
import { design } from '@chroma/motion-engine/src/design';
import { catalogEntry, type PrimitiveUse } from './catalog';
import { PrimitiveGlyph } from './PrimitiveGlyph';

const THUMB_W = 30;
const THUMB_H = 18;

/** See this file's own module doc comment ("Frozen at `THUMBNAIL_FRAME`")
 *  for the full reasoning — generously past any realistic per-layer
 *  entrance/stagger schedule, not tied to the real scene's own duration. */
const THUMBNAIL_FRAME = 300;

/** The real, empirically-checked allowlist — see the module doc comment's
 *  own dedicated section for the measurements behind it. Only these two
 *  primitives render as recognizable shapes at `THUMB_W`×`THUMB_H`; every
 *  other `use` (including the 3D three) falls back to `PrimitiveGlyph`. */
const LIVE_PREVIEW_USES: ReadonlySet<PrimitiveUse> = new Set(['matrix', 'layers']);

/** The standalone mini-composition `<Thumbnail component={...}>` actually
 *  renders: ONE layer's real primitive, adapted through the SAME
 *  `registry.ts` `lookup`/`adapt` `Video.tsx` itself uses for every layer in
 *  a real scene — never a second, hand-rolled prop-adaptation path. No
 *  `<Camera>`, no sibling layers: exactly the "in isolation" the task
 *  scoped this to. A plain absolutely-positioned `<div>` stands in for
 *  Remotion's own `<AbsoluteFill>` (which additionally registers a
 *  `<Sequence>` for timeline/devtools bookkeeping this one-off static
 *  render has no use for) — avoids adding `remotion` itself as a new direct
 *  dependency of this package for one wrapper div. */
function SingleLayerComposition({ layer, fps }: { layer: Layer; fps: number }) {
  const { component: Component, adapt } = lookup(layer.use);
  const props = adapt(layer as unknown as Record<string, unknown>, fps, THUMBNAIL_FRAME);
  return (
    <div style={{ position: 'absolute', inset: 0, background: design.bg, overflow: 'hidden' }}>
      <Component {...props} />
    </div>
  );
}

export function LayerThumbnail({ layer, manifest }: { layer: Layer; manifest: Manifest }) {
  const live = LIVE_PREVIEW_USES.has(layer.use);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  // See the module doc comment's "Performance" section — observes against
  // the nearest scrolling ancestor (`LayerList`'s own `overflow-y-auto`
  // div, found via `closest`, not a hardcoded ref threaded down through
  // every row — `root: null` falls back to the viewport if that div isn't
  // found for any reason, still correct, just less precise). Once visible,
  // stays mounted — see the doc comment for why tearing it back down on
  // scroll-out would be pure churn for no benefit.
  useEffect(() => {
    if (!live || visible) return;
    const el = containerRef.current;
    if (!el) return;
    const root = el.closest('[data-layer-list-scroll]');
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { root, rootMargin: '200px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [live, visible]);

  if (!live) {
    // Everything outside `LIVE_PREVIEW_USES` — the 3D three (WebGL-context
    // ceiling) and the empirically-illegible-at-this-scale `text`/
    // `emphasis`/`graph` (see the module doc comment) — the static glyph,
    // always legible regardless of scale.
    return (
      <span
        className="shrink-0 flex items-center justify-center text-text-secondary/80"
        style={{ width: THUMB_W, height: THUMB_H }}
        aria-hidden
      >
        <PrimitiveGlyph use={layer.use} />
      </span>
    );
  }

  return (
    <div
      ref={containerRef}
      className="shrink-0 rounded-sm overflow-hidden border border-border-color/60 bg-bg-primary"
      style={{ width: THUMB_W, height: THUMB_H }}
    >
      {visible && (
        <Thumbnail
          component={SingleLayerComposition}
          inputProps={{ layer, fps: manifest.fps }}
          compositionWidth={manifest.width}
          compositionHeight={manifest.height}
          durationInFrames={THUMBNAIL_FRAME + 1}
          fps={manifest.fps}
          frameToDisplay={THUMBNAIL_FRAME}
          style={{ width: THUMB_W, height: THUMB_H }}
          // A render that throws (a malformed hand-edited field, a future
          // primitive this file hasn't seen) falls back to the SAME static
          // glyph the non-live `use`s always show, rather than Thumbnail's
          // own default "⚠️" emoji — an honest "couldn't preview it," not a
          // crash, and visually consistent with the other fallback path.
          errorFallback={() => <PrimitiveGlyph use={layer.use} />}
        />
      )}
    </div>
  );
}

# @apelles/player

**The shared preview component** (D-039 roadmap "Next" item 1) — one canvas
viewport + title strip + transport bar all 3 tabs embed. Fully controlled and
**presentational only**: it renders whatever `surface` the caller hands it and
calls back on every interaction. It owns no frame-fetch, no IPC, no timeline
model, no playback-loop state — that logic is tab-owned and stays in the
caller (see `@apelles/editor`'s `PreviewPane.tsx` for the reference pattern:
the `chroma_timeline_frame` invoke, the scrub-refetch effect, the wall-clock
`requestAnimationFrame` play loop with frame-dropping).

Deps: `react`, `lucide-react`, `@apelles/ui` (Button/Slider from the shadcn kit,
D-042). **No `@tauri-apps/api`, no zustand, no video/decode logic** — if this
package ever grows a `useEffect` that calls `invoke(...)`, that's a bug; move
it to the caller.

## Layout

```
┌─────────────────────────────────────────────┐
│  ‹  title                              …     │  ← title strip (only if title/onPrev/onNext/menu given)
├─────────────────────────────────────────────┤
│                                               │
│                   surface                    │  ← viewport, bg-black/40, centered
│                                               │
├─────────────────────────────────────────────┤
│  ───────────●─────────────────────────────   │  ← scrub bar (only if onSeek given)
│  ⏮ ⏴ ▶ ⏵ ⏭   00:00:12:04 / 00:01:03:00  ⏱1×      📷 ⛶ 🔍Fit │  ← transport bar
└─────────────────────────────────────────────┘
```

## Prop contract

```ts
interface PlayerProps {
  surface: ReactNode;           // whatever the tab renders inside the viewport
  title?: string;                // clip/shot/composition name, shown in the title strip
  onPrev?: () => void;           // '‹' nav — only rendered if provided
  onNext?: () => void;           // '›' nav — only rendered if provided
  menu?: ReactNode;               // the '…' slot — caller supplies its own dropdown content (trigger included)

  frame: number;
  total: number;                  // last valid frame index
  fps?: number;                   // for the timecode readout; omit → frame counter only
  playing: boolean;
  onPlayPause: () => void;
  onStep: (delta: number) => void;      // ±1 frame
  onSeek?: (frame: number) => void;      // optional scrub bar; omit → no scrub bar rendered
  onSkipStart?: () => void;              // omit → button hidden
  onSkipEnd?: () => void;                // omit → button hidden

  onSnapshot?: () => void;               // omit → button hidden
  onFullscreen?: () => void;             // omit → button hidden
  rate?: number;                          // PLAYBACK rate, 1 = normal (D-280) — omit → control hidden
  onRateChange?: (rate: number) => void;
  zoom?: number;                          // viewport magnification, 1 = fit — omit → zoom cluster hidden
  onZoomIn?: () => void;                  // omit → the + button renders disabled
  onZoomOut?: () => void;                 // omit → the − button renders disabled
  onZoomReset?: () => void;               // omit → the `{pct}%` readout stays a plain label

  className?: string;
}
```

**Every optional prop's control is omitted, not disabled, when its callback
isn't supplied** — a tab that doesn't support fullscreen just doesn't render
the button. This is what lets Motion and Colorist adopt the component later
without the Editor's choices constraining them. Exceptions, by design:

- `rate` / `zoom` are display **and** control together — if the value prop
  (`rate`/`zoom`) is given but its setter isn't, the readout still renders
  (as plain text, not a button) rather than disappearing, since the caller
  clearly has a rate/zoom concept even if it hasn't wired the setter yet. For
  `zoom` the two +/− buttons render **disabled** rather than hidden when their
  callback is missing (D-218) — that is how a caller expresses "already at
  min/max", and a control that vanished at a bound would make the cluster
  jump around under the pointer.
- **`rate` is the TRANSPORT's playback rate** (D-280) — timeline seconds
  played per real second — and is **not** any clip's Speed/Retime property.
  It changes how fast the user watches; it persists nothing and changes no
  render. The control sits in the transport bar's left cluster, after the
  timecode, and opens a popover of presets plus a custom field. Unlike `zoom`,
  the presets/bounds/formatting DO live in this package
  (`src/playbackRate.ts`, exported) because the control renders all three —
  the tab imports the same values for its own clamp so there is one source.
  What the tab still owns entirely is what a rate MEANS: `@apelles/editor`'s
  `PreviewPane.tsx` multiplies its rAF loop's frame target by it and hands it
  to `chroma_audio_play`, which time-stretches the mixed audio with pitch
  preserved. This package makes no sound and decodes no frame.
- **`zoom` carries no math** (D-218). It is a multiplier where `1` = fit,
  shown as a percentage; the three callbacks are pure intent ("in" / "out" /
  "back to fit") and the tab owns its own bounds, step and clamping, since
  only the tab knows what its `surface` is. `@apelles/editor`'s
  `previewZoom.ts` is the reference implementation.
- `onStep`, `onPlayPause`, `frame`, `total`, `playing` are not optional — the
  ±1 step buttons and play/pause are always shown; there is no "not a
  playable surface" tab in the current design.

Icons (all `lucide-react`): skip-to-start/end use `SkipBack`/`SkipForward`;
the ±1 step buttons use the distinct `StepBack`/`StepForward` so the two
concepts never look the same control. Nav uses `ChevronLeft`/`ChevronRight`.
Snapshot `Camera`, fullscreen `Maximize`, playback rate `Gauge`, zoom `ZoomOut`/`ZoomIn` (the same
pair `TimelinePane`'s own timeline-zoom cluster uses — one tab, one zoom
idiom).

Nothing throws when `total`/`fps` are `0` — `fmtTimecode` (also exported,
single source of truth, `@apelles/editor` imports it from here) falls back to
a bare frame counter when `fps` is missing or non-positive, and the scrub
slider clamps its range and disables itself when `total <= 0`.

## Example call site

```tsx
import { Player } from '@apelles/player';

function MyTabPreview() {
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);

  return (
    <Player
      surface={<img src={frameSrc} alt="" className="max-h-full max-w-full object-contain" />}
      title="Timeline"
      frame={playhead}
      total={lastFrame}
      fps={fps}
      playing={playing}
      onPlayPause={() => setPlaying((p) => !p)}
      onStep={(delta) => setPlayhead((f) => f + delta)}
      onSeek={(f) => {
        setPlaying(false);
        setPlayhead(f);
      }}
    />
  );
}
```

The Editor tab (`@apelles/editor`'s `PreviewPane.tsx`) is the real consumer —
read it for how the frame-fetch + rAF play-loop logic stays in the caller
while only the rendered transport JSX moves to `<Player>`.

## `useContentBox` — letterbox math for an overlay

D-136 (Phase 1 of `docs/notes/on-canvas-transform.md`) added a second export
alongside `<Player>`: `useContentBox(containerRef, size)`, extracted from
`app/src/hooks/useImageRenderSize.ts` (D-046) so a tab built on this package
can place a DOM/SVG overlay over its `object-contain`-fit `surface` without
reaching into `app/` (`packages/editor` may not import from `app/` — D-039's
one-way dependency rule). Given the container the picture is centred within
and the picture's own natural size, it returns the on-screen rect
(`offsetX`/`offsetY`/`width`/`height`, in the container's own local pixels)
the picture actually occupies — the same "where did `object-contain` put the
letterboxed image" question `RelightPuckLayer.tsx`'s markers answer for the
Colorist tab.

`@apelles/editor`'s `TransformOverlay.tsx` is the first real consumer: it
renders as a sibling of `PreviewPane.tsx`'s `<img>`, both children of one
`relative` wrapper div, and uses `useContentBox` on that same wrapper to map
a selected clip's composition-fraction box (`Clip.position_x`/`position_y`/
`scale`, D-136) onto real screen pixels for its drag handles.

`app/src/hooks/useImageRenderSize.ts` itself is untouched and still owns
every Colorist-tab call site — this hook is the shared copy a NEW call site
should reach for, not (yet) a replacement for that one; see its own doc
comment for why migrating Colorist onto it is a separate, deliberately
deferred refactor.

## Tests

`npm test --workspace @apelles/player` (vitest; jsdom via `vitest.config.ts`,
mirroring `@apelles/keymap`'s rig). `playbackRate.test.ts` is the pure model;
`Player.rate.dom.test.tsx` mounts the real transport bar and clicks the real
popover. Added by D-280 — the package had no test rig before it.

## What's NOT here

- No `@tauri-apps/api` invoke calls, no zustand store, no knowledge of what a
  "timeline" or "frame source" is.
- No decode, no audio, no sense of how fast time passes — `rate` is a number
  this package renders a control for; the tab is what makes playback obey it.
- No craft-specific controls (color scopes, mask overlay toggles, LUT
  preview) — those stay in the Colorist tab's own chrome around `surface`.
- Colorist and Motion have not adopted this component yet (follow-on items on
  `docs/04-roadmap.md`'s "Next" queue) — only `@apelles/editor` uses it today.

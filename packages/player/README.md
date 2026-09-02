# @chroma/player

**The shared preview component** (D-039 roadmap "Next" item 1) — one canvas
viewport + title strip + transport bar all 3 tabs embed. Fully controlled and
**presentational only**: it renders whatever `surface` the caller hands it and
calls back on every interaction. It owns no frame-fetch, no IPC, no timeline
model, no playback-loop state — that logic is tab-owned and stays in the
caller (see `@chroma/editor`'s `PreviewPane.tsx` for the reference pattern:
the `chroma_timeline_frame` invoke, the scrub-refetch effect, the wall-clock
`requestAnimationFrame` play loop with frame-dropping).

Deps: `react`, `lucide-react`, `@chroma/ui` (Button/Slider from the shadcn kit,
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
│  ⏮ ⏴ ▶ ⏵ ⏭   00:00:12:04 / 00:01:03:00   📷 ⛶ 1× 🔍Fit │  ← transport bar
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
  rate?: number;                          // e.g. 1 — omit → rate control hidden
  onRateChange?: (rate: number) => void;
  zoom?: 'fit' | number;                  // 'fit' or a percentage — omit → zoom control hidden
  onZoomChange?: (zoom: 'fit' | number) => void;

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
  clearly has a rate/zoom concept even if it hasn't wired the setter yet.
- `onStep`, `onPlayPause`, `frame`, `total`, `playing` are not optional — the
  ±1 step buttons and play/pause are always shown; there is no "not a
  playable surface" tab in the current design.

Icons (all `lucide-react`): skip-to-start/end use `SkipBack`/`SkipForward`;
the ±1 step buttons use the distinct `StepBack`/`StepForward` so the two
concepts never look the same control. Nav uses `ChevronLeft`/`ChevronRight`.
Snapshot `Camera`, fullscreen `Maximize`, zoom `Search`.

Nothing throws when `total`/`fps` are `0` — `fmtTimecode` (also exported,
single source of truth, `@chroma/editor` imports it from here) falls back to
a bare frame counter when `fps` is missing or non-positive, and the scrub
slider clamps its range and disables itself when `total <= 0`.

## Example call site

```tsx
import { Player } from '@chroma/player';

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

The Editor tab (`@chroma/editor`'s `PreviewPane.tsx`) is the real consumer —
read it for how the frame-fetch + rAF play-loop logic stays in the caller
while only the rendered transport JSX moves to `<Player>`.

## What's NOT here

- No `@tauri-apps/api` invoke calls, no zustand store, no knowledge of what a
  "timeline" or "frame source" is.
- No craft-specific controls (color scopes, mask overlay toggles, LUT
  preview) — those stay in the Colorist tab's own chrome around `surface`.
- Colorist and Motion have not adopted this component yet (follow-on items on
  `docs/04-roadmap.md`'s "Next" queue) — only `@chroma/editor` uses it today.

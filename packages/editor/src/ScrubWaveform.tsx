/**
 * @apelles/editor — the viewer's audio waveform strip (D-232, roadmap item 27:
 * "Audio scrubbing + waveform toggle", ref `scratch/resolve-reference/scrubbing.jpg`).
 *
 * What it is: the *waveform toggle* half of D-232 — a thin, full-width strip
 * drawn between the picture and the transport's position bar, showing the audio
 * around the playhead with a line through it at the playhead's own position.
 * That placement, and the line, are read straight off the reference image: in
 * it, the audio strip sits immediately under the picture and immediately above
 * the position bar, spanning the full viewer width, with a coloured playhead
 * line through the waveform and a visibly brighter region inside a dimmer
 * surround.
 *
 * What it shows, and why that is not literally the reference (D-232 argues
 * this): a **fixed 4-second window centred on the playhead**, not a
 * full-duration overview. A whole real edit drawn across ~900 px is about one
 * pixel per second, which shows nothing you could scrub *to*; four seconds is
 * ~225 px/s, fine enough to see a word boundary or a transient and put the
 * playhead on it. The brighter region is the current clip's own trimmed extent
 * — material outside it is drawn dim because it is not on the timeline here,
 * which is exactly what the reference's inner highlight conveys.
 *
 * What it does NOT do: it is not a second waveform pipeline. Peaks come from
 * `Waveform.tsx`'s own `getPeaks` → `chroma_audio_waveform`, through the same
 * frontend cache and the same D-128 Rust cache the timeline's per-clip
 * waveforms use, and it fetches in snapped TILES (`waveformTileFor`) precisely
 * so a moving playhead does not miss that cache on every frame — see that
 * function's doc. It draws one source, the one `scrubSourceAt` resolves, which
 * is the same source the scrub engine is monitoring; the two cannot disagree
 * because they call the same resolver.
 *
 * Fixed height, deliberately: this is a readout strip in a transport bar, not a
 * content pane, so the resizable-panes rule (CLAUDE.md) does not apply to it —
 * there is nothing more of it to show.
 *
 * **It says WHY it is empty (B-120).** The owner opened this on a reel of
 * screen recordings that genuinely have no audio stream and reported it as
 * "idk what is this audio waveform but it seems broken" — and they were right
 * to: a flat centre line is what this drew for "silent here", for "still
 * fetching", and for "nothing resolved at all", so the one state a user needs
 * to be able to tell apart from a bug looked exactly like one. The line stays
 * (it is the honest picture of silence); a short label now says which of the
 * three it is, and no label at all means peaks are still in flight.
 */

import { useEffect, useRef, useState } from 'react';

import { getPeaks, type Peak } from './Waveform';
import { scrubSourceAt, waveformTileFor, waveformWindowAt } from './scrubSource';
import { timelineFps } from './timeline';
import { useEditorTimelineStore } from './timelineStore';

/** Strip height in CSS px. Tall enough for a peak envelope to be readable at a
 *  glance, short enough not to eat the picture. */
const STRIP_HEIGHT = 44;

/** How opaque the waveform is inside / outside the current clip's own extent.
 *  The contrast is the reference image's inner-highlight, and the dim value is
 *  deliberately still visible: "there is material here, it is just not on your
 *  timeline" is more useful than an empty gap. */
const IN_CLIP_ALPHA = 0.8;
const OUT_OF_CLIP_ALPHA = 0.22;

export function ScrubWaveform() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const playhead = useEditorTimelineStore((s) => s.playhead);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [peaks, setPeaks] = useState<Peak[] | null>(null);

  const fps = timelineFps(timeline);
  const source = scrubSourceAt(timeline, playhead);
  const tile = source ? waveformTileFor(source.sourceSecs) : null;
  const window_ = source ? waveformWindowAt(source, fps) : null;

  // Why the strip is empty, in the user's words — or `null` while peaks are
  // still in flight, which must NOT claim silence (B-120). `peaks` is `null`
  // until a fetch resolves and `[]` when the backend really had nothing:
  // `waveform_peaks` returns an empty envelope for a source whose
  // `VideoInfo::has_audio` is false, which is exactly the "this screen
  // recording was captured without sound" case.
  const emptyReason: string | null = !source
    ? 'No audio at the playhead'
    : peaks === null
      ? null
      : peaks.length === 0
        ? 'This clip has no audio'
        : null;

  // The strip is full-bleed in a flexible transport bar, so its pixel width is
  // whatever the window/panel layout leaves it — measured, not assumed. A
  // `ResizeObserver` rather than a one-shot read because the Inspector opening,
  // the Sources panel toggling and a real window resize all change it without
  // anything here re-rendering.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fetch the tile's peaks. Keyed on the TILE, not the window: the identity of
  // these three values changes at most once per `WAVEFORM_TILE_SECS` of source
  // traversed, so an ordinary drag re-fetches nothing at all.
  const tilePath = source?.path ?? null;
  const tileStart = tile?.startSecs ?? 0;
  const tileDuration = tile?.durationSecs ?? 0;
  const tileBuckets = tile?.buckets ?? 0;
  useEffect(() => {
    let cancelled = false;
    if (!tilePath || tileDuration <= 0 || tileBuckets <= 0) {
      setPeaks(null);
      return;
    }
    getPeaks(tilePath, tileStart, tileDuration, tileBuckets).then((p) => {
      if (!cancelled) setPeaks(p);
    });
    return () => {
      cancelled = true;
    };
  }, [tilePath, tileStart, tileDuration, tileBuckets]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(STRIP_HEIGHT * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, STRIP_HEIGHT);

    // Theme-consistent colours with no magic literals and no second token
    // source: the waveform inherits `--color-text-primary` through the canvas
    // element's own `color` (the same trick `Waveform.tsx` uses, so the two
    // waveform surfaces in this tab are visibly the same thing), and the
    // playhead line reads `--color-accent` off the same computed style — the
    // token the timeline's own insertion line already uses.
    const style = getComputedStyle(canvas);
    const waveColor = style.color || '#fff';
    const accent = style.getPropertyValue('--color-accent').trim() || waveColor;

    const mid = STRIP_HEIGHT / 2;

    if (peaks && peaks.length > 0 && window_ && tile) {
      // Map each on-screen column to a source second, then to a peak bucket in
      // the fetched tile. Doing it column-wise (rather than bucket-wise like
      // `Waveform.tsx`) is what lets the drawn window slide continuously over
      // a tile that does not move.
      for (let x = 0; x < Math.round(width); x++) {
        const secs = window_.startSecs + ((x + 0.5) / width) * window_.durationSecs;
        const i = Math.floor(((secs - tile.startSecs) / tile.durationSecs) * peaks.length);
        if (i < 0 || i >= peaks.length) continue;
        const fraction = (secs - window_.startSecs) / window_.durationSecs;
        const inClip = fraction >= window_.clipStartFraction && fraction < window_.clipEndFraction;
        ctx.fillStyle = waveColor;
        ctx.globalAlpha = inClip ? IN_CLIP_ALPHA : OUT_OF_CLIP_ALPHA;
        const [lo, hi] = peaks[i];
        const y1 = mid - hi * mid;
        const y2 = mid - lo * mid;
        ctx.fillRect(x, Math.min(y1, y2), 1, Math.max(Math.abs(y2 - y1), 1));
      }
    } else {
      // Nothing audible under the playhead — a gap, a title, a silent source.
      // A flat centre line says "there is no audio here", which is a real
      // answer; an empty strip would read as "still loading".
      ctx.fillStyle = waveColor;
      ctx.globalAlpha = OUT_OF_CLIP_ALPHA;
      ctx.fillRect(0, mid - 0.5, width, 1);
    }

    // The playhead. Dead centre except at the very head of a source, where the
    // window is clamped forward and the LINE moves instead (see
    // `waveformWindowAt`).
    ctx.globalAlpha = 1;
    ctx.fillStyle = accent;
    const px = Math.round((window_?.playheadFraction ?? 0.5) * width);
    ctx.fillRect(Math.min(px, Math.max(0, Math.round(width) - 2)), 0, 2, STRIP_HEIGHT);
  }, [peaks, width, window_, tile]);

  return (
    <div
      ref={wrapRef}
      data-scrub-waveform
      className="relative w-full overflow-hidden bg-bg-primary"
      style={{ height: STRIP_HEIGHT }}
    >
      <canvas
        ref={canvasRef}
        className="text-text-primary"
        style={{ width: '100%', height: STRIP_HEIGHT, display: 'block' }}
      />
      {emptyReason && (
        <span
          data-scrub-waveform-empty=""
          className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] uppercase tracking-wide text-text-secondary"
        >
          {emptyReason}
        </span>
      )}
    </div>
  );
}

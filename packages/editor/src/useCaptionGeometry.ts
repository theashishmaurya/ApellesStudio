/**
 * @apelles/editor — the measured caption box (D-316).
 *
 * **What it is.** A thin hook over `chroma_measure_caption_bounds` (Rust,
 * `chroma::caption_render`), which reports where a caption's rendered box
 * actually lands, in composition-fraction space.
 *
 * **Why a backend round trip rather than TypeScript arithmetic.** The box
 * depends on the measured advance width of every line and on the font's own
 * line-box height — glyph measurements, from a font file, at a resolved pixel
 * size. `caption.ts` already mirrors every *font-independent* number
 * (`captionLayout`) and deliberately stops exactly there, for the reason its own
 * header gives: the two engines must not disagree about a measurement, so only
 * the side that owns the font makes one. Same split `captionMetrics.ts` (D-243)
 * uses to feed the export compiler — "the caller supplies what only it can
 * know" (D-197).
 *
 * **The command is a PURE measurement, and that is load-bearing.** It takes the
 * cue's text, its fully-resolved style and the composition size — NOT a
 * `track`/`clip` pair to look up. Passing indices was the first design and was
 * wrong, found live: the Rust side's timeline is only as current as the
 * frontend's own debounced save (~400 ms, `timelineStore`'s `savedVersion` —
 * the whole story of B-088), so the box got measured against the style as it was
 * a moment ago. Dragging a caption moved the text and left the box behind: the
 * exact defect this overlay exists to fix, through a different door. The
 * frontend already has the style it is rendering; it asks only for the part it
 * cannot compute.
 *
 * **What it does NOT do:** no layout of its own, no caching beyond React state,
 * no write path. `null` means "nothing to draw a box around yet" — unresolved,
 * an empty cue (which really does draw nothing), or a failed measurement — the
 * same `null`-is-not-an-error contract `useClipGeometry`'s own doc states.
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import type { CaptionStyle } from './caption';
import type { FractionBox } from './transformGeometry';
import type { CompositionSize } from './useCompositionSize';

/** Mirrors `chroma::caption_render::CaptionBoundsFraction`
 *  (`#[serde(rename_all = "camelCase")]`) — already exactly the `FractionBox`
 *  every overlay on this surface works in, so it needs no conversion. */
export type CaptionGeometry = FractionBox;

/** One caption to measure. The whole request IS the invalidation identity —
 *  see [`captionGeometryKey`]. */
export interface CaptionMeasureRequest {
  text: string;
  /** The RESOLVED style (`resolveCaptionStyle`) — the per-cue-override →
   *  track-style → defaults chain already collapsed, so this is exactly what
   *  the renderer drew with. */
  style: Required<CaptionStyle>;
  size: CompositionSize | null;
}

/**
 * The refetch/cache identity for one measurement: **everything the box depends
 * on, and nothing else.**
 *
 * The box moves when the text changes (different advances, maybe a different
 * line count), when any style field that positions or sizes anything changes,
 * and when the composition is resized. It does NOT move when the clip is
 * trimmed or slid along the timeline — so those are deliberately absent, or a
 * drag on the timeline would re-measure on every frame.
 *
 * `id` distinguishes two cues that happen to have identical text and style
 * (common in a subtitle track), so a map keyed on this can hold both.
 */
export function captionGeometryKey(id: string, req: CaptionMeasureRequest): string {
  return JSON.stringify([
    id,
    req.text,
    req.style,
    req.size ? [req.size.width, req.size.height] : null,
  ]);
}

/** The one `invoke`, in one place, for both hooks below. Resolves to `null`
 *  for a cue that draws nothing and for a failed measurement alike — the
 *  caller draws no box either way. */
async function measure(req: CaptionMeasureRequest): Promise<CaptionGeometry | null> {
  if (!req.size || req.size.width <= 0 || req.size.height <= 0) return null;
  try {
    return (
      (await invoke<CaptionGeometry | null>('chroma_measure_caption_bounds', {
        text: req.text,
        style: req.style,
        compWidth: req.size.width,
        compHeight: req.size.height,
      })) ?? null
    );
  } catch {
    return null;
  }
}

/**
 * The measured box for ONE caption, or `null`.
 *
 * `req` may be rebuilt on every render (the natural thing when it is derived
 * from the store) — the effect is keyed on [`captionGeometryKey`], not on the
 * object's identity, so nothing refetches until the measurement really changes.
 */
export function useCaptionGeometry(id: string | null, req: CaptionMeasureRequest): CaptionGeometry | null {
  const [geometry, setGeometry] = useState<CaptionGeometry | null>(null);
  const dep = id === null ? null : captionGeometryKey(id, req);

  useEffect(() => {
    if (dep === null) {
      setGeometry(null);
      return;
    }
    let cancelled = false;
    // Parsed back out of the dependency rather than closed over, so the
    // dependency array stays honest — no `exhaustive-deps` suppression, which
    // would switch the React Compiler off for this whole file (D-201). Cast,
    // not `any`: this string was produced by `captionGeometryKey` above.
    const [, text, style, size] = JSON.parse(dep) as [
      string,
      string,
      Required<CaptionStyle>,
      [number, number] | null,
    ];
    void measure({ text, style, size: size ? { width: size[0], height: size[1] } : null }).then((g) => {
      if (!cancelled) setGeometry(g);
    });
    return () => {
      cancelled = true;
    };
  }, [dep]);

  return geometry;
}

const EMPTY: ReadonlyMap<string, CaptionGeometry> = new Map();

/**
 * [`useCaptionGeometry`] for every caption visible at the playhead at once —
 * what canvas click-to-select hit-tests against (`useCanvasClipPick.ts`).
 *
 * Returns a map from each request's [`captionGeometryKey`] to its box. Same
 * refetch policy as the singular hook and as `useClipGeometries`: keyed on the
 * SERIALIZED request list, so a caller rebuilding the array every render
 * refetches nothing until the set of cues (or one of their measurements)
 * actually changes.
 */
export function useCaptionGeometries(
  requests: ReadonlyArray<{ id: string; req: CaptionMeasureRequest }>,
): ReadonlyMap<string, CaptionGeometry> {
  const [geometries, setGeometries] = useState<ReadonlyMap<string, CaptionGeometry>>(EMPTY);

  const dep = JSON.stringify(requests.map((r) => captionGeometryKey(r.id, r.req)));

  useEffect(() => {
    const keys = JSON.parse(dep) as string[];
    if (keys.length === 0) {
      setGeometries(EMPTY);
      return;
    }
    let cancelled = false;
    void Promise.all(
      keys.map(async (key): Promise<[string, CaptionGeometry] | null> => {
        const [, text, style, size] = JSON.parse(key) as [
          string,
          string,
          Required<CaptionStyle>,
          [number, number] | null,
        ];
        const g = await measure({
          text,
          style,
          size: size ? { width: size[0], height: size[1] } : null,
        });
        return g ? [key, g] : null;
      }),
    ).then((results) => {
      if (cancelled) return;
      setGeometries(new Map(results.filter((r): r is [string, CaptionGeometry] => r !== null)));
    });
    return () => {
      cancelled = true;
    };
  }, [dep]);

  return geometries;
}

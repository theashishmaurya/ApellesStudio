/**
 * @apelles/editor — platform safe-area presets (D-431).
 *
 * What it is: the ONE data source for "where may a title / caption / key visual
 * sit without a platform's UI covering it". Pure data + arithmetic; no React,
 * no store, no IPC. The preview overlay (`SafeAreaOverlay.tsx`), the Safe Area
 * menu (`SafeAreaMenu.tsx`) and the MCP ops (`editor_get_safe_areas`,
 * `editor_set_safe_area_view`) all read from here, so a human and an agent are
 * shown the same rectangles.
 *
 * What it does NOT do: it never touches an export (a safe area is a view aid,
 * not part of the picture), and it is not a layout engine — it reports
 * rectangles, nothing moves into them for you.
 *
 * **Where the numbers come from.** None of the three platforms publishes an
 * organic-post safe zone; they publish ad templates. The per-platform insets
 * are therefore the ad-guidance figures from upload-post.com's Safe Zone
 * Checker (checked 2026-09-23), measured on a 1080x1920 frame and stored here
 * as FRACTIONS so they hold at any 9:16 resolution. The independent
 * adaptlypost.com guide (2026, reverse-engineered from the live apps) gives
 * roughly half those values (e.g. Shorts bottom 300 px, not 672 px); where the
 * two disagree we ship the larger, because a title that clears the stricter
 * figure clears both. The union preset is the per-side maximum, so it is safe on
 * every platform at once. Broadcast title/action safe are the classic 80% / 90%
 * of the frame (what Premiere's Safe Margins, Final Cut's Title/Action Safe and
 * Resolve's View > Safe Area draw; SMPTE ST 2046-1's newer 90% / 93% is
 * deliberately not used — editors' tools still ship 80/90). Sources and the
 * comparison with other tools: `docs/08-decisions.md` D-431.
 */

/** A rectangle inset from each edge of the frame, as a fraction of that axis
 *  (left/right of the width, top/bottom of the height). */
export interface SafeInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** One drawn rectangle of a preset. A platform preset has one ("safe"); the
 *  broadcast preset has two nested ones (action outside, title inside). */
export interface SafeAreaRegion {
  id: string;
  label: string;
  insets: SafeInsets;
}

export type SafeAreaPresetId =
  | 'broadcast'
  | 'youtube-shorts'
  | 'instagram-reels'
  | 'tiktok'
  | 'vertical-union';

export type SafeAreaOrientation = 'horizontal' | 'vertical';

export interface SafeAreaPreset {
  id: SafeAreaPresetId;
  label: string;
  /** The frame shape the preset was measured for. */
  orientation: SafeAreaOrientation;
  regions: SafeAreaRegion[];
  /** Where the numbers come from, with the date they were checked. */
  source: string;
}

/** `'off'` is a view state, not a preset: it has no rectangles. */
export type SafeAreaViewId = 'off' | SafeAreaPresetId;

/** The reference frame the platform pixel figures were measured on. */
export const SAFE_AREA_REFERENCE_WIDTH = 1080;
export const SAFE_AREA_REFERENCE_HEIGHT = 1920;

/** Reference-frame pixels -> insets. Left/right are fractions of the width,
 *  top/bottom of the height, so the same preset holds at 720x1280 or 2160x3840. */
function fromReferencePixels(top: number, bottom: number, left: number, right: number): SafeInsets {
  return {
    top: top / SAFE_AREA_REFERENCE_HEIGHT,
    bottom: bottom / SAFE_AREA_REFERENCE_HEIGHT,
    left: left / SAFE_AREA_REFERENCE_WIDTH,
    right: right / SAFE_AREA_REFERENCE_WIDTH,
  };
}

const UPLOAD_POST_SOURCE =
  'upload-post.com Safe Zone Checker, from each platform\'s ad guidance, checked 2026-09-23 (1080x1920 px)';

const TIKTOK = fromReferencePixels(240, 660, 120, 120);
const REELS = fromReferencePixels(269, 672, 65, 65);
const SHORTS = fromReferencePixels(288, 672, 48, 192);

/** Per-side maximum of the platform insets: a rectangle safe on all three. */
function unionOf(all: SafeInsets[]): SafeInsets {
  return {
    top: Math.max(...all.map((i) => i.top)),
    bottom: Math.max(...all.map((i) => i.bottom)),
    left: Math.max(...all.map((i) => i.left)),
    right: Math.max(...all.map((i) => i.right)),
  };
}

export const SAFE_AREA_PRESETS: readonly SafeAreaPreset[] = [
  {
    id: 'broadcast',
    label: 'Title + Action safe',
    orientation: 'horizontal',
    regions: [
      { id: 'action', label: 'Action safe 90%', insets: { top: 0.05, bottom: 0.05, left: 0.05, right: 0.05 } },
      { id: 'title', label: 'Title safe 80%', insets: { top: 0.1, bottom: 0.1, left: 0.1, right: 0.1 } },
    ],
    source: 'Classic broadcast convention: action 90%, title 80% (Premiere Safe Margins, Final Cut Title/Action Safe, Resolve View > Safe Area), checked 2026-10-30',
  },
  {
    id: 'youtube-shorts',
    label: 'YouTube Shorts',
    orientation: 'vertical',
    regions: [{ id: 'safe', label: 'Shorts safe', insets: SHORTS }],
    source: UPLOAD_POST_SOURCE,
  },
  {
    id: 'instagram-reels',
    label: 'Instagram Reels',
    orientation: 'vertical',
    regions: [{ id: 'safe', label: 'Reels safe', insets: REELS }],
    source: UPLOAD_POST_SOURCE,
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    orientation: 'vertical',
    regions: [{ id: 'safe', label: 'TikTok safe', insets: TIKTOK }],
    source: UPLOAD_POST_SOURCE,
  },
  {
    id: 'vertical-union',
    label: 'All vertical platforms',
    orientation: 'vertical',
    regions: [{ id: 'safe', label: 'Safe on every platform', insets: unionOf([SHORTS, REELS, TIKTOK]) }],
    source: `Per-side maximum of YouTube Shorts, Instagram Reels and TikTok; ${UPLOAD_POST_SOURCE}`,
  },
];

/** The preset ids in menu order, for validation. */
export const SAFE_AREA_VIEW_IDS: readonly SafeAreaViewId[] = ['off', ...SAFE_AREA_PRESETS.map((p) => p.id)];

export function isSafeAreaViewId(value: unknown): value is SafeAreaViewId {
  return typeof value === 'string' && (SAFE_AREA_VIEW_IDS as readonly string[]).includes(value);
}

export function safeAreaPreset(id: SafeAreaPresetId): SafeAreaPreset {
  const preset = SAFE_AREA_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`unknown safe-area preset ${id}`);
  return preset;
}

/** A region resolved against a concrete frame, in whole frame pixels. */
export interface SafeAreaRect {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Pixels cut from each edge, so a caller can also read the margins. */
  insets: { top: number; bottom: number; left: number; right: number };
}

/** Resolve insets to a pixel rectangle on a `width` x `height` frame. Insets
 *  are rounded to whole pixels; the rectangle never has a negative size. */
export function insetsToRect(
  region: SafeAreaRegion,
  width: number,
  height: number,
): SafeAreaRect {
  const left = Math.round(region.insets.left * width);
  const right = Math.round(region.insets.right * width);
  const top = Math.round(region.insets.top * height);
  const bottom = Math.round(region.insets.bottom * height);
  return {
    id: region.id,
    label: region.label,
    x: left,
    y: top,
    width: Math.max(0, width - left - right),
    height: Math.max(0, height - top - bottom),
    insets: { top, bottom, left, right },
  };
}

export function presetRects(preset: SafeAreaPreset, width: number, height: number): SafeAreaRect[] {
  return preset.regions.map((r) => insetsToRect(r, width, height));
}

/** The presets that fit a frame's shape, best first. A portrait frame is
 *  offered the vertical platform presets; anything else the broadcast one. */
export function suggestedPresets(width: number, height: number): SafeAreaPresetId[] {
  const orientation: SafeAreaOrientation = height > width ? 'vertical' : 'horizontal';
  const fitting = SAFE_AREA_PRESETS.filter((p) => p.orientation === orientation).map((p) => p.id);
  // The union is the one a short should be checked against first.
  return [...fitting.filter((id) => id === 'vertical-union'), ...fitting.filter((id) => id !== 'vertical-union')];
}

/** `true` for a portrait frame (the 9:16 short-form case). */
export function isVerticalFrame(width: number, height: number): boolean {
  return height > width;
}

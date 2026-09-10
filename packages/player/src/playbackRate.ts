/**
 * @apelles/player — the transport's PLAYBACK-RATE model (D-278).
 *
 * What it is: the bounds, the presets and the formatting behind `<Player>`'s
 * rate control — "review this at 3x, with audio", the thing an editor reaches
 * for to skim a long take.
 *
 * **What it is NOT, and this is why the file has a doc:** a clip's Speed/Retime
 * property (D-236). That one lives on the `Clip`, is persisted, is undoable,
 * changes the clip's real duration on the timeline and is baked into every
 * export. This changes how fast you WATCH and nothing else — an export taken
 * while the preview is at 4x renders exactly what an export at 1x renders. It
 * is transport state, in the same family as the playhead.
 *
 * Here rather than in `@apelles/editor` because the rate is a property of the
 * TRANSPORT, which is this package: `Player` itself formats the readout and
 * lists the presets, so the model has to be reachable from here, and a second
 * copy in the tab would be exactly the drift CLAUDE.md's "extract it" rule
 * exists to prevent. The Edit tab imports these same values for its store's
 * clamp and its MCP surface.
 *
 * Pure — no React, no store, no IPC.
 */

/**
 * The slowest and fastest rates the transport accepts.
 *
 * The same pair `app/src-tauri/src/chroma/audio.rs` clamps to
 * (`PLAYBACK_RATE_MIN`/`PLAYBACK_RATE_MAX`) — a boundary is checked at the
 * boundary, on both sides, the way monitoring volume's `0..1` already is. `8`
 * is the top of Final Cut Pro's own J/K/L shuttle ladder (1x → 2x → 4x → 8x);
 * below `0.25` the audio time-stretch is repeating each segment four times over
 * and the artefacts stop being worth the slow-down.
 */
export const MIN_PLAYBACK_RATE = 0.25;
export const MAX_PLAYBACK_RATE = 8;

/** Ordinary playback. What the transport starts at and returns to. */
export const DEFAULT_PLAYBACK_RATE = 1;

/** The custom field's notch — also its display precision and its scrub
 *  sensitivity. A quarter is the smallest step the bounds are expressed in. */
export const PLAYBACK_RATE_STEP = 0.25;

/**
 * The one-click presets, in the order the control lists them.
 *
 * `2 / 3 / 4` are the owner's own ask (roadmap, 2026-09-10). `0.5` rides along
 * because a rate control with no slow side is half a control and the engine
 * handles it identically; `1` is how you get back.
 *
 * Deliberately NOT the reference NLEs' doubling ladder (Resolve and Final Cut
 * both shuttle 1 → 2 → 4 → 8 on repeated `L`). That ladder belongs to a
 * *keyboard* shuttle, where each press multiplies what you already have; this
 * is a menu you pick from, which is the media-player idiom (QuickTime, VLC,
 * YouTube), and in a menu 3x is genuinely useful and genuinely absent from a
 * power-of-two list. Anything not here is one custom entry away. See D-278.
 */
export const PLAYBACK_RATE_PRESETS = [0.5, 1, 2, 3, 4] as const;

/**
 * Bring any value into range. A non-finite or non-positive input reads as
 * ordinary playback rather than as an error — the transport must keep working,
 * and whoever sent nonsense wanted to play something. Matches
 * `clamp_playback_rate`'s Rust contract exactly.
 */
export function clampPlaybackRate(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return DEFAULT_PLAYBACK_RATE;
  return Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, rate));
}

/** Whether this rate is ordinary playback — i.e. whether the control should
 *  read as "off". Tolerant of the float noise a custom entry can leave. */
export function isDefaultPlaybackRate(rate: number): boolean {
  return Math.abs(rate - DEFAULT_PLAYBACK_RATE) < 1e-6;
}

/**
 * The rate as the transport shows it: `1×`, `2×`, `1.5×`, `0.25×`.
 *
 * Trailing zeros are dropped (`2`, never `2.00`) because the whole-number case
 * is the common one, and a fixed decimal makes a readout that never changes
 * width but always looks like a measurement. Two decimals is the floor the
 * bounds actually need (`0.25`).
 */
export function formatPlaybackRate(rate: number): string {
  return `${Math.round(rate * 100) / 100}×`;
}

/**
 * @apelles/editor — export loudness target: the preset table, the wire shape
 * and the validator (D-401, roadmap 0c).
 *
 * What it is: the ONE place "youtube / broadcast / podcast / off / custom"
 * becomes numbers. `compileEditorExportArgs` calls [`resolveLoudnessTarget`]
 * for both callers (the MCP `editor_export` op and the Export dialog); the
 * measuring and the correction themselves are Rust
 * (`crates/apelles-media/src/loudness.rs`, which takes only numbers).
 *
 * What it does NOT do: measure or touch audio. `off` is the default and means
 * the export is not post-processed at all — the file is byte-identical to what
 * it was before this option existed.
 */

/** A loudness delivery spec: integrated loudness and the true-peak ceiling. */
export interface LoudnessTarget {
  integratedLufs: number;
  truePeakDbtp: number;
}

export type LoudnessPresetName = 'youtube' | 'broadcast' | 'podcast';
export type LoudnessPreset = LoudnessPresetName | 'off';

/** Platform specs. youtube: YouTube's -14 LUFS reference with a -1 dBTP
 *  ceiling; broadcast: EBU R128 (-23 LUFS); podcast: -16 LUFS (Apple/Spotify
 *  podcast guidance). All with a -1 dBTP ceiling, which leaves headroom for the
 *  platform's own lossy re-encode. */
export const LOUDNESS_PRESETS: Record<LoudnessPresetName, LoudnessTarget> = {
  youtube: { integratedLufs: -14, truePeakDbtp: -1 },
  broadcast: { integratedLufs: -23, truePeakDbtp: -1 },
  podcast: { integratedLufs: -16, truePeakDbtp: -1 },
};

/** Ceiling used when a custom target gives only a loudness. */
export const DEFAULT_TRUE_PEAK_DBTP = -1;

// Mirror `loudness.rs`'s accepted ranges so a bad value is refused at compile
// time with a message, not after a 15-minute render.
export const MIN_TARGET_LUFS = -40;
export const MAX_TARGET_LUFS = -5;
export const MIN_CEILING_DBTP = -9;
export const MAX_CEILING_DBTP = 0;

/** What the Rust side reports back (`LoudnessReport`, camelCase). */
export interface LoudnessMeasurement {
  integratedLufs: number;
  truePeakDbtp: number;
  loudnessRangeLu: number;
}
export interface LoudnessReport {
  target: LoudnessTarget;
  before: LoudnessMeasurement | null;
  after: LoudnessMeasurement | null;
  gainDb: number;
  attempts: number;
  targetMet: boolean;
  skipped?: string;
}

export interface LoudnessArgs {
  loudnessPreset?: unknown;
  loudnessLufs?: unknown;
  truePeakDbtp?: unknown;
}

/**
 * Resolve the loudness fields of an export request.
 * `{ ok: true, target: null }` means off. A custom value is given by
 * `loudnessLufs` (with optional `truePeakDbtp`), with no preset or the preset
 * omitted; a preset together with explicit numbers is refused as ambiguous.
 */
export function resolveLoudnessTarget(
  a: LoudnessArgs,
): { ok: true; target: LoudnessTarget | null } | { ok: false; error: string } {
  const { loudnessPreset: preset, loudnessLufs: lufs, truePeakDbtp: tp } = a;
  const hasNumbers = lufs !== undefined || tp !== undefined;
  if (preset !== undefined && preset !== 'off' && !(typeof preset === 'string' && preset in LOUDNESS_PRESETS)) {
    return { ok: false, error: 'loudnessPreset must be "youtube", "broadcast", "podcast" or "off"' };
  }
  if (preset === 'off') {
    return hasNumbers
      ? { ok: false, error: 'loudnessPreset "off" cannot be combined with loudnessLufs / truePeakDbtp' }
      : { ok: true, target: null };
  }
  if (preset !== undefined) {
    if (hasNumbers) {
      return {
        ok: false,
        error: 'give either a loudnessPreset or custom loudnessLufs / truePeakDbtp, not both',
      };
    }
    return { ok: true, target: { ...LOUDNESS_PRESETS[preset as LoudnessPresetName] } };
  }
  if (!hasNumbers) return { ok: true, target: null };
  if (lufs === undefined) {
    return { ok: false, error: 'truePeakDbtp needs loudnessLufs (or pick a loudnessPreset)' };
  }
  const integratedLufs = Number(lufs);
  const truePeakDbtp = tp === undefined ? DEFAULT_TRUE_PEAK_DBTP : Number(tp);
  if (!Number.isFinite(integratedLufs) || integratedLufs < MIN_TARGET_LUFS || integratedLufs > MAX_TARGET_LUFS) {
    return { ok: false, error: `loudnessLufs must be between ${MIN_TARGET_LUFS} and ${MAX_TARGET_LUFS}` };
  }
  if (!Number.isFinite(truePeakDbtp) || truePeakDbtp < MIN_CEILING_DBTP || truePeakDbtp > MAX_CEILING_DBTP) {
    return { ok: false, error: `truePeakDbtp must be between ${MIN_CEILING_DBTP} and ${MAX_CEILING_DBTP}` };
  }
  return { ok: true, target: { integratedLufs, truePeakDbtp } };
}

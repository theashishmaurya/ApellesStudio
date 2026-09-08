/**
 * @chroma/editor — the per-clip parametric EQ's model and math (D-224), the
 * exact mirror of the Rust `chroma_types::eq` module.
 *
 * **What it is:** the `EqBand` shape stored on `Clip.eq_bands`, the Resolve-
 * shaped four-band strip the Inspector authors, the stored-value clamps, and
 * the Audio EQ Cookbook biquad coefficients + magnitude response — the same
 * five forms, the same `A = 10^(gain/40)`, `w0 = 2π·f0/fs`, `α = sin(w0)/(2Q)`,
 * the same `a0` normalisation.
 *
 * **What it does NOT do:** it never touches a `Timeline` (the reducer in
 * `timeline.ts` does), never builds an ffmpeg argument (`timelineExportAudio
 * .ts` does, from the coefficients here), and never renders (the Inspector
 * does). Pure — no I/O, no Tauri, no React.
 *
 * **Why a mirror and not a call into Rust.** Same reason `panGains` and
 * `fadeGainAt` are mirrored here (D-223/D-197): the export compiler is
 * TypeScript and runs with no app process at all, and its unit tests must be
 * able to compute what it should emit without a Tauri round trip. The two
 * copies are pinned to each other by a shared reference table asserted in BOTH
 * `chroma_types::eq`'s tests and `timelineExport.ffmpeg.test.ts` — measured,
 * in each engine, rather than eyeballed for sameness.
 *
 * **The one thing this file's numbers do that the others' do not:** they are
 * shipped to ffmpeg AS numbers. `timelineExportAudio.ts` compiles each band to
 * ffmpeg's generic `biquad` filter with the coefficients from `eqBandCoeffs`,
 * rather than to ffmpeg's own `equalizer`/`bass`/`treble` — because those
 * shelves measurably do NOT implement the cookbook's Q parameterisation (see
 * `chroma_types::eq`'s module doc for the identified numbers). So a drift
 * between this file and the Rust would be a real preview-vs-render divergence,
 * which is exactly what the shared table is there to catch.
 */

/** What one band does to the spectrum. The stored spelling is snake_case, so
 *  it round-trips through `chroma_types::EqBandKind`'s own serde untouched. */
export type EqBandKind = 'low_shelf' | 'peak' | 'high_shelf' | 'high_pass' | 'low_pass';

/** Every kind, in the order the Inspector's shape dropdown lists them —
 *  Resolve's own band-1-to-band-4 default reading (low shelf, bell, bell, high
 *  shelf) with the two pass filters after, since those are a different KIND of
 *  move (remove a range) rather than a different amount of the same one. */
export const EQ_BAND_KINDS: readonly EqBandKind[] = [
  'low_shelf',
  'peak',
  'high_shelf',
  'high_pass',
  'low_pass',
];

/** The label the Inspector shows for each kind. Not derived from the stored
 *  string: "Low Shelf" is the term the reference NLE uses, and a mechanical
 *  un-snake_case would give "Low shelf" / "High pass". */
export const EQ_BAND_KIND_LABELS: Readonly<Record<EqBandKind, string>> = {
  low_shelf: 'Low Shelf',
  peak: 'Bell',
  high_shelf: 'High Shelf',
  high_pass: 'High Pass',
  low_pass: 'Low Pass',
};

/** Does this kind use `gain_db`? `false` for the two pass filters, whose depth
 *  is Q and whose slope is fixed. Mirrors `EqBandKind::uses_gain` — and is what
 *  makes a gain-using band at exactly 0 dB an inactive band while a high-pass
 *  at "0 dB" is still a real filter. */
export function eqKindUsesGain(kind: EqBandKind): boolean {
  return kind === 'low_shelf' || kind === 'peak' || kind === 'high_shelf';
}

/** One band of a clip's EQ — mirrors `chroma_types::EqBand` field for field,
 *  including the stored key names (this is what lands in `project.json`). */
export interface EqBand {
  kind: EqBandKind;
  /** Centre frequency (bell) or corner frequency (shelf/pass), Hz. */
  freq_hz: number;
  /** Boost/cut in dB. Ignored by the two pass kinds. */
  gain_db: number;
  /** The cookbook's Q. Higher is narrower. */
  q: number;
  /** Per-band bypass — Resolve's own per-band enable. */
  enabled: boolean;
}

// --------------------------------------------------------------------------- //
// bounds — mirror `chroma_types::eq`'s own constants exactly
// --------------------------------------------------------------------------- //

export const EQ_MIN_FREQ_HZ = 20;
export const EQ_MAX_FREQ_HZ = 20_000;
export const EQ_MIN_Q = 0.1;
export const EQ_MAX_Q = 20;
/** ±24 dB — Resolve's own Clip Equalizer graph axis
 *  (`scratch/resolve-reference/soundtrack.jpg`). */
export const EQ_MAX_GAIN_DB = 24;
/** Butterworth — maximally flat, and the rest value for every band. */
export const EQ_DEFAULT_Q = Math.SQRT1_2;

/** The rate the EXPORT designs its coefficients at, pinned with an `aresample`
 *  in front of the band chain. Mirrors `chroma_types::EQ_DESIGN_SAMPLE_RATE`
 *  — see that module's doc for why the export has to pin one at all (ffmpeg's
 *  `biquad` takes literal coefficients, so they must be computed for a known
 *  rate) and for what it costs when the live device runs at 44.1 kHz. */
export const EQ_DESIGN_SAMPLE_RATE = 48_000;

// --------------------------------------------------------------------------- //
// the authored strip
// --------------------------------------------------------------------------- //

/** How many bands the Inspector authors — **four**, which is exactly what
 *  Resolve's own Edit-page Clip Equalizer presents (`Band 1`…`Band 4` under
 *  the response graph, `scratch/resolve-reference/soundtrack.jpg`; the
 *  6-band EQ its marketing copy mentions is the Fairlight PAGE's channel EQ,
 *  a different control). Four is an authoring number, not a model limit — the
 *  stored field is a list and every consumer is length-agnostic. */
export const EQ_BAND_COUNT = 4;

/** The band strip a clip gets the first time its EQ is touched — Resolve's own
 *  reading of its four bands in the reference screenshot: low shelf, two bells,
 *  high shelf, spread across the spectrum at the frequencies that strip
 *  actually plots.
 *
 *  **Every band is at 0 dB**, so a materialised-but-untouched strip is
 *  completely inert: `EqBand::is_active` is false for a gain-using kind at
 *  exactly 0 dB, so the mixer builds no filter and the exporter emits no
 *  filtergraph node. Materialising the strip therefore costs a project one
 *  JSON key and the mix nothing at all.
 *
 *  Frozen, and copied (never handed out by reference) by
 *  `defaultEqBands` — a shared mutable array would let one clip's edit rewrite
 *  every other clip's defaults. */
const DEFAULT_EQ_BANDS: readonly EqBand[] = Object.freeze([
  Object.freeze<EqBand>({ kind: 'low_shelf', freq_hz: 120, gain_db: 0, q: EQ_DEFAULT_Q, enabled: true }),
  Object.freeze<EqBand>({ kind: 'peak', freq_hz: 500, gain_db: 0, q: 1, enabled: true }),
  Object.freeze<EqBand>({ kind: 'peak', freq_hz: 2_500, gain_db: 0, q: 1, enabled: true }),
  Object.freeze<EqBand>({ kind: 'high_shelf', freq_hz: 8_000, gain_db: 0, q: EQ_DEFAULT_Q, enabled: true }),
]);

/** A fresh, mutable copy of the default strip — the one way to get one. */
export function defaultEqBands(): EqBand[] {
  return DEFAULT_EQ_BANDS.map((b) => ({ ...b }));
}

/** This clip's bands for DISPLAY: what it stores, or the default strip when it
 *  stores none. Read-only — nothing is written to the clip until a real edit,
 *  so opening the Inspector on a clip never dirties the project. */
export function eqBandsForDisplay(bands: readonly EqBand[] | undefined | null): EqBand[] {
  return bands && bands.length > 0 ? bands.map((b) => ({ ...b })) : defaultEqBands();
}

// --------------------------------------------------------------------------- //
// clamps — mirror `EqBand::sanitised`
// --------------------------------------------------------------------------- //

function clampFinite(v: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(Math.max(v, lo), hi);
}

/** A band forced into its documented ranges — mirrors `EqBand::sanitised`.
 *  Applied by the reducer on the way IN, so the model is well-formed at rest
 *  rather than merely survivable, exactly as `clampClipVolume`/`clampClipPan`
 *  are (D-223). A cleared numeric `<input>`'s `NaN` becomes the field's own
 *  default rather than reaching a filter, where one NaN sample would poison
 *  every sample after it. */
export function clampEqBand(band: EqBand): EqBand {
  return {
    kind: EQ_BAND_KINDS.includes(band.kind) ? band.kind : 'peak',
    freq_hz: clampFinite(band.freq_hz, EQ_MIN_FREQ_HZ, EQ_MAX_FREQ_HZ, 1_000),
    gain_db: clampFinite(band.gain_db, -EQ_MAX_GAIN_DB, EQ_MAX_GAIN_DB, 0),
    q: clampFinite(band.q, EQ_MIN_Q, EQ_MAX_Q, EQ_DEFAULT_Q),
    enabled: band.enabled !== false,
  };
}

/** Does this band change the signal at all? Mirrors `EqBand::is_active`:
 *  `false` for a disabled band and for a gain-using band at exactly 0 dB. */
export function isEqBandActive(band: EqBand): boolean {
  return band.enabled && !(eqKindUsesGain(band.kind) && band.gain_db === 0);
}

/** Does this clip's band set do anything? Mirrors `Clip::has_active_eq`. The
 *  one predicate the exporter and the Inspector both ask, so "is the EQ doing
 *  something" is spelled once. */
export function hasActiveEq(bands: readonly EqBand[] | undefined | null): boolean {
  return !!bands && bands.some(isEqBandActive);
}

// --------------------------------------------------------------------------- //
// the cookbook — mirrors `EqBand::coefficients` / `BiquadCoeffs::response_db`
// --------------------------------------------------------------------------- //

/** One biquad's coefficients, already normalised by `a0` — the same five
 *  numbers ffmpeg's generic `biquad` filter takes, which is exactly what
 *  `timelineExportAudio.ts` does with them. */
export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** Mirrors `EqBand::coefficients`' own Nyquist guard: a corner is pulled to
 *  just under Nyquist rather than refused, so a 20 kHz shelf on a 32 kHz source
 *  becomes the highest shelf that source can represent instead of vanishing. */
const NYQUIST_MARGIN = 0.995;

/**
 * This band's normalised biquad coefficients at `sampleRate`, or `null` when
 * the band does nothing (`isEqBandActive`) or cannot be realised at that rate.
 *
 * The five forms are the Audio EQ Cookbook's, verbatim — an exact mirror of
 * `chroma_types::eq::EqBand::coefficients`, down to the clamping and the
 * Nyquist margin. See that module's doc for the reference and for the measured
 * reason the export sends these numbers to ffmpeg rather than naming one of
 * ffmpeg's own EQ filters.
 */
export function eqBandCoeffs(band: EqBand, sampleRate: number): BiquadCoeffs | null {
  if (!isEqBandActive(band) || !(sampleRate > 0)) return null;
  const b = clampEqBand(band);
  const f0 = Math.min(b.freq_hz, sampleRate * 0.5 * NYQUIST_MARGIN);
  if (!(f0 > 0)) return null;

  const a = Math.pow(10, b.gain_db / 40);
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * b.q);

  let b0: number;
  let b1: number;
  let b2: number;
  let a0: number;
  let a1: number;
  let a2: number;

  switch (b.kind) {
    case 'peak':
      b0 = 1 + alpha * a;
      b1 = -2 * cw;
      b2 = 1 - alpha * a;
      a0 = 1 + alpha / a;
      a1 = -2 * cw;
      a2 = 1 - alpha / a;
      break;
    case 'low_shelf': {
      const shelf = 2 * Math.sqrt(a) * alpha;
      b0 = a * (a + 1 - (a - 1) * cw + shelf);
      b1 = 2 * a * (a - 1 - (a + 1) * cw);
      b2 = a * (a + 1 - (a - 1) * cw - shelf);
      a0 = a + 1 + (a - 1) * cw + shelf;
      a1 = -2 * (a - 1 + (a + 1) * cw);
      a2 = a + 1 + (a - 1) * cw - shelf;
      break;
    }
    case 'high_shelf': {
      const shelf = 2 * Math.sqrt(a) * alpha;
      b0 = a * (a + 1 + (a - 1) * cw + shelf);
      b1 = -2 * a * (a - 1 + (a + 1) * cw);
      b2 = a * (a + 1 + (a - 1) * cw - shelf);
      a0 = a + 1 - (a - 1) * cw + shelf;
      a1 = 2 * (a - 1 - (a + 1) * cw);
      a2 = a + 1 - (a - 1) * cw - shelf;
      break;
    }
    case 'high_pass':
      b0 = (1 + cw) / 2;
      b1 = -(1 + cw);
      b2 = (1 + cw) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cw;
      a2 = 1 - alpha;
      break;
    case 'low_pass':
      b0 = (1 - cw) / 2;
      b1 = 1 - cw;
      b2 = (1 - cw) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cw;
      a2 = 1 - alpha;
      break;
  }

  if (a0 === 0 || !Number.isFinite(a0)) return null;
  const c: BiquadCoeffs = { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  return Object.values(c).every(Number.isFinite) ? c : null;
}

/** One filter's magnitude response at `freqHz`, in dB — `20·log10|H(e^jω)|`,
 *  mirroring `BiquadCoeffs::response_db`. A frequency at or above Nyquist has
 *  no meaning for a discrete filter and reads flat rather than as a wrapped
 *  alias. */
export function biquadResponseDb(c: BiquadCoeffs, freqHz: number, sampleRate: number): number {
  if (!(freqHz > 0) || !(sampleRate > 0) || freqHz >= sampleRate * 0.5) return 0;
  const w = (2 * Math.PI * freqHz) / sampleRate;
  // e^(-jωn) = cos(ωn) - j·sin(ωn)
  const c1 = Math.cos(-w);
  const s1 = Math.sin(-w);
  const c2 = Math.cos(-2 * w);
  const s2 = Math.sin(-2 * w);
  const num = Math.hypot(c.b0 + c.b1 * c1 + c.b2 * c2, c.b1 * s1 + c.b2 * s2);
  const den = Math.hypot(1 + c.a1 * c1 + c.a2 * c2, c.a1 * s1 + c.a2 * s2);
  if (den === 0 || num === 0) return 0;
  return 20 * Math.log10(num / den);
}

/** The whole band set's combined response at `freqHz`, in dB — mirrors
 *  `chroma_types::eq::eq_response_db`. A **sum**, because a cascade multiplies
 *  magnitudes and that is addition in dB; an inactive band contributes exactly
 *  0. This is the function a response-curve renderer would draw from, and the
 *  one the export's own measurement test predicts against. */
export function eqResponseDb(
  bands: readonly EqBand[] | undefined | null,
  freqHz: number,
  sampleRate: number = EQ_DESIGN_SAMPLE_RATE,
): number {
  if (!bands) return 0;
  let total = 0;
  for (const band of bands) {
    const c = eqBandCoeffs(band, sampleRate);
    if (c) total += biquadResponseDb(c, freqHz, sampleRate);
  }
  return total;
}

/** A one-line summary of what a band is doing, for the Inspector's band header
 *  and for the MCP tool's own response — "Bell 950 Hz −6.5 dB Q 1.8".
 *  The gain is omitted for a pass filter, which has none. */
export function describeEqBand(band: EqBand): string {
  const hz = band.freq_hz >= 1_000 ? `${(band.freq_hz / 1_000).toFixed(band.freq_hz % 1_000 === 0 ? 0 : 2)} kHz` : `${Math.round(band.freq_hz)} Hz`;
  const gain = eqKindUsesGain(band.kind) ? ` ${band.gain_db > 0 ? '+' : ''}${band.gain_db} dB` : '';
  const off = band.enabled ? '' : ' (off)';
  return `${EQ_BAND_KIND_LABELS[band.kind]} ${hz}${gain} Q ${band.q}${off}`;
}

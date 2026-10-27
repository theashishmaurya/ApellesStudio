/**
 * The beat-analysis wire types (D-413), mirroring `apelles_beat` (serde
 * camelCase) exactly: what the `chroma_detect_beats` Tauri command answers.
 * Times are SECONDS FROM THE START OF THE FILE; placing them on a timeline or
 * in a scene is the caller's job (`./grid.ts` has the helpers).
 */

/** One beat. Mirrors `apelles_beat::Beat`. */
export interface Beat {
  /** Seconds from the start of the analysed audio. */
  time: number;
  /** Bar number, 1-based from the first downbeat; `0` for pickup beats. */
  bar: number;
  /** Position in the bar, `1..=meter` (1 is the downbeat). */
  beat: number;
  downbeat: boolean;
  /** How hard the beat hits relative to the track, `0..=1`. */
  strength: number;
  /** A downbeat, or strength ≥ 0.75 (`apelles_beat::meter::STRONG_ACCENT`). */
  strong: boolean;
}

/** Mirrors `apelles_beat::BeatAnalysis`. */
export interface BeatAnalysis {
  algorithmVersion: number;
  /** Seconds of audio analysed. */
  duration: number;
  /** 0 when no beat was found. */
  tempoBpm: number;
  meter: number;
  beats: Beat[];
}

/** Mirrors `apelles_beat::BeatParams`. */
export interface BeatParams {
  meter: number;
  tempoHintBpm?: number | null;
}

/** What `chroma_detect_beats` answers: `apelles_beat::source::FileBeats`
 *  plus the path asked about and whether the answer came from the cache. */
export interface FileBeats {
  path: string;
  /** BLAKE3 of the file's bytes — the cache identity. */
  contentHash: string;
  params: BeatParams;
  /** The file is longer than 20 minutes and only its start was analysed. */
  truncated: boolean;
  cached: boolean;
  analysis: BeatAnalysis;
}

/** Which beats a snap, a cut or a cue considers. */
export type BeatKind = 'beat' | 'downbeat' | 'strong';

export const BEAT_KINDS: readonly BeatKind[] = ['beat', 'downbeat', 'strong'];

/** Default beats per bar (`apelles_beat::DEFAULT_METER`). */
export const DEFAULT_METER = 4;
/** Meters the analysis accepts (`apelles_beat::METERS`). */
export const MIN_METER = 2;
export const MAX_METER = 7;
/** Tempo-hint range, BPM (`apelles_beat::tempo::{MIN,MAX}_BPM`). */
export const MIN_TEMPO_HINT_BPM = 30;
export const MAX_TEMPO_HINT_BPM = 300;

/** Does `b` count as a beat of `kind`? */
export function isBeatOfKind(b: Pick<Beat, 'downbeat' | 'strong'>, kind: BeatKind): boolean {
  if (kind === 'downbeat') return b.downbeat;
  if (kind === 'strong') return b.strong;
  return true;
}

/** `null` when `meter`/`tempoHintBpm` are acceptable, else a readable reason. */
export function beatParamsProblem(meter: unknown, tempoHintBpm: unknown): string | null {
  if (meter !== undefined && meter !== null) {
    if (typeof meter !== 'number' || !Number.isInteger(meter) || meter < MIN_METER || meter > MAX_METER) {
      return `meter must be a whole number of beats per bar, ${MIN_METER}..${MAX_METER}`;
    }
  }
  if (tempoHintBpm !== undefined && tempoHintBpm !== null) {
    if (
      typeof tempoHintBpm !== 'number' ||
      !Number.isFinite(tempoHintBpm) ||
      tempoHintBpm < MIN_TEMPO_HINT_BPM ||
      tempoHintBpm > MAX_TEMPO_HINT_BPM
    ) {
      return `tempo_hint_bpm must be ${MIN_TEMPO_HINT_BPM}..${MAX_TEMPO_HINT_BPM} BPM`;
    }
  }
  return null;
}

/**
 * @apelles/beats — beat-grid maths shared by the Edit and Motion tabs (D-413).
 *
 * What it is: the wire types `chroma_detect_beats` answers with (mirrors of
 * `apelles_beat`), nearest-beat snapping, and the cue grammar that maps named
 * moves onto beats. What it does NOT do: call Tauri (the cached binding is
 * `@apelles/bridge`'s `beats.ts`), hold state, or know about clips, tracks,
 * scenes or keyframes — each tab maps its own objects onto these numbers.
 */
export type { Beat, BeatAnalysis, BeatKind, BeatParams, FileBeats } from './types';
export {
  BEAT_KINDS,
  DEFAULT_METER,
  MAX_METER,
  MAX_TEMPO_HINT_BPM,
  MIN_METER,
  MIN_TEMPO_HINT_BPM,
  beatParamsProblem,
  isBeatOfKind,
} from './types';
export { nearestIndex, snapSpan, snapTo, within } from './grid';
export type { Snap } from './grid';
export { parseCue, planMoves, spread } from './cues';
export type { CueBeat, MovePlan, MoveRequest, ParsedCue, PlanResult } from './cues';

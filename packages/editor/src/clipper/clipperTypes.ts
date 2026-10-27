/**
 * `@apelles/editor` — the Automatic Clipper's data shapes (D-411).
 *
 * **What it is.** TypeScript mirrors of `apelles_clipper`'s persisted run
 * (`ClipRun`, `clips/<run-id>.json`, snake_case on the wire like the rest of
 * the project document) and of the answers `chroma::clipper`'s commands give
 * (camelCase, like every command answer). The Rust types are the schema: a
 * run this side writes is checked by `ClipRun::validate` on every save.
 *
 * **What it does NOT do.** Hold logic. Constants that are facts of the Rust
 * crate (`ALLOWED_DURATIONS`, the aspect sizes) are repeated here with the
 * Rust name beside them, because the panel offers them as choices before any
 * command runs.
 */
import type { OutputSpec } from '../timeline';

/** Mirrors `apelles_clipper::gate::ALLOWED_DURATIONS`. */
export const ALLOWED_DURATIONS = [15, 30, 60, 90] as const;
export type TargetSecs = (typeof ALLOWED_DURATIONS)[number];

/** Mirrors `apelles_clipper::run::Aspect`. */
export type Aspect = '9:16' | '1:1' | '4:5';
export const ASPECTS: readonly Aspect[] = ['9:16', '1:1', '4:5'];
/** Mirrors `Aspect::output`. */
export const ASPECT_OUTPUT: Record<Aspect, OutputSpec> = {
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
};

/** Mirrors `apelles_clipper::run::MAX_COUNT`. */
export const MAX_CLIP_COUNT = 20;
/** Mirrors `apelles_clipper::run::CLIP_RUN_SCHEMA`. */
export const CLIP_RUN_SCHEMA = 1;

export interface SegmentRef {
  first_word: number;
  last_word: number;
}

export interface ClipShape {
  hook: SegmentRef | null;
  segments: SegmentRef[];
}

export interface TightCut {
  kind: 'dead_air' | 'retake';
  start_secs: number;
  end_secs: number;
}

export interface ResolvedRange {
  role: 'hook' | 'body';
  piece: number;
  source: number;
  first_word: number;
  last_word: number;
  start_secs: number;
  end_secs: number;
  cuts: TightCut[];
}

export interface Resolved {
  ranges: ResolvedRange[];
  raw_secs: number;
  tight_secs: number;
  first_sentence: number;
  last_sentence: number;
}

/** Mirrors `apelles_clipper::ClipVerdict` (serde `verdict`-tagged). */
export type ClipVerdict =
  | { verdict: 'verified'; resolved: Resolved }
  | { verdict: 'warned'; resolved: Resolved; warnings: Array<{ kind: string }> }
  | { verdict: 'refused'; reason: { kind: string }; offending: number[] };

export type RunSource =
  | { kind: 'media'; media_id: string; path: string; name: string }
  | { kind: 'timeline'; timeline_id: string; track: number; name: string };

export interface RunSettings {
  durations: number[];
  count: number;
  aspect: Aspect;
  /** `"brand"`, a caption preset id, or `"none"`. */
  captions: string;
  hook_first: boolean;
  tighten: { dead_air: boolean; retakes: boolean };
  range?: { start_secs: number; end_secs: number } | null;
  focus?: string | null;
}

export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'built';

export interface ClipProposal {
  id: string;
  shape: ClipShape;
  title: string;
  reason: string;
  hook_line?: string | null;
  picked_by: 'client' | 'person';
  view_id: string;
  rules_version: number;
  verdict: ClipVerdict;
  gate_notes: string[];
  status: ProposalStatus;
  timeline_id?: string | null;
  built_at?: string | null;
}

export interface ClipRun {
  schema: number;
  id: string;
  created_at: string;
  source: RunSource;
  settings: RunSettings;
  view_id?: string | null;
  proposals: ClipProposal[];
}

/** One sentence as `chroma_clipper_analyze` (`includeAnalysis`) returns it. */
export interface SentenceDto {
  index: number;
  firstWord: number;
  lastWord: number;
  piece: number;
  startSecs: number;
  endSecs: number;
  text: string;
  ending: string;
  topic: number;
  tags: string[];
}

export interface TopicDto {
  firstSentence: number;
  lastSentence: number;
  keywords: string[];
}

export interface CandidateDto {
  id: string;
  targetSecs: number;
  firstSentence: number;
  lastSentence: number;
  topic: number;
  rawSecs: number;
  tightSecs: number;
  tags: string[];
  warnings: string[];
}

export type PassState = { state: 'idle' } | { state: 'running' } | { state: 'done' } | { state: 'error'; error: string };

/** `chroma_clipper_analyze`'s answer. */
export interface AnalyzeWire {
  viewId: string;
  totalSentences: number;
  totalWords: number;
  topics: number;
  candidates: number;
  offset: number;
  returned: number;
  nextOffset: number | null;
  rulesVersion: number;
  evidence: Array<{ path: string; audio: PassState; scenes: PassState }>;
  text?: string;
  rules?: string;
  analysis?: { sentences: SentenceDto[]; topics: TopicDto[]; candidates: CandidateDto[] };
}

/** One verdict of `chroma_clipper_check`. */
export interface CheckVerdictWire {
  shape?: ClipShape;
  verdict: ClipVerdict;
  status: 'verified' | 'warned' | 'refused';
  reasonText: string | null;
  warnings: string[];
  offendingSentences?: number[];
  sentences?: {
    segments: Array<{ first: number | null; last: number | null }>;
    hook: { first: number | null; last: number | null } | null;
  };
  text?: string[];
}

export type CheckWire =
  | { stale: true; viewId: string }
  | { stale: false; viewId: string; verdicts: CheckVerdictWire[] };

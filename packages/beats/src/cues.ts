/**
 * Time to music: named moves mapped to beats by a small cue grammar (D-413).
 *
 * **What it is.** The planning half of "time the hero reveal to the first
 * downbeat, land the scale-up on the next strong beat, put smaller accents on
 * the beats between". The caller (the Motion op layer) hands over the beats of
 * a window (a scene) in local time and a list of moves, each a NAME, a CUE and
 * how many items it has; this answers, per move, the beat time each item lands
 * on. Moving keyframes onto those times is the caller's business.
 *
 * **The grammar** (case-insensitive; `<kind>` is `beat`, `downbeat` or
 * `strong beat`; every count is 1-based and counts within the window):
 *
 * | cue | lands on |
 * |---|---|
 * | `<kind> N` | the Nth beat of that kind (`beat 3`, `downbeat 1`, `strong beat 2`) |
 * | `bar N` | the Nth downbeat |
 * | `bar N beat M` | the Mth beat of the Nth bar (bar N starts at downbeat N) |
 * | `first <kind>` / `last <kind>` | the first / last beat of that kind |
 * | `next <kind>` | the first beat of that kind after the previous single-beat move in the list (the first in the window for the first move) |
 * | `next <kind> after <move>` | the first after that named move |
 * | `every <kind> between` | every beat of that kind strictly between the two single-beat moves listed last before this one |
 * | `every <kind> between <a> and <b>` | strictly between those two named moves |
 *
 * A single-beat cue lands every item of its move on that beat. An `every`
 * cue lands item i on the i-th of the beats it names; with more beats than
 * items the items are spread evenly across them (first and last included),
 * with fewer it is refused. Single cues resolve first, in list order, then
 * the `every` cues, so an `every` may name a move listed after it.
 *
 * **What it does NOT do.** No keyframes, no layers, no seconds↔frames: beats
 * in, times out. Nothing here reads a clock or a random number, so the same
 * beats and moves always give the same plan (render-path determinism).
 */
import type { BeatKind } from './types';

/** A beat placed in the caller's window: `at` in local seconds, ascending. */
export interface CueBeat {
  at: number;
  downbeat: boolean;
  strong: boolean;
}

export type ParsedCue =
  | { type: 'nth'; kind: BeatKind; n: number }
  | { type: 'bar'; bar: number; beat: number }
  | { type: 'first'; kind: BeatKind }
  | { type: 'last'; kind: BeatKind }
  | { type: 'next'; kind: BeatKind; after: string | null }
  | { type: 'every'; kind: BeatKind; between: [string, string] | null };

const KIND = '(beat|downbeat|strong beat)';

function kindOf(word: string): BeatKind {
  if (word === 'downbeat') return 'downbeat';
  if (word === 'strong beat') return 'strong';
  return 'beat';
}

/** One cue, parsed; `{error}` names what was not understood and the forms. */
export function parseCue(text: string): ParsedCue | { error: string } {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^(on|at) (the )?/, '').replace(/^the /, '');
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^bar (\d+) beat (\d+)$/))) {
    const [bar, beat] = [Number(m[1]), Number(m[2])];
    if (bar < 1 || beat < 1) return { error: `"${text}": bars and beats count from 1` };
    return { type: 'bar', bar, beat };
  }
  if ((m = t.match(/^bar (\d+)$/))) {
    const n = Number(m[1]);
    if (n < 1) return { error: `"${text}": bars count from 1` };
    return { type: 'nth', kind: 'downbeat', n };
  }
  if ((m = t.match(new RegExp(`^${KIND} (\\d+)$`)))) {
    const n = Number(m[2]);
    if (n < 1) return { error: `"${text}": beats count from 1` };
    return { type: 'nth', kind: kindOf(m[1]), n };
  }
  if ((m = t.match(new RegExp(`^(first|last) ${KIND}$`)))) {
    return m[1] === 'first' ? { type: 'first', kind: kindOf(m[2]) } : { type: 'last', kind: kindOf(m[2]) };
  }
  if ((m = t.match(new RegExp(`^next ${KIND}(?: after (.+))?$`)))) {
    return { type: 'next', kind: kindOf(m[1]), after: m[2]?.trim() ?? null };
  }
  if ((m = t.match(new RegExp(`^every ${KIND}s? between(?: (.+) and (.+))?$`)))) {
    return {
      type: 'every',
      kind: kindOf(m[1]),
      between: m[2] !== undefined && m[3] !== undefined ? [m[2].trim(), m[3].trim()] : null,
    };
  }
  return {
    error:
      `"${text}" is not a cue. Use one of: "beat N", "downbeat N", "strong beat N", "bar N", ` +
      `"bar N beat M", "first|last <kind>", "next <kind>", "next <kind> after <move>", ` +
      `"every <kind> between", "every <kind> between <move> and <move>" (kind: beat, downbeat, strong beat)`,
  };
}

/** One move to place. `items` ≥ 1: how many things it lands (layers, keys). */
export interface MoveRequest {
  name: string;
  cue: string;
  items: number;
}

/** Where one move's items land. */
export interface MovePlan {
  name: string;
  cue: ParsedCue;
  /** One time per item, in the caller's local seconds. */
  times: number[];
}

export type PlanResult = { ok: true; plans: MovePlan[] } | { ok: false; error: string; move?: string };

const KIND_LABEL: Record<BeatKind, string> = { beat: 'beat', downbeat: 'downbeat', strong: 'strong beat' };

function ofKind(beats: readonly CueBeat[], kind: BeatKind): CueBeat[] {
  return beats.filter((b) => kind === 'beat' || (kind === 'downbeat' ? b.downbeat : b.strong));
}

/** Times are compared with this slack so a beat exactly on a reference is not "after" it. */
const EPS = 1e-6;

/** Each move's landing times, or the first problem found. */
export function planMoves(beats: readonly CueBeat[], moves: readonly MoveRequest[]): PlanResult {
  const sorted = [...beats].sort((a, b) => a.at - b.at);
  const names = new Set<string>();
  const parsed: ParsedCue[] = [];
  for (const mv of moves) {
    const key = mv.name.trim().toLowerCase();
    if (!key) return { ok: false, error: 'every move needs a name' };
    if (names.has(key)) return { ok: false, error: `two moves are named "${mv.name}"`, move: mv.name };
    names.add(key);
    if (!Number.isInteger(mv.items) || mv.items < 1) {
      return { ok: false, error: `move "${mv.name}" has nothing to place`, move: mv.name };
    }
    const cue = parseCue(mv.cue);
    if ('error' in cue) return { ok: false, error: cue.error, move: mv.name };
    parsed.push(cue);
  }
  if (sorted.length === 0) return { ok: false, error: 'there are no beats in this window to time to' };

  const single = new Map<string, number>(); // lower-cased name → its beat time
  const order: string[] = []; // single-beat moves, in list order
  const times: (number[] | null)[] = moves.map(() => null);
  const refTime = (name: string, from: string): number | { error: string } => {
    const t = single.get(name.trim().toLowerCase());
    if (t === undefined) {
      return { error: `move "${from}" refers to "${name}", which is not a single-beat move listed before it` };
    }
    return t;
  };

  for (let i = 0; i < moves.length; i++) {
    const cue = parsed[i];
    const mv = moves[i];
    if (cue.type === 'every') continue;
    let at: number;
    if (cue.type === 'nth') {
      const pool = ofKind(sorted, cue.kind);
      if (cue.n > pool.length) {
        return {
          ok: false,
          move: mv.name,
          error: `move "${mv.name}": asked for ${KIND_LABEL[cue.kind]} ${cue.n}, but this window has ${pool.length}`,
        };
      }
      at = pool[cue.n - 1].at;
    } else if (cue.type === 'bar') {
      const downs = ofKind(sorted, 'downbeat');
      if (cue.bar > downs.length) {
        return { ok: false, move: mv.name, error: `move "${mv.name}": asked for bar ${cue.bar}, but this window has ${downs.length} bars` };
      }
      const start = sorted.findIndex((b) => b.at >= downs[cue.bar - 1].at - EPS);
      const target = sorted[start + cue.beat - 1];
      const nextDown = downs[cue.bar];
      if (!target || (nextDown && target.at >= nextDown.at - EPS)) {
        return { ok: false, move: mv.name, error: `move "${mv.name}": bar ${cue.bar} has no beat ${cue.beat} in this window` };
      }
      at = target.at;
    } else if (cue.type === 'first' || cue.type === 'last') {
      const pool = ofKind(sorted, cue.kind);
      if (pool.length === 0) {
        return { ok: false, move: mv.name, error: `move "${mv.name}": this window has no ${KIND_LABEL[cue.kind]}` };
      }
      at = cue.type === 'first' ? pool[0].at : pool[pool.length - 1].at;
    } else {
      let ref = -Infinity;
      if (cue.after !== null) {
        const r = refTime(cue.after, mv.name);
        if (typeof r !== 'number') return { ok: false, move: mv.name, error: r.error };
        ref = r;
      } else if (order.length > 0) {
        ref = single.get(order[order.length - 1]) ?? -Infinity;
      }
      const hit = ofKind(sorted, cue.kind).find((b) => b.at > ref + EPS);
      if (!hit) {
        return { ok: false, move: mv.name, error: `move "${mv.name}": no ${KIND_LABEL[cue.kind]} after that point in this window` };
      }
      at = hit.at;
    }
    const key = mv.name.trim().toLowerCase();
    single.set(key, at);
    order.push(key);
    times[i] = new Array<number>(mv.items).fill(at);
  }

  for (let i = 0; i < moves.length; i++) {
    const cue = parsed[i];
    const mv = moves[i];
    if (cue.type !== 'every') continue;
    let a: number;
    let b: number;
    if (cue.between) {
      const ra = refTime(cue.between[0], mv.name);
      const rb = refTime(cue.between[1], mv.name);
      if (typeof ra !== 'number') return { ok: false, move: mv.name, error: ra.error };
      if (typeof rb !== 'number') return { ok: false, move: mv.name, error: rb.error };
      [a, b] = [ra, rb];
    } else {
      // The two single-beat moves listed last BEFORE this one.
      const before = moves
        .slice(0, i)
        .map((m) => m.name.trim().toLowerCase())
        .filter((n) => single.has(n));
      if (before.length < 2) {
        return {
          ok: false,
          move: mv.name,
          error: `move "${mv.name}": "between" needs two single-beat moves listed before it, or name them ("every beat between reveal and land")`,
        };
      }
      a = single.get(before[before.length - 2]) ?? 0;
      b = single.get(before[before.length - 1]) ?? 0;
    }
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    const pool = ofKind(sorted, cue.kind).filter((x) => x.at > lo + EPS && x.at < hi - EPS);
    if (pool.length < mv.items) {
      return {
        ok: false,
        move: mv.name,
        error: `move "${mv.name}" has ${mv.items} items but there are only ${pool.length} ${KIND_LABEL[cue.kind]}s between ${lo.toFixed(3)} s and ${hi.toFixed(3)} s`,
      };
    }
    times[i] = spread(pool.length, mv.items).map((k) => pool[k].at);
  }

  return {
    ok: true,
    plans: moves.map((mv, i) => ({ name: mv.name, cue: parsed[i], times: times[i] ?? [] })),
  };
}

/** `items` indices into `count` slots, evenly spread, first and last included
 *  (one item takes the middle slot). Requires `items <= count`. */
export function spread(count: number, items: number): number[] {
  if (items === count) return Array.from({ length: count }, (_, k) => k);
  if (items === 1) return [Math.floor((count - 1) / 2)];
  return Array.from({ length: items }, (_, k) => Math.round((k * (count - 1)) / (items - 1)));
}

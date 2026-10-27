/**
 * issues.ts — the one issue shape every Motion check reports in (D-403), and
 * the two helpers that build it: path formatting and "did you mean".
 *
 * What it is: `ValidationIssue` (`{path, code, message, expected?, hint?}`),
 * `formatPath` and `closest`. Split out of `validate.ts` (D-409) so modules the
 * manifest schema itself depends on — the slot checks in `../slots.ts`, which
 * the schema uses for a custom component's props — can report issues without
 * importing the validator, which imports the schema (a cycle).
 *
 * What it does NOT do: validate anything. `validate.ts` re-exports all three,
 * so existing imports from there keep working.
 */

export interface ValidationIssue {
  /** where, as `scenes[0].layers[2].size` (empty string for the root). */
  path: string;
  /** a stable machine code: zod's own (`invalid_type`, `invalid_value`,
   *  `too_small`, ...) or one of ours (`unrecognized_key`, `unknown_use`). */
  code: string;
  message: string;
  /** what would have been accepted, when that is knowable. */
  expected?: unknown;
  /** what to do about it, when there is something specific to say. */
  hint?: string;
}

export type PathSeg = string | number;

/** `["scenes", 0, "layers", 2, "size"]` → `scenes[0].layers[2].size`. */
export function formatPath(path: readonly PathSeg[]): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out ? `.${seg}` : seg;
  }
  return out;
}

/** The inverse of `formatPath` for paths whose keys hold no `.`, `[` or `]`
 *  (slot and field ids): `props.values[2]` → `["props", "values", 2]`. */
export function parsePath(path: string): PathSeg[] {
  const out: PathSeg[] = [];
  for (const m of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) out.push(m[2] !== undefined ? Number(m[2]) : m[1]);
  return out;
}

/** Levenshtein distance, for "did you mean". Small strings only. */
function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

/** the closest candidate within a typo's reach, or `undefined`. */
export function closest(word: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = distance(word, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  const reach = Math.max(2, Math.floor(word.length / 3));
  return bestD <= reach ? best : undefined;
}

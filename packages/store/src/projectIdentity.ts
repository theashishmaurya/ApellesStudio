/**
 * `@apelles/store` — the cross-store project-identity guard (D-358, B-217).
 *
 * What it is: one place that can answer "do all the stores caching per-project
 *   state still agree about *which* project is open?", and one assertion the MCP
 *   op registries run before they execute anything.
 *
 * What it does: `useSessionStore` (the app's own source of truth for the open
 *   project) registers itself as the **authority**; every store that is handed
 *   that identity by the composition root — `@apelles/editor`'s timeline,
 *   `@apelles/motion`'s manifest, `@apelles/bridge`'s media pool — registers
 *   itself as a **participant** saying what it currently holds and what it should
 *   be holding. `assertProjectIdentity(op)` compares them and throws
 *   `ProjectIdentityError` when they disagree.
 *
 * What it does NOT do: it does not repair anything, it does not read or write
 *   any project, and it knows nothing about what those stores hold beyond one
 *   opaque identity string each. It also does nothing at all when no authority
 *   has registered (a `packages/*` unit test, or `app/src/harness-main.tsx`,
 *   which mounts the Edit tab without `useSessionStore`): with nothing to compare
 *   against, "agreeing" is not a question that has an answer.
 *
 * **Why it exists even though D-358's other half is supposed to prevent this
 * (B-217).** The HMR-resilient singleton factory in `sharedStore.ts` stops the
 * duplicate store instances that wedged the app once. This is the half that
 * *catches* the same class of failure if some future edge case gets past it —
 * and it is the more valuable half, because what made B-217 cost hours was not
 * that it happened, it is that it was **silent**: `editor_get_state` cheerfully
 * reported `openProject: "untitled:Untitled"` while the Edit tab was visibly
 * rendering a real project's timeline, and an MCP write in that window would have
 * landed one project's timeline in another project's file with no error anywhere.
 * A divergence here is not recoverable in-process and must never be papered over:
 * the op fails, loudly, naming both identities.
 *
 * **The settle window is deliberate, not a retry.** The composition root bridges
 * the identity out in a React effect, i.e. one tick after `useSessionStore`
 * changes, so an op that arrives inside that tick would see a divergence that is
 * about to resolve itself. `assertProjectIdentity` therefore waits up to
 * `SETTLE_MS` for agreement before it fails. A real duplicate-instance wedge never
 * resolves — it survived a whole session in B-217 — so this window costs nothing
 * in the failing case and nothing at all in the normal one, where the very first
 * check already agrees.
 */
import { sharedValue } from './sharedStore';

/** The open project as the app's own source of truth holds it. Two fields
 *  because the participants legitimately track different halves of it: the Edit
 *  tab and the media pool follow the full project *key* (which is non-null for an
 *  in-memory "Untitled" loose-clip session too), while the Motion tab follows the
 *  project *path*, because its manifest is a sidecar inside a real project
 *  directory and an Untitled session genuinely has nowhere to read or write. */
export interface SessionProjectIdentity {
  /** `projectPath`, or `untitled:<name>` for an in-memory session, or `null`. */
  projectKey: string | null;
  /** The `.chroma` project directory, or `null` (no project / Untitled). */
  projectPath: string | null;
}

/** One store that caches per-project state and is handed its identity by the
 *  composition root. */
export interface ProjectIdentityParticipant {
  /** Human-readable, used verbatim in the failure message. */
  label: string;
  /** What this store actually holds right now. */
  read: () => string | null;
  /** What it should be holding, given the authority's answer. */
  expected: (session: SessionProjectIdentity) => string | null;
}

/** One store disagreeing with the authority. */
export interface ProjectIdentityDivergence {
  id: string;
  label: string;
  held: string | null;
  expected: string | null;
}

/** Thrown by `assertProjectIdentity`. Carries the divergences so a caller can
 *  report them structurally rather than re-parsing the message. */
export class ProjectIdentityError extends Error {
  readonly divergences: readonly ProjectIdentityDivergence[];

  constructor(message: string, divergences: readonly ProjectIdentityDivergence[]) {
    super(message);
    this.name = 'ProjectIdentityError';
    this.divergences = divergences;
  }
}

/** How long a divergence is allowed to be the composition root's one-tick lag
 *  before it is treated as real. Generous on purpose: the cost of waiting is
 *  paid only when something is already wrong. */
const SETTLE_MS = 1000;
/** Poll interval inside that window. A React effect lands within one frame. */
const SETTLE_POLL_MS = 20;

interface GuardState {
  authority: (() => SessionProjectIdentity) | null;
  participants: Map<string, ProjectIdentityParticipant>;
  alert: ((message: string) => void) | null;
}

/** Held through `sharedValue` so an HMR re-evaluation of this module cannot
 *  silently empty the registry and turn the guard into a no-op. */
const state = sharedValue<GuardState>('projectIdentity.guard', () => ({
  authority: null,
  participants: new Map(),
  alert: null,
}));

/** `useSessionStore`'s own module calls this once: it is the source of truth
 *  every participant is measured against. */
export function registerProjectIdentityAuthority(read: () => SessionProjectIdentity): void {
  state.authority = read;
}

/** A per-project store's own module calls this once. `id` is stable and short
 *  (`'edit'`, `'motion'`, `'media'`); re-registering replaces. */
export function registerProjectIdentityParticipant(
  id: string,
  participant: ProjectIdentityParticipant,
): void {
  state.participants.set(id, participant);
}

/** Where a divergence is shown to the human. The app installs a toast sink at
 *  the composition root; with none installed the failure is still loud — it is
 *  `console.error`'d (which `app/src/utils/frontendLogBridge.ts` forwards to the
 *  Rust log) and the op itself fails with the same text. */
export function setProjectIdentityAlertSink(sink: ((message: string) => void) | null): void {
  state.alert = sink;
}

/** Every participant currently disagreeing with the authority. Empty when they
 *  agree AND when there is no authority to compare against — see the module doc
 *  for why "no authority" is not a failure. Synchronous and side-effect free:
 *  this is the one to call from a test or a debug read. */
export function readProjectIdentityDivergences(): ProjectIdentityDivergence[] {
  const { authority, participants } = state;
  if (!authority) return [];
  const session = authority();
  const out: ProjectIdentityDivergence[] = [];
  for (const [id, participant] of participants) {
    const held = participant.read();
    const expected = participant.expected(session);
    if (held !== expected) out.push({ id, label: participant.label, held, expected });
  }
  return out;
}

function describe(op: string, divergences: readonly ProjectIdentityDivergence[]): string {
  const rows = divergences
    .map((d) => `  ${d.label}: holds ${JSON.stringify(d.held)}, expected ${JSON.stringify(d.expected)}`)
    .join('\n');
  return (
    `B-217: the app's stores disagree about which project is open, so "${op}" was refused ` +
    `rather than run against the wrong project.\n${rows}\n` +
    'This is a duplicated store instance (a Vite dev-mode HMR fault). Reload the window ' +
    '(Cmd+R) — the divergence is not recoverable in-process.'
  );
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Refuse to run `op` while the stores disagree about which project is open.
 * Resolves (doing nothing) in every healthy case; throws `ProjectIdentityError`
 * only after the divergence has survived the settle window.
 */
export async function assertProjectIdentity(op: string): Promise<void> {
  let divergences = readProjectIdentityDivergences();
  if (divergences.length === 0) return;

  const deadline = Date.now() + SETTLE_MS;
  while (Date.now() < deadline) {
    await sleep(SETTLE_POLL_MS);
    divergences = readProjectIdentityDivergences();
    if (divergences.length === 0) return;
  }

  const message = describe(op, divergences);
  // Loud in three places at once: the dev console (and, through
  // `frontendLogBridge`, the Rust log), the GUI if a sink is installed, and the
  // op's own MCP response via the thrown error.
  console.error(message);
  state.alert?.(message);
  throw new ProjectIdentityError(message, divergences);
}

/** Test-only reset. Not exported from the package barrel — the registrations are
 *  module-evaluation-time facts in the real app and nothing should clear them. */
export function __resetProjectIdentityForTests(): void {
  state.authority = null;
  state.participants.clear();
  state.alert = null;
}

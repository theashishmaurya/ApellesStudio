/**
 * releaseTrace.ts - attribute the main-thread work after an edit gesture's
 * commit (B-347, D-437 S11; `docs/notes/timeline-lanes.md` "S11").
 *
 * What it is: a debug-only tracer the `debug_perf_entries {traceReleaseMs}` arg
 * arms. Once armed it wraps, for the page's lifetime:
 *   - the layout reads that can force a synchronous style + layout
 *     (`getBoundingClientRect`, `offset*`, `client*`, `scroll*` getters and the
 *     `scrollLeft`/`scrollTop` setters, `getComputedStyle`, `scrollIntoView*`) -
 *     a read that takes time IS a forced layout, and its duration is the cost;
 *   - the callbacks the browser runs as their own tasks (`setTimeout`, rAF,
 *     `MessagePort` messages, `ResizeObserver` / `MutationObserver` /
 *     `IntersectionObserver` created after arming) and the event listeners added
 *     after arming (arm before the page loads its listeners to see them all);
 *   - the Tauri IPC (`invoke`, `transformCallback`) where the runtime lets it be
 *     replaced (Tauri 2 freezes `__TAURI_INTERNALS__`: the reply's
 *     `trace.unwrapped` lists what could not be wrapped);
 *   - React's profiling-build component track (`console.timeStamp`), when the
 *     bundle uses `react-dom/profiling` under a `<Profiler>` (exploration only);
 *   - a `MessageChannel` probe that posts itself back to back from the commit,
 *     so a gap between two probes is time something else held the main thread
 *     (an unwrapped task, a rendering update, GC).
 * Everything that happens from the `apelles:edit:commit` mark until
 * `traceReleaseMs` later is written as a `performance.measure` named
 * `apelles:trace:<kind>|<label>`; `debug_perf_entries {prefix: 'apelles:trace:'}`
 * reads them back. A label is the caller's top stack frames (the debug bundle is
 * unminified, so they are function names).
 *
 * What it does NOT do: anything in a release build (the op that arms it is only
 * registered under `APELLES_DEBUG_TOOLS`), judge a number, or undo its wrapping
 * (it is a measurement session on a debug app; the wrappers cost a
 * `performance.now()` pair when no window is open).
 */
import { EDIT_PERF } from '@apelles/editor/src/editPerfNames';

export const TRACE_PREFIX = 'apelles:trace:';

/** A forced layout shorter than this is noise (a clean read). */
const LAYOUT_MIN_MS = 0.3;
/** A probe gap shorter than this is the probe's own scheduling. */
const GAP_MIN_MS = 1.5;
/** A callback shorter than this is not worth a row. */
const CALLBACK_MIN_MS = 0.3;
/** Stack frames kept per label. */
const STACK_FRAMES = 4;

let installed = false;
/** What could not be wrapped (a frozen or non-configurable property), so the reader knows what the trace cannot see. */
const unwrapped: string[] = [];

/** Replace `owner[key]`: a plain assignment, else a redefinition; a property that allows neither is listed in {@link unwrapped}. */
function assign(owner: object, key: string, value: unknown, label: string): void {
  const o = owner as Record<string, unknown>;
  try {
    o[key] = value;
    if (o[key] === value) return;
  } catch {
    // read-only: try a redefinition below
  }
  try {
    Object.defineProperty(owner, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  } catch {
    unwrapped.push(label);
  }
}

let windowMs = 0;
let windowEnd = -1;

const now = () => performance.now();
const open = (t: number = now()) => t <= windowEnd;

/**
 * The caller's top frames from `stack`, skipping `skip` frames of the tracer's own
 * wrappers above the call site (a stack is taken inside a wrapper, so its first
 * frames are always ours).
 */
function frames(stack: string | undefined, skip: number): string {
  if (!stack) return '?';
  const lines = stack
    .split('\n')
    .map((l) => l.trim())
    // V8 starts with an `Error` header line; WebKit has none.
    .filter((l, i) => l && !(i === 0 && /^Error\b/.test(l)));
  const out: string[] = [];
  for (const l of lines.slice(skip, skip + STACK_FRAMES)) {
    // WebKit: `fn@url:line:col`; V8: `at fn (url:line:col)`.
    const m = /^(?:at\s+)?([^@(\s]*)[@\s(]*(.*?)\)?$/.exec(l);
    const fn = m?.[1] || 'anon';
    const loc = (m?.[2] ?? '').replace(/^.*\//, '').replace(/\?[^:]*/, '');
    out.push(fn === 'anon' ? `@${loc}` : `${fn}@${loc}`);
  }
  return out.join(' < ') || '?';
}

function record(kind: string, label: string, start: number, end: number): void {
  try {
    performance.measure(`${TRACE_PREFIX}${kind}|${label}`, { start, end });
  } catch {
    // a measure with options is unsupported (old engine): nothing to record
  }
}

function wrapGetter(proto: object, prop: string, kind: string): void {
  const d = Object.getOwnPropertyDescriptor(proto, prop);
  if (!d?.get) return;
  const get = d.get;
  const set = d.set;
  try {
    Object.defineProperty(proto, prop, {
      ...d,
      get(this: unknown) {
        if (!open()) return get.call(this);
        const t = now();
        const v = get.call(this);
        const e = now();
        if (e - t >= LAYOUT_MIN_MS) record(kind, `${prop} ${frames(new Error().stack, 1)}`, t, e);
        return v;
      },
      set: set
        ? function (this: unknown, v: unknown) {
            if (!open()) return set.call(this, v);
            const t = now();
            set.call(this, v);
            const e = now();
            if (e - t >= LAYOUT_MIN_MS) record(kind, `set ${prop} ${frames(new Error().stack, 1)}`, t, e);
          }
        : undefined,
    });
  } catch {
    unwrapped.push(prop);
  }
}

function wrapMethod(owner: Record<string, unknown>, name: string, kind: string): void {
  const fn = owner[name];
  if (typeof fn !== 'function') return;
  assign(
    owner,
    name,
    function (this: unknown, ...args: unknown[]) {
      if (!open()) return (fn as (...a: unknown[]) => unknown).apply(this, args);
      const t = now();
      const v = (fn as (...a: unknown[]) => unknown).apply(this, args);
      const e = now();
      if (e - t >= LAYOUT_MIN_MS) record(kind, `${name} ${frames(new Error().stack, 1)}`, t, e);
      return v;
    },
    name,
  );
}

/** Wrap a callback so its run is timed, labelled with where it was registered. */
function timed<A extends unknown[], R>(kind: string, cb: (...a: A) => R, site: string): (...a: A) => R {
  return function (this: unknown, ...args: A): R {
    const t = now();
    try {
      return cb.apply(this, args);
    } finally {
      const e = now();
      if (open(t) && e - t >= CALLBACK_MIN_MS) record(kind, site, t, e);
    }
  };
}

/** Where a callback was registered: a stack only while a window is open or about to be. */
const site = () => (open() || windowEnd === -2 ? frames(new Error().stack, 2) : 'pre');

function installWrappers(): void {
  const w = window as unknown as Record<string, unknown>;
  // Layout reads.
  for (const p of ['offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft', 'offsetParent', 'innerText'])
    wrapGetter(HTMLElement.prototype, p, 'layout');
  for (const p of [
    'clientWidth',
    'clientHeight',
    'clientTop',
    'clientLeft',
    'scrollWidth',
    'scrollHeight',
    'scrollTop',
    'scrollLeft',
  ])
    wrapGetter(Element.prototype, p, 'layout');
  for (const m of ['getBoundingClientRect', 'getClientRects', 'scrollIntoView', 'scrollIntoViewIfNeeded', 'focus'])
    wrapMethod(Element.prototype as unknown as Record<string, unknown>, m, 'layout');
  wrapMethod(HTMLElement.prototype as unknown as Record<string, unknown>, 'focus', 'layout');
  wrapMethod(w, 'getComputedStyle', 'layout');

  // Event listeners (registered after install: arm early to see the app's own).
  type L = EventListenerOrEventListenerObject;
  const wrappedListeners = new WeakMap<object, Map<string, EventListener>>();
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const keyOf = (type: string, o?: boolean | AddEventListenerOptions) =>
    `${type}:${typeof o === 'boolean' ? o : !!o?.capture}`;
  EventTarget.prototype.addEventListener = function (
    this: EventTarget,
    type: string,
    l: L | null,
    o?: boolean | AddEventListenerOptions,
  ) {
    if (typeof l !== 'function') return add.call(this, type, l, o);
    let m = wrappedListeners.get(l);
    if (!m) wrappedListeners.set(l, (m = new Map()));
    const k = keyOf(type, o);
    let w = m.get(k);
    if (!w) {
      const tag = this === window ? 'window' : this === document ? 'document' : ((this as Element).tagName ?? 'target');
      w = timed(`listener`, l, `${type}@${tag} ${frames(new Error().stack, 1)}`) as EventListener;
      m.set(k, w);
    }
    return add.call(this, type, w, o);
  };
  EventTarget.prototype.removeEventListener = function (
    this: EventTarget,
    type: string,
    l: L | null,
    o?: boolean | EventListenerOptions,
  ) {
    const w = typeof l === 'function' ? wrappedListeners.get(l)?.get(keyOf(type, o)) : undefined;
    return remove.call(this, type, w ?? l, o);
  };

  // Task callbacks.
  const st = window.setTimeout.bind(window);
  assign(
    w,
    'setTimeout',
    (cb: TimerHandler, ms?: number, ...rest: unknown[]) =>
      typeof cb === 'function'
        ? st(timed('timeout', cb as (...a: unknown[]) => unknown, site()), ms, ...rest)
        : st(cb, ms, ...rest),
    'setTimeout',
  );
  const raf = window.requestAnimationFrame.bind(window);
  assign(
    w,
    'requestAnimationFrame',
    (cb: FrameRequestCallback) => raf(timed('raf', cb, site())),
    'requestAnimationFrame',
  );
  const onmessage = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
  if (onmessage?.set && onmessage.get) {
    const set = onmessage.set;
    try {
      Object.defineProperty(MessagePort.prototype, 'onmessage', {
        ...onmessage,
        set(this: MessagePort, cb: ((ev: MessageEvent) => unknown) | null) {
          set.call(this, cb ? timed('message', cb, site()) : cb);
        },
      });
    } catch {
      unwrapped.push('MessagePort.onmessage');
    }
  }
  for (const name of ['ResizeObserver', 'MutationObserver', 'IntersectionObserver'] as const) {
    const Orig = w[name] as (new (cb: (...a: unknown[]) => unknown, o?: unknown) => object) | undefined;
    if (!Orig) continue;
    const Wrapped = function (cb: (...a: unknown[]) => unknown, o?: unknown) {
      return new Orig(timed(name, cb, frames(new Error().stack, 1)), o);
    } as unknown as typeof Orig;
    Wrapped.prototype = Orig.prototype;
    assign(w, name, Wrapped, name);
  }

  // Tauri IPC.
  const internals = w.__TAURI_INTERNALS__ as Record<string, unknown> | undefined;
  if (internals && typeof internals.invoke === 'function') {
    const invoke = internals.invoke as (cmd: string, ...a: unknown[]) => Promise<unknown>;
    assign(
      internals,
      'invoke',
      (cmd: string, ...a: unknown[]) => {
        const t = now();
        const p = invoke(cmd, ...a);
        const e = now();
        if (open(t)) {
          record('invoke', `${cmd} ${frames(new Error().stack, 1)}`, t, e);
          void p.then(
            () => open() && record('reply', cmd, now(), now()),
            () => open() && record('reply', `${cmd} (rejected)`, now(), now()),
          );
        }
        return p;
      },
      '__TAURI_INTERNALS__.invoke',
    );
  }
  if (internals && typeof internals.transformCallback === 'function') {
    const tc = internals.transformCallback as (cb?: (r: unknown) => void, once?: boolean) => number;
    assign(
      internals,
      'transformCallback',
      (cb?: (r: unknown) => void, once?: boolean) =>
        tc(cb ? timed('ipc-callback', cb, frames(new Error().stack, 1)) : cb, once),
      '__TAURI_INTERNALS__.transformCallback',
    );
  }

  // React's profiling build reports each component render through
  // `console.timeStamp(name, start, end, track)` (only under a `<Profiler>`).
  const ts = (console as unknown as Record<string, unknown>).timeStamp;
  assign(
    console,
    'timeStamp',
    (name: unknown, start?: unknown, end?: unknown, track?: unknown, ...rest: unknown[]) => {
      if (typeof start === 'number' && typeof end === 'number' && open(start))
        record('react', `${String(track ?? '')}:${String(name)}`, start, end);
      if (typeof ts === 'function') (ts as (...a: unknown[]) => void).call(console, name, start, end, track, ...rest);
    },
    'console.timeStamp',
  );

  // The commit mark opens a window.
  const mark = performance.mark.bind(performance);
  assign(
    performance,
    'mark',
    ((name: string, opts?: PerformanceMarkOptions) => {
      if (name === EDIT_PERF.press) windowEnd = -2; // registrations from here carry a stack
      const m = mark(name, opts);
      if (name === EDIT_PERF.commit && windowMs > 0) startWindow();
      return m;
    }) as typeof performance.mark,
    'performance.mark',
  );
}

function startWindow(): void {
  const t0 = now();
  windowEnd = t0 + windowMs;
  record('t0', 'commit', t0, t0);
  // The probe: back-to-back tasks; a gap is someone else's main-thread time.
  const ch = new MessageChannel();
  let last = t0;
  ch.port1.onmessage = () => {
    const t = now();
    if (t - last >= GAP_MIN_MS) record('gap', 'main thread held', last, t);
    last = t;
    if (t <= windowEnd) ch.port2.postMessage(null);
    else ch.port1.close();
  };
  ch.port2.postMessage(null);
  // Frame boundaries, as zero-length rows.
  const frame = (ts: number) => {
    record('frame', 'rAF', ts, ts);
    if (now() <= windowEnd) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** Arm (or, with 0, disarm) the tracer for every following commit. Installs the wrappers once. */
export function armReleaseTrace(ms: number): {
  armed: boolean;
  windowMs: number;
  unwrapped: string[];
} {
  windowMs = Math.max(0, Math.min(2000, ms));
  if (windowMs > 0 && !installed && typeof window !== 'undefined') {
    installWrappers();
    installed = true;
  }
  return { armed: windowMs > 0, windowMs, unwrapped: [...unwrapped] };
}

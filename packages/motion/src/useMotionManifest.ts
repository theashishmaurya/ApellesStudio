/**
 * @apelles/motion — the manifest-editing state (D-046; readiness split out to
 * `motionProjectStore` in B-058/D-150).
 *
 * The *editing* state is component-local (text, parse errors, dirty, save,
 * render) — nothing outside this tab needs it. **Readiness is not**: whether a
 * project is open — and, since B-083/D-203, *which* one — comes from the app
 * (`app/src/Root.tsx` → `useMotionProjectStore.setOpenProject`) and the tab is
 * mounted from boot, so it lives in the
 * store. This hook seeds its editor text from whatever that store last read
 * (falling back to the engine's own sample manifest for a project with no
 * saved manifest yet), live-validates every edit (debounced) against
 * `@apelles/motion-engine`'s `zod` schema — the schema's single source of truth
 * — and drives save/render through `manifestIO`.
 *
 * B-058: `loadState` is *derived* — `'no-project'` comes from the store's
 * `openProjectPath` alone, never from a failed read. A read that fails while a
 * project is genuinely open is `'error'`, with the real backend message.
 *
 * A parse/validation error never blinks the preview away: `manifest` only
 * ever holds the last value that parsed clean, so `<MotionPreview>` keeps
 * showing it while `parseError` is surfaced separately in the editor pane.
 *
 * D-155 (Phase 0c of `docs/notes/motion-visual-builder-research.md`) adds
 * `commit` — the ONE path that both an Inspector field edit and a Phase 1
 * canvas drag write a whole-manifest change through, so both get undo/redo
 * "for free" from `@apelles/history` (D-051) with no per-mutation-site
 * wiring. It mirrors `@apelles/editor`'s own `timelineStore.applyOp`
 * (`before`/`after` snapshots closed over by `undo`/`redo`, pushed to the
 * SAME shared `useHistoryStore`) — adapted to this tab's "the JSON text is
 * the one serialized source of truth" contract (`setText`) rather than a
 * `restoreSnapshot` call. `setText` is `setTextLive`, i.e. still debounced,
 * so `commit` ALSO calls `applyParse` synchronously on the same string —
 * without that, a Phase 1 drag's pointer-up would clear its transient
 * preview override before the debounce re-parses `text`, and the picture
 * would visibly flash back to the pre-drag position for up to `DEBOUNCE_MS`.
 * The debounced call still fires a moment later on the identical string —
 * a harmless redundant parse, not a race, since `after`/`before` are fixed
 * strings closed over at push time, not read again later.
 *
 * **`save`/`render`'s return values, extended for D-170 (Motion tab MCP
 * surface, Phase 4).** Before this pass, both were `Promise<boolean>` /
 * `Promise<void>` — real failures only ever surfaced as a SIDE EFFECT
 * (`saveError`/`renderError` React state), which is fine for the GUI (the
 * next render just shows it) but not for `useMotionControl.ts`'s
 * `motion_save_manifest`/`motion_render` ops: a Tauri-event handler awaiting
 * `cur.save()`/`cur.render()` has no reliable way to observe a LATER
 * re-render of this same component from outside it — reading `mRef.current
 * .saveError` right after the `await` resolves would be racing this
 * component's own re-render (state updates here are not part of any React
 * *event* the bridge's caller participates in, so there's no batching
 * guarantee they've committed yet). Rather than accept that race, `save` now
 * resolves to a real `SaveOutcome` (`{ok, error?, path?}`) and `render` to a
 * real `RenderOutcome` (`{ok, error?, result?}`) — the definitive answer,
 * carried on the SAME promise the caller already awaits, no state re-read
 * required. Every existing side effect (`saveError`/`renderError`/
 * `renderResult`/`onRendered`) is unchanged — this only ADDS a return value
 * neither the GUI's `<Button onClick={m.save}>` / `<Button onClick={m.render}>`
 * (typed `() => void` in `ManifestEditor.tsx`, so a resolved-but-ignored
 * return value is exactly as before) nor any other existing caller reads.
 *
 * **D-415 — unsaved edits survive a reload.** Whatever the editor text holds
 * that the saved manifest (or, for a project that never saved one, the engine
 * sample it started on) does not is mirrored to the project's recovery copy
 * (`recoveryWriter.ts`, debounced, flushed on `pagehide`); the copy is removed
 * when the text is saved or is back to the saved document. The first time a
 * project's manifest is seeded, the copy is read and, if it differs, put back
 * as the editor text — dirty, never saved on the person's behalf — and the
 * store's `recovered` flag lets the composition root say so. `loadState` waits
 * for that read, so the tab never flashes the saved document first.
 *
 * **B-202/D-359 — the per-scene loop moved OUT of this file.** It is
 * `renderLoop.ts`'s `runSceneRenders`, a pure function, and `render()` here is
 * the shell around it: React state and the real `manifestIO` calls. That is
 * what makes the render's progress and its failing scene id a value
 * (`renderStatus`) instead of component state — readable by `motion_get_state`
 * for a caller whose op has already timed out, and testable in this package's
 * `node` vitest environment, which cannot render a hook at all.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { manifestSchema, type Manifest } from '@apelles/motion-engine/src/engine/schema';
import { formatIssues, issuesFromZod } from '@apelles/motion-engine/src/engine/validate';
import { sample } from '@apelles/motion-engine/src/engine/sample';
import { useHistoryStore } from '@apelles/history';

import {
  acknowledgeRenderedScene,
  clearRecovery,
  getRenderJobStatus,
  onRenderJobStatus,
  readRecovery,
  saveManifest,
  startRenderJob,
  writeRecovery,
  type MotionRenderResult,
} from './manifestIO';
import { useMotionProjectStore } from './motionProjectStore';
import { createRecoveryWriter } from './recoveryWriter';
import {
  IDLE_RENDER_STATUS,
  deliverFinished,
  renderFailedBeforeAnyScene,
  selectSceneJobs,
  waitForSettled,
  type MotionRenderStatus,
} from './renderLoop';

/** How often an awaiting `render()` re-reads the backend job's status. */
const RENDER_POLL_MS = 1000;

/** What `render` can be asked (D-398). `sceneIds` renders only those scenes
 *  (B-263); `resume` continues the interrupted or failed job from its own
 *  manifest snapshot instead of starting a new one (B-265). */
export interface RenderOptions {
  sceneIds?: readonly string[];
  resume?: boolean;
}

const DEBOUNCE_MS = 300;

export type LoadState = 'loading' | 'no-project' | 'ready' | 'error';

/** See this file's own module doc comment ("save/render's return values,
 *  extended for D-170") for why these carry the definitive outcome on the
 *  promise itself rather than leaving it to a later state read. */
export interface SaveOutcome {
  ok: boolean;
  error?: string;
  /** the sidecar path `chroma_motion_save_manifest` wrote to, on success. */
  path?: string;
}

/** D-180 — one scene's own render result, `MotionRenderResult` (the raw
 *  Rust-facing shape) plus the `sceneId` it belongs to (attached client-side;
 *  the backend command itself is manifest-shape agnostic and never knows
 *  scene identity, per `motion.rs`'s own module doc comment). */
export interface SceneRenderResult extends MotionRenderResult {
  sceneId: string;
}

/** B-262 — the answer to "re-read the manifest from disk". */
export interface ReloadOutcome {
  ok: boolean;
  error?: string;
  /** scenes in the document now loaded; `null` when the sidecar holds none. */
  scenes: number | null;
  /** false when the project has no saved manifest (the engine's sample shows). */
  hadSavedManifest: boolean;
}

export interface RenderOutcome {
  ok: boolean;
  error?: string;
  /** D-180 — every scene now renders to its OWN separate file (Render no
   *  longer produces one combined video), so this is an array even for a
   *  single-scene manifest, not a single `MotionRenderResult` any more. */
  result?: SceneRenderResult[];
}

export function useMotionManifest(onRendered?: (r: SceneRenderResult) => void | Promise<void>) {
  const projectOpen = useMotionProjectStore((s) => s.openProjectPath !== null);
  const status = useMotionProjectStore((s) => s.status);
  const loadError = useMotionProjectStore((s) => s.error);
  const loaded = useMotionProjectStore((s) => s.loaded);
  const reload = useMotionProjectStore((s) => s.load);

  const [text, setText] = useState('');
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  // the text as last written to disk — `null` before the first successful save
  const [savedText, setSavedText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // True while THIS call to `render()` is starting a job or waiting on it.
  const [renderBusy, setRenderBusy] = useState(false);
  const [renderResult, setRenderResult] = useState<SceneRenderResult[] | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  // B-202/D-398 — the render job's own progress, as a value anything outside
  // this component can read: the Render button, and `motion_get_state` for a
  // caller whose `motion_render` op has already timed out. It mirrors the
  // BACKEND job (`apelles_motion::job::JobView`), which owns the render: it is
  // fetched when a project opens (so a restart shows `interrupted`, not a
  // blank `idle`) and updated by every event the worker emits.
  const [renderStatus, setRenderStatus] = useState<MotionRenderStatus>(IDLE_RENDER_STATUS);
  const rendering = renderBusy || renderStatus.state === 'running';
  const openProjectPath = useMotionProjectStore((s) => s.openProjectPath);
  // The latest delivery callback, read at event time: the listener below is
  // registered once per project and must not close over a stale one.
  const onRenderedRef = useRef(onRendered);
  const deliveringRef = useRef(new Set<string>());
  useEffect(() => {
    onRenderedRef.current = onRendered;
  }, [onRendered]);

  useEffect(() => {
    if (openProjectPath === null) {
      setRenderStatus(IDLE_RENDER_STATUS);
      return;
    }
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    // Show the status and hand every finished-but-undelivered scene to the app
    // layer (Sources import + Edit clip refresh), acknowledging each: a scene
    // that finished while no page was listening is delivered when one returns.
    const apply = (status: MotionRenderStatus) => {
      if (cancelled) return;
      setRenderStatus(status);
      void deliverFinished(status, deliveringRef.current, {
        deliver: (o) => onRenderedRef.current?.({ sceneId: o.sceneId, outputPath: o.outputPath, stdoutTail: '' }),
        acknowledge: acknowledgeRenderedScene,
      });
    };
    void onRenderJobStatus(apply).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    void getRenderJobStatus().then(apply, () => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [openProjectPath]);

  const debounceRef = useRef<number | null>(null);

  // D-415 — the recovery copy's writer, and the book-keeping around it.
  const [recoveryWriter] = useState(() =>
    createRecoveryWriter({ write: writeRecovery, clear: clearRecovery }, (e) =>
      console.warn('motion recovery copy:', e),
    ),
  );
  // the document the editor started from (the engine sample for a project with
  // no saved manifest), the baseline while nothing has been saved
  const seedTextRef = useRef('');
  // the project whose recovery copy has been looked at, and the one whose read
  // has finished (what `loadState` waits for)
  const recoveryCheckedFor = useRef<string | null>(null);
  const [recoveryReadyFor, setRecoveryReadyFor] = useState<string | null>(null);
  // whether a recovery copy may exist on disk (so a clean text only asks the
  // backend to remove one when there is something to remove)
  const mayHaveRecovery = useRef(false);
  const recovered = useMotionProjectStore((s) => s.recovered);

  const applyParse = useCallback((raw: string) => {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e));
      return;
    }
    const result = manifestSchema.safeParse(json);
    if (result.success) {
      setManifest(result.data);
      setParseError(null);
    } else {
      // D-403 — the same issue list (path, message, did-you-mean hint) that
      // `motion_validate` and a refused `motion_*` op report, so the human
      // reading this panel and an agent reading a refusal see one wording.
      setParseError(formatIssues(issuesFromZod(result.error, manifestSchema, json)));
    }
  }, []);

  // Seed the editor from the store's last successful read. Keyed on the read's
  // *generation*, not on the value: re-running this for the same read would
  // discard whatever the owner has typed since it landed.
  const seededGeneration = useRef<number | null>(null);
  useEffect(() => {
    if (!loaded) {
      seededGeneration.current = null;
      recoveryCheckedFor.current = null;
      mayHaveRecovery.current = false;
      setRecoveryReadyFor(null);
      setText('');
      setSavedText(null);
      setManifest(null);
      setParseError(null);
      return;
    }
    if (seededGeneration.current === loaded.generation) return;
    seededGeneration.current = loaded.generation;
    const initialText = JSON.stringify(loaded.manifest ?? sample, null, 2);
    seedTextRef.current = initialText;
    setText(initialText);
    // a project with no saved manifest starts on the engine's sample, which is
    // by definition not "what's on disk" — so it starts dirty, as before.
    setSavedText(loaded.manifest ? initialText : null);
    applyParse(initialText);

    // D-415 — once per project, look for the previous page's unsaved edits.
    if (recoveryCheckedFor.current === openProjectPath) return;
    recoveryCheckedFor.current = openProjectPath;
    const generation = loaded.generation;
    void readRecovery()
      .then((copy) => {
        if (copy === null) return;
        mayHaveRecovery.current = true;
        if (seededGeneration.current !== generation) return; // a newer document took over
        if (copy.text === initialText) {
          recoveryWriter.clear(); // saved after the copy was made: nothing to restore
          return;
        }
        setText(copy.text);
        applyParse(copy.text);
        useMotionProjectStore.getState().setRecovered({ stale: copy.stale });
      })
      .catch((e: unknown) => console.warn('motion recovery copy could not be read:', e))
      .finally(() => setRecoveryReadyFor(openProjectPath));
  }, [loaded, applyParse, openProjectPath, recoveryWriter]);

  // B-058: re-check on window focus only when the last read actually *failed*.
  // The old version re-read whenever it believed no project was open, which was
  // this tab's only escape from that (wrong) state and never fired for the real
  // case — a project opened from the in-window launcher blurs nothing. It is
  // deliberately NOT a refetch-on-every-focus like `@apelles/editor`'s: this tab
  // holds unsaved editor text, and re-seeding it from disk on an alt-tab would
  // silently throw the owner's work away.
  useEffect(() => {
    const onFocus = () => {
      const s = useMotionProjectStore.getState();
      if (s.openProjectPath !== null && s.status === 'error') void s.load();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // B-058: derived, never inferred from a failed call. 'ready' additionally
  // waits for the seeding effect above to have run, so the tab never renders
  // its editor against an empty string for one frame.
  const loadState: LoadState = !projectOpen
    ? 'no-project'
    : status === 'error'
      ? 'error'
      : status === 'ready' && text !== '' && recoveryReadyFor === openProjectPath
        ? 'ready'
        : 'loading';

  const setTextLive = useCallback(
    (raw: string) => {
      setText(raw);
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => applyParse(raw), DEBOUNCE_MS);
    },
    [applyParse],
  );

  const dirty = savedText !== text;

  // D-415 — keep the recovery copy equal to "the unsaved text": scheduled while
  // the text differs from the document on disk (or the seed, before any save),
  // removed once it matches again. Holds off until the restore read is done.
  useEffect(() => {
    if (openProjectPath === null || recoveryReadyFor !== openProjectPath) return;
    const baseline = savedText ?? seedTextRef.current;
    if (text !== baseline) {
      mayHaveRecovery.current = true;
      recoveryWriter.schedule(text);
    } else {
      useMotionProjectStore.getState().setRecovered(null);
      if (mayHaveRecovery.current) {
        mayHaveRecovery.current = false;
        recoveryWriter.clear();
      }
    }
  }, [text, savedText, openProjectPath, recoveryReadyFor, recoveryWriter]);

  // The page may be killed with no further warning: write what is pending now
  // whenever it is hidden, and when this tab unmounts.
  useEffect(() => {
    const onHide = () => recoveryWriter.flush();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') recoveryWriter.flush();
    };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
      recoveryWriter.flush();
    };
  }, [recoveryWriter]);

  // D-155 — the one commit path for a whole-manifest change that should be
  // undoable: an Inspector field edit (first customer, per the research
  // doc's own Phase 0c) and a Phase 1 canvas-drag commit both call this
  // instead of `setText(JSON.stringify(...))` directly. `label` is a short,
  // human-readable one-liner for a future "Undo <label>" affordance, same
  // spirit as `@apelles/editor`'s `labelForOp`.
  const commit = useCallback(
    (next: Manifest, label: string) => {
      const after = JSON.stringify(next, null, 2);
      if (after === text) return; // no real change — don't push a no-op undo entry
      const before = text;
      const apply = (raw: string) => {
        setTextLive(raw);
        applyParse(raw);
      };
      apply(after);
      useHistoryStore.getState().push({
        tab: 'motion',
        label,
        undo: () => apply(before),
        redo: () => apply(after),
      });
    },
    [text, setTextLive, applyParse],
  );

  const save = useCallback(async (): Promise<SaveOutcome> => {
    if (!manifest || parseError) {
      return { ok: false, error: parseError ?? 'no manifest to save' };
    }
    setSaving(true);
    setSaveError(null);
    try {
      const path = await saveManifest(manifest);
      setSavedText(text);
      return { ok: true, path };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setSaveError(message);
      return { ok: false, error: message };
    } finally {
      setSaving(false);
    }
  }, [manifest, parseError, text]);

  /**
   * B-262 — re-read the manifest sidecar and replace the in-app document with
   * it. The store's `load` mints a new generation, which the seeding effect
   * above turns into the editor text (and a fresh parse). Refused while the
   * in-app text differs from what was last saved, unless `force`: that is the
   * person's (or an agent's) own unsaved work, and a reload would silently
   * discard it.
   */
  const reloadFromDisk = useCallback(
    async (force = false): Promise<ReloadOutcome> => {
      if (dirty && !force) {
        return {
          ok: false,
          error: 'the in-app manifest has unsaved edits; reloading would discard them (pass force to discard)',
          scenes: null,
          hadSavedManifest: false,
        };
      }
      await reload();
      const after = useMotionProjectStore.getState();
      if (after.status === 'error') {
        return { ok: false, error: after.error ?? 'reload failed', scenes: null, hadSavedManifest: false };
      }
      const saved = after.loaded?.manifest ?? null;
      const parsed = saved === null ? null : manifestSchema.safeParse(saved);
      return {
        ok: true,
        scenes: parsed?.success ? parsed.data.scenes.length : null,
        hadSavedManifest: saved !== null,
      };
    },
    [dirty, reload],
  );

  const render = useCallback(
    async (opts: RenderOptions = {}): Promise<RenderOutcome> => {
      const fail = (error: string, setStatus = true): RenderOutcome => {
        setRenderError(error);
        if (setStatus) setRenderStatus(renderFailedBeforeAnyScene(error));
        return { ok: false, error };
      };
      setRenderError(null);
      setRenderResult(null);
      const resume = opts.resume === true;
      let plan: ReturnType<typeof selectSceneJobs> = { jobs: [] };
      if (!resume) {
        if (!manifest || parseError) return fail('fix the manifest errors above before rendering');
        plan = selectSceneJobs(manifest, opts.sceneIds);
        if ('error' in plan) return fail(plan.error);
      }
      setRenderBusy(true);
      try {
        if (!resume && dirty) {
          const saveOutcome = await save();
          if (!saveOutcome.ok) {
            // `save()` itself already set `saveError`; additionally reported on
            // this promise for a caller with no component state to read
            // (`motion_render`), and on the pollable status.
            const error = saveOutcome.error ?? 'save failed';
            setRenderStatus(renderFailedBeforeAnyScene(error));
            return { ok: false, error };
          }
        }
        // D-398 — the render is the BACKEND's job. It receives the exact
        // manifest the frame windows were computed from (B-264), renders the
        // chosen scenes (B-263) sequentially to their own files (D-180), keeps
        // going if this page reloads and persists every step so a restart finds
        // it (B-265). This call starts it and waits for it to settle; if the
        // page is reloaded meanwhile the job carries on and the reloaded page
        // picks its status up from the backend.
        let started: MotionRenderStatus;
        try {
          started = await startRenderJob(
            resume ? null : manifest,
            resume || 'error' in plan ? [] : plan.jobs,
            resume,
          );
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e), false);
        }
        setRenderStatus(started);
        const final = await waitForSettled(
          getRenderJobStatus,
          (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
          RENDER_POLL_MS,
        );
        setRenderStatus(final);
        const results: SceneRenderResult[] = final.outputs.map((o) => ({
          sceneId: o.sceneId,
          outputPath: o.outputPath,
          stdoutTail: '',
        }));
        // Surface whichever scenes DID finish either way, rather than
        // discarding them on failure.
        if (results.length > 0) setRenderResult(results);
        if (final.state === 'error') return fail(final.error ?? 'render failed', false);
        if (final.state === 'interrupted') {
          return fail('the render was interrupted; resume it to render the scenes that are left', false);
        }
        return { ok: true, result: results };
      } finally {
        setRenderBusy(false);
      }
    },
    [manifest, parseError, dirty, save],
  );

  return {
    loadState,
    loadError,
    reload,
    reloadFromDisk,

    text,
    setText: setTextLive,
    manifest,
    parseError,
    commit,

    dirty,
    /** D-415 — the previous page's unsaved edits were put back (`stale`: the
     *  saved manifest changed since, so saving replaces it); null otherwise. */
    recovered,
    saving,
    saveError,
    save,

    rendering,
    renderResult,
    renderError,
    /** B-202 — `idle`/`running`/`error`, the scene in flight or the one that
     *  failed, and how many are done. Read by the Render button and by
     *  `motion_get_state`, off this one value. */
    renderStatus,
    render,
  };
}

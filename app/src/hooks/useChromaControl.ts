import { useEffect } from 'react';
import { listen, emit } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { v4 as uuidv4 } from 'uuid';
import { safeUnlisten } from '../utils/tauriListeners';

// D-183 — the three Edit-tab ops that used to live here (`get_timeline`,
// `set_clip_fade`, `set_track_duck`) moved to `@chroma/editor`'s own
// `useEditorControl.ts` (renamed `editor_get_timeline`/`editor_set_clip_fade`/
// `editor_set_track_duck`) — see `docs/notes/mcp-architecture.md`'s "every
// tab owns its own ops" rule. This file no longer imports `@chroma/editor`
// at all.
import { useEditorStore } from '../store/useEditorStore';
import { useChromaStore } from '../store/useChromaStore';
import { useAgentStore } from '../store/useAgentStore';
import { useSessionStore } from '../store/useSessionStore';
import { useEditorActions, debouncedSetHistory } from './useEditorActions';
import { useAiMasking } from './useAiMasking';
import { diffAdjustments, summarizeActivity } from '../utils/agentActivity';
import {
  Adjustments,
  MaskContainer,
  INITIAL_MASK_CONTAINER,
  INITIAL_MASK_ADJUSTMENTS,
  INITIAL_ADJUSTMENTS,
  normalizeLoadedAdjustments,
} from '../utils/adjustments';
import { createSubMask } from '../utils/maskUtils';
import { createRelightLight } from '../utils/relightUtils';
import {
  parseKeyframes,
  snapshotGeometry,
  upsertKeyframe,
  removeKeyframe,
  clearKeyframes,
  isKeyframeableMaskType,
} from '../utils/maskKeyframes';
import { Mask, SubMask, SubMaskMode } from '../components/panel/right/Masks';
import {
  computeScopes,
  computeGap,
  samplePoint,
  sampleRegion,
  renderParade,
  renderVectorscope,
  Scopes,
} from '../utils/scopes';

/**
 * The MCP ⇄ frontend bridge for the Chroma control server (D-020).
 *
 * Mounted ONCE (in Editor). The Rust control server (`src/chroma/control.rs`)
 * emits `chroma://request` for every HTTP `/op`; this hook runs the op against
 * the SAME store actions the GUI buttons use (`setAdjustments`, the `useAiMasking`
 * handlers), waits for the render to settle, and replies on
 * `chroma://response/<id>` with the post-render frame + histogram + adjustments.
 *
 * Adding a new MCP capability = add one entry to `OPS` below. Never a parallel
 * code path — that's what keeps MCP and the UI from ever diverging.
 */

/** top-level keys replace; nested plain objects merge one level. */
function deepMerge<T extends Record<string, any>>(base: T, patch: Record<string, any>): T {
  const out: any = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    const isPlainObj = (x: any) => x && typeof x === 'object' && !Array.isArray(x);
    if (isPlainObj(v) && isPlainObj(out[k])) {
      out[k] = { ...out[k], ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** the grading knobs `set_primary` / `set_mask_adjust` will accept — anything
 * else is rejected so an agent can't pollute the grade doc with junk keys. */
const PRIMARY_KNOBS = new Set([
  'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks',
  'temperature', 'tint', 'saturation', 'vibrance', 'dehaze', 'clarity', 'structure',
  'brightness', 'sharpness', 'sharpnessThreshold', 'lumaNoiseReduction', 'colorNoiseReduction',
  'vignetteAmount', 'vignetteMidpoint', 'vignetteFeather', 'vignetteRoundness',
  'grainAmount', 'grainSize', 'grainRoughness',
  'glowAmount', 'flareAmount', 'halationAmount',
  'chromaticAberrationRedCyan', 'chromaticAberrationBlueYellow',
]);

/** agent-facing mode words → the SubMaskMode a slider drag uses. This is how the
 * agent drives RapidRAW's native mask composition ("Add / Subtract from / Intersect
 * with Mask") instead of a bespoke +/- path. */
const MODE_MAP: Record<string, SubMaskMode> = {
  additive: SubMaskMode.Additive,
  add: SubMaskMode.Additive,
  subtractive: SubMaskMode.Subtractive,
  subtract: SubMaskMode.Subtractive,
  intersect: SubMaskMode.Intersect,
};
const MODE_WORDS = 'additive | subtractive | intersect';

/** knobs that only make sense on a mask (no global equivalent). `blur` (0–100)
 * is the per-mask defocus (D-027) — completes depth-haze, "blur the background". */
const MASK_ONLY_KNOBS = new Set(['blur']);

/** keep only known numeric knobs. Returns `{clean, rejected}`. `allow` is the
 * extra key set accepted on top of `PRIMARY_KNOBS` (mask ops pass MASK_ONLY_KNOBS). */
function filterKnobs(patch: Record<string, any> | undefined, allow?: Set<string>) {
  const clean: Record<string, number> = {};
  const rejected: string[] = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if ((PRIMARY_KNOBS.has(k) || allow?.has(k)) && typeof v === 'number' && Number.isFinite(v)) clean[k] = v;
    else rejected.push(k);
  }
  return { clean, rejected };
}

/** decode a data-URL / blob-URL image to ImageData (webview DOM canvas). */
async function decodeToImageData(src: string): Promise<ImageData | null> {
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return null;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, w, h);
  } catch {
    return null;
  }
}

const GRADE_SCHEMA = 'chroma.grade/1';

/** split a path on either separator → [dir, basename-without-extension]. */
function splitPath(p: string): [string, string] {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  const dir = i >= 0 ? p.slice(0, i) : '';
  const file = i >= 0 ? p.slice(i + 1) : p;
  return [dir, file.replace(/\.[^.]+$/, '')];
}

/**
 * Build the v1 `grade.json` shape (D-025) from the live store: the schema tag,
 * shot context (from the transport store / selected image), the RapidRAW
 * `adjustments` blob verbatim, and a free-text `notes`. The Rust side
 * (`chroma_save_grade`) externalises the mask mattes on write.
 */
function assembleGrade() {
  const s = useEditorStore.getState();
  const cv = useChromaStore.getState().videoInfo;
  const img = s.selectedImage;
  const srcPath = cv?.path || img?.path || '';
  const base = srcPath ? srcPath.split(/[\\/]/).pop() || null : null;
  const shot =
    cv?.isVideo
      ? {
          source: base,
          width: cv.width,
          height: cv.height,
          fps: cv.fps,
          frameCount: cv.frameCount,
          colorSpace: cv.colorSpace || 'bt709',
          reference: null as string | null,
        }
      : {
          source: base,
          width: img?.width ?? s.originalSize.width,
          height: img?.height ?? s.originalSize.height,
          fps: null as number | null,
          frameCount: 1,
          colorSpace: 'bt709',
          reference: null as string | null,
        };
  return { schema: GRADE_SCHEMA, shot, adjustments: s.adjustments, notes: '' };
}

/** default grade.json path: `<source dir>/<source basename>.grade.json`. */
function defaultGradePath(): string | null {
  const cv = useChromaStore.getState().videoInfo;
  const img = useEditorStore.getState().selectedImage;
  const p = cv?.path || img?.path;
  if (!p) return null;
  const [dir, stem] = splitPath(p);
  return `${dir}/${stem}.grade.json`;
}

/** drop zero / default-ish numeric fields so a mask summary stays readable. */
function nonDefault(obj: Record<string, any> | undefined): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (typeof v === 'number' && v !== 0) out[k] = v;
  }
  return out;
}

export function useChromaControl() {
  const { setAdjustments } = useEditorActions();
  const ai = useAiMasking();

  useEffect(() => {
    const editor = () => useEditorStore.getState();
    const chroma = () => useChromaStore.getState();

    const maskSummary = () =>
      (editor().adjustments.masks || []).map((c: MaskContainer) => ({
        id: c.id,
        name: c.name,
        visible: c.visible,
        invert: c.invert,
        opacity: c.opacity,
        adjustments: nonDefault(c.adjustments),
        subMasks: (c.subMasks || []).map((s: SubMask) => ({
          id: s.id,
          type: s.type,
          mode: s.mode,
          visible: s.visible,
          invert: s.invert,
          tracked: !!(s.parameters as any)?.chromaTrackDir,
        })),
      }));

    const findContainer = (id: string) =>
      (editor().adjustments.masks || []).find((c: MaskContainer) => c.id === id);

    const OPS: Record<string, (args: any) => Promise<any> | any> = {
      // Load a file (still or video) into the editor by absolute path — the
      // headless equivalent of picking it in the library. Sets `selectedImage`
      // with `isReady:false`; `useImageLoader`'s effect does the rest (decode +
      // `chroma_video_info` → the transport store). (docs/07 `open`)
      open: async (a) => {
        const path = a?.path;
        if (!path || typeof path !== 'string') return { error: 'path (absolute) required' };
        editor().setEditor({
          selectedImage: {
            exif: null,
            group_id: null,
            height: 0,
            isRaw: false,
            isReady: false,
            metadata: null,
            path,
            thumbnailUrl: null,
            width: 0,
          } as any,
          originalSize: { width: 0, height: 0 },
          activeMaskId: null,
          activeMaskContainerId: null,
          histogram: null,
        });
        for (let i = 0; i < 150; i++) {
          await sleep(100);
          if (useEditorStore.getState().selectedImage?.isReady) break;
        }
        const s = editor();
        return {
          path,
          ready: !!s.selectedImage?.isReady,
          size: s.originalSize,
          video: chroma().videoInfo,
        };
      },

      get_state: () => {
        const s = editor();
        const cv = chroma().videoInfo;
        return {
          image: s.selectedImage
            ? { path: s.selectedImage.path, width: s.selectedImage.width, height: s.selectedImage.height }
            : null,
          video: cv,
          frame: chroma().currentFrame ?? cv?.frame ?? 0,
          frameCount: cv?.frameCount ?? 1,
          adjustments: s.adjustments,
          masks: maskSummary(),
          // the agent's `request_human` hand-back (D-032). null once the user
          // has cleared it (or none is pending) — poll this to know when to
          // resume after a handoff.
          pendingHumanRequest: useAgentStore.getState().pendingHumanRequest,
          // the loaded project (D-037): where a save lands. null / 'Untitled'
          // = an in-memory session (loose clip via `open`) with nowhere to
          // autosave until the user saves it as a project.
          project: (() => {
            const ss = useSessionStore.getState();
            return ss.projectName
              ? {
                  name: ss.projectName,
                  path: ss.projectPath,
                  dirty: ss.dirty,
                  // per-project output spec (D-038). null = clip-derived
                  // (resolution / fps come from the loaded clip). colorSpace is
                  // stored + surfaced only for now (D-004).
                  settings: ss.projectSettings ?? null,
                }
              : null;
          })(),
          // the multi-shot session (D-033): every shot + which one is active.
          // Empty `shots` = a single still / no clip loaded.
          session: {
            shots: useSessionStore.getState().shots.map((sh, i) => ({
              index: i,
              path: sh.path,
              name: sh.name,
              frameCount: sh.frameCount,
              // D-070: `grades` keys off the shot's `id` (a clip id for a
              // real project) now, not its source path.
              hasGrade: !!useSessionStore.getState().grades[sh.id] &&
                i !== useSessionStore.getState().activeIndex,
            })),
            active: useSessionStore.getState().activeIndex,
          },
        };
      },

      // ---- D-183: get_timeline / set_clip_fade / set_track_duck moved OUT
      // of this file into @chroma/editor's own useEditorControl.ts, renamed
      // editor_get_timeline / editor_set_clip_fade / editor_set_track_duck
      // — see docs/notes/mcp-architecture.md's "every tab owns its own ops"
      // rule, and this file's own top-of-file comment.

      // ---- multi-shot session (round-3, D-033) ----------------------------
      // list_shots / set_active_shot / add_shots so the agent can grade shot 2,
      // then shot 3, in one session. Each shot keeps its own grade + activity
      // feed; switching saves the current shot's grade and restores the target's.
      list_shots: async () => {
        const dto: any = await invoke('chroma_session_list');
        return { shots: dto.shots, active: dto.active, count: dto.count };
      },

      set_active_shot: async (a) => {
        const dto: any = await invoke('chroma_session_list');
        const shots: any[] = dto.shots || [];
        let idx = typeof a?.index === 'number' ? Math.round(a.index) : -1;
        if (idx < 0 && typeof a?.path === 'string') {
          idx = shots.findIndex((s) => s.path === a.path || s.name === a.path);
        }
        if (idx < 0 || idx >= shots.length) {
          return { error: `pass index (0..${shots.length - 1}) or a shot path/name`, shots };
        }
        const res = await useSessionStore.getState().switchToShot(idx);
        if (!res.ok) return { error: res.error };
        const after: any = await invoke('chroma_session_list');
        return { active: after.active, shots: after.shots, note: 'grade + activity feed scoped to this shot' };
      },

      add_shots: async (a) => {
        const paths: string[] = Array.isArray(a?.paths)
          ? a.paths
          : typeof a?.path === 'string'
            ? [a.path]
            : [];
        if (!paths.length) return { error: 'paths (array of absolute clip paths) required' };
        const res = await useSessionStore.getState().addShots(paths);
        if (!res.ok) return { error: res.error };
        const after: any = await invoke('chroma_session_list');
        return { added: paths.length, active: after.active, shots: after.shots };
      },

      // ---- project model (D-037) -----------------------------------------
      // list / open / new / save the saved `<name>.chroma` project. `open` /
      // `new` load the project's shots + grades into the session; `save` writes
      // project.json + the active shot's grade.json + thumb.jpg.
      list_projects: async () => {
        const list: any[] = await invoke('chroma_project_list');
        return {
          projects: list.map((p) => ({
            name: p.name,
            path: p.path,
            modified: p.modified,
            shotCount: p.shotCount,
          })),
          folder: await invoke('chroma_project_settings_dir'),
        };
      },

      open_project: async (a) => {
        let path: string | undefined = typeof a?.path === 'string' ? a.path : undefined;
        if (!path && typeof a?.name === 'string') {
          const list: any[] = await invoke('chroma_project_list');
          path = list.find((p) => p.name === a.name || p.path === a.name)?.path;
        }
        if (!path) return { error: 'pass a project path or name (see list_projects)' };
        const res = await useSessionStore.getState().openProject(path);
        if (!res.ok) return { error: res.error };
        const st: any = await invoke('chroma_project_current');
        return { opened: st, shots: (await invoke<any>('chroma_session_list')).shots };
      },

      new_project: async (a) => {
        const name = typeof a?.name === 'string' ? a.name.trim() : '';
        if (!name) return { error: 'name (a string) required' };
        const media: string[] = Array.isArray(a?.media_paths)
          ? a.media_paths
          : Array.isArray(a?.mediaPaths)
            ? a.mediaPaths
            : [];
        const res = await useSessionStore.getState().newProject(name, media);
        if (!res.ok) return { error: res.error };
        return { created: await invoke('chroma_project_current') };
      },

      save_project: async () => {
        const ss = useSessionStore.getState();
        if (!ss.projectPath) return { error: 'no project loaded — new_project first' };
        if (ss.projectName === 'Untitled') return { error: 'this is an Untitled session — save it as a project in the app first' };
        const res = await ss.saveProject({ force: true });
        return res.ok ? { saved: true, thumbRegenerated: res.thumbRegenerated } : { error: res.error };
      },

      // ---- project output spec (D-038) -----------------------------------
      // partial-merge the loaded project's { width, height, fps, colorSpace }.
      // Only provided keys change; pass an explicit null to clear one back to
      // clip-derived. Export uses width/height (final resize) + fps; colorSpace
      // is stored + surfaced only (a colour-managed pipeline is D-004).
      set_project_settings: async (a) => {
        const partial: Record<string, unknown> = {};
        for (const k of ['width', 'height', 'fps'] as const) {
          if (a?.[k] !== undefined) partial[k] = a[k] === null ? null : Number(a[k]);
        }
        const cs = a?.colorSpace ?? a?.color_space;
        if (cs !== undefined) partial.colorSpace = cs === null ? null : String(cs);
        if (Object.keys(partial).length === 0) {
          return { error: 'pass at least one of width, height, fps, colorSpace' };
        }
        const res = await useSessionStore.getState().setProjectSettings(partial);
        return res.ok ? { settings: res.settings } : { error: res.error };
      },

      // ---- grade.json — "the grade is code" (roadmap 5, D-025) -------------
      // `get_grade` returns the v1 wrapper doc (schema + shot + the live
      // `adjustments`); `save_grade` writes it (Rust externalises the mattes);
      // `load_grade` reads one back and applies its `adjustments` through the
      // same `setAdjustments` a slider uses.
      get_grade: () => assembleGrade(),

      save_grade: async (a) => {
        const path = (typeof a?.path === 'string' && a.path) || defaultGradePath();
        if (!path) return { error: 'nothing loaded — open a clip first' };
        const res: any = await invoke('chroma_save_grade', { path, grade: assembleGrade() });
        return { ...res, note: 'diff-able — commit grade.json (+ its .mattes/ dir) to the project repo' };
      },

      load_grade: async (a) => {
        const path = a?.path;
        if (!path || typeof path !== 'string') return { error: 'path (absolute) to a grade.json required' };
        let grade: any;
        try {
          grade = await invoke('chroma_load_grade', { path });
        } catch (e: any) {
          return { error: String(e?.message || e) };
        }
        const next = normalizeLoadedAdjustments(grade?.adjustments ?? INITIAL_ADJUSTMENTS);
        setAdjustments(() => next);
        chroma().bumpFrameNonce();

        // v1 does NOT auto-switch clips — just flag a source mismatch.
        const cv = chroma().videoInfo;
        const open = (cv?.path || editor().selectedImage?.path || '').split(/[\\/]/).pop() || null;
        const want = grade?.shot?.source ?? null;
        const mismatch = want && open && want !== open ? { expected: want, open } : null;
        return { applied: true, shot: grade?.shot ?? null, sourceMismatch: mismatch };
      },

      set_primary: (a) => {
        const { clean, rejected } = filterKnobs(a?.patch ?? a ?? {});
        if (Object.keys(clean).length === 0) {
          return { error: `no valid knobs. allowed: ${[...PRIMARY_KNOBS].join(', ')}`, rejected };
        }
        setAdjustments((prev: Adjustments) => deepMerge(prev, clean));
        return rejected.length ? { applied: clean, rejected } : { applied: clean };
      },

      set_curve: (a) => {
        const channel = a?.channel ?? 'luma';
        const points = a?.points ?? [];
        setAdjustments((prev: Adjustments) => ({
          ...prev,
          curves: { ...prev.curves, [channel]: points },
          pointCurves: { ...(prev.pointCurves || prev.curves), [channel]: points },
        }));
        return { channel, points };
      },

      set_color_grade: (a) => {
        const CG_ZONES = new Set(['shadows', 'midtones', 'highlights', 'global']);
        const raw = a?.patch ?? a ?? {};
        const patch: Record<string, any> = {};
        const rejected: string[] = [];
        for (const [k, v] of Object.entries(raw)) {
          if (k === 'balance' || k === 'blending') {
            if (typeof v === 'number') patch[k] = v;
            else rejected.push(k);
          } else if (CG_ZONES.has(k) && v && typeof v === 'object') {
            const z: any = {};
            for (const [zk, zv] of Object.entries(v as any)) {
              if (['hue', 'saturation', 'luminance'].includes(zk) && typeof zv === 'number') z[zk] = zv;
            }
            if (Object.keys(z).length) patch[k] = z;
          } else rejected.push(k);
        }
        if (Object.keys(patch).length === 0) {
          return { error: 'no valid fields. allowed: shadows/midtones/highlights/global {hue,saturation,luminance}, balance, blending', rejected };
        }
        setAdjustments((prev: Adjustments) => ({ ...prev, colorGrading: deepMerge(prev.colorGrading, patch) }));
        return rejected.length ? { colorGrading: editor().adjustments.colorGrading, rejected } : { colorGrading: editor().adjustments.colorGrading };
      },

      seek: async (a) => {
        const cv = chroma().videoInfo;
        if (!cv?.isVideo) return { error: 'no video loaded' };
        const frame = Math.max(0, Math.min(cv.frameCount - 1, Math.round(a?.frame ?? 0)));
        await invoke('chroma_seek', { frame });
        chroma().setCurrentFrame(frame);
        chroma().bumpFrameNonce();
        return { frame };
      },

      list_masks: () => ({ masks: maskSummary() }),

      // Create a NEW mask container with one geometric sub-mask (radial | linear).
      // The agent's path to a plain shape mask: `add_subject_mask` / `apply_haze`
      // make the AI mattes, `add_component` only carves into an existing container.
      add_mask: (a) => {
        const img = editor().selectedImage;
        const w = img?.width ?? 1000;
        const h = img?.height ?? 1000;
        const TYPE_MAP: Record<string, Mask> = { radial: Mask.Radial, linear: Mask.Linear };
        const type = TYPE_MAP[String(a?.type ?? 'radial').toLowerCase()];
        if (!type) return { error: 'type must be one of: radial, linear' };
        const sub: any = createSubMask(type, { width: w, height: h }, SubMaskMode.Additive);
        const g = a?.geometry ?? a ?? {};
        if (type === Mask.Radial) {
          sub.parameters = {
            ...sub.parameters,
            centerX: g.cx ?? g.centerX ?? sub.parameters.centerX,
            centerY: g.cy ?? g.centerY ?? sub.parameters.centerY,
            radiusX: g.rx ?? g.radiusX ?? sub.parameters.radiusX,
            radiusY: g.ry ?? g.radiusY ?? sub.parameters.radiusY,
            rotation: g.rotation ?? 0,
            feather: g.feather ?? sub.parameters.feather,
          };
        } else {
          sub.parameters = {
            ...sub.parameters,
            startX: g.startX ?? sub.parameters.startX,
            startY: g.startY ?? sub.parameters.startY,
            endX: g.endX ?? sub.parameters.endX,
            endY: g.endY ?? sub.parameters.endY,
            range: g.range ?? sub.parameters.range,
          };
        }
        const count = (editor().adjustments.masks?.length || 0) + 1;
        const container: MaskContainer = {
          ...INITIAL_MASK_CONTAINER,
          adjustments: JSON.parse(JSON.stringify(INITIAL_MASK_ADJUSTMENTS)),
          id: uuidv4(),
          name: `Mask ${count}`,
          subMasks: [sub],
        };
        setAdjustments((prev: Adjustments) => ({ ...prev, masks: [...(prev.masks || []), container] }));
        editor().setEditor({ activeMaskContainerId: container.id, activeMaskId: sub.id });
        return { maskId: container.id, subMaskId: sub.id, type };
      },

      // Interactive relight (D-046). Mirrors add_mask/list_masks/delete_mask's
      // shape for the "Relight" layer — the agent's path to a light without
      // driving the canvas puck (`RelightPuckLayer`) directly.
      list_relight_lights: () => ({
        lights: editor().adjustments.relightLights || [],
        depthDir: editor().adjustments.relightDepthDir ?? null,
      }),

      add_relight_light: (a) => {
        const kind = String(a?.kind ?? 'key').toLowerCase();
        if (!['key', 'fill', 'rim', 'ambient'].includes(kind)) {
          return { error: 'kind must be one of: key, fill, rim, ambient' };
        }
        const light = createRelightLight(kind as any);
        if (typeof a?.x === 'number') light.x = a.x;
        if (typeof a?.y === 'number') light.y = a.y;
        if (typeof a?.radius === 'number') light.radius = a.radius;
        if (typeof a?.intensity === 'number') light.intensity = a.intensity;
        if (typeof a?.color === 'string') light.color = a.color;
        setAdjustments((prev: Adjustments) => ({
          ...prev,
          relightLights: [...(prev.relightLights || []), light],
        }));
        editor().setEditor({ activeRelightLightId: light.id });
        return { light };
      },

      set_relight_light: (a) => {
        const id = a?.id;
        if (typeof id !== 'string') return { error: 'id (relight light id) required' };
        const patch: Record<string, any> = {};
        for (const k of ['x', 'y', 'radius', 'intensity', 'color', 'visible', 'kind']) {
          if (a?.[k] !== undefined) patch[k] = a[k];
        }
        let found = false;
        setAdjustments((prev: Adjustments) => ({
          ...prev,
          relightLights: (prev.relightLights || []).map((l) => {
            if (l.id !== id) return l;
            found = true;
            return { ...l, ...patch };
          }),
        }));
        if (!found) return { error: `no relight light with id ${id}` };
        return { id, patch };
      },

      delete_relight_light: (a) => {
        const id = a?.id;
        if (typeof id !== 'string') return { error: 'id (relight light id) required' };
        setAdjustments((prev: Adjustments) => ({
          ...prev,
          relightLights: (prev.relightLights || []).filter((l) => l.id !== id),
        }));
        if (editor().activeRelightLightId === id) editor().setEditor({ activeRelightLightId: null });
        return { id, deleted: true };
      },

      add_subject_mask: async (a) => {
        const img = editor().selectedImage;
        const w = img?.width ?? 1000;
        const h = img?.height ?? 1000;
        const bbox: number[] = Array.isArray(a?.bbox) && a.bbox.length === 4
          ? a.bbox
          : [w * 0.25, h * 0.12, w * 0.75, h * 0.98]; // full-ish frame default
        const [x0, y0, x1, y1] = bbox;
        const mode = a?.mode ? MODE_MAP[String(a.mode).toLowerCase()] : SubMaskMode.Additive;
        if (a?.mode && !mode) return { error: `mode must be one of: ${MODE_WORDS}` };

        const sub: any = createSubMask(Mask.AiSubject, { width: w, height: h }, mode);
        sub.parameters = { ...sub.parameters, startX: x0, startY: y0, endX: x1, endY: y1 };

        const count = (editor().adjustments.masks?.length || 0) + 1;
        const container: MaskContainer = {
          ...INITIAL_MASK_CONTAINER,
          adjustments: JSON.parse(JSON.stringify(INITIAL_MASK_ADJUSTMENTS)),
          id: uuidv4(),
          name: `Mask ${count}`,
          subMasks: [sub],
        };
        setAdjustments((prev: Adjustments) => ({ ...prev, masks: [...(prev.masks || []), container] }));
        editor().setEditor({ activeMaskContainerId: container.id, activeMaskId: sub.id });

        // routes to `chroma_subject_mask` on a video (SAM 2 sidecar), ONNX SAM on a still
        await ai.handleGenerateAiMask(sub.id, { x: x0, y: y0 }, { x: x1, y: y1 });
        return { maskId: container.id, subMaskId: sub.id, bbox, mode: sub.mode };
      },

      // Add a sub-mask (component) to an EXISTING mask container — the agent's
      // equivalent of the "Add / Subtract from / Intersect with Mask" menu. A
      // subtractive Subject component carves a SAM region out of the container's
      // matte; a subtractive Radial/Linear carves a geometric region. This is
      // the include/exclude refinement path (D-023) — no bespoke +/- point op.
      add_component: async (a) => {
        const maskId = a?.mask_id ?? a?.maskId;
        const container = findContainer(maskId);
        if (!container) return { error: `mask not found: ${maskId}` };

        const TYPE_MAP: Record<string, Mask> = {
          subject: Mask.AiSubject,
          'ai-subject': Mask.AiSubject,
          radial: Mask.Radial,
          linear: Mask.Linear,
          brush: Mask.Brush,
        };
        const type = TYPE_MAP[String(a?.type ?? '').toLowerCase()];
        if (!type) return { error: 'type must be one of: subject, radial, linear, brush' };
        // default subtract — the reason to add a component to an existing mask is
        // almost always to carve something out.
        const mode = a?.mode ? MODE_MAP[String(a.mode).toLowerCase()] : SubMaskMode.Subtractive;
        if (a?.mode && !mode) return { error: `mode must be one of: ${MODE_WORDS}` };

        const img = editor().selectedImage;
        const w = img?.width ?? 1000;
        const h = img?.height ?? 1000;
        const sub: any = createSubMask(type, { width: w, height: h }, mode);
        const g = a?.geometry ?? {};

        if (type === Mask.AiSubject) {
          const bbox: number[] = Array.isArray(a?.bbox) && a.bbox.length === 4
            ? a.bbox
            : [w * 0.25, h * 0.12, w * 0.75, h * 0.98];
          const [x0, y0, x1, y1] = bbox;
          sub.parameters = { ...sub.parameters, startX: x0, startY: y0, endX: x1, endY: y1 };
        } else if (type === Mask.Radial) {
          sub.parameters = {
            ...sub.parameters,
            centerX: g.cx ?? g.centerX ?? sub.parameters.centerX,
            centerY: g.cy ?? g.centerY ?? sub.parameters.centerY,
            radiusX: g.rx ?? g.radiusX ?? sub.parameters.radiusX,
            radiusY: g.ry ?? g.radiusY ?? sub.parameters.radiusY,
            rotation: g.rotation ?? 0,
            feather: g.feather ?? sub.parameters.feather,
          };
        } else if (type === Mask.Linear) {
          sub.parameters = {
            ...sub.parameters,
            startX: g.startX ?? sub.parameters.startX,
            startY: g.startY ?? sub.parameters.startY,
            endX: g.endX ?? sub.parameters.endX,
            endY: g.endY ?? sub.parameters.endY,
            range: g.range ?? sub.parameters.range,
          };
        }

        setAdjustments((prev: Adjustments) => ({
          ...prev,
          masks: (prev.masks || []).map((c: MaskContainer) =>
            c.id === maskId ? { ...c, subMasks: [...(c.subMasks || []), sub] } : c,
          ),
        }));
        editor().setEditor({ activeMaskContainerId: maskId, activeMaskId: sub.id });

        if (type === Mask.AiSubject) {
          await ai.handleGenerateAiMask(
            sub.id,
            { x: sub.parameters.startX, y: sub.parameters.startY },
            { x: sub.parameters.endX, y: sub.parameters.endY },
          );
        }
        return { maskId, subMaskId: sub.id, type, mode: sub.mode };
      },

      set_submask_mode: (a) => {
        const subMaskId = a?.sub_mask_id ?? a?.subMaskId;
        if (!subMaskId) return { error: 'sub_mask_id required' };
        const mode = MODE_MAP[String(a?.mode ?? '').toLowerCase()];
        if (!mode) return { error: `mode must be one of: ${MODE_WORDS}` };
        let hit = false;
        setAdjustments((prev: Adjustments) => ({
          ...prev,
          masks: (prev.masks || []).map((c: MaskContainer) => ({
            ...c,
            subMasks: (c.subMasks || []).map((s: SubMask) => {
              if (s.id === subMaskId) {
                hit = true;
                return { ...s, mode };
              }
              return s;
            }),
          })),
        }));
        return hit ? { subMaskId, mode } : { error: `sub-mask not found: ${subMaskId}` };
      },

      // ---- mask keyframes (round 3, D-034) --------------------------------
      // Animate a shape sub-mask's geometry across source frames without SAM
      // tracking: seek to frame 0, position a radial over the face,
      // add_mask_keyframe; seek to frame 90, reposition, add_mask_keyframe —
      // the mask now glides between the keys on scrub / playback / export.
      // Geometry only (centre / radius / rotation / endpoints / brush points);
      // grade adjustments are not keyframed. A tracked sub-mask (chromaTrackDir)
      // can't also be keyframed — tracked wins.
      add_mask_keyframe: (a) => {
        const maskId = a?.mask_id ?? a?.maskId;
        const subId = a?.sub_mask_id ?? a?.subMaskId;
        const container = findContainer(maskId);
        const sub = container?.subMasks?.find((s: SubMask) => s.id === subId);
        if (!sub) return { error: `sub-mask not found: mask_id=${maskId} sub_mask_id=${subId}` };
        if (!isKeyframeableMaskType(sub.type)) {
          return { error: `keyframes are only for shape sub-masks (radial / linear / brush); this is "${sub.type}"` };
        }
        if ((sub.parameters as any)?.chromaTrackDir) {
          return { error: 'this sub-mask is AI-tracked (chromaTrackDir) — tracked and keyframed are mutually exclusive' };
        }
        const cv = chroma().videoInfo;
        const frame = Math.max(
          0,
          Math.round(typeof a?.frame === 'number' ? a.frame : chroma().currentFrame ?? 0),
        );
        const geometry = snapshotGeometry(sub.type, sub.parameters || {});
        const nextParams = upsertKeyframe(sub.parameters || {}, frame, geometry);
        setAdjustments((prev: Adjustments) => ({
          ...prev,
          masks: (prev.masks || []).map((c: MaskContainer) =>
            c.id === maskId
              ? { ...c, subMasks: (c.subMasks || []).map((s: SubMask) => (s.id === subId ? { ...s, parameters: nextParams } : s)) }
              : c,
          ),
        }));
        chroma().bumpFrameNonce();
        return {
          maskId,
          subMaskId: subId,
          frame,
          geometry,
          keyframes: parseKeyframes(nextParams).map((k) => k.frame),
          note: cv?.isVideo ? undefined : 'no video loaded — keyframes only take effect on a clip',
        };
      },

      list_mask_keyframes: (a) => {
        const maskId = a?.mask_id ?? a?.maskId;
        const subId = a?.sub_mask_id ?? a?.subMaskId;
        const container = findContainer(maskId);
        const sub = container?.subMasks?.find((s: SubMask) => s.id === subId);
        if (!sub) return { error: `sub-mask not found: mask_id=${maskId} sub_mask_id=${subId}` };
        const kfs = parseKeyframes(sub.parameters || {});
        return {
          maskId,
          subMaskId: subId,
          type: sub.type,
          tracked: !!(sub.parameters as any)?.chromaTrackDir,
          keyframes: kfs.map((k) => ({ frame: k.frame, params: k.params })),
        };
      },

      clear_mask_keyframe: (a) => {
        const maskId = a?.mask_id ?? a?.maskId;
        const subId = a?.sub_mask_id ?? a?.subMaskId;
        const container = findContainer(maskId);
        const sub = container?.subMasks?.find((s: SubMask) => s.id === subId);
        if (!sub) return { error: `sub-mask not found: mask_id=${maskId} sub_mask_id=${subId}` };
        if (typeof a?.frame !== 'number') return { error: 'frame (a keyframe frame from list_mask_keyframes) required' };
        const nextParams = removeKeyframe(sub.parameters || {}, a.frame);
        setAdjustments((prev: Adjustments) => ({
          ...prev,
          masks: (prev.masks || []).map((c: MaskContainer) =>
            c.id === maskId
              ? { ...c, subMasks: (c.subMasks || []).map((s: SubMask) => (s.id === subId ? { ...s, parameters: nextParams } : s)) }
              : c,
          ),
        }));
        chroma().bumpFrameNonce();
        return { maskId, subMaskId: subId, removed: Math.round(a.frame), keyframes: parseKeyframes(nextParams).map((k) => k.frame) };
      },

      clear_mask_keyframes: (a) => {
        const maskId = a?.mask_id ?? a?.maskId;
        const subId = a?.sub_mask_id ?? a?.subMaskId;
        const container = findContainer(maskId);
        const sub = container?.subMasks?.find((s: SubMask) => s.id === subId);
        if (!sub) return { error: `sub-mask not found: mask_id=${maskId} sub_mask_id=${subId}` };
        const nextParams = clearKeyframes(sub.parameters || {});
        setAdjustments((prev: Adjustments) => ({
          ...prev,
          masks: (prev.masks || []).map((c: MaskContainer) =>
            c.id === maskId
              ? { ...c, subMasks: (c.subMasks || []).map((s: SubMask) => (s.id === subId ? { ...s, parameters: nextParams } : s)) }
              : c,
          ),
        }));
        chroma().bumpFrameNonce();
        return { maskId, subMaskId: subId, cleared: true };
      },

      // Depth-haze preset (roadmap 4 / D-024): one action → a "Depth Haze" mask
      // whose matte is an inverted full-range depth mask (weight == distance) and
      // whose grade is negative-dehaze + desat + black/shadow lift, scaled by
      // `amount`. Milky, receding background; punchy subject.
      apply_haze: async (a) => {
        const amount = typeof a?.amount === 'number' ? a.amount : 1.0;
        const protectSubject = a?.protect_subject ?? a?.protectSubject ?? true;
        const tracked = a?.tracked ?? false;
        const res: any = await ai.handleAddDepthHaze({ amount, protectSubject, tracked });
        return res ?? { error: 'depth haze failed' };
      },

      track_subject: async (a) => {
        const subMaskId = a?.sub_mask_id ?? a?.subMaskId;
        if (!subMaskId) return { error: 'sub_mask_id required' };
        const mode = a?.mode === 'quality' ? 'quality' : 'fast';
        await ai.handleTrackSubject(subMaskId, mode);
        return { subMaskId, mode };
      },

      // D-036: precompute a temporally-consistent per-frame depth track (VDA) for
      // the clip and point a depth sub-mask at it. With no sub_mask_id, tracks
      // the active depth sub-mask (the "Depth Haze" one). NON-blocking — the pass
      // is minutes on a long clip; it returns the job immediately and the poll
      // loop (fire-and-forget) sets `chromaDepthDir` on completion + updates the
      // store progress. Poll `depth_track_status`.
      depth_track: async (a) => {
        let subMaskId = a?.sub_mask_id ?? a?.subMaskId;
        if (!subMaskId) {
          const { adjustments } = useEditorStore.getState();
          const depthSub = (adjustments?.masks || [])
            .flatMap((m: MaskContainer) => m.subMasks || [])
            .find((s: SubMask) => s.type === Mask.AiDepth);
          subMaskId = depthSub?.id;
        }
        if (!subMaskId) return { error: 'no depth sub-mask — run apply_haze first, or pass sub_mask_id' };
        const job: any = await invoke('chroma_depth_track', {
          fromFrame: a?.from_frame ?? a?.fromFrame ?? null,
          toFrame: a?.to_frame ?? a?.toFrame ?? null,
          step: a?.step ?? null,
          inputSize: a?.input_size ?? a?.inputSize ?? null,
        });
        if (job?.error) return job;
        chroma().setDepthTrackProgress({ done: 0, total: job?.total ?? 0 });
        // fire-and-forget poll: keeps the store progress fresh + stamps the dir
        (async () => {
          try {
            for (;;) {
              await new Promise((r) => setTimeout(r, 2000));
              const st: any = await invoke('chroma_depth_track_status', { jobId: job.job_id });
              if (st?.total) chroma().setDepthTrackProgress({ done: st.done ?? 0, total: st.total });
              if (st?.state === 'done') {
                const cur = useEditorStore
                  .getState()
                  .adjustments?.masks?.flatMap((m: MaskContainer) => m.subMasks || [])
                  .find((s: SubMask) => s.id === subMaskId);
                if (job?.dir) ai.updateSubMask(subMaskId, { parameters: { ...(cur?.parameters || {}), chromaDepthDir: job.dir } });
                chroma().bumpFrameNonce();
                break;
              }
              if (st?.state === 'error' || st?.state === 'cancelled' || st?.state === 'unknown') break;
            }
          } finally {
            chroma().setDepthTrackProgress(null);
          }
        })();
        return { started: true, subMaskId, jobId: job?.job_id, dir: job?.dir, total: job?.total ?? 0 };
      },

      depth_track_status: () => {
        const p = chroma().depthTrackProgress;
        const { adjustments } = useEditorStore.getState();
        const tracked = (adjustments?.masks || [])
          .flatMap((m: MaskContainer) => m.subMasks || [])
          .some((s: SubMask) => s.type === Mask.AiDepth && !!(s.parameters as any)?.chromaDepthDir);
        return { running: p != null, done: p?.done ?? 0, total: p?.total ?? 0, tracked };
      },

      set_mask_adjust: (a) => {
        const maskId = a?.mask_id ?? a?.maskId;
        if (!findContainer(maskId)) return { error: `mask not found: ${maskId}` };
        const { clean, rejected } = filterKnobs(a?.patch ?? {}, MASK_ONLY_KNOBS);
        if (Object.keys(clean).length === 0) {
          return {
            error: `no valid knobs. allowed: ${[...PRIMARY_KNOBS, ...MASK_ONLY_KNOBS].join(', ')}`,
            rejected,
          };
        }
        setAdjustments((prev: Adjustments) => ({
          ...prev,
          masks: (prev.masks || []).map((c: MaskContainer) =>
            c.id === maskId ? { ...c, adjustments: deepMerge(c.adjustments, clean) } : c,
          ),
        }));
        return rejected.length ? { maskId, applied: clean, rejected } : { maskId, applied: clean };
      },

      invert_mask: (a) => {
        const subId = a?.sub_mask_id ?? a?.subMaskId;
        const maskId = a?.mask_id ?? a?.maskId;
        let hit = false;
        setAdjustments((prev: Adjustments) => ({
          ...prev,
          masks: (prev.masks || []).map((c: MaskContainer) => {
            if (maskId && c.id === maskId) {
              hit = true;
              return { ...c, invert: !c.invert };
            }
            return {
              ...c,
              subMasks: (c.subMasks || []).map((s: SubMask) => {
                if (subId && s.id === subId) {
                  hit = true;
                  return { ...s, invert: !s.invert };
                }
                return s;
              }),
            };
          }),
        }));
        return hit ? { inverted: true } : { error: 'mask not found' };
      },

      delete_mask: (a) => {
        const maskId = a?.mask_id ?? a?.maskId;
        if (!findContainer(maskId)) return { error: `mask not found: ${maskId}` };
        ai.handleDeleteMaskContainer(maskId);
        return { deleted: maskId };
      },

      // ---- scopes / grade-by-the-numbers (roadmap item 1, D-021) -----------
      inspect_color: async (a) => {
        const b64 = await captureFrame();
        if (!b64) return { error: 'could not capture the current frame' };
        const id = await decodeToImageData(`data:image/jpeg;base64,${b64}`);
        if (!id) return { error: 'could not decode the captured frame' };

        const scopes = computeScopes(id);
        const [parade, vectorscope] = await Promise.all([
          renderParade(id).catch(() => null),
          renderVectorscope(id).catch(() => null),
        ]);
        const out: any = {
          scopes,
          parade,
          vectorscope,
          histogram: editor().histogram,
          frameSize: scopes.frameSize,
        };

        const refPath: string | undefined = a?.reference;
        if (refPath) {
          try {
            const bytes = await invoke<number[] | Uint8Array>('generate_preview_for_path', {
              path: refPath,
              jsAdjustments: {},
            });
            const blob = new Blob([new Uint8Array(bytes as any)], { type: 'image/jpeg' });
            const url = URL.createObjectURL(blob);
            const refId = await decodeToImageData(url);
            URL.revokeObjectURL(url);
            if (refId) {
              const refScopes: Scopes = computeScopes(refId);
              out.reference = { path: refPath, scopes: refScopes };
              out.gap = computeGap(scopes, refScopes);
            } else {
              out.reference = { path: refPath, error: 'could not decode reference image' };
            }
          } catch (e: any) {
            out.reference = { path: refPath, error: String(e?.message || e) };
          }
        }
        return out;
      },

      sample: async (a) => {
        const b64 = await captureFrame();
        if (!b64) return { error: 'could not capture the current frame' };
        const id = await decodeToImageData(`data:image/jpeg;base64,${b64}`);
        if (!id) return { error: 'could not decode the captured frame' };
        return { frameSize: [id.width, id.height], sample: samplePoint(id, a?.x ?? 0, a?.y ?? 0) };
      },

      sample_region: async (a) => {
        const b64 = await captureFrame();
        if (!b64) return { error: 'could not capture the current frame' };
        const id = await decodeToImageData(`data:image/jpeg;base64,${b64}`);
        if (!id) return { error: 'could not decode the captured frame' };
        return {
          frameSize: [id.width, id.height],
          sample: sampleRegion(id, a?.x ?? 0, a?.y ?? 0, a?.w ?? 16, a?.h ?? 16),
        };
      },

      // ---- match_to_reference — auto-grade toward a reference (round-2 item 1,
      // D-026). Measure the scope gap to a reference image, apply a DAMPED
      // primary correction (exposure / temperature / tint / contrast /
      // saturation), re-measure, iterate until the combined gap is < tolerance
      // or max_iters is hit. Merges into PRIMARY, not a new layer — a match is a
      // balance, and creative/curve/mask work stays separate. Gap→knob
      // heuristics + damping: docs/notes/match-reference.md.
      match_reference: async (a) => {
        const refPath: string | undefined = a?.reference;
        if (!refPath || typeof refPath !== 'string') {
          return { error: 'reference (absolute image path) required' };
        }
        let strength = typeof a?.strength === 'number' ? a.strength : 1.0;
        const maxIters = Math.max(1, Math.min(12, Math.round(a?.max_iters ?? a?.maxIters ?? 4)));
        const tolerance = typeof a?.tolerance === 'number' ? a.tolerance : 3.0;

        const r2 = (v: number) => Math.round(v * 100) / 100;
        const r3 = (v: number) => Math.round(v * 1000) / 1000;
        const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

        // --- load the reference through the same neutral-adjustments path
        //     inspect_color uses, then measure it once (it doesn't change).
        let refScopes: Scopes;
        try {
          const bytes = await invoke<number[] | Uint8Array>('generate_preview_for_path', {
            path: refPath,
            jsAdjustments: {},
          });
          const blob = new Blob([new Uint8Array(bytes as any)], { type: 'image/jpeg' });
          const url = URL.createObjectURL(blob);
          const refId = await decodeToImageData(url);
          URL.revokeObjectURL(url);
          if (!refId) return { error: `could not decode reference image: ${refPath}` };
          refScopes = computeScopes(refId);
        } catch (e: any) {
          return { error: `could not load reference (${refPath}): ${String(e?.message || e)}` };
        }

        const measureOnce = async (): Promise<Scopes | null> => {
          const b64 = await captureFrame();
          if (!b64) return null;
          const id = await decodeToImageData(`data:image/jpeg;base64,${b64}`);
          if (!id) return null;
          try {
            return computeScopes(id);
          } catch {
            return null;
          }
        };
        // the numbers we steer on, off a 512-px JPEG downsample (D-021), carry a
        // few units of noise — enough to swamp `tolerance` near the end. Average
        // two captures to halve it.
        const M = ['bp', 'wp', 'warm', 'gm', 'sat', 'mid'] as const;
        type Meas = Record<(typeof M)[number], number>;
        const flat = (s: Scopes): Meas => ({
          bp: s.blackPoint, wp: s.whitePoint,
          warm: s.cast.warmCool, gm: s.cast.greenMagenta,
          sat: s.saturation, mid: s.zones.mids.luma,
        });
        const measure = async (): Promise<Meas | null> => {
          const a = await measureOnce();
          if (!a) return null;
          const b = await measureOnce();
          const fa = flat(a);
          if (!b) return fa;
          const fb = flat(b);
          const out = {} as Meas;
          for (const k of M) out[k] = (fa[k] + fb[k]) / 2;
          return out;
        };

        const ref = flat(refScopes);

        // combined scalar gap magnitude — the convergence signal. Weights chosen
        // so an ~0.4 EV / ~10-unit cast / ~0.1 sat / ~10-code point error each
        // land around the same ballpark. See docs/notes/match-reference.md.
        const gapOf = (s: Meas) => {
          const dExp = ((ref.mid - s.mid) / 64) * 0.5;
          const dWarm = ref.warm - s.warm;
          const dGM = ref.gm - s.gm;
          const dSat = ref.sat - s.sat;
          const dBlack = ref.bp - s.bp;
          const dWhite = ref.wp - s.wp;
          const mag =
            Math.abs(dExp) * 8 +
            Math.abs(dWarm) +
            Math.abs(dGM) +
            Math.abs(dSat) * 20 +
            Math.abs(dBlack) +
            Math.abs(dWhite);
          return { mag: r2(mag), dExp, dWarm, dGM, dSat, dBlack, dWhite };
        };

        const a0 = editor().adjustments as any;
        const start = {
          exposure: a0.exposure ?? 0,
          contrast: a0.contrast ?? 0,
          temperature: a0.temperature ?? 0,
          tint: a0.tint ?? 0,
          saturation: a0.saturation ?? 0,
        };
        const cur = { ...start };

        // a one-line English reading off a fresh single measure (computeGap wants
        // full Scopes; the loop steers on the averaged Meas).
        const readingNow = async (): Promise<string> => {
          const s = await measureOnce();
          return s ? computeGap(s, refScopes).reading : '(no reading)';
        };

        let subj = await measure();
        if (!subj) return { error: 'could not capture the current frame — is a clip open?' };

        const gap0 = gapOf(subj);
        if (gap0.mag < tolerance) {
          return {
            converged: true,
            iterations: 0,
            gap_before: gap0.mag,
            gap_after: gap0.mag,
            gap_reading: await readingNow(),
            applied: {},
            merged_into: 'primary',
            trace: [],
            note: 'already within tolerance — no change made.',
          };
        }

        // per-knob gain + per-step ceiling. exposure/temperature/tint target a
        // scope value directly and rarely cascade, so they move freely; contrast
        // and saturation amplify cast + clip channels (they poison the next
        // measurement), so they get a small gain and a tight ceiling. The
        // temperature gain is back-derived from the app's WB-picker math
        // (ImageCanvas: normalized R-B imbalance × ~125 → temp units) and the
        // measured temp↔warmCool slope on this footage (~1.2). See D-026.
        const KNOB = {
          exposure:    { gain: 1.0,  cap: 0.6, lo: -5,   hi: 5   },
          temperature: { gain: 0.9,  cap: 34,  lo: -100, hi: 100 },
          tint:        { gain: 1.3,  cap: 22,  lo: -100, hi: 100 },
          contrast:    { gain: 0.45, cap: 9,   lo: -100, hi: 100 },
          saturation:  { gain: 130,  cap: 13,  lo: -100, hi: 100 },
        };
        const capped = (raw: number, k: keyof typeof KNOB) =>
          clamp(raw, -KNOB[k].cap, KNOB[k].cap);
        const applyCur = async (c: typeof cur) => {
          setAdjustments((prev: Adjustments) =>
            deepMerge(prev, {
              exposure: r3(c.exposure), temperature: r3(c.temperature),
              tint: r3(c.tint), contrast: r3(c.contrast), saturation: r3(c.saturation),
            }),
          );
          await sleep(450); // let the re-render settle
        };

        const trace: any[] = [];
        let iterations = 0;
        let converged = false;
        let stalls = 0;
        let bestMag = gap0.mag;
        let bestCur = { ...cur };
        let curMag = gap0.mag;
        const deadline = Date.now() + 16000; // stay well inside the 20s control-server bridge

        for (let i = 0; i < maxIters; i++) {
          const g = gapOf(subj);
          if (g.mag < tolerance) {
            converged = true;
            break;
          }
          if (Date.now() > deadline || stalls >= 2) break;

          // near-constant damping (a slow decay) — the loop tracks a shrinking
          // gap, so an aggressive per-iter decay double-counts and stalls short
          // of the target. Overshoot is handled by the roll-back below, not by
          // starving every step.
          const damp = 0.78 * Math.pow(0.95, i);
          const eff = strength * damp;

          const spreadDiff = g.dWhite - g.dBlack;
          // exposure answers the mids-luma gap AND the common-mode black/white
          // shift (both points low ⇒ lift exposure); contrast answers only the
          // spread difference, which pivots on mid-grey.
          const expTarget = g.dExp + (g.dBlack + g.dWhite) * 0.004;
          const dExpKnob = capped(expTarget * KNOB.exposure.gain * eff, 'exposure');
          const dTempKnob = capped(g.dWarm * KNOB.temperature.gain * eff, 'temperature');
          const dTintKnob = capped(g.dGM * KNOB.tint.gain * eff, 'tint');
          const dContrastKnob = capped(spreadDiff * KNOB.contrast.gain * eff, 'contrast');
          // saturation off the raw HSV-sat difference (0–1), not the ratio — a
          // ratio blows up when the subject starts near-greyscale.
          const dSatKnob = capped(g.dSat * KNOB.saturation.gain * eff, 'saturation');

          const prevCur = { ...cur };
          cur.exposure = clamp(cur.exposure + dExpKnob, KNOB.exposure.lo, KNOB.exposure.hi);
          cur.temperature = clamp(cur.temperature + dTempKnob, KNOB.temperature.lo, KNOB.temperature.hi);
          cur.tint = clamp(cur.tint + dTintKnob, KNOB.tint.lo, KNOB.tint.hi);
          cur.contrast = clamp(cur.contrast + dContrastKnob, KNOB.contrast.lo, KNOB.contrast.hi);
          cur.saturation = clamp(cur.saturation + dSatKnob, KNOB.saturation.lo, KNOB.saturation.hi);

          await applyCur(cur);
          const next = await measure();
          if (!next) {
            trace.push({ iter: i + 1, error: 'capture failed' });
            break;
          }
          const ng = gapOf(next);
          const step: any = {
            iter: i + 1,
            damp: r3(damp),
            gapMag_before: r2(curMag),
            gapMag_after: r2(ng.mag),
            patch: {
              exposure: r3(dExpKnob), temperature: r3(dTempKnob), tint: r3(dTintKnob),
              contrast: r3(dContrastKnob), saturation: r3(dSatKnob),
            },
          };

          if (ng.mag < curMag - 0.5) {
            // improvement — keep it
            subj = next;
            curMag = ng.mag;
            iterations += 1;
            if (ng.mag < bestMag) {
              bestMag = ng.mag;
              bestCur = { ...cur };
            }
            step.cumulative = {
              exposure: r3(cur.exposure), temperature: r3(cur.temperature), tint: r3(cur.tint),
              contrast: r3(cur.contrast), saturation: r3(cur.saturation),
            };
            trace.push(step);
            if (ng.mag < tolerance) {
              converged = true;
              break;
            }
          } else {
            // over-shoot / no progress — roll this step back, damp harder
            Object.assign(cur, prevCur);
            await applyCur(cur);
            const back = await measure();
            if (back) {
              subj = back;
              curMag = gapOf(back).mag;
            }
            strength *= 0.5;
            stalls += 1;
            step.reverted = true;
            trace.push(step);
          }
        }

        // land on the best grade seen, not necessarily the last step
        if (bestCur.exposure !== cur.exposure || bestCur.temperature !== cur.temperature ||
            bestCur.tint !== cur.tint || bestCur.contrast !== cur.contrast ||
            bestCur.saturation !== cur.saturation) {
          Object.assign(cur, bestCur);
          await applyCur(cur);
          subj = (await measure()) ?? subj;
        }
        const finalMag = gapOf(subj).mag;
        converged = converged || finalMag < tolerance;

        return {
          converged,
          iterations,
          gap_before: r2(gap0.mag),
          gap_after: r2(finalMag),
          gap_reading: await readingNow(),
          applied: {
            exposure: r3(cur.exposure - start.exposure),
            contrast: r3(cur.contrast - start.contrast),
            temperature: r3(cur.temperature - start.temperature),
            tint: r3(cur.tint - start.tint),
            saturation: r3(cur.saturation - start.saturation),
          },
          merged_into: 'primary',
          trace,
          note: 'primary balance only — creative look, curves, and mask work are separate. Inspect the result.',
        };
      },

      // ---- export (roadmap item 2, D-022) --------------------------------
      // `kind`: prores | h264 | cube. Video export runs in the background —
      // this op kicks it off and returns; poll `export_progress`.
      export: async (a) => {
        const kind = a?.kind ?? 'prores';
        const jsAdjustments = useEditorStore.getState().adjustments;
        if (kind === 'cube') {
          return await invoke('chroma_bake_lut', {
            outPath: a?.path ?? null,
            size: a?.size ?? null,
            jsAdjustments,
          });
        }
        const cv = chroma().videoInfo;
        if (!cv?.isVideo) return { error: 'no video loaded' };
        return await invoke('chroma_export_video', {
          outPath: a?.path ?? null,
          fromFrame: a?.from ?? null,
          toFrame: a?.to ?? null,
          codec: kind === 'h264' ? 'h264' : 'prores',
          quality: a?.quality ?? null,
          fpsOverride: a?.fps ?? null,
          jsAdjustments,
        });
      },

      export_progress: async () => await invoke('chroma_export_progress'),

      // ---- request_human — hand back to the user (round-3 item 1, D-032) ----
      // Non-blocking: posts a request (banner + optional canvas ROI) and returns
      // an ack immediately. The agent polls `get_state().pendingHumanRequest`
      // to see whether the user has cleared it.
      request_human: (a) => {
        const reason = typeof a?.reason === 'string' ? a.reason.trim() : '';
        if (!reason) return { error: 'reason (a short string) is required' };
        let roi: { x: number; y: number; w: number; h: number } | null = null;
        const r = a?.roi;
        if (r != null) {
          const num = (v: any) => typeof v === 'number' && Number.isFinite(v);
          if (!r || typeof r !== 'object' || !num(r.x) || !num(r.y) || !num(r.w) || !num(r.h)) {
            return { error: 'roi must be {x, y, w, h} normalized to 0..1 (top-left origin)' };
          }
          const c01 = (v: number) => Math.max(0, Math.min(1, v));
          roi = { x: c01(r.x), y: c01(r.y), w: c01(r.w), h: c01(r.h) };
        }
        useAgentStore.getState().postHumanRequest(reason, roi);
        return {
          posted: true,
          reason,
          roi,
          note: 'the user has been shown a banner (+ an ROI rectangle if given). Call get_state and check pendingHumanRequest — it goes cleared/null once they resume you.',
        };
      },
    };

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const dataUrlToB64 = (u: string | null) =>
      u && u.startsWith('data:') ? u.slice(u.indexOf(',') + 1) : null;

    // The app renders to a native WGPU surface (D-006), so `apply_adjustments`
    // returns WGPU_RENDER and never fills `finalPreviewUrl`. For the agent's
    // eyes we ask for a real headless re-render of the *current* adjustments
    // (masks included) via `generate_uncropped_preview`, which emits
    // `preview-update-uncropped` as a JPEG data URL.
    const captureFrame = async (): Promise<string | null> => {
      let dataUrl: string | null = null;
      const off = await listen('preview-update-uncropped', (e: any) => {
        if (typeof e?.payload === 'string') dataUrl = e.payload;
      });
      try {
        await invoke('generate_uncropped_preview', {
          jsAdjustments: useEditorStore.getState().adjustments,
        });
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && !dataUrl) await sleep(80);
      } catch {
        /* fall through to whatever the store last had */
      } finally {
        off();
      }
      return dataUrlToB64(dataUrl ?? useEditorStore.getState().uncroppedAdjustedPreviewUrl);
    };

    // let the op's setAdjustments-driven re-render + analytics worker settle,
    // then grab the frame + histogram + the compact scope numbers (so the agent
    // gets the new measurement for free after every grade change — roadmap 1).
    const settleAndCapture = async () => {
      await sleep(500);
      const image_b64 = await captureFrame();
      let scopes: Scopes | null = null;
      if (image_b64) {
        const decoded = await decodeToImageData(`data:image/jpeg;base64,${image_b64}`);
        if (decoded) {
          try {
            scopes = computeScopes(decoded);
          } catch {
            /* leave scopes null */
          }
        }
      }
      const s = useEditorStore.getState();
      return {
        adjustments: s.adjustments,
        image_b64,
        histogram: s.histogram,
        scopes,
        frame: useChromaStore.getState().currentFrame ?? 0,
      };
    };

    const unlistenP = listen('chroma://request', async (ev: any) => {
      const payload = ev?.payload || {};
      const { id, op, args } = payload;
      // Motion ops (namespaced `motion_*`) are answered by `@chroma/motion`'s
      // own `useMotionControl` listener, mounted from `MotionTab.tsx` — see
      // docs/notes/motion-mcp-surface-research.md §6. Both listeners see
      // every `chroma://request` event (Tauri doesn't scope `listen()` by
      // payload), so this early return is load-bearing: without it, this
      // handler's synchronous "unknown op" branch below would race ahead of
      // Motion's real (multi-`await`) handler and win the one-shot
      // `chroma://response/<id>` slot with a false "unknown op" error.
      //
      // D-183 — `editor_*` gets the SAME treatment, for the SAME reason, now
      // that `@chroma/editor`'s own `useEditorControl` (mounted from
      // `EditorTab.tsx`) is a second real listener on this same event —
      // this file is deliberately NOT a catch-all any more (see
      // `docs/notes/mcp-architecture.md`'s "every tab opts IN to its own
      // prefix" rule); `get_timeline`/`set_clip_fade` moved OUT of this
      // file's own `OPS` map into that hook, renamed `editor_get_timeline`/
      // `editor_set_clip_fade`, so this skip is also what stops this file
      // from answering "unknown op" for its own former ops under their new
      // names.
      if (typeof op === 'string' && (op.startsWith('motion_') || op.startsWith('editor_'))) return;
      const respond = (body: any) => emit(`chroma://response/${id}`, body);

      const fn = OPS[op];
      if (!fn) {
        respond({ ok: false, error: `unknown op: ${op}` });
        return;
      }

      // read-only ops don't mutate the grade, so skip the settle + re-render.
      const READ_ONLY = new Set([
        'get_state', 'list_masks', 'inspect_color', 'sample', 'sample_region',
        'export', 'export_progress', 'get_grade', 'save_grade', 'request_human',
        'list_shots', 'list_mask_keyframes',
        'list_projects', 'save_project', 'set_project_settings',
      ]);
      // pure navigation — changes the playhead / open clip / active shot, not
      // the grade of the current shot. Not logged to the activity feed (a shot
      // switch restores that shot's own feed — D-033). `settleAndCapture` still
      // runs so the agent gets the new shot's frame back.
      const NAV = new Set(['seek', 'open', 'set_active_shot', 'add_shots', 'open_project', 'new_project']);
      const shouldLog = !READ_ONLY.has(op) && !NAV.has(op);

      try {
        // snapshot the grade + history position BEFORE the op — the feed's diff
        // base and undo target (D-032).
        const before = shouldLog
          ? {
              historyIndex: useEditorStore.getState().historyIndex,
              adjustments: useEditorStore.getState().adjustments,
            }
          : null;

        const result = await fn(args || {});

        const frame = READ_ONLY.has(op)
          ? {
              adjustments: useEditorStore.getState().adjustments,
              histogram: useEditorStore.getState().histogram,
            }
          : await settleAndCapture();

        // ---- record one activity-feed entry per mutating op (D-032) --------
        if (shouldLog && before && !result?.error) {
          try {
            // force the pending debounced pushHistory to land NOW so this op is
            // exactly one history entry (match_reference's N iterations included).
            debouncedSetHistory.flush();
            const after = useEditorStore.getState().adjustments;
            const diff = diffAdjustments(before.adjustments, after);
            if (diff.length > 0) {
              useAgentStore.getState().recordActivity({
                id: uuidv4(),
                op,
                args: args || {},
                ts: Date.now(),
                summary: summarizeActivity(op, args || {}, result, diff),
                frame: useChromaStore.getState().videoInfo?.isVideo
                  ? (useChromaStore.getState().currentFrame ?? 0)
                  : null,
                historyIndexBefore: before.historyIndex,
                adjustmentsBefore: before.adjustments,
                adjustmentsAfter: after,
                diff,
                undone: false,
              });
            }
          } catch {
            /* the feed is best-effort — never break the bridge response */
          }
        }

        respond({ ok: !result?.error, error: result?.error ?? null, result, ...frame });
      } catch (e: any) {
        respond({
          ok: false,
          error: String(e?.message || e),
          result: null,
          adjustments: useEditorStore.getState().adjustments,
          histogram: useEditorStore.getState().histogram,
          image_b64: null,
          scopes: null,
          frame: useChromaStore.getState().currentFrame ?? 0,
        });
      }
    });

    return () => {
      safeUnlisten(unlistenP);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

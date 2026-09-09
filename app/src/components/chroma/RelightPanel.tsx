// Apelles — interactive relight panel (D-048).
//
// The right-panel controls for the "Relight" grade layer: a ClipDrop-style
// bottom tab strip (Preset / Ambient / Light 1 / Light 2 / … / + Add Light),
// and below it either the Preset picker (D-054) or the selected light's
// Color / Power / Distance controls plus a keyframe affordance (reuses the
// D-034 mask-keyframe mechanism via `utils/maskKeyframes.ts` —
// `GEOMETRY_KEYS.relight`, not a new keyframe system). Two depth sources
// (D-073 UX): Bake Depth (D-054's static single-frame fallback,
// `useAiMasking.ts`'s `handleBakeRelightDepth` — a few seconds) now fires
// itself automatically the moment it's needed, surfaced only as a status
// line + a manual re-bake affordance; Track Depth (D-036's real per-frame
// `chroma_depth_track` job over the whole clip, minutes not seconds,
// `handleTrackRelightDepth`) is its own clearly-labeled "finalize" section
// at the bottom of the panel, not a button sitting next to Bake Depth as if
// the two were equal-weight choices.
//
// The canvas puck drag lives in `RelightPuckLayer` (ImageCanvas.tsx); this
// panel is the numeric-control half of the same interaction, matching the
// brief's "drag = position, a control = falloff radius" split.
//
// Styling (D-068): rebuilt on `@apelles/ui`'s shadcn/Base UI primitives
// (`Button`, `Slider`) — was plain elements + app tokens matching
// MasksPanel's pre-Apelles-pivot style, flagged by the owner as visibly
// inconsistent with the rest of the app ("feels like it's not from this
// app"). Interaction logic (tab selection, preset apply, keyframe ops) is
// untouched — this pass only changes what renders it, not what it does.
//
// Depth-source UX (D-073): Bake Depth (single-frame, a few seconds) now
// fires automatically the moment a positional light exists with no depth
// source yet — the owner's own live testing found "no live feedback kills
// the purpose of relight": Track Depth (the OTHER depth source, a real
// per-frame pass over the *entire* clip, minutes not seconds, and heavy
// enough to have crashed the AI sidecar once tonight processing a 12k-frame
// 4K clip) was sitting next to Bake Depth as two equal-weight buttons with
// no guidance on which to reach for — a user reasonably tries the one
// listed first. Bake is now invisible machinery (a status line, not a
// button a user has to know to click) with a small manual "Re-bake"
// affordance for after a scrub; Track Depth moves to its own section below
// every light control, visually separated and labeled as the deliberate
// "finalize for the whole video" action it actually is.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Diamond, Info, Loader2, Plus, RotateCw, Trash2, Eye, EyeOff, Video, X } from 'lucide-react';
import { Button, Slider, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@apelles/ui';
import { trackEvent } from '@apelles/bridge';

import { useEditorStore } from '../../store/useEditorStore';
import { useEditorActions } from '../../hooks/useEditorActions';
import { useChromaStore } from '../../store/useChromaStore';
import { useAiMasking } from '../../hooks/useAiMasking';
import { Adjustments, RelightLight } from '../../utils/adjustments';
import { createRelightLight, relightLightLabel } from '../../utils/relightUtils';
import { RELIGHT_PRESETS, RelightPreset } from '../../utils/relightPresets';
import { parseKeyframes, upsertKeyframe, removeKeyframe, clearKeyframes } from '../../utils/maskKeyframes';

export default function RelightPanel() {
  const { setAdjustments } = useEditorActions();
  const { handleTrackRelightDepth, handleBakeRelightDepth, handleBakeRelightNormals } = useAiMasking();
  const videoInfo = useChromaStore((s) => s.videoInfo);
  const currentFrame = useChromaStore((s) => s.currentFrame);
  const depthTrackProgress = useChromaStore((s) => s.depthTrackProgress);

  const lights = useEditorStore((s) => s.adjustments.relightLights) || [];
  const relightDepthDir = useEditorStore((s) => s.adjustments.relightDepthDir);
  const relightDepthBake = useEditorStore((s) => s.adjustments.relightDepthBake);
  const relightNormalsBake = useEditorStore((s) => s.adjustments.relightNormalsBake);
  const isBakingRelightDepth = useEditorStore((s) => s.isBakingRelightDepth);
  const isBakingRelightNormals = useEditorStore((s) => s.isBakingRelightNormals);
  const activeLightId = useEditorStore((s) => s.activeRelightLightId);
  const setEditor = useEditorStore((s) => s.setEditor);

  // D-054: the Preset tab is a picker, not a light — its own bit of UI state
  // rather than a fourth kind of `activeRelightLightId`. Selecting Ambient,
  // a light tab, or +Add Light all drop back out of it (see their handlers).
  const [showPresets, setShowPresets] = useState(false);

  const ambientLight = useMemo(() => lights.find((l) => l.kind === 'ambient'), [lights]);
  const positionalLights = useMemo(() => lights.filter((l) => l.kind !== 'ambient'), [lights]);
  const activeLight = useMemo(() => lights.find((l) => l.id === activeLightId) ?? null, [lights, activeLightId]);

  // D-073: fire Bake Depth automatically — a positional light with no depth
  // source at all renders as an ambient-only no-op (per `resolve_relight_
  // depth_bitmap`), which read as "broken" until the owner explicitly
  // clicked a button most people wouldn't know to reach for first. Only
  // fires once per "genuinely no depth yet" state (the effect's own deps
  // naturally gate re-firing — adding a second/third light, or toggling
  // between lights, doesn't re-trigger it once a bake exists), and never
  // fights `Track Depth`: `relightDepthDir` winning over `relightDepthBake`
  // at render time is unchanged (`resolve_relight_depth_bitmap`'s existing
  // precedence), so a track in progress or already finished is left alone.
  useEffect(() => {
    if (
      positionalLights.length > 0 &&
      !relightDepthDir &&
      !relightDepthBake &&
      !isBakingRelightDepth &&
      !depthTrackProgress
    ) {
      void handleBakeRelightDepth();
    }
    // `handleBakeRelightDepth` is deliberately not a dependency — it's a
    // plain (non-`useCallback`) function from `useAiMasking()`, a new
    // reference every render, so including it would re-fire this effect on
    // any unrelated re-render rather than only on a real state change. The
    // real guard is `isBakingRelightDepth`, which `handleBakeRelightDepth`
    // itself sets synchronously (via `setEditor`) before its first `await`
    // — this effect can't re-enter mid-bake.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionalLights.length, relightDepthDir, relightDepthBake, isBakingRelightDepth, depthTrackProgress]);

  const updateLights = useCallback(
    (fn: (lights: RelightLight[]) => RelightLight[]) => {
      setAdjustments((prev: Adjustments) => ({ ...prev, relightLights: fn(prev.relightLights || []) }));
    },
    [setAdjustments],
  );

  const updateActiveLight = useCallback(
    (patch: Partial<RelightLight>) => {
      if (!activeLightId) return;
      updateLights((ls) => ls.map((l) => (l.id === activeLightId ? { ...l, ...patch } : l)));
    },
    [activeLightId, updateLights],
  );

  const selectOrAddAmbient = useCallback(() => {
    setShowPresets(false);
    if (ambientLight) {
      setEditor({ activeRelightLightId: ambientLight.id });
      return;
    }
    const light = createRelightLight('ambient');
    updateLights((ls) => [...ls, light]);
    setEditor({ activeRelightLightId: light.id });
    trackEvent('relight_light_add', { kind: 'ambient' });
  }, [ambientLight, updateLights, setEditor]);

  const addPositionalLight = useCallback(() => {
    setShowPresets(false);
    // Alternate key/fill for the first two, then default to "key" — a simple,
    // predictable preset progression rather than a kind picker on add.
    const kind = positionalLights.length === 0 ? 'key' : positionalLights.length === 1 ? 'fill' : 'key';
    const light = createRelightLight(kind);
    updateLights((ls) => [...ls, light]);
    setEditor({ activeRelightLightId: light.id });
    trackEvent('relight_light_add', { kind });
  }, [positionalLights.length, updateLights, setEditor]);

  // D-054: apply a built-in preset — REPLACES `relightLights` through the
  // exact same `setAdjustments` a manual add-light action uses (`updateLights`
  // above), then selects the first light of the new set so its controls show
  // immediately, matching "+Add Light"'s own select-on-add behaviour.
  const applyPreset = useCallback(
    (preset: RelightPreset) => {
      const newLights = preset.build();
      updateLights(() => newLights);
      setEditor({ activeRelightLightId: newLights[0]?.id ?? null });
      setShowPresets(false);
      trackEvent('relight_preset_apply', { preset: preset.id });
    },
    [updateLights, setEditor],
  );

  const deleteLight = useCallback(
    (id: string) => {
      updateLights((ls) => ls.filter((l) => l.id !== id));
      if (activeLightId === id) setEditor({ activeRelightLightId: null });
      trackEvent('relight_light_delete', {});
    },
    [updateLights, activeLightId, setEditor],
  );

  // --- keyframes (D-034 reuse) — only meaningful for a positional light on a video.
  const keyframes = useMemo(() => (activeLight ? parseKeyframes(activeLight) : []), [activeLight]);
  const keyedHere = keyframes.some((k) => k.frame === Math.round(currentFrame));
  // D-066: `next` here is always a COMPLETE light object — `upsertKeyframe`/
  // `removeKeyframe`/`clearKeyframes` (`utils/maskKeyframes.ts`) each build
  // it as `{ ...parameters, ... }` from the light passed in, so it already
  // carries every field. `removeKeyframe`/`clearKeyframes` signal "no
  // keyframes left" by *deleting* `chromaKeyframes` from that object — but
  // `{ ...l, ...next }` (the old body here) spread `next` back ONTO the
  // stale `l`, and a spread can only overwrite a key, never un-set one:
  // `next` has no `chromaKeyframes` key to overwrite `l`'s with, so `l`'s
  // stale (soon-to-be-removed) `chromaKeyframes` survived every "Clear"/
  // "X" click, silently. Replacing `l` outright fixes both buttons in one
  // place, since `updateActiveLight` (a separate function, for the Color/
  // Power/Distance sliders) already does the correct partial-patch merge —
  // this function's own job was never "merge a patch," only "keyframe ops
  // give you the next real state, use it."
  const writeLightParams = useCallback(
    (next: Record<string, any>) => {
      if (!activeLightId) return;
      updateLights((ls) => ls.map((l) => (l.id === activeLightId ? (next as RelightLight) : l)));
    },
    [activeLightId, updateLights],
  );

  // `@apelles/ui`'s `Slider` (Base UI) always deals in `number | readonly
  // number[]` since it's shared with range sliders — every call here only
  // ever uses one thumb, so unwrap once and reuse (same pattern
  // `@apelles/player`'s `Player.tsx` uses for its own scrub bar).
  const sliderValue = (v: number | readonly number[]): number => (Array.isArray(v) ? v[0] : (v as number));

  return (
    <div className="flex flex-col gap-3 p-3 text-sm">
      <div>
        <div className="text-text-primary font-medium">Relight</div>
        <div className="text-text-secondary text-xs mt-0.5">
          Deterministic, depth-driven light pucks — drag on the canvas to position, adjust falloff and colour here.
        </div>
      </div>

      {/* Depth status (D-073) ------------------------------------------------
          No button here any more for the common case — Bake Depth (a few
          seconds, single frame) fires automatically the moment a positional
          light needs it (see the effect above). This is just the live status
          + a small manual "Re-bake" for after a scrub to a different frame.
          "Track Depth" (the heavy, whole-clip, minutes-long pass) moved to
          its own section below every light control — see there. */}
      {positionalLights.length > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-text-secondary">
          {isBakingRelightDepth ? (
            <>
              <Loader2 size={12} className="animate-spin shrink-0" />
              <span>Generating a quick depth preview…</span>
            </>
          ) : relightDepthDir ? (
            <span>Full video depth ready — lights follow camera motion.</span>
          ) : relightDepthBake ? (
            <>
              <span className="flex-1">Quick preview ready (single frame — won&apos;t follow camera motion).</span>
              {videoInfo?.isVideo && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={handleBakeRelightDepth}
                  title="Re-bake the depth preview at the current frame"
                >
                  <RotateCw size={12} />
                </Button>
              )}
            </>
          ) : (
            <span>Ambient works now; positional lights need depth — starting a quick preview…</span>
          )}
        </div>
      )}

      {/* Real surface normals (D-077) — an optional quality upgrade on top of
          depth, not a requirement: positional lights already shade with the
          depth-derived normal above once a depth source exists. This is a
          deliberate action (not auto-fired like Bake Depth) since it hits the
          AI sidecar over HTTP for a real trained model, not the fast
          in-process ONNX depth path — closer to Track Depth's "heavier, ask
          first" tier than Bake Depth's "instant, just do it" one. Gated on
          having a depth source already (a normal alone still can't shade
          without `pixel_depth` for the light's z-comparison, see
          `apply_relight`). */}
      {positionalLights.length > 0 && (relightDepthDir || relightDepthBake) && (
        <div className="flex items-center gap-1.5 text-xs text-text-secondary">
          {isBakingRelightNormals ? (
            <>
              <Loader2 size={12} className="animate-spin shrink-0" />
              <span>Computing real surface shape (first run downloads a model, ~15s)…</span>
            </>
          ) : relightNormalsBake ? (
            <>
              <span className="flex-1">Real surface shading on — lights follow facial contours.</span>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={handleBakeRelightNormals}
                      >
                        <RotateCw size={12} />
                      </Button>
                    }
                  />
                  <TooltipContent side="top" align="end">
                    Re-bake at the current frame
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </>
          ) : (
            <>
              <span className="flex-1">Shading uses an approximation — for real facial contours, bake real surface normals.</span>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button variant="secondary" size="xs" onClick={handleBakeRelightNormals}>
                        Bake Normals
                      </Button>
                    }
                  />
                  <TooltipContent side="top" align="end">
                    Runs a real AI model (MoGe-2, local) to compute actual surface geometry —
                    light wraps around contours instead of a flat colour wash. A few seconds,
                    single frame, not video-tracked.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </>
          )}
        </div>
      )}

      {/* Bottom tab strip: Preset / Ambient / Light 1 / Light 2 / … / + Add Light */}
      <div className="flex items-center gap-1.5 flex-wrap border-t border-b border-border-color py-2">
        <Button
          variant={showPresets ? 'default' : 'secondary'}
          size="xs"
          onClick={() => setShowPresets(true)}
          title="Apply a saved lighting setup"
        >
          Preset
        </Button>
        <Button
          variant={!showPresets && activeLight?.kind === 'ambient' ? 'default' : 'secondary'}
          size="xs"
          onClick={selectOrAddAmbient}
        >
          Ambient
        </Button>
        {positionalLights.map((light) => (
          <Button
            key={light.id}
            variant={!showPresets && light.id === activeLightId ? 'default' : 'secondary'}
            size="xs"
            className="gap-1.5"
            onClick={() => {
              setShowPresets(false);
              setEditor({ activeRelightLightId: light.id });
            }}
          >
            <span
              className="inline-block size-2.5 rounded-full border border-white/40"
              style={{ background: light.color }}
            />
            {relightLightLabel(light, lights)}
          </Button>
        ))}
        <Button variant="secondary" size="xs" className="gap-1" onClick={addPositionalLight} title="Add a positional light">
          <Plus size={12} /> Add Light
        </Button>
      </div>

      {/* Preset picker (D-054) ----------------------------------------------- */}
      {showPresets ? (
        <div className="flex flex-col gap-2">
          <div className="text-text-secondary text-xs">
            Apply a starting look — replaces the current lights, then tweak from there.
          </div>
          {RELIGHT_PRESETS.map((preset) => (
            <button
              key={preset.id}
              className="text-left px-2.5 py-2 rounded-md border border-border-color bg-surface hover:bg-card-active hover:border-accent/60 transition-colors"
              onClick={() => applyPreset(preset)}
            >
              <div className="text-text-primary text-xs font-medium">{preset.label}</div>
              <div className="text-text-secondary text-[11px] mt-0.5">{preset.description}</div>
            </button>
          ))}
        </div>
      ) : /* Selected light's controls ----------------------------------------- */
      !activeLight ? (
        <div className="text-text-secondary text-xs">Select Ambient or add a light to edit it.</div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="text-text-primary text-xs font-medium">{relightLightLabel(activeLight, lights)}</div>
            <div className="flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => updateActiveLight({ visible: !activeLight.visible })}
                title={activeLight.visible ? 'Hide this light' : 'Show this light'}
              >
                {activeLight.visible ? <Eye size={14} /> : <EyeOff size={14} />}
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-red-400 hover:text-red-400"
                onClick={() => deleteLight(activeLight.id)}
                title="Delete this light"
              >
                <Trash2 size={14} />
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-text-secondary text-xs flex-1">Color</span>
            {/* A real color-picker component doesn't exist yet in `@apelles/ui`
                — the native `<input type="color">` still does the real job
                (opens the OS picker), just given a proper bordered/rounded
                button shell around it instead of a bare swatch, matching
                every other control's sizing on this panel. */}
            <label className="relative size-7 rounded-md border border-border-color overflow-hidden cursor-pointer hover:border-accent/60 transition-colors">
              <input
                type="color"
                value={activeLight.color}
                onChange={(e) => updateActiveLight({ color: e.target.value })}
                className="absolute -inset-1 cursor-pointer"
              />
            </label>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-text-secondary">Power</span>
              <span className="text-text-primary tabular-nums">{activeLight.intensity}</span>
            </div>
            <Slider
              min={0}
              max={200}
              step={1}
              value={activeLight.intensity}
              onValueChange={(v) => updateActiveLight({ intensity: sliderValue(v) })}
            />
          </div>

          {activeLight.kind !== 'ambient' && (
            <>
              {/* Distance (D-076) — the light's own absolute position in the
                  depth map's normalized space (the z, not a screen-space
                  size), compared directly against each pixel's own depth.
                  Deliberately NOT sampled from whatever's directly behind
                  the puck's own x/y — a first version did that, which
                  anchored the light's z to whatever was under the puck: fine
                  if dropped right on the subject, broken the moment it was
                  parked beside them over open background (a normal way to
                  place a point light) — the background caught light, the
                  subject didn't. Defaults high (85) since it's absolute, not
                  relative: a low default would sit "behind" a typical
                  near-camera subject regardless of where the puck is. Was
                  previously (mis)labeled "Distance" but wired to `radius`
                  (screen-space falloff size, below) — that slider never
                  touched depth at all. */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-text-secondary">Distance</span>
                  <span className="text-text-primary tabular-nums">{activeLight.distance}</span>
                </div>
                <Slider
                  min={0}
                  max={100}
                  step={1}
                  value={activeLight.distance}
                  onValueChange={(v) => updateActiveLight({ distance: sliderValue(v) })}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-text-secondary">Radius</span>
                  <span className="text-text-primary tabular-nums">{activeLight.radius}</span>
                </div>
                <Slider
                  min={5}
                  max={100}
                  step={1}
                  value={activeLight.radius}
                  onValueChange={(v) => updateActiveLight({ radius: sliderValue(v) })}
                />
              </div>

              {/* Keyframes (D-034 reuse) — position/radius/distance only, video only. */}
              {videoInfo?.isVideo && (
                <div className="flex items-center gap-2 text-[11px] text-text-secondary select-none pt-1">
                  <Button
                    variant="ghost"
                    size="xs"
                    className={`gap-1 px-1.5 ${keyedHere ? 'text-accent' : 'text-text-primary'}`}
                    onClick={() =>
                      writeLightParams(
                        upsertKeyframe(activeLight, currentFrame, {
                          x: activeLight.x,
                          y: activeLight.y,
                          radius: activeLight.radius,
                          distance: activeLight.distance,
                        }),
                      )
                    }
                    title={keyedHere ? 'Update this light keyframe' : 'Keyframe this light at the current frame'}
                  >
                    <Diamond size={11} fill={keyedHere ? 'currentColor' : 'none'} />
                    {keyframes.length === 0 ? 'Keyframe light' : keyedHere ? 'Update key' : 'Add key'}
                  </Button>
                  {keyframes.length > 0 && (
                    <>
                      <span className="tabular-nums">
                        {keyframes.length} key{keyframes.length === 1 ? '' : 's'}
                      </span>
                      {keyedHere && (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => writeLightParams(removeKeyframe(activeLight, currentFrame))}
                          title="Delete the keyframe at this frame"
                        >
                          <X size={12} />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => writeLightParams(clearKeyframes(activeLight))}
                        title="Remove all keyframes (light becomes static)"
                      >
                        Clear
                      </Button>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Track Depth — the deliberate "finalize" action (D-073).
          Always at the bottom, video-only (a still has no temporal track to
          run — Bake Depth already covers it), not gated on having a
          positional light yet (tracking ahead of adding one is a real,
          reasonable workflow). Compact by design (owner: "keep the track
          full depth at right bottom with I icon instead of so much text") —
          the explanation lives in a real `@apelles/ui` `Tooltip` (D-042,
          `render={<Button/>}` — the same pattern `TimelinePane.tsx`'s
          toolbar already establishes) instead of always-visible paragraph
          text; only the compact progress readout stays inline while a track
          is actually running, since that's live status, not explanation. */}
      {videoInfo?.isVideo && (
        <div className="flex items-center justify-end gap-1.5 mt-1 pt-2 border-t border-border-color">
          {depthTrackProgress && (
            <span className="text-[10px] text-text-secondary tabular-nums mr-auto">
              Tracking… {depthTrackProgress.total ? `${depthTrackProgress.done}/${depthTrackProgress.total}` : 'starting…'}
            </span>
          )}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="text-text-secondary/50 hover:text-text-secondary cursor-help">
                    <Info size={13} />
                  </span>
                }
              />
              <TooltipContent side="top" align="end">
                Finalize for the whole video: tracks real depth across every frame so lights follow
                camera motion — a real per-frame pass, minutes not seconds for a long or high-res clip.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-sm"
                  onClick={handleTrackRelightDepth}
                  disabled={!!depthTrackProgress}
                  aria-label={relightDepthDir ? 'Re-track depth (full video)' : 'Track Depth (full video)'}
                >
                  {depthTrackProgress ? <Loader2 size={14} className="animate-spin" /> : <Video size={14} />}
                </Button>
              }
            />
            <TooltipContent side="top" align="end">
              {relightDepthDir ? 'Re-track depth (full video)' : 'Track Depth (full video)'}
            </TooltipContent>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

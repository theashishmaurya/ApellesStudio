// Chroma — interactive relight panel (D-048).
//
// The right-panel controls for the "Relight" grade layer: a ClipDrop-style
// bottom tab strip (Preset / Ambient / Light 1 / Light 2 / … / + Add Light),
// and below it either the Preset picker (D-054) or the selected light's
// Color / Power / Distance controls plus a keyframe affordance (reuses the
// D-034 mask-keyframe mechanism via `utils/maskKeyframes.ts` —
// `GEOMETRY_KEYS.relight`, not a new keyframe system), a "Track Depth" button
// (D-036's `chroma_depth_track` job, wired to the top-level `relightDepthDir`
// instead of a mask's parameters — see `useAiMasking.ts`'s
// `handleTrackRelightDepth`) and a "Bake Depth" button (D-054's static
// single-frame fallback, `handleBakeRelightDepth` — the depth-less-clip
// parity D-024's AI-Depth mask already has).
//
// The canvas puck drag lives in `RelightPuckLayer` (ImageCanvas.tsx); this
// panel is the numeric-control half of the same interaction, matching the
// brief's "drag = position, a control = falloff radius" split.
//
// Styling (D-068): rebuilt on `@chroma/ui`'s shadcn/Base UI primitives
// (`Button`, `Slider`) — was plain elements + app tokens matching
// MasksPanel's pre-Chroma-pivot style, flagged by the owner as visibly
// inconsistent with the rest of the app ("feels like it's not from this
// app"). Interaction logic (tab selection, preset apply, keyframe ops) is
// untouched — this pass only changes what renders it, not what it does.
import { useCallback, useMemo, useState } from 'react';
import { Diamond, Plus, Trash2, Eye, EyeOff, X } from 'lucide-react';
import { Button, Slider } from '@chroma/ui';

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
  const { handleTrackRelightDepth, handleBakeRelightDepth } = useAiMasking();
  const videoInfo = useChromaStore((s) => s.videoInfo);
  const currentFrame = useChromaStore((s) => s.currentFrame);
  const depthTrackProgress = useChromaStore((s) => s.depthTrackProgress);

  const lights = useEditorStore((s) => s.adjustments.relightLights) || [];
  const relightDepthDir = useEditorStore((s) => s.adjustments.relightDepthDir);
  const relightDepthBake = useEditorStore((s) => s.adjustments.relightDepthBake);
  const isBakingRelightDepth = useEditorStore((s) => s.isBakingRelightDepth);
  const activeLightId = useEditorStore((s) => s.activeRelightLightId);
  const setEditor = useEditorStore((s) => s.setEditor);

  // D-054: the Preset tab is a picker, not a light — its own bit of UI state
  // rather than a fourth kind of `activeRelightLightId`. Selecting Ambient,
  // a light tab, or +Add Light all drop back out of it (see their handlers).
  const [showPresets, setShowPresets] = useState(false);

  const ambientLight = useMemo(() => lights.find((l) => l.kind === 'ambient'), [lights]);
  const positionalLights = useMemo(() => lights.filter((l) => l.kind !== 'ambient'), [lights]);
  const activeLight = useMemo(() => lights.find((l) => l.id === activeLightId) ?? null, [lights, activeLightId]);

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
  }, [ambientLight, updateLights, setEditor]);

  const addPositionalLight = useCallback(() => {
    setShowPresets(false);
    // Alternate key/fill for the first two, then default to "key" — a simple,
    // predictable preset progression rather than a kind picker on add.
    const kind = positionalLights.length === 0 ? 'key' : positionalLights.length === 1 ? 'fill' : 'key';
    const light = createRelightLight(kind);
    updateLights((ls) => [...ls, light]);
    setEditor({ activeRelightLightId: light.id });
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
    },
    [updateLights, setEditor],
  );

  const deleteLight = useCallback(
    (id: string) => {
      updateLights((ls) => ls.filter((l) => l.id !== id));
      if (activeLightId === id) setEditor({ activeRelightLightId: null });
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

  // `@chroma/ui`'s `Slider` (Base UI) always deals in `number | readonly
  // number[]` since it's shared with range sliders — every call here only
  // ever uses one thumb, so unwrap once and reuse (same pattern
  // `@chroma/player`'s `Player.tsx` uses for its own scrub bar).
  const sliderValue = (v: number | readonly number[]): number => (Array.isArray(v) ? v[0] : (v as number));

  return (
    <div className="flex flex-col gap-3 p-3 text-sm">
      <div>
        <div className="text-text-primary font-medium">Relight</div>
        <div className="text-text-secondary text-xs mt-0.5">
          Deterministic, depth-driven light pucks — drag on the canvas to position, adjust falloff and colour here.
        </div>
      </div>

      {/* Depth source -------------------------------------------------------
          "Track Depth" (D-036, per-frame, video only) always wins when both
          exist; "Bake Depth" (D-054) is the fallback — a static single-frame
          bake, parity with D-024's AI-Depth mask — works on a still image
          too, since a still has no temporal track to run in the first place. */}
      <div className="flex flex-col gap-1.5 text-xs text-text-secondary">
        <div className="flex items-center gap-2 flex-wrap">
          {videoInfo?.isVideo && (
            <Button
              variant="secondary"
              size="xs"
              onClick={handleTrackRelightDepth}
              disabled={!!depthTrackProgress}
            >
              {relightDepthDir ? 'Re-track depth' : 'Track Depth'}
            </Button>
          )}
          <Button
            variant="secondary"
            size="xs"
            onClick={handleBakeRelightDepth}
            disabled={isBakingRelightDepth}
            title="Static single-frame depth bake — fallback for a clip with no depth track"
          >
            {isBakingRelightDepth ? 'Baking…' : relightDepthBake ? 'Re-bake depth' : 'Bake Depth'}
          </Button>
          {depthTrackProgress && (
            <span className="tabular-nums">
              {depthTrackProgress.total
                ? `${depthTrackProgress.done}/${depthTrackProgress.total}`
                : 'starting…'}
            </span>
          )}
        </div>
        {!depthTrackProgress &&
          (relightDepthDir ? (
            <span>Depth track ready — key/fill/rim lights shade the frame.</span>
          ) : relightDepthBake ? (
            <span>Static depth bake ready — key/fill/rim lights shade the frame (won&apos;t follow camera motion).</span>
          ) : (
            <span>Key/fill/rim lights need a depth track or bake (ambient works without one).</span>
          ))}
      </div>

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
            {/* A real color-picker component doesn't exist yet in `@chroma/ui`
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
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-text-secondary">Distance</span>
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

              {/* Keyframes (D-034 reuse) — position/radius only, video only. */}
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
    </div>
  );
}

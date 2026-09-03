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
// Styling: plain elements + app tokens + the shared `Slider`, matching
// MasksPanel's own control style — not a new design language.
import { useCallback, useMemo, useState } from 'react';
import { Diamond, Plus, Trash2, Eye, EyeOff, X } from 'lucide-react';

import Slider from '../ui/Slider';
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
            <button
              className="px-2 py-1 rounded bg-surface hover:bg-card-active text-text-primary disabled:opacity-50"
              onClick={handleTrackRelightDepth}
              disabled={!!depthTrackProgress}
            >
              {relightDepthDir ? 'Re-track depth' : 'Track Depth'}
            </button>
          )}
          <button
            className="px-2 py-1 rounded bg-surface hover:bg-card-active text-text-primary disabled:opacity-50"
            onClick={handleBakeRelightDepth}
            disabled={isBakingRelightDepth}
            title="Static single-frame depth bake — fallback for a clip with no depth track"
          >
            {isBakingRelightDepth ? 'Baking…' : relightDepthBake ? 'Re-bake depth' : 'Bake Depth'}
          </button>
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
      <div className="flex items-center gap-1 flex-wrap border-t border-b border-border py-2">
        <button
          className={`px-2 py-1 rounded text-xs ${
            showPresets ? 'bg-accent text-button-text' : 'bg-surface text-text-secondary hover:bg-card-active'
          }`}
          onClick={() => setShowPresets(true)}
          title="Apply a saved lighting setup"
        >
          Preset
        </button>
        <button
          className={`px-2 py-1 rounded text-xs ${
            !showPresets && activeLight?.kind === 'ambient' ? 'bg-accent text-button-text' : 'bg-surface text-text-secondary hover:bg-card-active'
          }`}
          onClick={selectOrAddAmbient}
        >
          Ambient
        </button>
        {positionalLights.map((light) => (
          <button
            key={light.id}
            className={`px-2 py-1 rounded text-xs flex items-center gap-1.5 ${
              !showPresets && light.id === activeLightId ? 'bg-accent text-button-text' : 'bg-surface text-text-secondary hover:bg-card-active'
            }`}
            onClick={() => {
              setShowPresets(false);
              setEditor({ activeRelightLightId: light.id });
            }}
          >
            <span
              className="inline-block w-2.5 h-2.5 rounded-full border border-white/40"
              style={{ background: light.color }}
            />
            {relightLightLabel(light, lights)}
          </button>
        ))}
        <button
          className="px-2 py-1 rounded text-xs flex items-center gap-1 bg-surface text-text-secondary hover:bg-card-active"
          onClick={addPositionalLight}
          title="Add a positional light"
        >
          <Plus size={12} /> Add Light
        </button>
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
              className="text-left px-2 py-2 rounded bg-surface hover:bg-card-active"
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
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="text-text-primary text-xs font-medium">{relightLightLabel(activeLight, lights)}</div>
            <div className="flex items-center gap-1">
              <button
                className="p-1 rounded hover:bg-surface text-text-secondary"
                onClick={() => updateActiveLight({ visible: !activeLight.visible })}
                title={activeLight.visible ? 'Hide this light' : 'Show this light'}
              >
                {activeLight.visible ? <Eye size={14} /> : <EyeOff size={14} />}
              </button>
              <button
                className="p-1 rounded hover:bg-surface text-red-400"
                onClick={() => deleteLight(activeLight.id)}
                title="Delete this light"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-text-secondary text-xs w-16">Color</span>
            <input
              type="color"
              value={activeLight.color}
              onChange={(e) => updateActiveLight({ color: e.target.value })}
              className="w-7 h-7 p-0 border-none rounded-sm cursor-pointer bg-transparent"
            />
          </div>

          <Slider
            label="Power"
            min={0}
            max={200}
            step={1}
            value={activeLight.intensity}
            onChange={(e: any) => updateActiveLight({ intensity: Number(e.target.value) })}
            fillOrigin="min"
          />

          {activeLight.kind !== 'ambient' && (
            <>
              <Slider
                label="Distance"
                min={5}
                max={100}
                step={1}
                value={activeLight.radius}
                onChange={(e: any) => updateActiveLight({ radius: Number(e.target.value) })}
                fillOrigin="min"
              />

              {/* Keyframes (D-034 reuse) — position/radius only, video only. */}
              {videoInfo?.isVideo && (
                <div className="flex items-center gap-2 text-[11px] text-text-secondary select-none pt-1">
                  <button
                    className={`flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-surface ${
                      keyedHere ? 'text-accent' : 'text-text-primary'
                    }`}
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
                  </button>
                  {keyframes.length > 0 && (
                    <>
                      <span className="tabular-nums">
                        {keyframes.length} key{keyframes.length === 1 ? '' : 's'}
                      </span>
                      {keyedHere && (
                        <button
                          className="p-0.5 rounded hover:bg-surface"
                          onClick={() => writeLightParams(removeKeyframe(activeLight, currentFrame))}
                          title="Delete the keyframe at this frame"
                        >
                          <X size={12} />
                        </button>
                      )}
                      <button
                        className="px-1 py-0.5 rounded hover:bg-surface"
                        onClick={() => writeLightParams(clearKeyframes(activeLight))}
                        title="Remove all keyframes (light becomes static)"
                      >
                        Clear
                      </button>
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

// Chroma — interactive relight panel (D-046).
//
// The right-panel controls for the "Relight" grade layer: a ClipDrop-style
// bottom tab strip (Ambient / Light 1 / Light 2 / … / + Add Light), and below
// it the selected light's Color / Power / Distance controls plus a keyframe
// affordance (reuses the D-034 mask-keyframe mechanism via
// `utils/maskKeyframes.ts` — `GEOMETRY_KEYS.relight`, not a new keyframe
// system) and a "Track Depth" button (D-036's `chroma_depth_track` job,
// wired to the top-level `relightDepthDir` instead of a mask's parameters —
// see `useAiMasking.ts`'s `handleTrackRelightDepth`).
//
// The canvas puck drag lives in `RelightPuckLayer` (ImageCanvas.tsx); this
// panel is the numeric-control half of the same interaction, matching the
// brief's "drag = position, a control = falloff radius" split.
//
// Styling: plain elements + app tokens + the shared `Slider`, matching
// MasksPanel's own control style — not a new design language.
import { useCallback, useMemo } from 'react';
import { Diamond, Plus, Trash2, Eye, EyeOff, X } from 'lucide-react';

import Slider from '../ui/Slider';
import { useEditorStore } from '../../store/useEditorStore';
import { useEditorActions } from '../../hooks/useEditorActions';
import { useChromaStore } from '../../store/useChromaStore';
import { useAiMasking } from '../../hooks/useAiMasking';
import { Adjustments, RelightLight } from '../../utils/adjustments';
import { createRelightLight, relightLightLabel } from '../../utils/relightUtils';
import { parseKeyframes, upsertKeyframe, removeKeyframe, clearKeyframes } from '../../utils/maskKeyframes';

export default function RelightPanel() {
  const { setAdjustments } = useEditorActions();
  const { handleTrackRelightDepth } = useAiMasking();
  const videoInfo = useChromaStore((s) => s.videoInfo);
  const currentFrame = useChromaStore((s) => s.currentFrame);
  const depthTrackProgress = useChromaStore((s) => s.depthTrackProgress);

  const lights = useEditorStore((s) => s.adjustments.relightLights) || [];
  const relightDepthDir = useEditorStore((s) => s.adjustments.relightDepthDir);
  const activeLightId = useEditorStore((s) => s.activeRelightLightId);
  const setEditor = useEditorStore((s) => s.setEditor);

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
    if (ambientLight) {
      setEditor({ activeRelightLightId: ambientLight.id });
      return;
    }
    const light = createRelightLight('ambient');
    updateLights((ls) => [...ls, light]);
    setEditor({ activeRelightLightId: light.id });
  }, [ambientLight, updateLights, setEditor]);

  const addPositionalLight = useCallback(() => {
    // Alternate key/fill for the first two, then default to "key" — a simple,
    // predictable preset progression rather than a kind picker on add.
    const kind = positionalLights.length === 0 ? 'key' : positionalLights.length === 1 ? 'fill' : 'key';
    const light = createRelightLight(kind);
    updateLights((ls) => [...ls, light]);
    setEditor({ activeRelightLightId: light.id });
  }, [positionalLights.length, updateLights, setEditor]);

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
  const writeLightParams = useCallback(
    (next: Record<string, any>) => {
      if (!activeLightId) return;
      updateLights((ls) => ls.map((l) => (l.id === activeLightId ? { ...l, ...next } : l)));
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

      {/* Depth source ------------------------------------------------------ */}
      {videoInfo?.isVideo && (
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <button
            className="px-2 py-1 rounded bg-surface hover:bg-card-active text-text-primary disabled:opacity-50"
            onClick={handleTrackRelightDepth}
            disabled={!!depthTrackProgress}
          >
            {relightDepthDir ? 'Re-track depth' : 'Track Depth'}
          </button>
          {depthTrackProgress ? (
            <span className="tabular-nums">
              {depthTrackProgress.total
                ? `${depthTrackProgress.done}/${depthTrackProgress.total}`
                : 'starting…'}
            </span>
          ) : relightDepthDir ? (
            <span>Depth track ready — key/fill/rim lights shade the frame.</span>
          ) : (
            <span>Key/fill/rim lights need a depth track (ambient works without one).</span>
          )}
        </div>
      )}

      {/* Bottom tab strip: Ambient / Light 1 / Light 2 / … / + Add Light --- */}
      <div className="flex items-center gap-1 flex-wrap border-t border-b border-border py-2">
        <button
          className={`px-2 py-1 rounded text-xs ${
            activeLight?.kind === 'ambient' ? 'bg-accent text-button-text' : 'bg-surface text-text-secondary hover:bg-card-active'
          }`}
          onClick={selectOrAddAmbient}
        >
          Ambient
        </button>
        {positionalLights.map((light) => (
          <button
            key={light.id}
            className={`px-2 py-1 rounded text-xs flex items-center gap-1.5 ${
              light.id === activeLightId ? 'bg-accent text-button-text' : 'bg-surface text-text-secondary hover:bg-card-active'
            }`}
            onClick={() => setEditor({ activeRelightLightId: light.id })}
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

      {/* Selected light's controls ----------------------------------------- */}
      {!activeLight ? (
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

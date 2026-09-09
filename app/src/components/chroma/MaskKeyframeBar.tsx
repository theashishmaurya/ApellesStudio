// Apelles — mask keyframes affordance + track (D-034).
//
// Shows only when a shape sub-mask (radial / linear / brush) is the active mask
// on a video clip. A "◆ Keyframe" button snapshots the sub-mask's current
// geometry into `parameters.chromaKeyframes` at the current frame (re-pressing at
// a keyed frame updates it); a small track draws a diamond at each keyed frame
// (click to seek); "×" removes the key at the current frame; "Clear" drops them
// all (back to a static mask). Dragging the mask on the canvas at a frame also
// writes/updates the key there (ImageCanvas, D-034).
//
// Styling: plain elements + app tokens, matching ChromaTimeline / ShotStrip /
// AgentActivityDock. An AI-tracked sub-mask (chromaTrackDir) can't be keyframed
// — tracked wins — so the bar hides for those.
import { useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Diamond, X } from 'lucide-react';

import { useEditorStore } from '../../store/useEditorStore';
import { useChromaStore } from '../../store/useChromaStore';
import { useAiMasking } from '../../hooks/useAiMasking';
import type { MaskContainer } from '../../utils/adjustments';
import type { SubMask } from '../panel/right/Masks';
import {
  isKeyframeableMaskType,
  parseKeyframes,
  snapshotGeometry,
  upsertKeyframe,
  removeKeyframe,
  clearKeyframes,
} from '../../utils/maskKeyframes';

export default function MaskKeyframeBar() {
  const masks = useEditorStore((s) => s.adjustments.masks);
  const activeMaskId = useEditorStore((s) => s.activeMaskId);
  const activeAiSubMaskId = useEditorStore((s) => s.activeAiSubMaskId);
  const videoInfo = useChromaStore((s) => s.videoInfo);
  const currentFrame = useChromaStore((s) => s.currentFrame);
  const setCurrentFrame = useChromaStore((s) => s.setCurrentFrame);
  const bumpFrameNonce = useChromaStore((s) => s.bumpFrameNonce);
  const { updateSubMask } = useAiMasking();

  const activeSubId = activeMaskId || activeAiSubMaskId;

  const sub: SubMask | undefined = useMemo(() => {
    if (!activeSubId) return undefined;
    for (const c of (masks || []) as MaskContainer[]) {
      const hit = (c.subMasks || []).find((s: SubMask) => s.id === activeSubId);
      if (hit) return hit;
    }
    return undefined;
  }, [masks, activeSubId]);

  const keyframes = useMemo(() => parseKeyframes(sub?.parameters), [sub?.parameters]);
  const frameCount = videoInfo?.frameCount ?? 0;
  const keyedHere = keyframes.some((k) => k.frame === Math.round(currentFrame));

  const seek = useCallback(
    async (frame: number) => {
      const f = Math.max(0, Math.min((frameCount || 1) - 1, Math.round(frame)));
      try {
        await invoke('chroma_seek', { frame: f });
        setCurrentFrame(f);
        bumpFrameNonce();
      } catch (e) {
        console.error(e);
      }
    },
    [frameCount, setCurrentFrame, bumpFrameNonce],
  );

  const writeParams = useCallback(
    (next: Record<string, any>) => {
      if (!sub) return;
      updateSubMask(sub.id, { parameters: next });
      bumpFrameNonce();
    },
    [sub, updateSubMask, bumpFrameNonce],
  );

  if (!videoInfo?.isVideo || !sub || !isKeyframeableMaskType(sub.type)) return null;
  if ((sub.parameters as any)?.chromaTrackDir) return null;

  const addOrUpdate = () => {
    const geometry = snapshotGeometry(sub.type, sub.parameters || {});
    writeParams(upsertKeyframe(sub.parameters || {}, currentFrame, geometry));
  };

  return (
    <div className="w-full flex items-center gap-2 text-[11px] text-text-secondary select-none">
      <button
        className={`flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-surface ${
          keyedHere ? 'text-accent' : 'text-text-primary'
        }`}
        onClick={addOrUpdate}
        title={keyedHere ? 'Update this mask keyframe' : 'Keyframe this mask at the current frame'}
      >
        <Diamond size={11} fill={keyedHere ? 'currentColor' : 'none'} />
        {keyframes.length === 0 ? 'Keyframe mask' : keyedHere ? 'Update key' : 'Add key'}
      </button>

      <div className="relative flex-1 h-4 rounded bg-bg-primary">
        {keyframes.map((k) => {
          const pct = frameCount > 1 ? (k.frame / (frameCount - 1)) * 100 : 0;
          const active = k.frame === Math.round(currentFrame);
          return (
            <button
              key={k.frame}
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 p-0.5"
              style={{ left: `${pct}%` }}
              onClick={() => seek(k.frame)}
              title={`Seek to keyframe · frame ${k.frame}`}
            >
              <Diamond
                size={10}
                className={active ? 'text-accent' : 'text-text-secondary'}
                fill="currentColor"
              />
            </button>
          );
        })}
        {/* playhead */}
        {frameCount > 1 && (
          <div
            className="absolute top-0 bottom-0 w-px bg-white/60 pointer-events-none"
            style={{ left: `${(currentFrame / (frameCount - 1)) * 100}%` }}
          />
        )}
      </div>

      {keyframes.length > 0 && (
        <>
          <span className="tabular-nums">{keyframes.length} key{keyframes.length === 1 ? '' : 's'}</span>
          {keyedHere && (
            <button
              className="p-0.5 rounded hover:bg-surface"
              onClick={() => writeParams(removeKeyframe(sub.parameters || {}, currentFrame))}
              title="Delete the keyframe at this frame"
            >
              <X size={12} />
            </button>
          )}
          <button
            className="px-1 py-0.5 rounded hover:bg-surface"
            onClick={() => writeParams(clearKeyframes(sub.parameters || {}))}
            title="Remove all keyframes (mask becomes static)"
          >
            Clear
          </button>
        </>
      )}
    </div>
  );
}

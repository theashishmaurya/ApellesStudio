import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useChromaStore } from '../store/useChromaStore';
import { useEditorStore } from '../store/useEditorStore';
import { MaskContainer } from '../utils/adjustments';
import { SubMask } from '../components/panel/right/Masks';

/**
 * Mounted ONCE (in Editor). The per-frame tracked matte is read straight from
 * disk by the renderer (`tracked_full_mask` on `params.chromaTrackDir`), so a
 * seek needs no frontend work. This hook only does the *quality* upgrade: once
 * the scrub settles, it asks the sidecar to overwrite the current frame's cached
 * PNG with a ViTMatte edge, then bumps the frame nonce to re-render.
 */
export function useChromaSubjectTracking() {
  const frameNonce = useChromaStore((s) => s.frameNonce);
  const refineTimer = useRef<any>(null);
  const lastRefined = useRef<string>(''); // `${dir}@${frame}` already upgraded

  useEffect(() => {
    const frame = useChromaStore.getState().currentFrame;
    const { adjustments, activeMaskId } = useEditorStore.getState();
    const subs: SubMask[] =
      adjustments?.masks?.flatMap((m: MaskContainer) => m.subMasks) ?? [];
    const tracked =
      subs.find((s) => s.id === activeMaskId && (s.parameters as any)?.chromaTrackDir) ||
      subs.find((s) => (s.parameters as any)?.chromaTrackDir);
    const dir = (tracked?.parameters as any)?.chromaTrackDir;
    if (!dir) return;

    const key = `${dir}@${frame}`;
    if (lastRefined.current === key) return; // this frame is already hi-res

    if (refineTimer.current) clearTimeout(refineTimer.current);
    refineTimer.current = setTimeout(async () => {
      if (useChromaStore.getState().currentFrame !== frame) return;
      lastRefined.current = key;
      try {
        const changed: boolean = await invoke('chroma_refine_tracked_frame', {
          trackDir: dir,
          frame,
        });
        if (changed && useChromaStore.getState().currentFrame === frame) {
          useChromaStore.getState().bumpFrameNonce();
        }
      } catch {
        lastRefined.current = ''; // let it retry
      }
    }, 600);
  }, [frameNonce]);
}

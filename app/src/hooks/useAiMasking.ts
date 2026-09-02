import { useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import { v4 as uuidv4 } from 'uuid';
import { useEditorStore } from '../store/useEditorStore';
import { useEditorActions } from './useEditorActions';
import {
  Adjustments,
  AiPatch,
  MaskContainer,
  Coord,
  INITIAL_MASK_CONTAINER,
  INITIAL_MASK_ADJUSTMENTS,
} from '../utils/adjustments';
import { Mask, SubMask, SubMaskMode } from '../components/panel/right/Masks';
import { createSubMask } from '../utils/maskUtils';
import { Invokes } from '../components/ui/AppProperties';
import { useChromaStore } from '../store/useChromaStore';

// Chroma has no cloud-AI auth (D-029) — RapidRAW's generative-replace / cloud-inpaint
// pass this token; a null token = unauthenticated, which those paths already handle.
const getToken = async (): Promise<string | null> => null;

const getTransformAdjustments = (adj: Adjustments) => ({
  transformDistortion: adj.transformDistortion,
  transformVertical: adj.transformVertical,
  transformHorizontal: adj.transformHorizontal,
  transformRotate: adj.transformRotate,
  transformAspect: adj.transformAspect,
  transformScale: adj.transformScale,
  transformXOffset: adj.transformXOffset,
  transformYOffset: adj.transformYOffset,
  lensDistortionAmount: adj.lensDistortionAmount,
  lensVignetteAmount: adj.lensVignetteAmount,
  lensTcaAmount: adj.lensTcaAmount,
  lensDistortionParams: adj.lensDistortionParams,
  lensMaker: adj.lensMaker,
  lensModel: adj.lensModel,
  lensDistortionEnabled: adj.lensDistortionEnabled,
  lensTcaEnabled: adj.lensTcaEnabled,
  lensVignetteEnabled: adj.lensVignetteEnabled,
});

export function useAiMasking() {
  const { setAdjustments } = useEditorActions();
  const setEditor = useEditorStore((state) => state.setEditor);

  const updateSubMask = useCallback(
    (subMaskId: string, updatedData: any) => {
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        masks: prev.masks.map((c: MaskContainer) => ({
          ...c,
          subMasks: c.subMasks.map((sm: SubMask) => (sm.id === subMaskId ? { ...sm, ...updatedData } : sm)),
        })),
        aiPatches: (prev.aiPatches || []).map((p: AiPatch) => ({
          ...p,
          subMasks: p.subMasks.map((sm: SubMask) => (sm.id === subMaskId ? { ...sm, ...updatedData } : sm)),
        })),
      }));
    },
    [setAdjustments],
  );

  const handleDirectPatch = useCallback(
    async (subMaskId: string, sourceX: number, sourceY: number) => {
      const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
      if (!selectedImage?.path) return;

      const patchId = adjustments.aiPatches.find((p: AiPatch) =>
        p.subMasks.some((sm: SubMask) => sm.id === subMaskId),
      )?.id;
      if (!patchId) return;

      setAdjustments((prev: Partial<Adjustments>) => ({
        ...prev,
        aiPatches: prev.aiPatches?.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: true } : p)),
      }));

      try {
        const patchDefinitionForBackend = adjustments.aiPatches.find((p: AiPatch) => p.id === patchId);
        const isLiquify = patchDefinitionForBackend?.subMasks.some((sm: SubMask) => sm.type === 'liquify');
        const isRetouch = patchDefinitionForBackend?.subMasks.some((sm: SubMask) => sm.type === 'retouch');
        const command = isLiquify
          ? 'generate_liquify_patch'
          : isRetouch
            ? 'generate_retouch_patch'
            : 'generate_manual_cleanup_patch';

        const newPatchDataJson: any = await invoke(command, {
          currentAdjustments: adjustments,
          patchDefinition: patchDefinitionForBackend,
          sourcePoint: [sourceX, sourceY],
        });

        const newPatchData = JSON.parse(newPatchDataJson);
        patchesSentToBackend.delete(patchId);

        setAdjustments((prev: Partial<Adjustments>) => ({
          ...prev,
          aiPatches: prev.aiPatches?.map((p: AiPatch) =>
            p.id === patchId ? { ...p, patchData: newPatchData, isLoading: false } : p,
          ),
        }));
      } catch (err: any) {
        toast.error(`Patch Generation Failed: ${err.message || String(err)}`);
        setAdjustments((prev: Partial<Adjustments>) => ({
          ...prev,
          aiPatches: prev.aiPatches?.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: false } : p)),
        }));
      }
    },
    [setAdjustments],
  );

  const handleGenerativeReplace = useCallback(
    async (patchId: string, prompt: string, useFastInpaint: boolean) => {
      const { selectedImage, adjustments, isGeneratingAi, patchesSentToBackend } = useEditorStore.getState();
      if (!selectedImage?.path || isGeneratingAi) return;

      const patch: AiPatch | undefined = adjustments.aiPatches.find((p: AiPatch) => p.id === patchId);
      if (!patch) return;

      const patchDefinition = { ...patch, prompt };
      const token = await getToken();

      setAdjustments((prev: Adjustments) => ({
        ...prev,
        aiPatches: prev.aiPatches.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: true, prompt } : p)),
      }));

      setEditor({ isGeneratingAi: true });

      try {
        const newPatchDataJson: any = await invoke(Invokes.InvokeGenerativeReplaseWithMaskDef, {
          currentAdjustments: adjustments,
          patchDefinition: patchDefinition,
          path: selectedImage.path,
          useFastInpaint: useFastInpaint,
          token: token || null,
        });

        const newPatchData = JSON.parse(newPatchDataJson);
        patchesSentToBackend.delete(patchId);

        setAdjustments((prev: Adjustments) => ({
          ...prev,
          aiPatches: prev.aiPatches.map((p: AiPatch) =>
            p.id === patchId
              ? {
                  ...p,
                  patchData: newPatchData,
                  isLoading: false,
                  name: useFastInpaint ? 'Inpaint' : prompt && prompt.trim() ? prompt.trim() : p.name,
                }
              : p,
          ),
        }));
        setEditor({ activeAiPatchContainerId: null, activeAiSubMaskId: null });
      } catch (err) {
        toast.error(`AI Replace Failed: ${err}`);
        setAdjustments((prev: Adjustments) => ({
          ...prev,
          aiPatches: prev.aiPatches.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: false } : p)),
        }));
      } finally {
        setEditor({ isGeneratingAi: false });
      }
    },
    [setAdjustments, setEditor, getToken],
  );

  const handleQuickErase = useCallback(
    async (subMaskId: string | null, startPoint: Coord, endPoint: Coord) => {
      const { selectedImage, adjustments, isGeneratingAi, patchesSentToBackend } = useEditorStore.getState();
      if (!selectedImage?.path || isGeneratingAi) return;
      const token = await getToken();

      const patchId = adjustments.aiPatches.find((p: AiPatch) =>
        p.subMasks.some((sm: SubMask) => sm.id === subMaskId),
      )?.id;
      if (!patchId) return;

      setEditor({ isGeneratingAi: true });
      setAdjustments((prev: Partial<Adjustments>) => ({
        ...prev,
        aiPatches: prev.aiPatches?.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: true } : p)),
      }));

      try {
        const transformAdjustments = getTransformAdjustments(adjustments);
        const newMaskParams: any = await invoke(Invokes.GenerateAiSubjectMask, {
          jsAdjustments: transformAdjustments,
          endPoint: [endPoint.x, endPoint.y],
          flipHorizontal: adjustments.flipHorizontal,
          flipVertical: adjustments.flipVertical,
          orientationSteps: adjustments.orientationSteps,
          path: selectedImage.path,
          rotation: adjustments.rotation,
          startPoint: [startPoint.x, startPoint.y],
        });

        const subMaskToUpdate = adjustments.aiPatches
          ?.find((p: AiPatch) => p.id === patchId)
          ?.subMasks.find((sm: SubMask) => sm.id === subMaskId);
        const finalSubMaskParams: any = { ...subMaskToUpdate?.parameters, ...newMaskParams };
        const updatedAdjustmentsForBackend = {
          ...adjustments,
          aiPatches: adjustments.aiPatches.map((p: AiPatch) =>
            p.id === patchId
              ? {
                  ...p,
                  subMasks: p.subMasks.map((sm: SubMask) =>
                    sm.id === subMaskId ? { ...sm, parameters: finalSubMaskParams } : sm,
                  ),
                }
              : p,
          ),
        };

        const patchDefinitionForBackend = updatedAdjustmentsForBackend.aiPatches.find((p: AiPatch) => p.id === patchId);
        const newPatchDataJson: any = await invoke(Invokes.InvokeGenerativeReplaseWithMaskDef, {
          currentAdjustments: updatedAdjustmentsForBackend,
          patchDefinition: { ...patchDefinitionForBackend, prompt: '' },
          path: selectedImage.path,
          useFastInpaint: true,
          token: token || null,
        });

        const newPatchData = JSON.parse(newPatchDataJson);
        patchesSentToBackend.delete(patchId);

        setAdjustments((prev: Partial<Adjustments>) => ({
          ...prev,
          aiPatches: prev.aiPatches?.map((p: AiPatch) =>
            p.id === patchId
              ? {
                  ...p,
                  patchData: newPatchData,
                  isLoading: false,
                  subMasks: p.subMasks.map((sm: SubMask) =>
                    sm.id === subMaskId ? { ...sm, parameters: finalSubMaskParams } : sm,
                  ),
                }
              : p,
          ),
        }));
        setEditor({ activeAiPatchContainerId: null, activeAiSubMaskId: null });
      } catch (err: any) {
        toast.error(`Quick Erase Failed: ${err.message || String(err)}`);
        setAdjustments((prev: Partial<Adjustments>) => ({
          ...prev,
          aiPatches: prev.aiPatches?.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: false } : p)),
        }));
      } finally {
        setEditor({ isGeneratingAi: false });
      }
    },
    [setAdjustments, setEditor, getToken],
  );

  const handleDeleteMaskContainer = useCallback(
    (containerId: string) => {
      const { activeMaskContainerId } = useEditorStore.getState();
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        masks: (prev.masks || []).filter((c) => c.id !== containerId),
      }));
      if (activeMaskContainerId === containerId) {
        setEditor({ activeMaskContainerId: null, activeMaskId: null });
      }
    },
    [setAdjustments, setEditor],
  );

  const handleDeleteAiPatch = useCallback(
    (patchId: string) => {
      const { activeAiPatchContainerId } = useEditorStore.getState();
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        aiPatches: (prev.aiPatches || []).filter((p) => p.id !== patchId),
      }));
      if (activeAiPatchContainerId === patchId) {
        setEditor({ activeAiPatchContainerId: null, activeAiSubMaskId: null });
      }
    },
    [setAdjustments, setEditor],
  );

  const handleToggleAiPatchVisibility = useCallback(
    (patchId: string) => {
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        aiPatches: (prev.aiPatches || []).map((p: AiPatch) => (p.id === patchId ? { ...p, visible: !p.visible } : p)),
      }));
    },
    [setAdjustments],
  );

  const handleGenerateAiMask = async (subMaskId: string, startPoint: Coord, endPoint: Coord) => {
    const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
    if (!selectedImage?.path) return;
    setEditor({ isGeneratingAiMask: true });

    try {
      const transformAdjustments = getTransformAdjustments(adjustments);
      // Chroma: a loaded video routes the subject mask through the AI sidecar
      // (SAM 2 → ViTMatte, D-016) instead of the in-process ONNX SAM.
      const isChromaVideo = useChromaStore.getState().videoInfo?.isVideo ?? false;
      const newParameters = isChromaVideo
        ? await invoke('chroma_subject_mask', {
            jsAdjustments: transformAdjustments,
            bbox: [
              Math.min(startPoint.x, endPoint.x),
              Math.min(startPoint.y, endPoint.y),
              Math.max(startPoint.x, endPoint.x),
              Math.max(startPoint.y, endPoint.y),
            ],
          })
        : await invoke(Invokes.GenerateAiSubjectMask, {
        jsAdjustments: transformAdjustments,
        endPoint: [endPoint.x, endPoint.y],
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        path: selectedImage.path,
        rotation: adjustments.rotation,
        startPoint: [startPoint.x, startPoint.y],
      });

      const subMask = adjustments.aiPatches
        ?.flatMap((p: AiPatch) => p.subMasks)
        .find((sm: SubMask) => sm.id === subMaskId);
      const mergedParameters = { ...(subMask?.parameters || {}), ...newParameters };
      patchesSentToBackend.delete(subMaskId);
      updateSubMask(subMaskId, { parameters: mergedParameters });
    } catch (error) {
      toast.error(`AI Mask Failed: ${error}`);
    } finally {
      setEditor({ isGeneratingAiMask: false });
    }
  };

  // Chroma: precompute a subject matte per frame for the whole clip. The cache
  // dir is stored on the sub-mask (`chromaTrackDir`) and the renderer reads the
  // current frame's PNG from it — no per-seek matte swap in the frontend.
  const handleTrackSubject = async (subMaskId: string, mode: 'fast' | 'quality' = 'fast') => {
    const { adjustments } = useEditorStore.getState();
    const sm = adjustments?.masks
      ?.flatMap((m: MaskContainer) => m.subMasks)
      .find((s: SubMask) => s.id === subMaskId);
    const p = sm?.parameters || {};
    const hasBox =
      Math.abs((p.endX ?? 0) - (p.startX ?? 0)) >= 8 && Math.abs((p.endY ?? 0) - (p.startY ?? 0)) >= 8;

    const { setTrackProgress } = useChromaStore.getState();
    setTrackProgress({ done: 0, total: 0 });
    try {
      // fast = guided-filter edge; the visible frame upgrades to ViTMatte on
      // seek-settle. quality = ViTMatte every frame — the pre-export pass; it
      // only re-does frames not already at ViTMatte quality.
      const job: any = await invoke('chroma_track_subject', {
        step: 1,
        mode,
        bbox: hasBox ? [p.startX, p.startY, p.endX, p.endY] : null,
      });
      const dir: string | undefined = job?.dir;
      if (job?.job_id) {
        for (;;) {
          await new Promise((r) => setTimeout(r, 1500));
          const st: any = await invoke('chroma_track_status', { jobId: job.job_id });
          if (st?.total) setTrackProgress({ done: st.done ?? 0, total: st.total });
          if (st?.state === 'done') break;
          if (st?.state === 'error') throw new Error(st.error || 'track failed');
          if (st?.state === 'unknown') break;
        }
      }
      if (dir) {
        const cur = useEditorStore
          .getState()
          .adjustments?.masks?.flatMap((m: MaskContainer) => m.subMasks)
          .find((s: SubMask) => s.id === subMaskId);
        updateSubMask(subMaskId, { parameters: { ...(cur?.parameters || {}), chromaTrackDir: dir } });
      }
      useChromaStore.getState().bumpFrameNonce(); // re-render this frame from the cache
    } catch (err: any) {
      toast.error(`Track Subject failed: ${err?.message || String(err)}`);
    } finally {
      setTrackProgress(null);
    }
  };

  // Chroma (D-036): precompute a temporally-consistent depth map per frame for
  // the whole clip via the sidecar's Video Depth Anything (/depth_track). The
  // cache dir is stored on the depth sub-mask (`chromaDepthDir`) and the renderer
  // reads the current frame's PNG from it — no per-seek swap in the frontend,
  // exactly like the subject track. Mirrors `handleTrackSubject`.
  const handleTrackDepth = async (subMaskId: string) => {
    const { setDepthTrackProgress } = useChromaStore.getState();
    setDepthTrackProgress({ done: 0, total: 0 });
    try {
      const job: any = await invoke('chroma_depth_track', { step: 1 });
      const dir: string | undefined = job?.dir;
      if (job?.job_id) {
        for (;;) {
          await new Promise((r) => setTimeout(r, 2000));
          const st: any = await invoke('chroma_depth_track_status', { jobId: job.job_id });
          if (st?.total) setDepthTrackProgress({ done: st.done ?? 0, total: st.total });
          if (st?.state === 'done') break;
          if (st?.state === 'error') throw new Error(st.error || 'depth track failed');
          if (st?.state === 'cancelled' || st?.state === 'unknown') break;
        }
      }
      if (dir && subMaskId) {
        const cur = useEditorStore
          .getState()
          .adjustments?.masks?.flatMap((m: MaskContainer) => m.subMasks)
          .find((s: SubMask) => s.id === subMaskId);
        updateSubMask(subMaskId, { parameters: { ...(cur?.parameters || {}), chromaDepthDir: dir } });
      }
      useChromaStore.getState().bumpFrameNonce();
      return { subMaskId, dir };
    } catch (err: any) {
      toast.error(`Track Depth failed: ${err?.message || String(err)}`);
      return { error: err?.message || String(err) };
    } finally {
      setDepthTrackProgress(null);
    }
  };

  const handleGenerateAiDepthMask = async (subMaskId: string, parameters: any) => {
    const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
    if (!selectedImage?.path) return;
    setEditor({ isGeneratingAiMask: true });

    try {
      const transformAdjustments = getTransformAdjustments(adjustments);
      const newParameters = await invoke('generate_ai_depth_mask', {
        jsAdjustments: transformAdjustments,
        path: selectedImage.path,
        minDepth: parameters.minDepth ?? 20,
        maxDepth: parameters.maxDepth ?? 100,
        minFade: parameters.minFade ?? 15,
        maxFade: parameters.maxFade ?? 15,
        feather: parameters.feather ?? 10,
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        rotation: adjustments.rotation,
      });

      const subMask = adjustments.aiPatches
        ?.flatMap((p: AiPatch) => p.subMasks)
        .find((sm: SubMask) => sm.id === subMaskId);
      const mergedParameters = { ...(subMask?.parameters || {}), ...newParameters };
      patchesSentToBackend.delete(subMaskId);
      updateSubMask(subMaskId, { parameters: mergedParameters });
    } catch (error) {
      toast.error(`AI Depth Mask Failed: ${error}`);
    } finally {
      setEditor({ isGeneratingAiMask: false });
    }
  };

  /**
   * Depth-haze preset (roadmap item 4 / D-024).
   *
   * One action → a "Depth Haze" mask container whose matte is a depth mask over
   * the FULL depth range, inverted, so the mask weight tracks distance: the
   * nearest surfaces (the subject) get ~0, the farthest (the background wall)
   * get the most. The container's grade is the atmospheric look — negative
   * `dehaze` (which ADDS haze in-shader), desaturation, a lifted black point,
   * lifted shadows and a background defocus (per-mask `blur`, D-027) — scaled by
   * `amount`. Net effect: the background goes milky, soft and recedes, the
   * subject stays sharp and punchy, depth separation without a rotoscope.
   *
   * Depth is per-frame: the mask re-runs Depth Anything V2 on `generate_ai_depth_mask`
   * and `chroma_seek` now busts the depth cache, so a re-run on another frame
   * grades that frame's depth. It is NOT keyframed / temporally smoothed — a
   * static shot is fine; a moving camera would want a re-generate per section.
   *
   * `protectSubject` (default true): with a tracked `ai-subject` mask already on
   * the clip, that mask's own grade composites on top and keeps the subject
   * punchy, so nothing extra is needed here. Caveat: a subject that physically
   * stands in the far-depth band still picks up some haze from this mask — the
   * clean fix is an additive-depth / subtractive-subject composite in one
   * container, deferred.
   */
  const handleAddDepthHaze = useCallback(
    async ({
      amount = 1.0,
      protectSubject = true,
      tracked = false,
    }: { amount?: number; protectSubject?: boolean; tracked?: boolean } = {}) => {
      const { selectedImage, adjustments } = useEditorStore.getState();
      if (!selectedImage?.path) {
        toast.error('Depth Haze: open an image or video first');
        return { error: 'no image loaded' };
      }
      const a = Math.max(0, Math.min(3, Number.isFinite(amount) ? amount : 1.0));
      const w = selectedImage.width ?? 1000;
      const h = selectedImage.height ?? 1000;

      const sub: any = createSubMask(Mask.AiDepth, { width: w, height: h }, SubMaskMode.Additive);
      // full range + invert => mask value == distance (near subject ~0, far bg ~max)
      sub.invert = true;
      sub.name = 'Background (depth)';
      sub.parameters = { ...sub.parameters, minDepth: 0, maxDepth: 100, minFade: 0, maxFade: 0, feather: 12 };

      const hazeAdjustments = {
        ...JSON.parse(JSON.stringify(INITIAL_MASK_ADJUSTMENTS)),
        dehaze: -30 * a, // negative dehaze ADDS haze (engine note, doc 09)
        saturation: -25 * a,
        blacks: 10 * a,
        shadows: 8 * a,
        blur: Math.min(40, 12 * a), // depth-weighted background defocus (D-027)
      };

      const container: MaskContainer = {
        ...INITIAL_MASK_CONTAINER,
        adjustments: hazeAdjustments,
        invert: false,
        id: uuidv4(),
        name: 'Depth Haze',
        opacity: 100,
        subMasks: [sub],
        visible: true,
      };

      setAdjustments((prev: Adjustments) => ({ ...prev, masks: [...(prev.masks || []), container] }));
      setEditor({ activeMaskContainerId: container.id, activeMaskId: sub.id });

      // runs Depth Anything V2 (Rust ONNX) on the current frame + merges the
      // static matte into the sub-mask — always, so a still / an un-tracked clip
      // still works and there's a baked fallback if the track is later cleared.
      await handleGenerateAiDepthMask(sub.id, sub.parameters);

      // `tracked`: also precompute a per-frame VDA depth track and point the
      // sub-mask at it (`chromaDepthDir`). The render-time hook then prefers the
      // per-frame PNG over the static bake — the haze follows a moving camera
      // without flicker (D-036). Video only.
      let depthDir: string | undefined;
      if (tracked && (useChromaStore.getState().videoInfo?.isVideo ?? false)) {
        const r: any = await handleTrackDepth(sub.id);
        depthDir = r?.dir;
      }

      useChromaStore.getState().bumpFrameNonce();
      return { maskId: container.id, subMaskId: sub.id, amount: a, protectSubject, tracked: !!depthDir, depthDir };
    },
    [setAdjustments, setEditor],
  );

  const handleGenerateAiForegroundMask = async (subMaskId: string) => {
    const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
    if (!selectedImage?.path) return;
    setEditor({ isGeneratingAiMask: true });

    try {
      const transformAdjustments = getTransformAdjustments(adjustments);
      const newParameters = await invoke(Invokes.GenerateAiForegroundMask, {
        jsAdjustments: transformAdjustments,
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        rotation: adjustments.rotation,
      });

      const subMask = adjustments.aiPatches
        ?.flatMap((p: AiPatch) => p.subMasks)
        .find((sm: SubMask) => sm.id === subMaskId);
      const mergedParameters = { ...(subMask?.parameters || {}), ...newParameters };
      patchesSentToBackend.delete(subMaskId);
      updateSubMask(subMaskId, { parameters: mergedParameters });
    } catch (error) {
      toast.error(`AI Mask Failed: ${error}`);
    } finally {
      setEditor({ isGeneratingAiMask: false });
    }
  };

  const handleGenerateAiSkyMask = async (subMaskId: string) => {
    const { selectedImage, adjustments, patchesSentToBackend } = useEditorStore.getState();
    if (!selectedImage?.path) return;
    setEditor({ isGeneratingAiMask: true });

    try {
      const transformAdjustments = getTransformAdjustments(adjustments);
      const newParameters = await invoke(Invokes.GenerateAiSkyMask, {
        jsAdjustments: transformAdjustments,
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        rotation: adjustments.rotation,
      });

      const subMask = adjustments.aiPatches
        ?.flatMap((p: AiPatch) => p.subMasks)
        .find((sm: SubMask) => sm.id === subMaskId);
      const mergedParameters = { ...(subMask?.parameters || {}), ...newParameters };
      patchesSentToBackend.delete(subMaskId);
      updateSubMask(subMaskId, { parameters: mergedParameters });
    } catch (error) {
      toast.error(`AI Mask Failed: ${error}`);
    } finally {
      setEditor({ isGeneratingAiMask: false });
    }
  };

  useEffect(() => {
    const { activeMaskId, activeAiSubMaskId, adjustments, selectedImage } = useEditorStore.getState();
    const activeSubMask =
      adjustments?.masks?.flatMap((m: MaskContainer) => m.subMasks).find((sm: SubMask) => sm.id === activeMaskId) ||
      adjustments?.aiPatches?.flatMap((p: AiPatch) => p.subMasks).find((sm: SubMask) => sm.id === activeAiSubMaskId);

    const isChromaVideo = useChromaStore.getState().videoInfo?.isVideo ?? false;
    if (activeSubMask?.type === 'ai-subject' && selectedImage?.path && !isChromaVideo) {
      const transformAdjustments = getTransformAdjustments(adjustments);
      invoke('precompute_ai_subject_mask', {
        jsAdjustments: transformAdjustments,
        path: selectedImage.path,
      }).catch((err) => console.error('Failed to precompute AI subject mask:', err));
    }
  }, [
    useEditorStore.getState().activeMaskId,
    useEditorStore.getState().activeAiSubMaskId,
    useEditorStore.getState().selectedImage?.path,
  ]);

  return {
    updateSubMask,
    handleGenerativeReplace,
    handleDirectPatch,
    handleQuickErase,
    handleDeleteMaskContainer,
    handleDeleteAiPatch,
    handleToggleAiPatchVisibility,
    handleGenerateAiMask,
    handleGenerateAiDepthMask,
    handleAddDepthHaze,
    handleGenerateAiForegroundMask,
    handleGenerateAiSkyMask,
    handleTrackSubject,
    handleTrackDepth,
  };
}

/**
 * The Colorist's brand applier (D-416).
 *
 * What it is: registers the Colorist with `@apelles/brand`'s applier registry,
 * so the Brand panel's Apply and `brand_apply_kit` can give the open shot the
 * kit's grade look: its LUT (from the project's kit snapshot, a content-hashed
 * `.cube` file) at the kit's intensity. One `setAdjustments` write, the same
 * path the LUT picker uses (`useEditorActions.handleLutSelect`), so it is ONE
 * Colorist history entry and undoes like any LUT choice.
 *
 * What it does NOT do: grade anything else (a kit's look is a LUT, nothing per
 * shot), or apply to shots that are not open (each shot's grade is its own).
 * Mounted once from `App.tsx`, next to `useChromaControl`.
 */
import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { assetPath, registerBrandApplier, type BrandApplyOutcome, type BrandApplyRequest } from '@apelles/brand';
import { useEditorStore } from '../store/useEditorStore';
import { INITIAL_ADJUSTMENTS, type Adjustments } from '../utils/adjustments';
import { useEditorActions } from './useEditorActions';

type SetAdjustments = (value: (prev: Adjustments) => Adjustments) => void;

/** The applier itself, given the Colorist's own adjustment writer. */
export async function applyBrandToColorist(
  setAdjustments: SetAdjustments,
  req: BrandApplyRequest,
): Promise<BrandApplyOutcome> {
  const look = req.kit.look;
  if (!look) return { ok: true, changed: false, summary: 'the kit has no grade look' };
  const image = useEditorStore.getState().selectedImage;
  if (!image) return { ok: false, error: 'no shot is open in the Colorist' };
  const path = assetPath(req.assetsDir, look.lut);
  const { size } = await invoke<{ size: number }>('load_and_parse_lut', { path });
  const name = look.name ?? `${req.kit.name} look`;
  const prev = useEditorStore.getState().adjustments;
  if (prev.lutPath === path && prev.lutIntensity === look.intensity) {
    return { ok: true, changed: false, summary: `already graded with ${name}` };
  }
  setAdjustments((current) => ({
    ...current,
    lutPath: path,
    lutName: name,
    lutSize: size,
    lutIntensity: look.intensity,
    lutIsSceneReferred: false,
    sectionVisibility: {
      ...(current.sectionVisibility || INITIAL_ADJUSTMENTS.sectionVisibility),
      effects: true,
    },
  }));
  return { ok: true, changed: true, summary: `LUT ${name} at ${look.intensity}%`, details: { lut: path, shot: image.path } };
}

export function useColoristBrandApplier(): void {
  const { setAdjustments } = useEditorActions();
  useEffect(
    () => registerBrandApplier('colorist', (req) => applyBrandToColorist(setAdjustments, req)),
    [setAdjustments],
  );
}

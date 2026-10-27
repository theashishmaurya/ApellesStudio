/**
 * @apelles/brand — applying a kit to the tabs, one undo step per tab (D-416).
 *
 * What it is: a registry each tab puts ITS apply function into when it mounts
 * (`registerBrandApplier('motion', …)` from `MotionTab`, `'edit'` from
 * `EditorTab`, `'colorist'` from the app), and `applyBrandKit`, the ONE function
 * the Brand panel's Apply button and the `brand_apply_kit` op both call. Each
 * applier makes exactly one history entry in its own tab (a Motion commit, one
 * Edit op, one Colorist adjustment write), so undo walks a brand application
 * back tab by tab.
 *
 * Why a registry: this package sits below the tabs (CLAUDE.md layering:
 * tabs → services), so it may not import them; and the Motion document is
 * component state inside `MotionTab`, reachable only from there. A tab that is
 * not mounted (Motion hidden in the beta, D-391) simply has no applier and is
 * reported as unavailable, not silently skipped.
 *
 * What it does NOT do: decide what a kit means for a tab (each applier does),
 * or apply anything the caller did not ask for.
 */
import { sharedValue } from '@apelles/store';
import type { BrandKit } from './kit';

export const BRAND_TABS = ['edit', 'motion', 'colorist'] as const;
export type BrandTab = (typeof BRAND_TABS)[number];

export interface BrandApplyOptions {
  /** Motion only: also restyle EXISTING layers and keyframes with the kit's
   *  motion style (entrances, keyframe eases). Off by default: a kit's motion
   *  style is a default for new work, never a silent rewrite. */
  restyleExisting?: boolean;
  /** Edit only: also restyle existing titles (text clips) with the kit's
   *  display font and text colour, not just the caption tracks. Default true. */
  titles?: boolean;
}

export interface BrandApplyRequest {
  kit: BrandKit;
  /** the project's brand asset folder (`chroma_brand_project_assets_dir`),
   *  where every file the kit names is (the snapshot copy) */
  assetsDir: string;
  options: BrandApplyOptions;
}

/** One tab's answer: what changed, or why nothing did. */
export type BrandApplyOutcome =
  | { ok: true; changed: boolean; summary: string; details?: Record<string, unknown> }
  | { ok: false; error: string };

export type BrandApplier = (req: BrandApplyRequest) => Promise<BrandApplyOutcome>;

const appliers = sharedValue('brand.appliers', () => new Map<BrandTab, BrandApplier>());

/** Install `tab`'s apply function; returns the uninstall (call it on unmount). */
export function registerBrandApplier(tab: BrandTab, applier: BrandApplier): () => void {
  appliers.set(tab, applier);
  return () => {
    if (appliers.get(tab) === applier) appliers.delete(tab);
  };
}

/** Which tabs can apply a kit right now. */
export function availableBrandTabs(): BrandTab[] {
  return BRAND_TABS.filter((t) => appliers.has(t));
}

/** Apply `req.kit` to each of `tabs`, in Edit → Motion → Colorist order, each
 *  independently: one tab failing does not stop the others, and each outcome
 *  is reported. */
export async function applyBrandKit(
  tabs: readonly BrandTab[],
  req: BrandApplyRequest,
): Promise<Record<BrandTab, BrandApplyOutcome | undefined>> {
  const out: Record<BrandTab, BrandApplyOutcome | undefined> = { edit: undefined, motion: undefined, colorist: undefined };
  for (const tab of BRAND_TABS) {
    if (!tabs.includes(tab)) continue;
    const applier = appliers.get(tab);
    if (!applier) {
      out[tab] = { ok: false, error: `the ${tab} tab is not available in this build` };
      continue;
    }
    try {
      out[tab] = await applier(req);
    } catch (e) {
      out[tab] = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return out;
}

/** Test seam: forget every applier. */
export function __clearBrandAppliersForTest(): void {
  appliers.clear();
}

// @apelles/editor — applying a brand kit to the Edit timeline (D-416).
//
// **What it is:** the Edit tab's applier for `@apelles/brand`'s registry
// (`EditorTab` registers it). It resolves the kit into ONE `apply_brand_text`
// op (one undo step): the kit's caption preset (`captionPresets.ts`), with the
// kit's font and colour roles laid over it, onto every unlocked subtitle track;
// and, unless asked not to, the kit's display font and text colour onto every
// title. `planBrandText` is pure and tested; the applier only adds the store.
//
// **Fonts.** The Edit renderers read one single-face font FILE for both the
// preview and the export (D-212), so a kit font reaches Edit only as a
// `.ttf`/`.otf` file the project's kit snapshot carries (its asset id IS the
// catalogue key, `chroma_text_fonts` lists it) or through the font's
// `editFallback` catalogue key. A Google or system face with neither keeps the
// preset's font, and the result says so rather than pretending.
//
// **What it does NOT do:** create a subtitle track or captions (the Captions
// panel and `editor_add_caption_preset` do), or touch anything but text.

import type { BrandApplyOutcome, BrandApplyRequest, BrandKit, ColorRole } from '@apelles/brand';
import { captionPresetById, captionPresetIds } from './captionPresets';
import type { CaptionStyle } from './caption';
import { isTextClip, type EditOp, type TextLayer, type Timeline } from './timeline';
import { reloadTextFonts } from './textFonts';
import { useEditorTimelineStore } from './timelineStore';

/** The caption preset a kit without a caption section gets. */
export const DEFAULT_BRAND_CAPTION_PRESET = 'plain-subtitle';

/** The Edit catalogue key a kit's font role reaches Edit as, or null. */
export function editFontKey(kit: BrandKit, role: 'display' | 'body'): string | null {
  const font = kit.typography[role];
  if (font.source === 'file' && font.file && /\.(ttf|otf)$/.test(font.file)) return font.file;
  return font.editFallback ?? null;
}

const colorOf = (kit: BrandKit, role: ColorRole | undefined): string | undefined =>
  role ? kit.colors[role] : undefined;

export type BrandTextPlan =
  | { op: Extract<EditOp, { kind: 'apply_brand_text' }>; notes: string[]; captionTracks: number[]; titles: number }
  | { error: string };

/** The kit → the one op (or why there is nothing to apply). Pure. */
export function planBrandText(tl: Timeline, kit: BrandKit, opts: { titles: boolean }): BrandTextPlan {
  const notes: string[] = [];
  const presetId = kit.captions?.preset ?? DEFAULT_BRAND_CAPTION_PRESET;
  const preset = captionPresetById(presetId);
  if (!preset) {
    return { error: `the kit's caption preset "${presetId}" is not one of: ${captionPresetIds().join(', ')}` };
  }
  const captionFont = editFontKey(kit, kit.captions?.font ?? 'body');
  if (!captionFont) notes.push(`captions keep the preset's font: the kit's ${kit.captions?.font ?? 'body'} font is not a .ttf/.otf file and has no editFallback`);
  const captionStyle: Partial<CaptionStyle> = {
    ...preset.style,
    ...(captionFont ? { font: captionFont } : {}),
    ...(colorOf(kit, kit.captions?.color) ? { color: colorOf(kit, kit.captions?.color) } : {}),
    ...(colorOf(kit, kit.captions?.boxColor) ? { box_color: colorOf(kit, kit.captions?.boxColor) } : {}),
  };
  const captionTracks = tl.tracks.flatMap((t, i) => (t.kind === 'subtitle' && !t.locked ? [i] : []));
  if (captionTracks.length === 0) notes.push('no unlocked subtitle track to style');

  let titlePatch: Partial<TextLayer> | null = null;
  let titles = 0;
  if (opts.titles) {
    const titleFont = editFontKey(kit, 'display');
    if (!titleFont) notes.push("titles keep their font: the kit's display font is not a .ttf/.otf file and has no editFallback");
    titlePatch = { color: kit.colors.text, ...(titleFont ? { font: titleFont } : {}) };
    titles = tl.tracks.reduce((n, t) => n + (t.locked ? 0 : t.clips.filter((c) => isTextClip(c)).length), 0);
  }
  return {
    op: {
      kind: 'apply_brand_text',
      kitName: kit.name,
      captionTracks,
      captionStyle: captionTracks.length > 0 ? captionStyle : null,
      titlePatch: titles > 0 ? titlePatch : null,
    },
    notes,
    captionTracks,
    titles,
  };
}

/** The Edit tab's brand applier. */
export async function applyBrandToEdit(req: BrandApplyRequest): Promise<BrandApplyOutcome> {
  const store = useEditorTimelineStore.getState();
  const tl = store.timeline;
  if (!tl) return { ok: false, error: 'no timeline: open a project first' };
  // The kit's font files are catalogue entries only once the backend has read
  // the project's kit; refresh so the Inspector and the export see them.
  await reloadTextFonts();
  const plan = planBrandText(tl, req.kit, { titles: req.options.titles !== false });
  if ('error' in plan) return { ok: false, error: plan.error };
  store.applyOp(plan.op);
  const after = useEditorTimelineStore.getState().timeline;
  const changed = after !== tl;
  return {
    ok: true,
    changed,
    summary: changed
      ? `${plan.captionTracks.length} subtitle track(s) and ${plan.titles} title(s) styled`
      : 'nothing to change',
    details: { captionTracks: plan.captionTracks, titles: plan.titles, notes: plan.notes },
  };
}

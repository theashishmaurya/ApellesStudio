/**
 * @chroma/editor — the Inspector's **Title** section: a text clip's own
 * content / font / size / colour (D-211, `docs/notes/text-title-clips.md`).
 *
 * **Its own component, rendered ABOVE `EditorInspectorPanel`, rather than a
 * section inside `ClipInspectorPanel`.** A title's properties are a different
 * form from a clip's geometry — different fields, a different write op
 * (`set_text_clip`, not `set_clip_transform`), and only ever relevant for one
 * kind of clip. Stacking the two panels is also what keeps the shared half
 * genuinely shared: a text clip's Opacity and Position rows, with their
 * keyframe diamonds and per-property reset, are the EXISTING D-208 rows in
 * `ClipInspectorPanel`, rendered unchanged underneath this — not a
 * copy-pasted second implementation, which is what folding this in as a
 * branch of that panel would have tempted.
 *
 * Renders `null` for anything that is not exactly one selected text clip, so
 * `EditorTab` can mount it unconditionally.
 *
 * **Known Phase 1 gap, disclosed rather than hidden:** a text clip honours
 * `opacity` and `position_x`/`position_y` in both renderers and nothing else
 * (see `chroma::edit::resolve_text_clip_transform` and
 * `buildTextDrawtextStep`), but the Transform panel below this one still
 * SHOWS its Scale / Rotation / Crop / Size rows for a title, because
 * `ClipInspectorPanel.tsx` was being edited by two other concurrent efforts
 * during this pass and could not be touched. Editing one of those rows on a
 * title changes no pixel in either engine. Three things stand in for the
 * missing hide: the note at the bottom of this section, the MCP
 * `editor_set_clip_transform` op refusing a non-default value for one of
 * them outright, and both renderers pinning them. Gating those rows on
 * `clip.text == null` inside `ClipInspectorPanel` is a one-line follow-up —
 * tracked in `docs/notes/text-title-clips.md` and roadmap item 24.
 *
 * Every write goes through the same `set_text_clip` op the MCP
 * `editor_set_text_clip` tool uses, and through the same `newTextLayer`
 * validation — one op and one validator under both interfaces, per CLAUDE.md.
 */
import { useEffect, useState } from 'react';
import {
  Button,
  Input,
  ScrubbableNumberInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@chroma/ui';
import { InspectorSection } from '@chroma/inspector';

import { findClip, newTextLayer, type TextLayer } from './timeline';
import { useEditorTimelineStore } from './timelineStore';
import { baseFontFamilies, composeFontStyleKey, fontStyleOf, useTextFonts } from './textFonts';

/** `TextLayer.size` is a fraction of the composition height; the field shows
 *  it as a percentage, which is the number a human actually reasons about
 *  ("12% of frame height"). Same "store the invariant, show the readable
 *  unit" split `ClipInspectorPanel`'s own Width/Height fields already use
 *  (canvas fractions stored, real pixels shown). */
const SIZE_PERCENT = 100;
/** 0.5%–100% of the frame height. The lower bound is where a title stops
 *  being legible at all rather than an arbitrary floor; the upper is the
 *  whole frame. */
const MIN_SIZE_PERCENT = 0.5;
const MAX_SIZE_PERCENT = 100;

const row = 'flex items-center justify-between gap-2';
const numInput = 'h-7 w-20 text-right';

export function TextClipInspectorPanel() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const selection = useEditorTimelineStore((s) => s.selection);
  const applyOp = useEditorTimelineStore((s) => s.applyOp);
  const fonts = useTextFonts();

  // Same Phase 1 multi-select fallback every single-clip-only consumer uses
  // (`docs/notes/multi-select.md`): a selection that isn't exactly one clip
  // shows nothing.
  const primary = selection.length === 1 ? selection[0] : null;
  const found = primary ? findClip(timeline, primary.track, primary.id) : null;
  const clip = found?.clip ?? null;
  const layer = clip?.text ?? null;
  const clipIndex = found?.index ?? -1;
  const trackLocked = primary ? !!timeline?.tracks[primary.track]?.locked : false;

  // The content field is a *draft* while it is being typed: committing an op
  // on every keystroke would push one undo entry per character and re-run the
  // preview's compositor for each. Committed on blur and on Enter — the same
  // "type freely, commit on a real boundary" behaviour every reference NLE's
  // own title text field has. Re-seeded whenever the selected clip's own
  // stored text changes (a different clip, or an MCP write landing while this
  // panel is open), so the field can never keep showing a stale draft.
  const storedContent = layer?.content ?? '';
  const [draft, setDraft] = useState(storedContent);
  useEffect(() => {
    setDraft(storedContent);
  }, [storedContent, clip?.id]);

  const [error, setError] = useState<string | null>(null);

  if (!primary || !clip || !layer || clipIndex < 0) return null;

  const patch = (p: Partial<TextLayer>) => {
    // Validated here, with the SAME validator the MCP op uses, so the human
    // gets the identical message an agent would (`newTextLayer`'s errors are
    // written to be read by either).
    const merged = newTextLayer(p, layer);
    if ('error' in merged) {
      setError(merged.error);
      return;
    }
    setError(null);
    applyOp({ kind: 'set_text_clip', track: primary.track, clip: clipIndex, patch: p });
  };

  const commitDraft = () => {
    if (draft === storedContent) return;
    patch({ content: draft });
  };

  return (
    <div className="shrink-0 border-b border-border-color p-3">
      <InspectorSection label="Title">
        <div className="flex flex-col gap-2 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-text-secondary">Text</span>
            <Input
              value={draft}
              disabled={trackLocked}
              className="h-7"
              placeholder="Type your title…"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitDraft}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitDraft();
                } else if (e.key === 'Escape') {
                  setDraft(storedContent);
                }
                // Every other key stays local to the field — without this the
                // timeline pane's own Delete/Backspace handler would delete
                // the selected clip while its title is being edited.
                e.stopPropagation();
              }}
            />
          </label>

          <div className={row}>
            <span className="text-text-secondary">Font</span>
            <span className="flex items-center gap-1">
              <Select
                value={fontStyleOf(fonts, layer.font).group ?? layer.font}
                disabled={trackLocked || fonts.length === 0}
                // Base UI's `Select` can hand back `null` (a cleared value);
                // this one has no clear affordance, so ignore it rather than
                // writing an empty font key. Changing FAMILY keeps whatever
                // Bold/Italic is currently on (D-240) — composed via the
                // family's own `group`, from a base row keyed by group.
                onValueChange={(v: string | null) => {
                  if (!v) return;
                  const cur = fontStyleOf(fonts, layer.font);
                  patch({ font: composeFontStyleKey(fonts, v, cur.bold, cur.italic) });
                }}
              >
                <SelectTrigger className="h-7 w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {baseFontFamilies(fonts).map((f) => (
                    // A family this machine has no file for is listed but not
                    // selectable — see `textFonts.ts`: substituting a
                    // different face would make the export disagree with the
                    // preview.
                    <SelectItem key={f.key} value={f.group ?? f.key} disabled={!f.path}>
                      {f.path ? f.label : `${f.label} (unavailable)`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* D-240 — Bold/Italic toggle buttons next to the family picker,
                  the universal text-editor convention (Word, Resolve's Text+,
                  Premiere's Essential Graphics, Final Cut's Titles all put
                  B/I buttons beside the font family rather than a combined
                  "Family Bold Italic" dropdown row per style). Disabled when
                  the current family has no `group` (Impact, Sans Black —
                  neither ships an italic face, and both are already at their
                  own maximum weight) since there is no sibling to toggle to. */}
              {(() => {
                const style = fontStyleOf(fonts, layer.font);
                const disabled = trackLocked || style.group === null;
                return (
                  <>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={disabled}
                      className={`font-bold ${style.bold ? 'text-accent' : 'text-text-secondary/50'}`}
                      aria-pressed={style.bold}
                      title="Bold"
                      onClick={() =>
                        patch({ font: composeFontStyleKey(fonts, layer.font, !style.bold, style.italic) })
                      }
                    >
                      B
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={disabled}
                      className={`italic ${style.italic ? 'text-accent' : 'text-text-secondary/50'}`}
                      aria-pressed={style.italic}
                      title="Italic"
                      onClick={() =>
                        patch({ font: composeFontStyleKey(fonts, layer.font, style.bold, !style.italic) })
                      }
                    >
                      I
                    </Button>
                  </>
                );
              })()}
            </span>
          </div>

          <label className={row}>
            <span className="text-text-secondary">Size</span>
            <span className="flex items-center gap-1">
              <ScrubbableNumberInput
                step={0.5}
                min={MIN_SIZE_PERCENT}
                max={MAX_SIZE_PERCENT}
                disabled={trackLocked}
                className={numInput}
                value={Number((layer.size * SIZE_PERCENT).toFixed(2))}
                onValueChange={(pct) => {
                  if (pct <= 0) return;
                  patch({ size: pct / SIZE_PERCENT });
                }}
              />
              <span className="text-text-secondary/60">%</span>
            </span>
          </label>

          <label className={row}>
            <span className="text-text-secondary">Colour</span>
            <span className="flex items-center gap-1.5">
              <Input
                disabled={trackLocked}
                className="h-7 w-20 text-right font-mono"
                value={layer.color}
                onChange={(e) => patch({ color: e.target.value })}
              />
              {/* The native swatch and the hex field write the SAME field —
                  the picker is the discoverable way in, the hex box the exact
                  one, and neither is a second source of truth. */}
              <input
                type="color"
                disabled={trackLocked}
                aria-label="Title colour"
                className="h-7 w-7 shrink-0 cursor-pointer rounded border border-border-color bg-transparent p-0.5"
                value={/^#[0-9a-fA-F]{6}$/.test(layer.color) ? layer.color : '#FFFFFF'}
                onChange={(e) => patch({ color: e.target.value })}
              />
            </span>
          </label>

          {error && <p className="text-[11px] text-red-400">{error}</p>}
          <p className="text-[10px] leading-snug text-text-secondary/60">
            Position and opacity are below, and keyframe like any other clip. Scale, rotation and crop
            don’t apply to a title — use Size.
          </p>
        </div>
      </InspectorSection>
    </div>
  );
}

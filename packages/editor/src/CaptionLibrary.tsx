/**
 * @apelles/editor — the Edit tab's **caption library** (D-243, docked by
 * D-263; `docs/notes/caption-presets.md`).
 *
 * **What it is:** the Subtitles library, rendered inside the docked left-hand
 * library column (`EditLibraryPanel.tsx`). Two tabs:
 * - **Import** — the D-229 `.srt`/`.vtt` flow, unchanged, moved in here.
 * - **Styles** — a library of caption presets, each with a live thumbnail,
 *   that drop onto the timeline in one click.
 *
 * **What it does NOT do:** it owns no preset data (`captionPresets.ts`), no
 * placement logic (`captionPresetAction.ts`) and no per-caption property
 * editing — that is `CaptionInspectorPanel.tsx`, which is where a PLACED
 * caption is edited, the same split the reference NLEs use (a browser of
 * looks, and an Inspector for the selected thing).
 *
 * **Why a library rather than the bare button it replaces.** D-229's
 * "Subtitles" button went straight to a file picker, so the only way to get a
 * caption was to already have an `.srt`. The owner's ask (roadmap 28) is the
 * CapCut/HeyGen shape: a library of styled looks you can drop directly, with
 * import as one option rather than the only one.
 *
 * **Docked, not a popover (D-263).** This was `CaptionPanel.tsx` until D-263:
 * a "Captions ▾" button that opened this same content in a `Popover`, itself
 * mounted inside the library rail's own popover. The owner asked for the
 * libraries to open *in the docked panel* instead, and a browser of looks is
 * exactly what a docked browser column is for — it is what Final Cut Pro's own
 * Titles-and-Generators browser and Resolve's effects library both are
 * (`scratch/activity-bar-reference/notes.md`). Nothing about the CONTENT
 * changed in that move; what went away is the popover wrapper, its open flag
 * (D-252's `caption-panel` panel id, retired with it) and the two
 * `setOpen(false)` calls that closed it after a pick — a docked panel has
 * nothing to close, and staying open is what lets a second preset be tried
 * straight after the first.
 *
 * **The thumbnails are the real style, not pictures.** Each tile renders the
 * preset's own colours, weight, box and highlight in CSS at tile scale — so a
 * preset cannot show one thing in the library and apply another, which a
 * checked-in PNG per preset would eventually do. It is an approximation of the
 * RENDER (the browser is a third rasteriser, and it is not asked to be exact),
 * but it is driven by the same `CaptionStyle` the two renderers read.
 */
import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { FileUp } from 'lucide-react';
import {
  Button,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@apelles/ui';

import { resolveCaptionStyle } from './caption';
import { captionAnimationOf } from './captionAnim';
import { captionPresetGroups, type CaptionPreset } from './captionPresets';
import { applyCaptionPreset } from './captionPresetAction';
import { useEditorTimelineStore } from './timelineStore';

/** One cue as `chroma_import_subtitles` returns it — already parsed and on the
 *  project's own timebase. Mirrors `chroma::subtitles::ImportedCaption`. */
interface ImportedCaption {
  id: string;
  start_frame: number;
  duration: number;
  text: string;
}

/** The words a thumbnail shows. Three short words so a per-word preset has
 *  something to highlight, and so every tile is the same width. */
const THUMB_WORDS = ['Your', 'caption', 'here'];
/** Which word a thumbnail shows as the ACTIVE one — the middle, so a viewer
 *  sees a spoken word, the live word and an upcoming one at once. */
const THUMB_ACTIVE = 1;

/**
 * A preset's look, drawn in CSS at tile scale.
 *
 * Sizes are expressed against the tile's own height the same way the real
 * style is expressed against the frame's — so a preset that is 8% of frame
 * height is 8% of tile height here, and the tiles' relative weights are
 * honest.
 */
function PresetThumbnail({ preset }: { preset: CaptionPreset }) {
  const style = resolveCaptionStyle(preset.style);
  const anim = captionAnimationOf(preset.style);
  // The tile is 56px tall; a caption's `size` is a fraction of frame height.
  // Scaled up (x2.4) because a real 5.5% caption at 56px would be 3px tall and
  // unreadable — the tiles are a comparison of LOOK, not a to-scale mock.
  const fontPx = Math.max(7, Math.round(style.size * 56 * 2.4));
  const singleWord = anim.kind === 'slam';
  const words = singleWord ? [THUMB_WORDS[THUMB_ACTIVE]] : THUMB_WORDS;

  return (
    <div
      className="flex h-14 w-full items-end justify-center overflow-hidden rounded-sm bg-bg-primary p-1"
      // A checkerboard-free flat backdrop: the presets differ by colour, and a
      // patterned one would fight them.
      style={{ backgroundColor: 'var(--color-bg-primary)' }}
      data-testid={`caption-preset-thumb-${preset.id}`}
    >
      <div
        className="flex max-w-full flex-wrap items-baseline justify-center gap-[2px]"
        style={{
          backgroundColor: style.box_enabled
            ? hexWithAlpha(style.box_color, style.box_opacity)
            : 'transparent',
          padding: style.box_enabled ? '1px 3px' : undefined,
          borderRadius: 2,
        }}
      >
        {words.map((w, i) => {
          const active = singleWord || i === THUMB_ACTIVE;
          const spoken = !singleWord && i < THUMB_ACTIVE;
          const color = active
            ? (anim.active_color ?? style.color)
            : spoken
              ? (anim.spoken_color ?? style.color)
              : (anim.upcoming_color ?? style.color);
          const boxed = active && !!anim.active_box_color;
          return (
            <span
              key={w}
              style={{
                fontSize: fontPx,
                lineHeight: 1.1,
                fontWeight: fontWeightFor(style.font),
                fontFamily: fontFamilyFor(style.font),
                color,
                backgroundColor: boxed
                  ? hexWithAlpha(anim.active_box_color as string, anim.active_box_opacity)
                  : 'transparent',
                padding: boxed ? '0 2px' : undefined,
                whiteSpace: 'nowrap',
              }}
            >
              {w}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** `#RRGGBB` + an opacity as a CSS `rgb()` with alpha. Tolerates `#RGB` and
 *  degrades a malformed value to transparent — a wrong colour in a THUMBNAIL
 *  is cosmetic, so unlike the renderers this one does not fall back to white
 *  (which would read as a real style). */
function hexWithAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return 'transparent';
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : 1));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** A rough CSS stand-in for a catalogue font key.
 *
 *  Deliberately approximate: the tile is a browser rendering and the real
 *  render reads a specific `.ttf` (D-212). What matters is that a "black"
 *  preset LOOKS heavier than a "bold" one in the library, not that the tile
 *  matches the export glyph for glyph. */
function fontFamilyFor(key: string): string {
  if (key.startsWith('serif')) return 'Georgia, serif';
  if (key === 'mono') return 'ui-monospace, monospace';
  if (key === 'impact') return 'Impact, Haettenschweiler, sans-serif';
  if (key === 'condensed-bold') return '"Arial Narrow", Arial, sans-serif';
  return 'Arial, Helvetica, sans-serif';
}

function fontWeightFor(key: string): number {
  if (key.endsWith('black')) return 900;
  if (key.endsWith('bold')) return 700;
  return 400;
}

export function CaptionLibrary() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const applyOp = useEditorTimelineStore((s) => s.applyOp);
  const playhead = useEditorTimelineStore((s) => s.playhead);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const importFile = async () => {
    setError(null);
    // The filter names only what the backend will actually accept — offering
    // `.ttml` here and refusing it after the picker would be a worse
    // experience than not offering it (D-229 §4 on why TTML is refused).
    const picked = await open({
      multiple: false,
      filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt'] }],
    });
    if (typeof picked !== 'string') return;

    // Dropped at the playhead, not at 00:00 — what every reference NLE does
    // when you import into the middle of an edit.
    //
    // Computed BEFORE the `try`, deliberately: the React Compiler bails out of
    // a whole function containing a conditional "value block" inside a
    // try/catch, and D-201 keeps this package at zero bailouts (enforced by
    // `reactCompiler.test.ts`).
    const offsetFrames = playhead > 0 ? playhead : null;
    setBusy(true);
    let res: { cues: ImportedCaption[]; source_name: string } | null = null;
    try {
      res = await invoke<{ cues: ImportedCaption[]; source_name: string }>(
        'chroma_import_subtitles',
        { path: picked, offsetFrames },
      );
    } catch (e) {
      // The backend's message is written to be read by a human as well as an
      // agent, so it is surfaced verbatim rather than replaced with a generic
      // failure.
      setError(String(e));
    }
    setBusy(false);
    if (!res) return;
    if (res.cues.length === 0) {
      setError('That file contained no cues.');
      return;
    }
    // ONE op for the whole file: a 400-cue `.srt` is one undo entry, not four
    // hundred. See the op's own doc in `timeline.ts`.
    applyOp({ kind: 'import_subtitles', cues: res.cues });
  };

  const pick = (preset: CaptionPreset) => {
    setError(null);
    // The SAME action `editor_add_caption_preset` calls — one path for the
    // human and the agent (CLAUDE.md).
    const res = applyCaptionPreset({ presetId: preset.id, placeCaption: true });
    if ('error' in res) setError(res.error);
  };

  return (
    // B-121 — the STYLES tab is what opens first, because the styled preset
    // library is the thing D-243 built and the thing the owner went looking
    // for and could not find when this content sat behind a button that used
    // to open a file picker. "Subtitles" now names only the `.srt`/`.vtt` tab,
    // which is the one thing it accurately describes.
    <div
      data-testid="caption-library"
      className="flex h-full min-h-0 w-full flex-col"
    >
      <Tabs defaultValue="styles" className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-border-color px-2 pt-2">
          <TabsList>
            <TabsTrigger value="styles">Styles</TabsTrigger>
            <TabsTrigger value="import">Import</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="styles" className="m-0 min-h-0 flex-1">
          {/* A plain overflow scroller rather than `@apelles/ui`'s `ScrollArea`
              (which is what the popover used at a fixed `h-[320px]`): docked,
              this fills whatever height the resizable column has, and a
              height-driven flex child is the one thing Base UI's ScrollArea
              viewport needs a fixed height for. */}
          <div className="h-full overflow-y-auto">
            <div className="space-y-3 p-2">
              {captionPresetGroups().map(({ group, presets }) => (
                <div key={group}>
                  <div className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-text-secondary">
                    {group}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {presets.map((preset) => (
                      <Tooltip key={preset.id}>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              onClick={() => pick(preset)}
                              data-testid={`caption-preset-${preset.id}`}
                              aria-label={`Apply the ${preset.label} caption style`}
                              className="group flex flex-col gap-1 rounded-md border border-border-color p-1 text-left transition-colors hover:border-accent focus-visible:border-accent focus-visible:outline-none"
                            >
                              <PresetThumbnail preset={preset} />
                              <span className="truncate px-0.5 text-[11px] text-text-primary">
                                {preset.label}
                              </span>
                            </button>
                          }
                        />
                        <TooltipContent side="right" className="max-w-[260px]">
                          <div className="text-[11px]">{preset.description}</div>
                          {/* The provenance/divergence note, shown where the
                              choice is made rather than buried in a doc. */}
                          <div className="mt-1 text-[10px] opacity-70">{preset.note}</div>
                        </TooltipContent>
                      </Tooltip>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="import" className="m-0">
          <div className="space-y-2 p-3">
            <p className="text-[11px] text-text-secondary">
              Import a subtitle file as a new subtitle track. Cues land at the playhead and can
              be moved, trimmed and split like any other clip.
            </p>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || !timeline}
              onClick={importFile}
              data-testid="caption-import"
            >
              <FileUp className="size-3.5" />
              <span className="ml-1">{busy ? 'Importing…' : 'Choose .srt or .vtt…'}</span>
            </Button>
            <p className="text-[10px] text-text-secondary opacity-70">
              TTML, XML and embedded MXF subtitles are not supported.
            </p>
          </div>
        </TabsContent>
      </Tabs>

      {error && (
        <div
          className="shrink-0 border-t border-border-color px-3 py-2 text-[11px] text-red-400"
          data-testid="caption-library-error"
        >
          {error}
        </div>
      )}
    </div>
  );
}

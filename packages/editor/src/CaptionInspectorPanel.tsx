/**
 * @chroma/editor — the Inspector's **Caption** and **Subtitle Track Style**
 * sections (D-229, `docs/notes/subtitles.md`).
 *
 * **Built from the real reference**, `scratch/resolve-reference/captioning.jpg`
 * (opened and read, not paraphrased — CLAUDE.md's "research the real pattern
 * first" rule). What that frame actually shows, and what is reproduced here:
 *
 * - The panel is titled with the TRACK ("Subtitle 1"), not the clip — because
 *   the thing being styled is the track.
 * - Two groups of controls: the selected **Caption** (its in/out, its
 *   character count, its text, and a "Use Track Style" checkbox) and the
 *   **Track Style** (font / colour / size / position / background).
 * - A **cue list** below them — `#`, Time In/Out, the caption text, and `CPS`
 *   (characters per second, the standard subtitle readability metric) — with
 *   the current cue highlighted. This is the reference's most distinctive
 *   element and the one that makes a 400-cue import navigable at all, so it is
 *   reproduced rather than dropped.
 *
 * **Chroma's own idiom, not a Resolve reskin.** The reference splits
 * Caption/Track Style across two TABS; this uses two stacked
 * `InspectorSection`s, which is how every other panel in this Inspector is
 * built (D-103/D-208) — the same information architecture in this app's own
 * vocabulary. Every control is a `@chroma/ui` component on the shared
 * `--color-*` tokens; no magic colour literals.
 *
 * **Its own component, rendered above `EditorInspectorPanel`**, for exactly
 * the reason `TextClipInspectorPanel` is: a caption's properties are a
 * different form, with a different write op, relevant only to one kind of
 * clip. Renders `null` when the selection is not a caption, so `EditorTab` can
 * mount it unconditionally.
 *
 * **Every write goes through the same store ops the MCP tools use** —
 * `set_caption_text`, `set_caption_style`, `set_caption_cue_style` — so the
 * human and `editor_set_caption*` share one reducer, one validation and one
 * undo entry (CLAUDE.md: "the same op/store action underneath both").
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Input,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from '@chroma/ui';
import { InspectorSection } from '@chroma/inspector';

import {
  captionCps,
  captionLines,
  endFrame,
  findClip,
  isCaptionClip,
  resolveCaptionStyle,
  timelineFps,
  type CaptionAlign,
  type CaptionStyle,
} from './timeline';
// D-243 — the animation half of a caption's style.
import {
  captionAnimationOf,
  isPerWordAnim,
  isSingleWordAnim,
  type CaptionAnimation,
  type CaptionAnimKind,
} from './captionAnim';
import { useEditorTimelineStore } from './timelineStore';
import { useTextFonts } from './textFonts';

/** `size`, `box_padding` and `line_spacing` are stored as fractions and shown
 *  as percentages — the number a human reasons about ("5.5% of frame height").
 *  The same "store the invariant, show the readable unit" split
 *  `TextClipInspectorPanel`'s Size field already uses. */
const PERCENT = 100;

const row = 'flex items-center justify-between gap-2';
const numInput = 'h-7 w-20 text-right';

const ALIGNMENTS: Array<{ value: CaptionAlign; label: string }> = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Centre' },
  { value: 'right', label: 'Right' },
];

/** D-243 — the animation kinds, labelled for the picker. Deliberately the
 *  whole closed set from `captionAnim.ts`: an author can reach any look the
 *  renderers implement from here, not only the ones a preset happens to use. */
const ANIM_KINDS: Array<{ value: CaptionAnimKind; label: string }> = [
  { value: 'none', label: 'None (static)' },
  { value: 'highlight', label: 'Highlight' },
  { value: 'karaoke', label: 'Karaoke' },
  { value: 'slam', label: 'Kinetic slam' },
  { value: 'build', label: 'Word build' },
];

/** The colour the Highlight-box switch turns on with — a visible red rather
 *  than an empty string, so flipping the switch always produces a box the user
 *  can see and then recolour. Matches the Highlight preset's own accent. */
const DEFAULT_HIGHLIGHT_BOX = '#FF1745';

/** Frames → `HH:MM:SS:FF`, the timecode form the reference's own Time In/Out
 *  column uses. Frame-accurate rather than seconds, because a caption's in and
 *  out are edited at frame precision. */
function timecode(frames: number, fps: number): string {
  const f = Math.max(0, Math.round(frames));
  const rate = fps > 0 ? Math.round(fps) : 24;
  const totalSeconds = Math.floor(f / rate);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(
    totalSeconds % 60,
  )}:${pad(f % rate)}`;
}

export function CaptionInspectorPanel() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const selection = useEditorTimelineStore((s) => s.selection);
  const applyOp = useEditorTimelineStore((s) => s.applyOp);
  const setSelection = useEditorTimelineStore((s) => s.setSelection);
  const fonts = useTextFonts();

  // Same Phase 1 multi-select fallback every single-clip-only consumer uses
  // (`docs/notes/multi-select.md`).
  const primary = selection.length === 1 ? selection[0] : null;
  const found = primary ? findClip(timeline, primary.track, primary.id) : null;
  const clip = found?.clip ?? null;
  const clipIndex = found?.index ?? -1;
  const track = primary ? (timeline?.tracks[primary.track] ?? null) : null;
  const trackLocked = !!track?.locked;
  const cue = clip?.caption ?? null;

  // The text is a *draft* while it is being typed: committing on every
  // keystroke would push one undo entry per character and re-rasterise the
  // preview for each. Committed on blur and on Cmd/Ctrl-Enter (a plain Enter
  // has to insert a newline here — a caption is legitimately multi-line, which
  // is the one real difference from the title field's own Enter-commits).
  // Re-seeded whenever the stored text changes, so the field can never show a
  // stale draft after an MCP write or a different cue being selected.
  const storedText = cue?.text ?? '';
  const [draft, setDraft] = useState(storedText);
  useEffect(() => {
    setDraft(storedText);
  }, [storedText, clip?.id]);

  const fps = timelineFps(timeline);
  // The whole track's cues, in timeline order — the reference's cue list.
  // Memoised because it re-sorts on every render otherwise, and a 400-cue
  // imported track re-sorting per keystroke is exactly the kind of jank
  // CLAUDE.md's performance rule is about.
  const cues = useMemo(() => {
    if (!track || track.kind !== 'subtitle') return [];
    return track.clips
      .map((c, index) => ({ c, index }))
      .filter((e) => isCaptionClip(e.c))
      .sort((a, b) => a.c.start_frame - b.c.start_frame);
  }, [track]);

  if (!primary || !clip || !cue || clipIndex < 0 || !track) return null;

  const style = resolveCaptionStyle(cue.style, track.caption_style);
  const usingTrackStyle = cue.style == null;
  // Which "Subtitle N" this is — derived from its position among subtitle
  // tracks, the way the reference labels them, rather than a stored name.
  const subtitleOrdinal =
    (timeline?.tracks.filter((t, i) => t.kind === 'subtitle' && i <= primary.track).length ?? 1);

  const durationSecs = (endFrame(clip, fps) - clip.start_frame) / fps;
  const cps = captionCps(cue.text, durationSecs);

  const commitDraft = () => {
    if (draft === storedText) return;
    applyOp({ kind: 'set_caption_text', track: primary.track, clip: clipIndex, text: draft });
  };

  /** Write a style patch to whichever level is currently in effect — the cue's
   *  own override if it has one, otherwise the track. One control, one
   *  meaning: the user edits "the style of what I'm looking at", and the "Use
   *  Track Style" switch is what chooses which that is. */
  const patchStyle = (p: Partial<CaptionStyle>) => {
    if (usingTrackStyle) {
      applyOp({ kind: 'set_caption_style', track: primary.track, patch: p });
    } else {
      applyOp({ kind: 'set_caption_cue_style', track: primary.track, clip: clipIndex, patch: p });
    }
  };

  /** D-243 — the resolved animation of whatever style is in effect. Read
   *  through `captionAnimationOf` rather than off the field, so an absent key
   *  and an explicit `kind: 'none'` are the same thing here too. */
  const anim = captionAnimationOf(style);

  /** Write one animation field.
   *
   *  Merges onto the RESOLVED animation rather than the stored one, so editing
   *  a single knob on a style that carries no `animation` key at all writes a
   *  complete, self-describing animation instead of a fragment whose other
   *  fields would then silently follow any future change to the defaults.
   *  Goes through `patchStyle`, so it lands at the same level (cue override or
   *  track) as every other control here. */
  const patchAnim = (p: Partial<CaptionAnimation>) => {
    patchStyle({ animation: { ...anim, ...p } });
  };

  return (
    <div className="shrink-0 border-b border-border-color p-3">
      <InspectorSection label={`Subtitle ${subtitleOrdinal}`}>
        <div className="flex flex-col gap-2 text-xs">
          <div className={row}>
            <span className="font-mono text-text-secondary">
              {timecode(clip.start_frame, fps)} → {timecode(endFrame(clip, fps), fps)}
            </span>
            <span className="text-text-secondary/60">
              {[...cue.text].filter((c) => c !== '\n' && c !== '\r').length} chars
              {cps !== null && ` · ${cps.toFixed(0)} CPS`}
            </span>
          </div>

          <Textarea
            value={draft}
            disabled={trackLocked}
            rows={2}
            className="text-xs"
            placeholder="Caption text…"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              // Cmd/Ctrl-Enter commits; a plain Enter inserts a newline,
              // because a two-line cue is the normal case for a caption.
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                commitDraft();
              } else if (e.key === 'Escape') {
                setDraft(storedText);
              }
              // Every other key stays local to the field — without this the
              // timeline pane's own Delete/Backspace handler would delete the
              // selected clip while its caption is being edited.
              e.stopPropagation();
            }}
          />

          <label className={row}>
            <span className="text-text-secondary">Use track style</span>
            <Switch
              checked={usingTrackStyle}
              disabled={trackLocked}
              onCheckedChange={(on: boolean) =>
                applyOp({
                  kind: 'set_caption_cue_style',
                  track: primary.track,
                  clip: clipIndex,
                  // Unticking seeds the override from what is on screen now,
                  // so departing from the track style never visibly jumps.
                  patch: on ? null : {},
                })
              }
            />
          </label>
        </div>
      </InspectorSection>

      <div className="mt-3">
        <InspectorSection label={usingTrackStyle ? 'Track style' : 'This caption only'}>
          <div className="flex flex-col gap-2 text-xs">
            <div className={row}>
              <span className="text-text-secondary">Font</span>
              <Select
                value={style.font}
                disabled={trackLocked || fonts.length === 0}
                onValueChange={(v: string | null) => {
                  if (v) patchStyle({ font: v });
                }}
              >
                <SelectTrigger className="h-7 w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {fonts.map((f) => (
                    // A family with no font file on this machine is listed but
                    // not selectable — substituting a face would make the
                    // export disagree with the preview (D-212).
                    <SelectItem key={f.key} value={f.key} disabled={!f.path}>
                      {f.path ? f.label : `${f.label} (unavailable)`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <label className={row}>
              <span className="text-text-secondary">Size</span>
              <span className="flex items-center gap-1">
                <Input
                  type="number"
                  step={0.1}
                  min={0.5}
                  max={100}
                  disabled={trackLocked}
                  className={numInput}
                  value={Number((style.size * PERCENT).toFixed(2))}
                  onChange={(e) => {
                    const pct = Number(e.target.value);
                    if (!Number.isFinite(pct) || pct <= 0) return;
                    patchStyle({ size: pct / PERCENT });
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
                  value={style.color}
                  onChange={(e) => patchStyle({ color: e.target.value })}
                />
                {/* The swatch and the hex field write the SAME field — the
                    picker is the discoverable way in, the hex box the exact
                    one, and neither is a second source of truth. */}
                <input
                  type="color"
                  disabled={trackLocked}
                  aria-label="Caption colour"
                  className="h-7 w-7 shrink-0 cursor-pointer rounded border border-border-color bg-transparent p-0.5"
                  value={/^#[0-9a-fA-F]{6}$/.test(style.color) ? style.color : '#FFFFFF'}
                  onChange={(e) => patchStyle({ color: e.target.value })}
                />
              </span>
            </label>

            <label className={row}>
              <span className="text-text-secondary">Background</span>
              <Switch
                checked={style.box_enabled}
                disabled={trackLocked}
                onCheckedChange={(on: boolean) => patchStyle({ box_enabled: on })}
              />
            </label>

            {style.box_enabled && (
              <>
                <label className={row}>
                  <span className="text-text-secondary pl-2">Colour</span>
                  <span className="flex items-center gap-1.5">
                    <Input
                      disabled={trackLocked}
                      className="h-7 w-20 text-right font-mono"
                      value={style.box_color}
                      onChange={(e) => patchStyle({ box_color: e.target.value })}
                    />
                    <input
                      type="color"
                      disabled={trackLocked}
                      aria-label="Caption background colour"
                      className="h-7 w-7 shrink-0 cursor-pointer rounded border border-border-color bg-transparent p-0.5"
                      value={/^#[0-9a-fA-F]{6}$/.test(style.box_color) ? style.box_color : '#000000'}
                      onChange={(e) => patchStyle({ box_color: e.target.value })}
                    />
                  </span>
                </label>
                <label className={row}>
                  <span className="text-text-secondary pl-2">Opacity</span>
                  <span className="flex items-center gap-1">
                    <Input
                      type="number"
                      step={1}
                      min={0}
                      max={100}
                      disabled={trackLocked}
                      className={numInput}
                      value={Math.round(style.box_opacity * PERCENT)}
                      onChange={(e) => {
                        const pct = Number(e.target.value);
                        if (!Number.isFinite(pct)) return;
                        patchStyle({ box_opacity: Math.min(1, Math.max(0, pct / PERCENT)) });
                      }}
                    />
                    <span className="text-text-secondary/60">%</span>
                  </span>
                </label>
              </>
            )}

            <div className={row}>
              <span className="text-text-secondary">Align</span>
              <Select
                value={style.align}
                disabled={trackLocked}
                onValueChange={(v: string | null) => {
                  if (v === 'left' || v === 'center' || v === 'right') patchStyle({ align: v });
                }}
              >
                <SelectTrigger className="h-7 w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ALIGNMENTS.map((a) => (
                    <SelectItem key={a.value} value={a.value}>
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {(
              [
                ['position_x', 'Position X'],
                ['position_y', 'Position Y'],
              ] as const
            ).map(([key, label]) => (
              <label className={row} key={key}>
                <span className="text-text-secondary">{label}</span>
                <Input
                  type="number"
                  step={0.01}
                  min={-1}
                  max={2}
                  disabled={trackLocked}
                  className={numInput}
                  value={Number(style[key].toFixed(3))}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) patchStyle({ [key]: v });
                  }}
                />
              </label>
            ))}

            <p className="text-[10px] leading-snug text-text-secondary/60">
              Position Y sets where the last line sits; extra lines stack upward. Scale, rotation,
              crop, opacity and fades don’t apply to a caption — its look is entirely this style.
            </p>

            {/* D-243 — the ANIMATION half of the style.
                Every knob a preset sets is editable here, deliberately: a
                preset is data applied through this same style, not a baked-in
                look (owner, 2026-09-08: "keep the style configurable as much
                as possible"). The rows below are gated on the animation kind
                only where a field genuinely does nothing — the same rule the
                background rows above already follow. */}
            <div className="mt-1 border-t border-border-color pt-2" data-testid="caption-animation">
              <div className={row}>
                <span className="text-text-secondary">Animation</span>
                <Select
                  value={anim.kind}
                  disabled={trackLocked}
                  onValueChange={(v: string | null) => {
                    if (!v) return;
                    if (ANIM_KINDS.some((k) => k.value === v)) {
                      patchAnim({ kind: v as CaptionAnimKind });
                    }
                  }}
                >
                  <SelectTrigger className="h-7 w-32" data-testid="caption-anim-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ANIM_KINDS.map((k) => (
                      <SelectItem key={k.value} value={k.value}>
                        {k.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {isPerWordAnim(anim.kind) && (
                <div className="mt-2 flex flex-col gap-2">
                  {/* Per-word colours. `null` means "use the caption colour",
                      which is why each is a nullable swatch with a clear
                      button rather than a plain colour input. */}
                  {(
                    [
                      ['active_color', 'Active word'],
                      ['spoken_color', 'Spoken'],
                      ['upcoming_color', 'Upcoming'],
                    ] as const
                  ).map(([key, label]) => (
                    <label className={row} key={key}>
                      <span className="text-text-secondary">{label}</span>
                      <span className="flex items-center gap-1.5">
                        <Input
                          disabled={trackLocked}
                          placeholder="default"
                          className="h-7 w-20 text-right font-mono"
                          value={anim[key] ?? ''}
                          onChange={(e) => {
                            const v = e.target.value.trim();
                            patchAnim({ [key]: v === '' ? null : v });
                          }}
                        />
                        <input
                          type="color"
                          disabled={trackLocked}
                          aria-label={`${label} colour`}
                          className="h-7 w-7 shrink-0 cursor-pointer rounded border border-border-color bg-transparent p-0.5"
                          value={
                            /^#[0-9a-fA-F]{6}$/.test(anim[key] ?? '')
                              ? (anim[key] as string)
                              : style.color
                          }
                          onChange={(e) => patchAnim({ [key]: e.target.value })}
                        />
                      </span>
                    </label>
                  ))}

                  <label className={row}>
                    <span className="text-text-secondary">Highlight box</span>
                    <Switch
                      checked={anim.active_box_color !== null}
                      disabled={trackLocked}
                      onCheckedChange={(on: boolean) =>
                        // Turning it on picks a visible default rather than an
                        // empty string, so the switch always produces a box a
                        // user can actually see and then recolour.
                        patchAnim({ active_box_color: on ? DEFAULT_HIGHLIGHT_BOX : null })
                      }
                    />
                  </label>

                  {anim.active_box_color !== null && (
                    <>
                      <label className={row}>
                        <span className="text-text-secondary pl-2">Colour</span>
                        <span className="flex items-center gap-1.5">
                          <Input
                            disabled={trackLocked}
                            className="h-7 w-20 text-right font-mono"
                            value={anim.active_box_color}
                            onChange={(e) => patchAnim({ active_box_color: e.target.value })}
                          />
                          <input
                            type="color"
                            disabled={trackLocked}
                            aria-label="Highlight box colour"
                            className="h-7 w-7 shrink-0 cursor-pointer rounded border border-border-color bg-transparent p-0.5"
                            value={
                              /^#[0-9a-fA-F]{6}$/.test(anim.active_box_color)
                                ? anim.active_box_color
                                : DEFAULT_HIGHLIGHT_BOX
                            }
                            onChange={(e) => patchAnim({ active_box_color: e.target.value })}
                          />
                        </span>
                      </label>
                      <label className={row}>
                        <span className="text-text-secondary pl-2">Opacity</span>
                        <span className="flex items-center gap-1">
                          <Input
                            type="number"
                            step={1}
                            min={0}
                            max={100}
                            disabled={trackLocked}
                            className={numInput}
                            value={Math.round(anim.active_box_opacity * PERCENT)}
                            onChange={(e) => {
                              const pct = Number(e.target.value);
                              if (!Number.isFinite(pct)) return;
                              patchAnim({
                                active_box_opacity: Math.min(1, Math.max(0, pct / PERCENT)),
                              });
                            }}
                          />
                          <span className="text-text-secondary/60">%</span>
                        </span>
                      </label>
                      {(
                        [
                          ['active_box_pad_x', 'Pad X'],
                          ['active_box_pad_y', 'Pad Y'],
                        ] as const
                      ).map(([key, label]) => (
                        <label className={row} key={key}>
                          <span className="text-text-secondary pl-2">{label}</span>
                          <Input
                            type="number"
                            step={0.01}
                            min={0}
                            max={2}
                            disabled={trackLocked}
                            className={numInput}
                            value={Number(anim[key].toFixed(3))}
                            onChange={(e) => {
                              const v = Number(e.target.value);
                              if (Number.isFinite(v) && v >= 0) patchAnim({ [key]: v });
                            }}
                          />
                        </label>
                      ))}
                    </>
                  )}

                  <label className={row}>
                    <span className="text-text-secondary">Animate in</span>
                    <span className="flex items-center gap-1">
                      <Input
                        type="number"
                        step={0.01}
                        min={0}
                        max={5}
                        disabled={trackLocked}
                        className={numInput}
                        value={Number(anim.enter_secs.toFixed(3))}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v) && v >= 0) patchAnim({ enter_secs: v });
                        }}
                      />
                      <span className="text-text-secondary/60">s</span>
                    </span>
                  </label>

                  {/* `Rise` only moves anything for the kinds whose words
                      actually travel vertically; `slam` moves horizontally and
                      the line-held kinds do not move at all. */}
                  {anim.kind === 'build' && (
                    <label className={row}>
                      <span className="text-text-secondary">Rise</span>
                      <Input
                        type="number"
                        step={0.01}
                        min={0}
                        max={2}
                        disabled={trackLocked}
                        className={numInput}
                        value={Number(anim.enter_rise.toFixed(3))}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v) && v >= 0) patchAnim({ enter_rise: v });
                        }}
                      />
                    </label>
                  )}

                  {/* The word gap is what stands in for a space, so it only
                      exists for the kinds that lay out a whole line. */}
                  {!isSingleWordAnim(anim.kind) && (
                    <label className={row}>
                      <span className="text-text-secondary">Word gap</span>
                      <Input
                        type="number"
                        step={0.01}
                        min={0}
                        max={2}
                        disabled={trackLocked}
                        className={numInput}
                        value={Number(anim.word_gap.toFixed(3))}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v) && v >= 0) patchAnim({ word_gap: v });
                        }}
                      />
                    </label>
                  )}

                  <p className="text-[10px] leading-snug text-text-secondary/60">
                    Word timings are derived from each word’s length across the cue. The highlight
                    box is square and switches on and off per word — ffmpeg can’t round or fade one,
                    so a preview that did wouldn’t export (D-243).
                  </p>
                </div>
              )}
            </div>
          </div>
        </InspectorSection>
      </div>

      {cues.length > 1 && (
        <div className="mt-3">
          <InspectorSection label={`Captions (${cues.length})`}>
            {/* Height-capped and scrolled rather than unbounded: an imported
                `.srt` is routinely hundreds of cues, and rendering all of them
                into the Inspector's own flow would push every section below it
                off the panel. */}
            <ScrollArea className="max-h-48">
              <ul className="flex flex-col text-[11px]">
                {cues.map(({ c, index }, ordinal) => {
                  const secs = (endFrame(c, fps) - c.start_frame) / fps;
                  const rowCps = captionCps(c.caption?.text ?? '', secs);
                  const isCurrent = index === clipIndex;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => setSelection([{ track: primary.track, id: c.id }])}
                        className={`flex w-full items-start gap-2 rounded px-1.5 py-1 text-left hover:bg-surface-hover ${
                          isCurrent ? 'bg-surface-selected' : ''
                        }`}
                      >
                        <span className="w-5 shrink-0 tabular-nums text-text-secondary/60">
                          {ordinal + 1}
                        </span>
                        <span className="w-24 shrink-0 font-mono text-[10px] text-text-secondary">
                          {timecode(c.start_frame, fps)}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          {captionLines(c.caption?.text ?? '').join(' ') || '—'}
                        </span>
                        {/* CPS is the reference's own readability metric.
                            Flagged past 20 — the widely-used subtitle
                            readability ceiling — so an imported file's
                            unreadably fast cues are visible at a glance
                            rather than only on playback. */}
                        <span
                          className={`w-7 shrink-0 text-right tabular-nums ${
                            rowCps !== null && rowCps > 20
                              ? 'text-red-400'
                              : 'text-text-secondary/60'
                          }`}
                        >
                          {rowCps === null ? '—' : rowCps.toFixed(0)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </ScrollArea>
          </InspectorSection>
        </div>
      )}
    </div>
  );
}

# UI redesign: an FCP-style Edit tab (research + spec)

**Status: accepted (D-432). P1 (tokens and type) and P2 (clip block, handles, edit-tool feedback, playhead, layer scale) done 2026-10-31; P3 (track headers, per-track height, ruler, markers, snapping / skimming, two-up viewer), P5 (chrome and layout) and P4 (Inspector) done 2026-11-01; the v0.3.0 gap closure against the approved mockup (B-359, B-354: §6e) done 2026-11-03.**
This note is the research trail, the design system, the per-component spec, the list of
concrete CSS defects in today's components, and the phased plan. The look is shown in
the static mockup `scratch/ui-redesign-mockup.html` (not app code; `scratch/` is
gitignored, so the mockup and the reference images live only in the main checkout).

**Why.** The owner, 2026-10-31: "I don't like the UI at all. The design is not pretty …
the drag handles, the clip names, etc." He named Final Cut Pro as the direction (clean,
Mac-native, calm, still pro). His specific complaints: overall look, the timeline feel,
the Inspector and side panels, a selected clip drawn as "a thick white, heavily rounded
border with a floating keyframe glyph in the corner. No timeline has this", a marker flag
with no editor on click, and clip names that "do not look professional but vibe-coded
slop" next to a real FCP timeline. He also called drag "very slow, buggy, not intuitive".
Speed and bugs belong to the separate harness task. This spec only makes sure the design
can be fast: each component below has a perf note, and each phase has numbers for the
harness to measure.

Reference material, all saved to `scratch/ui-redesign-reference/` (main checkout):

| Path | What | Source (fetched 2026-10-31) |
|---|---|---|
| `../bug-refs/2026-10-31-fcp-clip-reference.png` | **Primary target for clip anatomy** (owner-supplied FCP timeline) | owner |
| `../bug-refs/2026-10-31-clip-selection-style.png` | Today's selected audio clip (the defect) | owner |
| `../bug-refs/2026-10-31-marker-no-popover.png` | Today's marker flag (no editor) | owner |
| `fcp/interface-intro-1.png` | FCP full window: browser / viewer / full-width timeline | https://support.apple.com/guide/final-cut-pro/ver92bd100/mac |
| `fcp/magnetic-timeline-1..6.png` | FCP clips, connected clips, yellow selection, lanes | https://support.apple.com/guide/final-cut-pro/verb8fcfc133/mac |
| `fcp/clip-appearance-*.png` | FCP Clip Appearance popover (waveform/filmstrip ratio, clip height) | https://support.apple.com/guide/final-cut-pro/verb8e5d346/mac |
| `fcp/SOURCES.txt` | Image URL ↔ file map | |
| `../other-nle-reference/fcp-1.png` | FCP clip with inline keyframe lane, selected (yellow outline) | earlier scrape, 2026-09-08 |
| `../resolve-reference/markers.jpg`, `timeline.jpg`, `trim.jpg` | Resolve Edit page: track headers, clip name bar, marker shields + Markers dialog, trim modes | https://www.blackmagicdesign.com/products/davinciresolve/edit (scraped 2026-09-08) |
| `palmier-pro-ui-readme.png`, `palmier-pro-editor-tosea.png` | Palmier Pro full window | https://github.com/palmier-io/palmier-pro (README), https://tosea.ai/blog/palmier-pro-ai-video-editor-mac-guide |
| `palmier-src/*.swift` | Palmier Pro's real theme and timeline constants, read from its GPL-3.0 branch `last-gpl-source`; numbers only, no code copied | https://github.com/palmier-io/palmier-pro/tree/last-gpl-source |
| `cardboard/hero.png`, `cardboard/first-image-*.png`, `cardboard/timeline.md` | Cardboard editor shots and its timeline docs | https://learn.usecardboard.com/editing/timeline.md, https://learn.usecardboard.com/first.md |

---

## 1. What each reference does

### 1.1 Final Cut Pro (the direction)

Read from Apple's own guide pages and the owner's screenshot.

- **Window layout** (`fcp/interface-intro-1.png`). The browser sits top-left and the viewer top-right. The Inspector, when open, takes the top-right column next to the viewer. **The timeline spans the full window width underneath.** Panels have no cards, gaps or shadows; they are flat surfaces split by 1 px dark dividers. The palette is near-black neutral greys, with no tinted chrome.
- **Clip anatomy** (owner reference, sampled with PIL; `magnetic-timeline-4.png`):
  - A **thin name strip across the top**: about 14–16 px at standard height, filled with a darker shade of the clip colour (sampled `#2D3F61` on a blue video clip). The label is small, light and semibold, left-aligned, and truncates with an ellipsis.
  - Below it, a **continuous filmstrip**. Tiles are cut at the source aspect, run edge to edge, and start at the clip start.
  - Below that, the clip's **own audio as a waveform band inside the same block**, blue-grey (`#677B9D`) with a lighter rectified waveform.
  - Proportions at the reference height: strip ~18 %, filmstrip ~60 %, audio band ~22 %.
  - Corners have a small radius (~2–3 px). Clips have no thick borders and nothing floats over the picture.
  - Neighbouring clips are split by a **hairline**. A through edit (two clips cut from the same source) shows a **dashed** hairline.
- **Colours by kind.**
  - Video+audio: blue.
  - Connected audio (dialogue/effects): teal-blue.
  - Music: green (sampled body `#29532E`, waveform `#6B9C76`, name text light green).
  - Titles: purple.
  - Adjustment clip: magenta.
  - Gap clip: neutral grey (`#404040`).
  - Lanes are subtle bands on a `#1F1F1F` background.
- **Audio clip** (owner reference, "Module 1 Music track"):
  - A small kind icon and the name sit top-left.
  - The waveform runs along the bottom.
  - A **volume line with keyframe dots** is drawn across the clip, and the end of the line shows the fade shape.
- **Selection.** A **thin yellow outline** (~2 px) follows the clip's own small radius (`magnetic-timeline-4.png`, `fcp-1.png`). There is no glow, no fill change and no ring outside the clip.
- **Playhead.** A thin yellow/amber vertical line, 1 px. The skimmer is a separate pinkish-red line.
- **Clip Appearance popover** (`clip-appearance-2.png`): a zoom slider; six buttons that set the waveform/filmstrip ratio (from waveform-only through labels-only); a clip-height slider; show-names, angles and roles checkboxes. Clip height and the band ratio are **view settings**, not per-clip data.
- **Toolbar.** Tool and edit buttons sit left. The centre shows the project name and the timecode, with the current time in yellow. Toggles sit right: snapping, skimming, audio skimming, solo, Clip Appearance. Active toggles use the system accent.
- **No track headers.** The magnetic timeline has none; audio lanes show their role name faintly in the lane itself. Apelles is track-based (D-080), so track headers come from Resolve and Palmier below. They are kept as calm and narrow as FCP's lane labels.
- **Inspector.** A clip-name header. A row of icon tabs (Video, Audio, Info, …). Collapsible sections (Compositing, Transform, Crop, …), each with an enable checkbox; Show/Hide and reset appear on hover. Label/value rows are dense, ~11–12 px; the keyframe diamond and reset sit at the row's right end.

### 1.2 DaVinci Resolve (track headers, markers, trim)

From `resolve-reference/markers.jpg`, `timeline.jpg` and `trim.jpg`.

- **Track header.**
  - A short ID badge (`V2`, `A1`), then the track name.
  - Under them, lock / auto-select / disable icons, then a clip count ("7 Clips").
  - Audio tracks add S / M (solo / mute) and the channel format ("2.0").
  - A coloured strip runs down the far left: blue for video, green for audio.
- **Clips.** Filmstrip with a **name bar along the bottom** (FCP puts it at the top). Audio clips are green with a white waveform and a volume line with keyframe dots. Corners are small.
- **Markers.**
  - Small **shield/pentagon flags** in 16 colours, on a strip just under the ruler. Clip markers sit on the clip itself.
  - A duration marker is the flag plus a bar.
  - The **Markers dialog** has Time, Duration, Name, Notes, Keyword, a Colour swatch row, and **Remove Marker / Done** buttons.
- **Trim.** The smart trim tool picks ripple, roll, slip or slide from the pointer position, with no mode switch (`trim.jpg` shows the four bracket glyphs). Resolve's manual calls the selected clip "outlined in orange". Red marks a roll edit with no handle media left (KDE T6868, which cites both FCP and Resolve).
- **Playhead.** Red, with a red head in the ruler.

### 1.3 Palmier Pro (the AI-native Mac editor Apelles started from)

From the README screenshot and the GPL-3.0 source branch (`palmier-src/`). Numbers come straight from `AppTheme.swift`, `Constants.swift`, `TimelineClipColors.swift` and `ClipRenderer.swift`.

- **Layout.** Floating rounded panels on a black window, with a 5 px gap (`Layout.panelGap = 5`). Left: the agent chat. Then the media browser and the viewer. Inspector on the right. The timeline runs full width at the bottom, with a toolbar holding undo/redo, select/blade, split, `[` `]` and a text tool, plus a zoom slider on the right.
- **Surfaces** (dark): base `#18191C`, surface `#1E1F23`, raised `#26272C`, prominent `#303137`. Borders are white at 10 % (primary) and 7 % (subtle). Text is white at 98 / 84 / 68 / 46 %.
- **Accent.** The timecode is orange (`#F2994D`) and the playhead red (`#FF524D`).
- **Clip colours.** Video `#1D5878`, audio `#2E7765`, text/image `#715486`, animation `#A07822`. The user can change each one in Settings → Timeline Colors.
- **Clip anatomy.**
  - A **16 px label bar** on top (`labelBarHeight = 16`) with a 10 pt medium label.
  - Clip corner radius **4 px** (`Trim.clipCornerRadius = Radius.xsSm`).
  - A **1 px black border** on every clip; selection is a **1.5 px white** stroke (`BorderWidth.medium`).
  - The label shows only above 56 px of width, detail chrome above 32 px, the border above 8 px.
  - Trim handle width 4 px. Volume keyframes 7 px, hit area 14 px.
- **Tracks.** Default height 44 px, min 32, max 200. Each track resizes from a 6 px zone. Track headers default to 160 px (min 112, max 320), with a 3 px colour strip, an 8 px resize hit and short IDs `V1` / `A1`.
- **Snapping.** Threshold 8 px, sticky ×1.5, drag threshold 3 px.
- **Inspector** (`EditorPanel`). Default width 340, min 300, a **label column of 88 px**, rows at least 22 px high, group headers 28 px, numeric fields 56 px wide. The screenshot shows small uppercase group labels (LEVELS, PLAYBACK) and right-aligned values.

### 1.4 Cardboard (the browser-based AI editor)

From `cardboard/hero.png`, `first-image-*.png` and its docs. Cardboard runs in the browser (WebGPU/WebCodecs per reviewers) and has four panels: Media Library, Canvas, Timeline and AI Chat (`learn.usecardboard.com`).

- **Look.** Near-black, with large-radius cards and an icon rail on the left (captions, brush, text, transitions, palette, crop, settings). Gradient transition tiles. Caption clips are saturated purple pills with white text. The playhead is white with a triangular head.
- **Interaction** (docs): drag a clip to reorder; the others shift ("no gaps, no mess"). The cursor becomes a resize arrow on an edge. Ripple Edit is a toggle top-right of the timeline. Blade tool top-left.
- **Export dialog** (`first-image-4.png`): one bold title, segmented format choices, cards for resolution, one white primary button.

## 2. What Apelles takes, and why

| Take | From | Why |
|---|---|---|
| Thin top name strip, continuous filmstrip, attached-audio waveform band in one block; small radius; hairline separators | FCP (owner's primary target) | The owner named it. It also reads fastest: the name is never over picture, so it never needs a scrim. |
| Clip height and band split as a *view* setting (Clip Appearance popover) | FCP | One control gives a dense or detailed timeline without per-track fiddling. |
| Thin yellow selection outline; trim affordance on the hovered edge only | FCP + Resolve | Fixes the owner's "thick white rounded border". Yellow is free in Apelles's palette, where white is not (white is text). |
| Amber 1 px playhead, amber current-time timecode | FCP (amber), Palmier (orange timecode) | Calm, and distinct from every clip colour and from the accent. |
| Full-width timeline, Inspector top-right beside the viewer | FCP | The timeline is the main surface of an editor; today it is squeezed between two full-height side panels. |
| Track header: colour strip + short ID badge + name + quiet toggles, resizable | Resolve, Palmier | Apelles is track-based (D-080). Keep it narrow and quiet. |
| Shield marker flags, a popover editor with Name / Colour / Note / Duration | Resolve | Same fields Apelles already stores (D-222, D-328). Only how they are shown and reached changes. |
| Per-track height 32–200 from a 6 px bottom-edge zone; 8 px snap threshold with stickiness; 3 px drag threshold | Palmier (real constants) | Proven numbers from a native Mac editor of the same kind. |
| Inspector: fixed label column, right-hand value fields, 26 px rows | FCP + Palmier | Dense and aligned. Today each row carries ad-hoc widths. |
| Flat panels, 1 px dividers, no floating cards | FCP (not Palmier/Cardboard) | The owner chose "calm, Mac-native". Floating cards and gaps cost space and read as web-app. |
| One primary white-on-accent button per dialog, segmented choices | Cardboard export dialog | Clean dialog pattern. The dialog layer barely changes. |
| **Not taken:** Cardboard's large radii and gradient tiles; Palmier's floating panels; Resolve's dense always-visible header icons | | Too loud, or too busy, for "calm". |

---

## 3. The Apelles design system

### 3.1 One token source

The redesign **changes values** in the existing token set and adds a few names. It never
starts a parallel theme.

- Today the values live in `app/src/utils/themes.ts` (`THEMES[].cssVariables`, the `--app-*` vars). `app/src/styles.css` `@theme` aliases them as `--color-*`, and `packages/ui/src/styles.css` maps the shadcn names onto those aliases. That chain stays.
- Phase 1 moves the **values** into `@apelles/tokens` (today a stub that, per its own README, is meant to hold exactly this). `themes.ts` then imports them. One definition, the D-039 intent.
- Every new name below gets an `--app-*` value per theme, a `--color-*` alias in `@theme`, and nothing else.

### 3.2 Palette, dark theme (designed first)

Existing names, new values:

| Token (`--app-*` → `--color-*`) | Today | **Proposed** | Role |
|---|---|---|---|
| `bg-primary` | `rgb(24,24,24)` | `#1E1E20` | window background, behind panels |
| `surface` | `rgb(28,28,28)` | `#262629` | panels: browser, inspector, toolbars, ruler, track headers |
| `bg-secondary` | `rgb(35,35,35)` | `#2E2E32` | fields, segmented tracks, hovered rows |
| `card-active` | `rgb(43,43,43)` | `#3A3A3F` | pressed/selected rows, active segment |
| `border-color` | `rgb(45,45,45)` | `#333338` | hairlines inside a panel |
| `text-primary` | `rgb(232,234,237)` | `#EBEBF0` | primary text |
| `text-secondary` | `rgb(158,158,158)` | `#9A9AA3` | labels, secondary text (5.9:1 on `surface`) |
| `accent` | `rgb(255,255,255)` (white) | `#0A84FF` (macOS dark system blue) | active toggles, focus ring, primary button, links |
| `button-text` | `rgb(0,0,0)` | `#FFFFFF` | text on `accent` |
| `hover-color` | `rgb(255,255,255)` | `#EBEBF0` | (kept for the fork's existing uses) |

**Why the accent changes from white.** In the dark theme the accent *is* white. So a selected clip ring, an active tool, a focus ring and body text are all the same colour, which is why the owner's selected clip reads as "a thick white border". FCP uses the system accent for active controls and yellow for selection. Apelles follows that: blue for *controls*, amber for *timeline selection*.

New names (each also gets a light and grey value, §3.3):

| New token | Dark value | Role |
|---|---|---|
| `text-tertiary` | `#6B6B74` | placeholders, units, disabled labels |
| `divider` | `#111113` | 1 px splits *between* panels (FCP's black dividers) |
| `surface-raised` | `#2C2C30` | popovers, menus, tooltips |
| `destructive` | `#FF453A` | moves the value of `ui/styles.css`'s pinned `--color-destructive` literal into the theme |
| `timeline-bg` | `#1A1A1C` | the lane area behind clips |
| `lane-alt` | `#1F1F22` | every other lane (subtle bands) |
| `selection` | `#F5C542` | selected-clip outline, hovered trim bracket, snap guide |
| `playhead` | `#F5C542` | playhead line and head, current-time timecode |
| `skimmer` | `#FF5A5F` | only if skimming ships (open question) |
| `clip-label` | `#E8ECF4` | clip-name text on any name strip |
| `clip-video` / `-strip` / `-wave` / `-wave-ink` | `#3D5A8A` / `#2D3F61` / `#677B9D` / `#B7C4DD` | video body (seen at the clip edges), name strip, attached-audio band, waveform ink (body, strip and band sampled from the owner's FCP reference) |
| `clip-audio` / `-strip` / `-wave-ink` | `#2A5530` / `#214427` / `#7FB38A` | audio clip (FCP music green, sampled) |
| `clip-text` / `-strip` | `#5B4A9E` / `#44397A` | title clips (FCP purple) |
| `clip-caption` / `-strip` | `#7A6838` / `#5C4E2A` | caption clips (muted sand, distinct from amber selection) |
| `clip-adjustment` / `-strip` | `#8A3F7E` / `#6A2F61` | adjustment clips (FCP magenta) |
| `clip-motion` / `-strip` | `#2C7A78` / `#1F5B59` | Motion-scene clips (teal) |
| `clip-gap` | `#3A3A3E` | gap placeholder |

All clip colours are **opaque** and the same in every theme. FCP keeps them constant across appearances; it is a media colour, not chrome. Today's 55 %-alpha literals over a grey backing are what make the colours muddy (§6).

Marker colours stay document data (`Marker.color`, D-222). The default swatch row becomes eight: blue `#3D8BFF`, cyan `#2EC4D6`, green `#3FBF5F`, yellow `#F5C542`, orange `#FF9F40`, red `#FF5A5F`, purple `#A77BF3`, pink `#F26CB5`.

### 3.3 Light and grey themes

They get values for every new name in phase 1 (for example light: `timeline-bg #E6E6E9`, `lane-alt #DEDEE2`, `selection #D9A400`, `playhead #D9A400`, `divider #C9C9CE`, `surface-raised #FFFFFF`, `text-tertiary #8E8E96`). They are **not redesigned in this pass**. The mockup shows dark only, so it has no theme toggle.

### 3.4 Typography

The face is SF Pro through the system stack. **Today's default is Poppins** (`app/src/hooks/useAppInitialization.ts:314`), the single largest "not Mac-native" signal. Phase 1 makes `system` the default (`-apple-system, BlinkMacSystemFont, system-ui, sans-serif`), and Poppins stays a setting. Timecode uses `ui-monospace, "SF Mono", Menlo` with `tabular-nums`.

The scale is set as Tailwind v4 theme variables in `@theme`, which is the canonical v4 way. It replaces the ~30 different `text-[10px]`/`text-[11px]` literals in the editor:

| Token | Size / line | Weight | Use |
|---|---|---|---|
| `--text-2xs` (new) | 10 / 12 | 500–600 | ruler labels, clip names at S/M height, badges, ID pills |
| `--text-xs` | **11** / 14 (was 12) | 400–500 | inspector labels, track names, tooltips |
| `--text-sm` | **12** / 16 (was 14) | 400 | inspector values, menus, fields, body |
| `--text-base` | **13** / 18 (was 16) | 500–600 | panel titles, inspector clip name, buttons |
| `--text-lg` | 15 / 20 | 600 | dialog titles |

Changing `xs`/`sm`/`base` also touches `app/` screens. That is intended (one scale), and the phase-1 screenshot pass covers it. Section headers drop the 10 px uppercase tracked style (`InspectorSection.tsx:13`) for 12 px semibold in title case, as FCP does.

### 3.5 Spacing, radii, elevation

- **Spacing.** A 4 px grid, with a 2 px half step allowed inside dense controls. Tailwind's default `--spacing: 4px` already gives this; the rule is "no arbitrary `px-[7px]`".
- **Radii:**

  | Token | Value | Use |
  |---|---|---|
  | `--radius-xs` (new) | 2 px | clips, marker bars, playhead head |
  | `--radius-sm` (new) | 4 px | fields, buttons, tiles, chips |
  | `--radius-md` | 6 px (was 8) | menus, popovers |
  | `--radius-lg` | 10 px (was 15) | dialogs |

- **Elevation.** Panels are flat: no shadow, split by `divider`. Popovers and menus get `surface-raised`, a 1 px `rgba(255,255,255,.08)` border and `--shadow-popover: 0 8px 24px rgba(0,0,0,.45)`. Dialogs get `--shadow-dialog: 0 20px 60px rgba(0,0,0,.55)`. **Nothing inside the timeline has a shadow, blur or glow.** The existing `--shadow-shiny` is unused by the editor and stays out of it.

### 3.6 Icons

Phosphor only, `@phosphor-icons/react`, regular weight at 14–16 px in chrome, fill weight for status glyphs. The marker flag and the playhead head become Phosphor glyphs (`BookmarkSimple` fill, `CaretDown` fill); today they are CSS `clip-path` shapes (`TimelineMarkers.tsx:88`). A blade cursor needs a static file, so it is exported from the installed package by a reproducible build step (CLAUDE.md icon rule). Until then the blade tool uses CSS `crosshair`.

---

## 4. Component specs

Dimensions are CSS px at 1× and assume a 1440×900 window.

### 4.1 Edit tab layout (FCP arrangement)

```
┌ window chrome 38 ─ traffic lights · ‹ Projects / name ·· [Edit|Motion|Colorist] ·· Export ┐
├──────────────┬───────────────────────────────────┬─────────────────────┤
│ Browser 280  │ Viewer header 28                  │ Inspector 300       │
│ (220–480)    │ picture (black, letterboxed)      │ (260–440)           │
│              │ Transport 40                      │                     │
├──────────────┴───────────────────────────────────┴─────────────────────┤  ← resizable (upper min 260)
│ Timeline toolbar 36 (full width)                                       │
│ Track headers 136 │ Ruler 24 + marker strip 14                         │
│ (100–280)         │ lanes …                                            │  timeline default 42 % (min 180)
└────────────────────────────────────────────────────────────────────────┘
```

- The **timeline spans the full width**; today it sits under the viewer only (`EditorTab.tsx:152–278`). Browser, viewer and Inspector share the upper band. Every split is a `@apelles/ui` `ResizablePanel` (standing rule), and sizes persist per user.
- The **left icon rail is removed**. Its four destinations (Media, Text, Effects/Adjust, Captions) become a segmented header inside the browser, as FCP's browser tabs do. That returns 48 px of width.
- Panels are flat `surface` with `divider` 1 px splits. No gutters, no rounded panels.
- The Inspector can collapse (Cmd+4 as in FCP, plus the existing toggle). When collapsed, the viewer takes its width.

### 4.2 Window chrome (38 px)

- Traffic lights, then `‹ Projects` and the project name: `text-sm`, secondary, then primary.
- **Centred segmented control** for Edit / Motion / Colorist. 24 px high, track `bg-secondary`, active segment `card-active` with primary text, inactive secondary.
- Right: **Export** as a secondary button (`bg-secondary`, `DownloadSimple` icon, `text-sm` 500) and the shortcuts button (`Keyboard`).
- Today's "APELLES" wordmark is dropped (already owner-flagged in `titlebar-redundant-apelles-label.png`).

### 4.3 Clip block (the owner's primary complaint)

**Geometry.**
- Radius `--radius-xs` (2 px). The clip is opaque (`--color-clip-<kind>`).
- No border at rest. Adjacent clips are split by a **1 px `rgba(0,0,0,.55)` hairline**, drawn as the clip's own inset left edge, so a cut reads as a line and not as a gap of lane colour.
- A **through edit** (same `source_path`, contiguous source range, as a split produces) draws that hairline **dashed** (2 on / 2 off), like FCP.
- The 0.5 px vertical inset per lane keeps lanes visually separate.

**Anatomy by track height.** Clip height = track height minus 2 px (1 px top and bottom inset).

| Track height | Name strip | Filmstrip (video) | Waveform band (video's own audio) | Audio clip | Notes |
|---|---|---|---|---|---|
| **S 32** | 14 | 16 | hidden | strip 14 + waveform 16 | waveform for video hidden; label only if width ≥ 28 |
| **M 52** (default, = today's `ROW_HEIGHT`) | 14 | 24 | 12 | strip 14 + waveform 36, volume line | |
| **L 76** | 16 | 40 | 18 | strip 16 + waveform 58 | badges allowed in strip |
| **XL 108** | 16 | 62 | 28 | strip 16 + waveform 90 | |
| **< 26 (custom)** | name overlaid in the body | hidden | hidden | — | "labels only" (FCP mode 6) |

Rule: strip = 14 px below 76, 16 px at 76 and up. The band is `round((H − strip) × 0.3)` from M up, hidden below M. The filmstrip takes the rest. The Clip Appearance popover's ratio buttons change the 0.3 (0 = filmstrip only, 1 = waveform only).

**Name strip.**
- Fill `--color-clip-<kind>-strip`.
- Label `--text-2xs` (10/12) at strip 14, `--text-xs` (11/14) at strip 16. Weight 600, `--color-clip-label`, padding-left 4 px, single line, `text-overflow: ellipsis`.
- The label is **sticky**: when the clip's start is scrolled off the left edge, the label pins to the viewport's left edge while the clip is visible (FCP and Resolve both do this).
- Only audio, text, caption, adjustment and Motion clips get a leading **kind icon**, 10 px Phosphor: `Waveform`, `TextT`, `ClosedCaptioning`, `MagicWand`, `FilmSlate`. Video clips do not; the filmstrip already says what they are.
- Trailing **badges**, as 10 px text pills inside the strip (`rgba(0,0,0,.28)` fill, radius 2): speed `2×`, `fx` (has an effect), `◆` (`DiamondsFour`, has keyframes). Shown only when the clip is at least 120 px wide. **Never floating over the picture.**
- Thresholds (from Palmier's): label at width ≥ 28 px, badges ≥ 120 px, hairline ≥ 8 px. Below 8 px the clip is a bare colour sliver.

**Filmstrip.** Tiles at the source aspect, height = band height, run continuously from the clip start (the first tile is anchored to the in point, as FCP does). The last tile is cut, never squeezed. Only the visible slice is fetched (unchanged from D-128/D-334).

**Waveform.**
- Rectified (bottom-up), as FCP draws it, in `--color-clip-<kind>-wave-ink`.
- On a video clip it sits on a `--color-clip-video-wave` band: the clip's own embedded audio.
- For an A/V-linked pair (D-129) the picture's own stream is muted, so the **band shows the linked audio half's waveform**, and the A-track clip draws its normal audio block.
- Whether to also offer an FCP-style collapsed view, where the linked audio is drawn only inside the video block and the A-lane hides, is open question 3.

**Volume line** (audio clips, and the band from L height up).
- 1 px `rgba(255,255,255,.75)`. 0 dB sits at 25 % from the top of the waveform area, and −∞ at the bottom.
- Keyframe dots: 5 px white with a 1 px `rgba(0,0,0,.5)` ring, 14 px hit area.
- Hovering the line gives an `ns-resize` cursor and a `-3.0 dB` pill; drag to set the level.
- Shown on every audio clip, the way FCP and Resolve show it. Today the volume is reachable only from the Inspector.

**States.**

| State | Treatment |
|---|---|
| Rest | as above |
| Hover | a `::after` overlay `rgba(255,255,255,.05)`, so no colour recompute. Fade handles show (§4.5). |
| **Selected** | **2 px inset outline `--color-selection`** (`outline: 2px solid; outline-offset: -2px`), following the 2 px radius. Nothing else changes: no fill swap, no glow, no ring outside the box. |
| Selected, multi | the same outline on each clip |
| A/V-linked partner of the selection | 1 px inset outline `--color-selection` at 55 % (solid, not dashed) |
| Sync-locked (would ripple) | 1 px inset outline `rgba(255,255,255,.35)` |
| Disabled (clip off) | 40 % opacity, label struck through |
| Muted (audio off) | waveform at 30 % opacity, `SpeakerSlash` 10 px in the strip |
| Locked track | 6 % diagonal hatch overlay (`repeating-linear-gradient` 45°, 6 px), clips not draggable, no hover |
| Missing media | `--color-destructive` 25 % wash + 1 px inset destructive outline, "Missing" in the strip |
| Generating / rendering (AI) | `rgba(255,255,255,.08)` wash with a 1 px progress bar along the strip's bottom edge |
| Ripple feedback (D-080) | one 160 ms opacity flash on the shifted clips. **No `animate-pulse`.** |

**Selection, corner radius and in-clip glyphs: the rules** (owner: "no timeline has this", `bug-refs/2026-10-31-clip-selection-style.png`).

| | FCP | Resolve | Palmier | Apelles today | **Apelles spec** |
|---|---|---|---|---|---|
| Selected clip | ~2 px yellow outline on the clip's own edge (`magnetic-timeline-4.png`, `fcp-1.png`) | outline in orange/red ("outlined in orange", Resolve manual) | 1.5 px white stroke inside a 1 px black border | 2 px **white box-shadow ring outside** a 4 px rounded body, plus extra rings for related clips | 2 px inset `--color-selection` outline, nothing outside the box |
| Corner radius | ~2–3 px | ~2 px | 4 px | 4 px (`rounded`) + library stretch zones at 4 px | 2 px |
| Trim affordance | yellow bracket on the edge under the pointer / the selected edit point; red at a media limit | bracket edit-point highlight, mode glyph by pointer zone | 4 px handle | permanent translucent triangles from the library | bracket on hover and selection only, red at a limit (§4.4, §5.1) |
| Glyphs on the clip | in the name strip only (multicam, effects); nothing over the picture | in the name bar (fx, speed) | badges in the label bar | a floating curve button over the picture at top-right | strip badges only, width ≥ 120 px |

**What leaves the clip.** The D-233 curve-editor toggle (`BezierCurve`) is today a floating glyph at the clip's top-right. It moves to (a) the `◆` badge in the strip: clicking it opens the curve lane when the clip is selected; (b) the clip context menu; (c) the Inspector keyframe controls. The DotsSix move grip is already gone (whole-body drag, D-098 later work); it must not come back.

**Perf.**
- One DOM node for the body with the strip as a child. Filmstrip and waveform are each **one `<canvas>`**, drawn from cached bitmaps per zoom bucket; no per-tile `<img>`.
- States use `outline`, `opacity` and a pre-laid `::after`, never `box-shadow` (`ring-*` is box-shadow) and never `filter`.
- `contain: layout paint style` on each clip and `contain: strict` on each lane.
- Clips outside the viewport plus one screen of margin are not rendered (horizontal virtualisation, which exists in part via the visible-slice fetch today).

### 4.4 Trim handles

- **Hit area.** `min(8 px, width / 3)` inside each edge. Where two clips abut, the cut gets both clips' zones (8 | 8 = 16 px), and the pointer half decides which side trims. D-235's Alt/Option context modes (ripple, roll, slip, slide) are unchanged.
- **Visual.** Nothing at rest. On edge hover, a **bracket** in `--color-selection`: a 3 px vertical bar the full clip height, with 6 × 2 px serifs at top and bottom pointing into the clip (`[` on the in edge, `]` on the out edge). It is drawn with borders on one absolutely positioned element per clip, moved to the hovered edge, not with an icon.
  - On a selected clip the bracket sits on top of the 2 px outline.
  - With no handle media left beyond the edge, the bracket draws in `--color-destructive` (the FCP/Resolve convention).
- **Cursor.** `col-resize` on the zone. The active tool, or the D-235 Alt mode, shows as a small text pill (Ripple / Roll / Slip / Slide), as Resolve's smart trim does, until real Phosphor-exported cursors exist. §5.1 covers each tool's highlight, live motion and readout.
- **While trimming.** A delta pill (`+00:00:12`, `--text-2xs` mono, `surface-raised`) sits above the edge. The edge snaps (§5). The viewer shows the edge frame (already D-137-era behaviour).
- **Removed.** The library's 10 px stretch zones with their 7 px translucent triangles (`react-timeline-editor.css` `.timeline-editor-action-*-stretch:after`) and our hover rule that brightens them (`timeline-overrides.css:21–33`). This is the "drag handles" the owner dislikes.
- **Perf.** The hover bracket is one element per pane, positioned by `transform`; no per-clip handle DOM. Hit-testing is arithmetic on the hovered clip's rect, not a stacked z-index of invisible divs, which is the B-013 class of bug.

### 4.5 Fade handles

- An FCP-style **tab** at each top corner, just under the name strip, inset 2 px from the edge, as a 6 × 8 px pill. At rest it is `rgba(255,255,255,.85)` with a 1 px `rgba(0,0,0,.4)` ring; set fades are drawn in `--color-selection`. Hit area 14 × 14 px. Shown on clip hover or selection, and always shown when a fade is set.
- Dragging the tab inward draws the ramp: a `rgba(0,0,0,.35)` shaded triangle over the body, a 1 px `rgba(255,255,255,.7)` curve line, and a duration pill while dragging. The curve shape comes from the existing `FADE_PRESETS`, selectable from the tab's context menu.
- Replaces today's white-ringed dots (`ClipFadeOverlay.tsx:357`) and their `bg-bg-primary` badge (`:369`).

### 4.6 Playhead, ruler, skimmer

- **Playhead.** A 1 px line in `--color-playhead`, positioned with `transform: translate3d(x,0,0)` and `x` rounded to the device pixel. No `scaleX(.5)`; the library's half-scaled 2-border line is blurry and blue (`#5297FF`). The head is Phosphor `CaretDown` fill, 12 px, in the ruler. A 9 px invisible grab zone (`ew-resize`).
- **Ruler.** 24 px, `surface`, with a 1 px `border-color` bottom.
  - Major tick 8 px, minor 4 px, `rgba(255,255,255,.18)`.
  - Labels `--text-2xs` tabular, `text-secondary`, 3 px right of the major tick.
  - **Adaptive format**: `0:05`, `1:30`, `1:02:10` (h:mm:ss), and frames appear only at frame-level zoom (`1:30:12`). Today it prints `00:00:00` style at every zoom.
  - The tick target stays `TICK_TARGET_PX` (~70 px between labels).
- **In/out range.** An `accent` band at 18 % across the ruler and lanes, with 2 px solid ends.
- **Skimmer** (only if adopted, open question 5). A 1 px `--color-skimmer` line that follows the hovered x. The preview shows that frame while hovering; the playhead stays put.

### 4.7 Markers

- **Strip.** 14 px under the ruler (today `MARKER_STRIP_HEIGHT = 16`), `timeline-bg`.
- **Flag.** Phosphor `BookmarkSimple` fill, 11 px, in the marker colour, centred on the frame. A 1 px `rgba(0,0,0,.4)` ring keeps light colours visible. Hit area 14 × 14 px.
- **Duration marker.** The flag plus a 4 px bar in the marker colour at 55 %, with a 2 px solid end, radius 2.
- **Hover.** After 400 ms, a tooltip with the name, timecode and duration.
- **Click.** Selects the marker (flag gets a 1 px white ring) and moves the playhead to it, as today.
- **Click on an already selected marker, double-click, or Enter.** Opens the editor.
- **Adding a marker** (the toolbar `BookmarkSimple` button, the M key, or `editor_add_marker` when the GUI is focused) **creates it and opens the editor immediately** with Name focused. This is FCP's M-M and Resolve's "M then edit". It fixes the owner's "no popover": today the popover opens only on double-click or context menu (`TimelineMarkers.tsx:244–255`), and adding a marker never opens it.
- **Marker editor popover.**
  - 280 px wide, `surface-raised`, `--radius-md`, `--shadow-popover`, anchored under the flag with an arrow.
  - Rows use a 64 px left label column, `text-xs` secondary:
    1. **Name**: text field, autofocus, placeholder "Marker".
    2. **Time** and **Duration** side by side: timecode fields (mono, number-scrubber behaviour, §4.10). Duration 0 means a point marker.
    3. **Colour**: eight 14 px swatches (§3.2) in a row. The selected swatch gets a 2 px ring in `text-primary`.
    4. **Note**: a 3-line textarea, which grows to 6.
  - Footer: **Delete** (ghost, destructive text, `Trash` icon) on the left, **Done** (accent) on the right. Enter on Name commits, Esc closes.
  - Same fields as Resolve's dialog minus Keyword. They map 1:1 onto `editor_set_marker`.
- **Perf.** Flags render in one absolutely positioned layer, translated with scroll (one `transform` on the layer, not per-flag `left` updates on every scroll frame).

### 4.8 Track headers

- **Column.** 136 px default (`HEADER_WIDTH` 156 today); resizable 100–280 from a 6 px right-edge zone (`col-resize`).
- **Row.** Height = track height. One horizontal line of content, vertically centred, at every height:
  - A **3 px colour strip** at the far left, in the track-kind colour (video `clip-video`, audio `clip-audio`, captions `clip-caption`).
  - An **ID pill**: `V1`, `A1`, `C1`, `--text-2xs` 600 mono, 20 × 16, `bg-secondary`, radius 2. The pill turns `accent` when the track is the target for edits/paste.
  - The **name**: `--text-xs` primary, ellipsis, renamed on double-click.
  - **Toggles**, 20 × 20 icon buttons (14 px icons), shown on row hover: lock (`LockSimple` / `LockSimpleOpen`), visibility (`Eye`) or mute (`SpeakerSimpleHigh`), sync lock (`LinkSimpleHorizontal`). **A toggle in its non-default state stays visible without hover** (e.g. a locked track always shows its lock).
  - A `DotsThree` menu holding Rename, Track height (S/M/L/XL), Duck (D-xxx track duck), and Delete track (destructive).
- **Remove** the always-visible red trash per row (`TimelinePane.tsx:1023–1028`) and the `DotsSixVertical` grip (`:930–937`).
- **Reorder.** Press and drag anywhere on the header past a 3 px threshold. The cursor is `grab` on press and `grabbing` while dragging. The dragged header lifts with `opacity .9`; a 2 px `accent` insertion line shows the drop slot. dnd-kit sortable stays (D-098).
- **Per-track height.** A 6 px zone on the row's bottom edge, both in the header and in the lane (`row-resize`), drags the height between 32 and 200. Double-click resets it to the view default.
- Locked tracks show the hatch overlay on their lane (§4.3). The header text drops to `text-secondary`.
- **Perf.** Headers scroll vertically with the lanes through one `transform` on the column (already the D-080 pattern). Height drags write a CSS variable on the row during the gesture and commit to the store on pointer-up.

### 4.9 Timeline toolbar (36 px, `surface`, `divider` below)

- **Left.**
  - A **tool segmented control** (24 px high, 28 px segments, 16 px icons). It keeps D-261's explicit tools and Premiere shortcuts, which the owner asked for ("instead of alt lets have icons for all of them"): Select `Cursor` (V), Ripple `ArrowsOutLineHorizontal` (B), Roll `SquareSplitHorizontal` (N), Slip `FilmStrip` (Y), Slide `ArrowsHorizontal` (U), and **Blade** `Scissors` (C, new; today there is only Split at playhead). The active segment is `card-active` with an `accent` icon, replacing today's filled chip. D-235's Alt/Option context modes stay as the shortcut on top of Select. Full feedback spec in §5.1.
  - Then **Split at playhead** (`SplitHorizontal`), **Add marker** (`BookmarkSimple`), and **AI** (`MagicWand`, the existing D-xxx actions menu).
- **Centre.** The timeline switcher (name + `CaretDown`, today's `TimelineSwitcher`), then the **timecode**: current time in `--color-playhead`, mono 13 / 600, then `/` and the duration in `text-secondary`. This replaces the separate tab row (`2026-09-09-edit` + `+`); the switcher menu holds New / Duplicate / Rename.
- **Right.** Toggle buttons, each 24 × 24 with a 16 px icon; an active toggle has an `accent` icon on `bg-secondary`:
  - Snapping (`Magnet`, S)
  - Linked selection (`LinkSimple`)
  - Audio scrubbing (`Waveform`)
  - Beat grid (`Metronome`)
  - **Clip Appearance** (`SlidersHorizontal`): opens a popover with the zoom slider, the band-ratio segmented control, the clip-height segmented control (S/M/L/XL), and Show clip names / Show badges checkboxes
  - **Zoom**: `MagnifyingGlassMinus`, a 96 px slider, `MagnifyingGlassPlus`. The `1%` readout goes; zoom % shows in the slider's tooltip.
- **Removed.** The toolbar Delete button (the Delete key and context menu stay); delete is not a tool.

### 4.10 Inspector (300 px; 260–440)

- **Header** (44 px). Kind icon (14 px, kind colour), the clip name (`--text-base` 600, ellipsis), and on the right the duration in mono `text-secondary`. With nothing selected the header reads "Timeline" and the body shows the timeline settings (today's "Project Settings" view, restyled).
- **Tab bar** (32 px). Centred icon tabs, 28 × 22 each: Video `FilmStrip`, Audio `SpeakerHigh`, Text `TextT` (text clips), Speed `Gauge`, Info `Info`. The active tab has an `accent` icon on `bg-secondary`; a tooltip gives the name. This replaces today's full-width line tabs with a 2 px underline.
- **Section.**
  - Header row 28 px: `CaretRight` / `CaretDown` 10 px, the title (`--text-sm` 600, title case, primary), and on the right an enable checkbox where the section can be bypassed, plus `ArrowCounterClockwise` reset, shown on header hover.
  - Sections are split by a 1 px `border-color` line, with no cards or background boxes. Body padding is 4 px 12 px 10 px.
- **Row** (26 px, grid):
  - **Label column 92 px**: `--text-xs`, `text-secondary`, left-aligned, ellipsis, full text on hover.
  - **Control** (flex): a slider when the property has a natural range.
  - **Value field, 56 px**: the number scrubber.
  - **A fixed 36 px slot** for the keyframe diamond (`Diamond`, filled `--color-selection` when a key sits on this frame, outline when animated, hidden otherwise) and reset. It shows on row hover or when animated. **The slot always takes its width**, so nothing shifts on hover. Today four `icon-xs` buttons per row squeeze the field (D-208 comment in `EditorTab.tsx`).
- **Paired values** (Position X/Y, Size W/H). Two 64 px fields with an inline `X` / `Y` prefix in `text-tertiary`, plus a 16 px link toggle (`LinkSimple`) for aspect lock.
- **Slider.** A 3 px track `rgba(255,255,255,.12)` with no fill, and a 12 px `text-primary` thumb with a 1 px `rgba(0,0,0,.35)` ring. A detent at the default value; double-click resets.
- **Number scrubber** (new `@apelles/ui` component, used across tabs).
  - 22 px high, `bg-secondary`, `--radius-sm`, value `--text-sm` tabular and right-aligned, unit suffix in `text-tertiary`.
  - Hover gives the `ew-resize` cursor. Drag left/right to scrub: 1 step per px, Shift ×10, Alt ×0.1. It uses `requestPointerLock` so a scrub never hits the screen edge.
  - A click without movement (< 3 px) enters text edit with everything selected. Enter commits, Esc reverts, ↑/↓ steps (Shift ×10).
  - Expressions like `+10` and `*2` are open question 7.
- **Perf.** A scrub coalesces into one store op per `requestAnimationFrame`. The commit to history lands on pointer-up as **one** undo step. Sections mount lazily (closed sections render no body).

### 4.11 Viewer and transport

- **Viewer header** (28 px, `surface`). Left: the format line `3840×2160 · 24p · Stereo` (`--text-xs`, `text-secondary`). This replaces the `3840×2160` chip painted over the picture. Right: zoom `Fit` with `CaretDown`, the Safe Area menu (`FrameCorners`, D-431), and the Inspector toggle.
- **Picture.** A black canvas, letterboxed, with nothing drawn over it except the user's own overlays (safe areas, transform handles).
- **Transport** (40 px, `surface`).
  - Left: the current timecode (mono 13 / 600, `--color-playhead`).
  - Centre: `SkipBack`, `CaretLeft` (−1 frame), **Play** (`Play` / `Pause` fill, 28 px button), `CaretRight`, `SkipForward`.
  - Right: playback rate (`1×` menu), volume (`SpeakerHigh`, popover slider), and full screen (`CornersOut`).
- **Removed.** The full-width white progress slider under the picture: the timeline playhead already does this, and FCP has none. This is open question 6, in case the owner wants a thin 3 px scrub bar kept.

### 4.12 Browser (Sources), 280 px; 220–480

- **Header** (36 px). A segmented control of icons: Media `FilmStrip`, Titles `TextT`, Effects `MagicWand`, Captions `ClosedCaptioning`. It replaces the left rail. Import (`Plus` + "Import", ghost) sits on the right.
- **Search** (28 px field, `MagnifyingGlass`), then the folder/collection row.
  - **Built (D-436, 2026-11-01).** The folder row is a header with a disclosure caret (collapses the whole list; Left/Right keys), "All media", the selected folder's name while collapsed, and New folder. The list sits in its own resizable pane above the grid.
  - **Built (2026-11-01).** Audio tiles draw the file's waveform in the `clip-audio` tokens with a `MusicNotes` glyph (glyph centred while peaks load); every probed tile has the duration pill.
- **Grid.** 2 columns at 280 px, more when wider; a tile size slider sits in the header menu.
  - Thumbnail 16:9, `--radius-sm`. Duration as a 10 px mono pill bottom-right on the thumb (`rgba(0,0,0,.6)`).
  - Name below, `--text-xs`, one line with ellipsis.
  - Selected: a 2 px `accent` outline.
  - Hover: skim the thumbnail (FCP filmstrip skimming) if cheap; otherwise a static frame.
- **Perf.** The grid is virtualised (rows outside view are not mounted). Thumbnails are decoded once and kept in an LRU.

### 4.13 Empty states

- **Timeline, no clips.** Lanes are drawn (V1, A1) at their default height with the `lane-alt` banding. One centred line, "Drag media here, or select a clip and press E to append" (`--text-sm`, `text-secondary`), and an Import button (ghost). Today it shows a dashed 2 px box.
- **Inspector, no selection.** The "Timeline" settings described above, never a blank panel.
- **Browser, no media.** A drop zone: a 1 px dashed `border-color` rounded `--radius-md` with `FilmStrip` 24 px, the text "Import media", and the shortcut ⌘I.
- **No project.** Unchanged copy, restyled to the new type scale.

---

## 5. Interaction feel

- **Drag a clip.**
  - Starts past a 3 px threshold (Palmier's). The clip lifts: one overlay element follows the pointer via `transform: translate3d`. The original slot keeps a 1 px dashed `text-tertiary` outline.
  - Vertical movement over 12 px moves the clip to the lane under the pointer. That lane gets a `rgba(255,255,255,.04)` tint, and an incompatible lane (a video clip over an audio track) gets the `not-allowed` cursor.
  - No `backdrop-filter`, gradient or shadow on the ghost. Today's drop ghost has all three (`TimelinePane.tsx:4670`), and its drag preview has `shadow-lg ring-2` (`:4848`).
  - The store is written **once, on drop**. During the drag only the overlay transform and the snap guide change.
- **Snapping.**
  - Threshold 8 px. Once snapped, the clip stays until the pointer leaves 12 px (×1.5 sticky); the playhead snaps at 12 px.
  - Targets: playhead, clip edges on all tracks, markers, in/out, beats when the beat grid is on.
  - Feedback: a 1 px `--color-selection` vertical guide through the ruler and all lanes, plus the delta pill on the moving edge. S toggles snapping (FCP uses N, which is Roll here); holding ⌘ while dragging suspends it.
- **Cursors.**
  - Default arrow over a clip body (FCP; no `grab` hand on clips).
  - `col-resize` on trim zones and the header column edge. `row-resize` on track-height zones. `ns-resize` on volume lines.
  - `grab` / `grabbing` only on track headers. `crosshair` for the blade (until the exported Phosphor cursor exists). `ew-resize` on number scrubbers and the playhead.
- **Hover.**
  - Tooltips after 500 ms; once one has shown, adjacent tooltips show at once for 1.5 s.
  - Fade tabs and the trim bracket reveal immediately with a 80 ms opacity transition.
  - **All hover effects are suspended during any drag** (a `data-dragging` attribute on the pane root gates them in CSS).
- **Motion.** Only `opacity`, `color` and `transform` animate, 80–160 ms, `ease-out`. Nothing animates layout properties, and nothing loops.
- **Keyboard parity.** Every gesture above has a key:
  - V / B / N / Y / U / C tools (D-261's Premiere set, plus C for Blade)
  - M marker (M again opens the editor)
  - S snapping (FCP uses N, but N is Roll here)
  - ⌘= / ⌘- zoom, ⇧Z fit
  - ⌥⌘↑ / ⌥⌘↓ clip height (FCP)
  - , / . nudge the selected edit point 1 frame, ⇧ for 10 frames (FCP)

### 5.1 Edit-tool feedback (ripple, roll, slip, slide, blade)

The owner: the edit tools "don't work, or the UI doesn't show the change / animate
properly". Whether they *work* is the harness task's job. This section is about
*showing* what the tool will do, before and during the drag, so it never feels like
nothing is happening.

References:
- Apple, "Make slip edits" (https://support.apple.com/guide/final-cut-pro/ver1632d8e4/mac, fetched 2026-10-31):
  - "Yellow edge selections on the start point and end point indicate a slip edit."
  - "If either the start point or the end point turns red as you drag, you've reached the end of the available media."
  - "As you drag, a timecode field indicates the amount of time you're moving the start point and the end point."
  - The two-up display "shows the start and end points of the clip you're slipping".
- Apple, "Make roll edits" (https://support.apple.com/guide/final-cut-pro/ver1632d9ae/mac):
  - A roll moves the edit point only, affecting both adjacent clips, and no other clip moves.
  - Two-up is available for ripple, roll, slip and slide (View → "Show 2-Up When Trimming", ⌥U).
- Resolve: the smart trim glyphs (`resolve-reference/trim.jpg`) and the "trim tool switches between ripple, roll, slip and slide based on the pointer position" (Blackmagic Edit page).
- Today's Apelles: D-261 tools and D-235 trim modes. `TimelineDragPreview.tsx` (D-304) already paints ghosts for sync-lock ripples and A/V links from an imperative handle without re-rendering the pane. The live-motion design below extends that pattern rather than replacing it.

**Tool picker.**
- Segmented control as in §4.9. Hover shows a tooltip with the name and key after 500 ms, e.g. "Roll (N): move a cut, both sides".
- Holding a tool key switches temporarily, the way holding T works in FCP: the tool reverts on key-up if the key was held longer than 300 ms.
- The active tool also shows as a 10 px label at the far left of the ruler while it is not Select ("ROLL" in `text-tertiary`). This catches "why does my drag trim instead of move".

**Per-tool cursor over a clip.** Until the real cursors are exported from the Phosphor package by a reproducible build step (CLAUDE.md icon rule), each tool shows the CSS cursor below plus a 10 px tool pill that follows the pointer at +12 px. The pill is one element, positioned by `transform`.

| Tool | Over a clip body | Over an edge zone (8 px) | Over a cut (both zones) |
|---|---|---|---|
| Select | arrow | `col-resize` + pill "Trim" | `col-resize` |
| Ripple | arrow | `col-resize` + "Ripple" | ripples the hovered side |
| Roll | arrow | `col-resize` + "Roll" | `col-resize` + "Roll" (both sides) |
| Slip | `ew-resize` + "Slip" | as body | as body |
| Slide | `ew-resize` + "Slide" | as body | as body |
| Blade | `crosshair` + a 1 px `text-primary` cut-preview line through the hovered clip (all linked halves) | | |

**Edit-point highlight** (what the drag will move; shown on hover *and* during the drag):
- **Trim / Ripple:** the §4.4 bracket on the hovered edge only, in `--color-selection`.
- **Roll:** brackets on *both* sides of the cut, `]` on the outgoing clip and `[` on the incoming one, so the two read as one `][` edit point.
- **Slip:** brackets on both edges of the one clip (FCP's "yellow edge selections on the start point and end point").
- **Slide:** brackets on the *neighbours'* inner edges (the out edge of the left neighbour and the in edge of the right one), because those are what change. The slid clip gets the 2 px selection outline.
- **Limit reached:** a bracket turns `--color-destructive` the moment its side runs out of handle media, or hits a neighbour or 1 frame of length. The drag clamps there; it never overshoots and snaps back.

**Live clip motion during the drag.** The timeline *shows the result while dragging*, not ghosts plus a jump on release. The store is written once, on drop; during the drag every moving element is translated or scaled through an imperative handle (the D-304 pattern), with no React render of the pane.

| Tool | What moves live |
|---|---|
| Trim (non-ripple) | The edge moves; the clip's width changes via `transform: scaleX` on the body wrapper, with the name strip counter-scaled, or by width on that one clip only. A gap opens behind it. |
| **Ripple** | The edge moves **and every downstream clip on that track, plus sync-locked tracks (D-113), shifts in real time** by the same delta, via one `translateX` per affected lane segment (downstream clips are wrapped in one moving group per lane during the gesture). |
| **Roll** | **Both sides move together**: the outgoing clip's out edge and the incoming clip's in edge follow the pointer, and nothing else moves. |
| **Slip** | The clip stays put. Its **filmstrip and waveform slide inside it** (canvas `translateX` within `overflow: hidden`), so the content visibly moves under a fixed frame. |
| **Slide** | The clip translates. The left neighbour's out edge and the right neighbour's in edge follow it (roll-like on both sides). |
| **Blade** | No drag. On click the cut appears at once as a dashed through-edit hairline (§4.3) and the two halves get a 120 ms selection-outline flash. |

Linked A/V halves (D-129) move with their partner in all of the above, in the same frame.

**Delta readout.**
- A `surface-raised` pill, 20 px high, `--text-2xs` mono, pinned 8 px above the moving edge (not following the pointer, so it does not jitter). It is clamped inside the timeline viewport.
- Content per tool:
  - Trim / ripple: `+00:00:12` and the new duration (`→ 00:04:03`).
  - Roll: `+12f` (or `−00:00:12`).
  - Slip: `+00:00:08` and the new source in/out.
  - Slide: the delta.
- It turns `--color-destructive` with "Limit" at a clamp. Today's `TRIM_BADGE_OFFSET_PX` badge follows the pointer (`TimelinePane.tsx:1818–1835`); it becomes this edge-pinned pill.

**Two-up viewer** (on by default for roll, slip and slide; ripple and trim show one-up of the edge frame; ⌥U toggles):

| Tool | Viewer shows |
|---|---|
| Ripple / Trim | the edge frame, one-up, with its timecode underneath |
| Roll | left: the outgoing clip's last frame; right: the incoming clip's first frame |
| Slip | left: the new first frame; right: the new last frame |
| Slide | left: the left neighbour's last frame; right: the right neighbour's first frame |

- Each half carries a 10 px label ("Out", "In", "Start", "End") and a mono timecode at the bottom edge. A 2 px `divider` sits between the halves.
- Frames come from the existing decode path and are requested at most once per animation frame (latest-wins), so a fast drag never queues decodes.

**Snapping during an edit.** As in §5: an 8 px threshold, sticky, and the 1 px `--color-selection` guide through all lanes. The moving edge's bracket brightens for 80 ms on the snap. The readout appends the snapped target ("· playhead", "· marker 'Hook'").

**Settle on drop.**
- The store commits, the pane renders the new layout once, and the elements that moved play a **FLIP settle**: from their last drag transform to identity, **≤ 120 ms, `ease-out`, `transform` only**.
- The ripple-shifted clips also get the 160 ms opacity flash (§4.3).
- No settle runs when the drop position equals the preview, which is the common case, since live motion already shows the result.
- A clamped or rejected drop animates back to the origin in 120 ms rather than jumping.

**Perf.**
- Every per-frame change in this section is a `transform` or `opacity` on elements that already exist. The pane's React tree renders exactly twice per gesture (start: wrap the moving groups; end: commit).
- The two-up decode is latest-wins.
- The harness numbers are in P2 (§8).

## 6. Concrete CSS defects in today's components

Line numbers are as of `main` at `c90569f`. Each one is fixed by the phase in brackets.

1. **`packages/editor/src/TimelinePane.tsx:2699–2708`** — the selection is `ring-2 ring-accent`. `ring` is a 2 px **box-shadow painted outside** the box, and `--app-accent` is **white** (`app/src/utils/themes.ts:23`), on a `rounded` (4 px) `overflow-hidden` body. The result is the owner's "thick white, heavily rounded border": it reads thicker than 2 px because it sits outside the clip and over the lane and its neighbours. The other relationship states layer more on top:
   - sync-linked: another `ring-2 ring-text-secondary` (`:2707`)
   - A/V-linked: a dashed `outline` (`:2706`)
   - ripple: `ring-2 animate-pulse` (`:2701`), an infinite box-shadow repaint
   → §4.3 states. **[P2]**
2. **`TimelinePane.tsx:2922–2945`** — the curve-editor toggle is a floating `BezierCurveIcon` button `absolute right-3 top-0.5` over the clip picture. This is the "floating keyframe/fade glyph in the corner" in `2026-10-31-clip-selection-style.png` → the `◆` strip badge / context menu / Inspector (§4.3). **[P2]**
3. **`TimelinePane.tsx:2947–2949`** — the clip name is a full-height flex row, **vertically centred over the filmstrip**, in `text-button-text`. That token is **black** in the dark theme (`themes.ts:20`), so the name is unreadable over picture, as `scratch/timeline-check2.png` shows → the top name strip with `--color-clip-label`. **[P2]**
4. **`TimelinePane.tsx:659–665`** — `CLIP_BODY_BACKGROUND` holds `rgba(...,0.55)` literals. **`:2736`** (`rgba(150,120,190,0.55)` for text clips) and **`:2771`** (`rgba(70,110,205,0.72)` for adjustment clips) are the same. All are colour literals in component code, which breaks the one-token-source rule. At 55 % alpha over the library's grey backing they turn muddy → opaque `--color-clip-*` tokens. **[P1 tokens, P2 use]**
5. **`TimelinePane.tsx:2815`** (and the drag preview copy at **`:4865`**) — the waveform is an overlay at 40 % of `ROW_HEIGHT` **on top of the filmstrip**, so picture and audio fight → separate bands (§4.3). **[P2]**
6. **`node_modules/@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css`**, `.timeline-editor-action-{left,right}-stretch` and their `:after` — 10 px zones with a 4 px radius and 7 px translucent white triangles (`border-left: 7px solid rgba(255,255,255,.1)`). **`packages/editor/src/timeline-overrides.css:21–33`** brightens them on hover. This is the "drag handles" look → override to no visual, plus the §4.4 bracket. **[P2]**
7. The same library CSS sets `.timeline-editor-action { background-color: #2f3134 }`. This grey backing shows through the translucent clip colours and at the rounded corners → `background: transparent` in the override file. **[P2]**
8. The same library CSS: `.timeline-editor-cursor { border-left: 1px solid #5297FF; border-right: 1px solid #5297FF; transform: translate(-25%) scaleX(.5) }`. That is a hard-coded blue playhead, sub-pixel scaled so it renders blurry → the §4.6 playhead on `--color-playhead`. **[P2]**
9. **`TimelinePane.tsx:1021–1029`** — a per-row delete button, `text-red-400 hover:text-red-400`. It is a raw Tailwind palette colour, not `--color-destructive`, and it is always visible on every track header (the red trash column in `timeline-check2.png`) → the `DotsThree` menu. **[P3]**
10. **`TimelinePane.tsx:916–939`** — the track header is a two-row layout with a `DotsSixVertical` grip (`:930–937`), a 10 px `text-[10px]` label (`:939`), and every toggle always shown → §4.8. **[P3]**
11. **`TimelinePane.tsx:502, 513`** — a fixed `ROW_HEIGHT = 52` for every track, and `HEADER_WIDTH = 156`. There is no per-track height → §4.8, with the M height kept at 52. **[P3]**
12. **`packages/editor/src/ClipFadeOverlay.tsx:357`** — the fade handles are `rounded-full border border-accent bg-bg-primary`: white-ringed black dots. **`:369`** the duration badge is `bg-bg-primary` with `text-[10px]` → §4.5. **[P2]**
13. **`packages/editor/src/TimelineMarkers.tsx:83–88, 230–240`** — the flag is a 9 px CSS `clip-path` polygon, not a library icon. **`:244–255`** opens the editor only on double-click or context menu, and adding a marker never opens it (the owner's `2026-10-31-marker-no-popover.png`) → §4.7. **[P3]**
14. **`TimelineMarkers.tsx:384–430`** — the popover stacks every label above its field (`flex-col gap-1`), and the duration/time fields are separate rows → the 64 px label column (§4.7). **[P3]**
15. **`app/src/hooks/useAppInitialization.ts:314–318`** — the default font is **Poppins** → the system stack (§3.4). **[P1]**
16. **`app/src/utils/themes.ts:16–27`** — in the dark theme `accent` = `hover-color` = white and `button-text` = black. `surface` (28) sits *between* `bg-primary` (24) and `bg-secondary` (35), so panels barely separate → §3.2. **[P1]**
17. **`app/src/styles.css:31–32`** — `--radius-md: 8px`, `--radius-lg: 15px`. Too round for a pro tool; Cardboard-like → §3.5. **[P1]**
18. **`TimelinePane.tsx:4670`** — the drop ghost uses `backdrop-blur-sm` with a gradient and an inset shadow. Backdrop blur is re-rasterised on every frame of a drag. **`:4848`** the drag preview is `rounded shadow-lg ring-2 ring-accent` → §5. **[P2]**
19. **`packages/inspector/src/InspectorSection.tsx:13`** — the section header is `text-[10px] font-semibold uppercase tracking-wide` → §4.10. **[P4]**
20. Arbitrary text-size literals throughout the editor: `text-[10px]` and `text-[11px]` at **`TimelinePane.tsx:737, 766, 818, 939, 2738, 2754, 2774, 2780, 4136, 4145, 4319, 4329, 4392`** and more, plus `ClipInspectorPanel.tsx:658, 781, 819, 904` → the §3.4 scale. **[P1 scale, each phase migrates its own files]**
21. **`packages/editor/src/EditorTab.tsx:152–278`** — the timeline sits *inside* the centre column, so Sources and the Inspector take full height and the timeline loses ~600 px of width at 1440 → §4.1. **[P5 — closed, §6d]**

## 6a. P1 as built (2026-10-31)

Values live in `packages/tokens/src/themes.ts` (`THEME_VALUES`, `cssVariablesFor`); `app/src/utils/themes.ts` imports them. The CSS side is in `app/src/styles.css` `@theme`. Differences from the spec above:

- **Accent is terracotta, not blue (owner answer, D-432).** Dark `accent` and `focus-ring` are `#c4502f`. The brand `#a6432c` was too dark for the dark UI: 2.49:1 against `surface`, under the 3:1 a focus ring or active control needs. `#c4502f` is the same hue, lifted, and measures:
  - `button-text` (white) on it: **4.63:1** (AA for text).
  - on `surface`: **3.26:1**; on `bg-primary`: 3.59:1 (AA for UI components).
  - Terracotta used as text on dark is too dim at that value, so a separate `accent-text` `#e8896b` is added: 5.91:1 on `surface`.
- **`destructive` is `#ff5a50`, not `#ff453a`.** The spec value gives 4.43:1 on `surface`; the tweak gives 4.91:1, so it passes as text.
- `hover-color` stays `#ebebf0`. The fork's `bg-accent-hover` class has no definition anywhere (it never resolved), so nothing changes there.
- New names beyond the spec: `accent-text`, `focus-ring`. `--color-ring` (shadcn) now points at `focus-ring`; `--color-destructive` points at `--app-destructive` (the literal left `packages/ui/src/styles.css`).
- The type scale (`--text-2xs..lg`), `--font-mono`, radii `xs/sm/md/lg`, and `--shadow-popover` / `--shadow-dialog` are in `@theme`. The scale changes `text-xs/sm/base/lg` app-wide on purpose.
- The system font is the default: `resolveUiFontStack` falls back to it; `fontFamily: 'poppins'` saved in settings still gets Poppins.
- `text-white` on `bg-accent` fixed to `text-button-text` in `SourcesPanel.tsx` and `LensCorrectionModal.tsx`.
- Light and grey have values for every new name, not redesigned.

Defects closed: 15, 16, 17 and the token half of 4 and 20. Left for later phases: the migration of `text-[10px]` literals and the use of `clip-*` in `TimelinePane` (P2 to P4).

**Tests.** `packages/tokens/src/tokens.test.ts`: every token present in every theme with a parseable colour, no duplicates, each name aliased in CSS, clip colours theme-independent, and computed WCAG contrast (text >= 4.5, UI >= 3, `clip-label` on every `clip-*-strip` >= 4.5).

**Not verified.** No screenshot pass: the app was not run (a running dev instance was off limits) and no visual harness exists for the three tabs. The first look at it on screen is the owner's or the P2 harness.

## 6b. P2 as built (2026-10-31)

**Files.** `clipAnatomy.ts` (pure split by track height + width thresholds + cut style),
`ClipBlock.tsx` (the clip's inside, shared by the resting clip and the drag ghost),
`editGesture.ts` (pure: op per drag, live preview, clamp, brackets, snap, readout),
`useEditGesture.ts` (the imperative gesture), `EditFeedbackLayer.tsx` (bracket, readout,
snap guide, Blade line), `timeline-overrides.css` (library overrides), the
`--z-timeline-*` scale in `app/src/styles.css`. `TimelinePane.tsx` wires them.

**How an edit drag works now.** The library's interact.js resize is off
(`flexible: false`); each clip renders two invisible ≥ 8 px edge zones
(`data-testid` `timeline-clip-trim-start` / `-end`). The clip body's capture-phase
`pointerdown` resolves the mode with the D-235/D-261 rule (`resolveTrimMode`) and, for
anything but a move, claims the press before dnd-kit sees it. Each `pointermove`: delta =
pointer offset since press + scroll since press, in frames; snapped as a whole to clip
edges / playhead / markers (8 px, sticky ×1.5, ⌘ suspends); `previewEdit` applies the real
`applyOp` to a copy and diffs every clip, bisecting to the furthest legal delta if the op
refuses (which turns the bracket and readout red). The diff becomes `transform`s on the
moving clip bodies, a `width` on a clip whose length changes, and a `transform` on the
slipped clip's `[data-chroma-clip-media]` layer. No React state is set during the gesture;
on release the op commits once, the edited clip is selected (same batched render), and a
layout effect drops the inline styles on that render, before paint. Esc or a refused op
animates back over 120 ms.

**Perf design vs the §8 targets.**
- Zero React renders while the pointer moves; one pane render at release (DOM test:
  `paneRenders` 0 during the drag, ≤ 2 including the release; React commits anywhere in the
  tree during the drag: 0).
- Per move: one `applyOp` on a copy (structured clone of the timeline) only when the snapped
  frame delta changes, plus transform writes. On a 300-clip project the clone cost is the
  one thing to watch in the live trace.
- **Not literally "zero layout during pointermove":** a trimmed clip takes its new `width`
  (the spec allows "width on that one clip only"); it is `contain: layout paint style`, so
  the layout is that node's subtree. Neighbours that only shift are transform-only. The
  library no longer writes `left`/`width` during a gesture at all.
- Measured live: not yet (owner's app and ports were off limits); the harness run after the
  merge is the acceptance check for p95 ≤ 8 ms.

**Deviations from the spec above.**
- Band heights follow the §4.3 formula (`round((H − strip) × 0.3)`, as the mockup does):
  M = 14/25/11, L = 16/41/17, XL = 16/63/27. The table's 24/12, 40/18, 62/28 differ by
  rounding.
- Track height is still the fixed 52 px for every track; per-track height, the Clip
  Appearance popover and their `editor_set_timeline_view` fields are P3. The anatomy is
  computed for any height already and unit-tested at S/M/L/XL.
- The filmstrip is still per-tile `<img>` (not one canvas); the waveform is one canvas and
  now draws rectified in the clip's `-wave-ink` (`Waveform` `variant="band"`).
- Not built in P2: the two-up trim viewer, the volume line on audio clips, sticky labels,
  the per-tool pointer pill (the D-250 badge still names an armed mode), the locked-track
  hatch (locked clips keep `opacity-60`), missing/muted/generating states, the FLIP settle
  (unneeded: the preview is the result, so nothing moves at commit).
- The Blade tool is a palette tool (key **C**, Premiere's Razor; FCP's B is Ripple here). Its
  MCP twin is the existing `editor_split_clip(track, clip, at_frame)`; no new tool, count
  unchanged.
- Snapping (N) and skimming (S) toggles are not in P2, so **Roll keeps N** until the phase
  that builds snapping moves it.
- The playhead head keeps the library's own inline SVG shape, recoloured amber by CSS (not
  a Phosphor `CaretDown`): replacing it means rendering our own playhead, which is P3's
  ruler work.
- The playhead grab zone is the head band under the ruler (the marker-strip height), not
  the ruler itself; the ruler still seeks on click.
- The z-index scale is plain custom properties in `app/src/styles.css` (with the radii and
  shadows), not `@apelles/tokens`, which holds colour values only; the shadcn `z-50` layer
  and the rest of the app's literals are not migrated.
- Clip body cursor is the default arrow (spec §5); harness scenario
  `clip-body-hover-cursor` was updated from "grab" to "default/auto" to match.

**Defects closed:** §6 #1, #2, #3, #4 (use), #5, #6, #7, #8, #12, #18 (drag ghost: no
shadow/ring/blur, same anatomy). Bugs: B-342, B-344, B-345, B-346; B-347 in part.

**Tests.** `clipAnatomy.test.ts` (12), `editGesture.test.ts` (18: each tool's preview,
the clamps, preview == commit, brackets, snapping, readout), `timelineOverrides.test.ts` (3),
`TimelinePane.clipBlock.dom.test.tsx` (19: anatomy, selection outline, zones and limit
bracket, live motion and exact result for trim/head-trim/ripple/roll/slip/slide, Esc,
style drop at commit, render budget, Blade, layer isolation), `tokens.test.ts` (layer
order). Updated: trim, trimTools and fade DOM suites, `trimMode.test.ts` (`resizeEndOp` /
`bodyDragOp` removed with their only callers).

**Visual check.** The real `TimelinePane` in the D-142 browser harness
(`app/harness.html`, Chromium, real tokens): `scratch/ui-redesign-p2/after-rest-selected.png`
(main checkout) — strip / filmstrip / band, amber playhead, selected clip; and
`after-roll-mid-drag.png` — a roll mid-drag, `][` brackets on the cut, `+13f` readout,
both clips moving, then committed exactly. Chromium, not WKWebView, and no thumbnails or
waveforms (stubbed IPC).

**Needs the live harness:** frame p95 / worst / dropped for every edit tool, the commit
spike at release, `elementFromPoint` on the edge zones at a butted cut (both halves), slip's
filmstrip motion, the head-only playhead grab, and `observed.trusted` on the capture-phase
claim.

## 6c. P3 as built (2026-11-01)

**Files.** `TrackHeader.tsx` (the header row, its toggles, menu and rename; the
D-149 ducking popover moved here), `trackHeight.ts` (pure per-track geometry:
presets, clamp, tops, row at y, fractional rows), `TimelineViewControls.tsx`
(Snapping / Skimming toggles, Clip Appearance popover), `TimelineRuler.tsx`
(our own ruler), `previewPeek.ts` (skim frame + two-up request store),
`twoUp.ts` + `TwoUpViewer.tsx` (two-up), the rewritten `MarkerStrip` /
`MarkerEditor` in `TimelineMarkers.tsx`, `timelineView.ts` (new fields),
`trackOps.ts` (labels, badges, the two new tools' argument checks). Rust:
`Track.name` / `Track.height` (`apelles-timeline`), `PipeLane::TRIM_VIEW`
(`apelles-media`), `chroma_trim_view_frame` / `chroma_trim_view_end`
(`chroma/edit.rs`).

**Keys.** N snapping, S skimming, **T Roll** (moved off N; FCP's Trim tool and
Resolve's Trim Edit mode are both T), `=` / `-` zoom with Cmd+= / Cmd+- as
aliases. §5's "S toggles snapping" and §4.9's "Snapping (`Magnet`, S)" are
superseded by the owner's answer (D-432): snapping is N.

**How a height drag works.** The header's bottom 6 px (and a 4 px band on each
lane line) starts `startTrackHeightDrag`: each move writes the dragged
header's `height` and moves one guide line across the lanes, with no React
render; release commits one `set_track_height` (one undo step), whose render
lays the lanes out (the library takes a `rowHeight` per row). Esc cancels;
double-click resets to the view default. Every `index × ROW_HEIGHT` in the
pane, the drag preview, transitions, the gesture feedback and the marquee now
reads `trackTops`; the edit area exposes them as `data-chroma-row-tops` for
the harness.

**AI parity.** `editor_set_timeline_view` gained `clip_height`, `band_ratio`,
`show_names`, `show_badges`, `snapping`, `skimming` (all optional; at least
one field); `editor_get_state.timelineView` reports them. New tools
`editor_rename_track` and `editor_set_track_height` (the per-track values are
document data, see D-432 P3 for why). `editor_list_tracks` reports `badge`,
`renamed` and `height`. 262 -> 264 tools (release 249).

**Deviations from the spec above.**
- Toggles are hidden by `display` (not opacity) and float over the name's
  right end: with opacity, the hidden buttons still took the row's width and
  truncated an audio track's name to nothing at 136 px (caught in the
  Chromium check). Revealing them changes no layout.
- The ID pill never turns accent: there is no "target track for edits /
  paste" concept yet to drive it.
- Markers keep the D-328 16-colour palette (MCP colour names are a contract),
  as 14 px swatches in two rows; Time and Duration are on separate rows.
- The ruler is ours, the playhead still the library's: its head keeps the
  library shape, recoloured (D-437 replaces both). **Since D-437 S4 the playhead is
  ours too** (`lanes/Playhead.tsx`: 1 px line, Phosphor `CaretDown` head in the ruler,
  grab band under it, §4.6).
- The zoom readout stays beside the +/- buttons (harness ids); the zoom slider
  is in the Clip Appearance popover.
- The beat grid's own snap toggle stays (D-413) with a straight magnet; the
  toolbar's Snapping (N) gates it.
- Two-up shows source frames without grade or transform (Final Cut's two-up
  shows the clip picture too); trim / ripple stay on the playhead's frame
  (no one-up edge frame yet).
- View settings are not persisted across relaunch (P5's layout persistence).
- Not built: the locked-track hatch, the hover tooltip delay rules, hover
  suspension during drags via `data-dragging`.

**Defects closed:** §6 #9, #10, #11, #13, #14. Bugs: B-350; B-348 in part
(two-up, keyboard zoom, snapping toggle, marker drag).

**Tests.** `trackHeight.test.ts` (geometry, ops, labels), `twoUp.test.ts`
(roll / slip / slide frames, marker drag rule), `ruler.test.ts` (labels,
split count), `timelineView.dom.test.tsx` (new view fields, both new tools),
`TimelinePane.p3.dom.test.tsx` (19: headers, rename, menu delete, height drag
renders nothing and commits once, anatomy at L, Esc and reset, appearance
popover, ruler per zoom, ruler scrub, marker shield / drag / editor, N / T
keys, snapping on/off on a trim, skimming with no pane render, keyboard zoom,
two-up only during roll); `trimMode.test.ts` (keys); the marker DOM suite
updated for the 24 px ruler and the shield. Rust: `apelles-timeline` round
trip of name / height; MCP parity corpus re-captured.

**Visual check.** `app/harness.html` in Chromium (real tokens, stubbed IPC),
saved to `scratch/ui-redesign-p3/` (main checkout): `before-owner-after-p2.png`
(the owner's screenshot before P3), `after-rest.png`,
`after-headers-heights-markers.png` (renamed audio track, a 108 px track, a
locked track's lock showing, point and ranged markers),
`after-clip-appearance.png`, `after-marker-editor.png`. Not WKWebView; no
thumbnails or waveforms; the two-up viewer lives in the preview, which the
timeline-mode harness does not mount.

**Needs the live harness:** scroll at 60 fps with 12 tracks × 300 clips, the
height drag's single commit, marker popover open-and-focused within a frame of
M, `editor_set_track_height` round trip, the new scenarios
(`snapping-toggle-button`, `skimming-toggle-key`, `scrub-ruler-drag`,
`track-height-drag`, `track-header-quiet`, the updated
`move-snapping-toggle` / `trim-tool-shortcuts` / `trim-two-up-viewer`), and
the two-up decode cadence on real 4K footage.

## 6d. P4 as built (2026-11-01)

- **`NumberScrubber`** (`packages/ui/src/components/ui/number-scrubber.tsx`, tests `packages/editor/src/NumberScrubber.dom.test.tsx`): a `role="spinbutton"` text field. 1 px = 1 `step` (callers pick steps so a pixel is a useful nudge: Scale / Opacity / Volume 0.01), Shift x10, Alt x0.1, 3 px click slop, Esc mid-drag restores. Typed text goes through `lib/number-expression.ts` (closed grammar, no `eval`): `+ * /` lead = relative to the current value, `-` lead = a negative number, `-=` subtracts, the field's own unit is accepted. Open question 7 is answered: arithmetic = yes.
- **Perf.** The field renders its live value locally during a scrub; `onChange` is coalesced to one call per `requestAnimationFrame`, the final value flushed on release. `InspectorNumber` (editor) brackets the gesture with `beginHistoryGroup` / `endHistoryGroup`; `applyOp` pushes entries with a shared `coalesceKey`, which `@apelles/history` folds into one entry (first `undo`, last `redo`).
- **No pointer lock.** B-136 / D-271 found Pointer Lock's mandatory banner unusable in WKWebView. The pointer is captured on the field with window listeners as backup; the cursor is a static `ew-resize`.
- **Rows / sections.** `InspectorRow` (`@apelles/ui`): 92 px label (ellipsis + full-text tooltip), control, optional fixed 80 px slot (‹ ◇ › ∿ ↺ at 16 px; ‹ › are `invisible` until animated, diamond / reset fade in on row hover or focus: opacity only, no layout). The slot is 80 px, not the spec's 36, because it holds nav arrows and the curve button too. `InspectorSection` (`@apelles/inspector`) is collapsible when given `onOpenChange` (28 px header, caret, `meta`, `actions`, lazy body); `EditorSection` binds it to `timelineStore.inspectorSections`. Every section starts collapsed (owner, 2026-11-01; a section the user opens is remembered per id in the store and persisted, so a fresh Inspector is a list of headers). Labels are full ("Crop left"), Opacity moved into a new Compositing section, Width / Height became one Size row with a real link toggle (`aria-pressed`).
- **Tabs / header.** Icon tabs (`FilmStrip`, `SpeakerHigh`, 28 x 22, accent icon on `bg-secondary`, `aria-label` = name); a 44 px header (kind icon + name). The no-selection view uses the same header and rows ("Project", "This timeline" sections).
- **AI parity.** Every op, MCP tool and debug op is unchanged (`debug_set_editor_inspector`, `debug_set_inspector_tab`); `debug_get_ui_state` gained `editor.inspectorSections`. There is no new MCP surface: nothing here adds a capability, only presentation and gesture.
- **Not done (deviations).** No inline sliders (mockup rows with a range); no Speed / Info icon tabs (Speed stays a section); no duration in the header (the panel has no fps); the Text / Caption / Adjustment inspectors keep their own rows (they get the new heading type only); the section open state has a read (`debug_get_ui_state`) but no debug write op, to avoid touching `mcp/server.py` during the drag-perf work. Live-harness numbers (scrub latency, swap time, hover CLS) are not yet measured.
- **Evidence.** `scratch/ui-redesign-p4/after-*.png`: the Inspector rendered in `app/harness.html?mode=inspector` (headless Chromium, 380 px wide); the "before" is the owner's `scratch/bug-refs/2026-11-01-after-p2.png`.
## 6d. P5 as built (2026-11-01)

Done ahead of P4, at the owner's ask ("the player and buttons etc. still
haven't moved to the way you showed me").

**What moved where.**
- **Layout (§4.1, defect #21).** `EditorTab` is one vertical `ResizablePanelGroup`:
  the upper band (`data-chroma-panel="edit-upper"`) holds browser | viewer |
  Inspector as a horizontal group, and the timeline (`edit-timeline`) sits
  beneath it across the full window width. All three splits are `@apelles/ui`
  resizable panels. Bounds: browser 280 px (220–480), Inspector 320 px
  (264–440), viewer at least 320, upper band at least 260, timeline at least
  180 and 42 % of the tab by default. At 1440 the timeline's edit area is now
  1304 px wide (it was ~660 px with Sources and the Inspector open).
- **Persistence.** `packages/editor/src/editLayout.ts` (`useEditLayoutStore`)
  holds the sizes and the browser's open flag. A split commits only when the
  user releases it (`onLayoutChanged` with `isUserInteraction`), so a mount or
  a window resize never rewrites a saved size. The composition root hydrates it
  from, and persists it to, `appSettings.editLayout` (new
  `EditLayoutSettings` in `app_settings.rs`), the keymap's injected-sink
  pattern (D-273). A non-user write (debug op, late hydrate) is applied to the
  live panels through their imperative `resize`.
- **Browser (§4.12).** `EditBrowser.tsx` is the upper-left panel: a tab bar
  of eight icon tabs (`@apelles/ui` `Tabs`, `data-chroma-browser-tab`) over the
  selected library — Sources shows the injected media pool (kept mounted,
  hidden, on the other tabs), the rest `EditLibraryPanel`. The left icon rail
  (`EditLibraryRail.tsx`) and `Shell`'s `libraryRail` / `libraryPanel` slots are
  deleted. `ShellTab.ownsLibraryColumn` tells `Shell` to draw neither its
  docked column nor its floating Sources chip for the Edit tab; Motion and
  Colorist keep both.
- **Viewer (§4.11).** `Player`: a 28 px header (caller's `headerStart` — the
  browser toggle —, the format line `1920×1080 · 24p`, the timeline name
  centred, then `− Fit +`, the Safe Area menu (D-431), the waveform toggle and
  the caller's `headerEnd` — the Inspector toggle); the black picture; the
  optional waveform band; a **3 px scrub bar** (`ScrubBar`, new in
  `@apelles/ui`: Base UI slider, playhead-coloured fill, knob on hover / focus
  / drag, 12 px hit area, arrows / Shift ×10 / Home / End); a 40 px transport
  (full timecode in `--color-playhead` left; previous edit, frame back, play,
  frame forward, next edit centred; rate, volume, fullscreen right). The two
  floating corner chips are gone, and so is the `W×H` chip `CanvasBoundary`
  painted over the picture.
- **Edit points.** The outer transport buttons go to the previous / next
  edit point (`editPoints.ts`: every clip start and end on any track, plus
  the first and last frame), also on ↑ / ↓ (`edit.prev_edit` /
  `edit.next_edit`, rebindable).
- **Top bar (§4.2).** 38 px; traffic lights, a `‹ Projects / <name>`
  breadcrumb (new `projectName` prop), the tabs as a centred segmented control
  (`bg-secondary` track, `card-active` segment), then activity, brand,
  shortcuts, MCP and **Export last** (restyled as the secondary button). The
  72 px macOS spacer is gone: the tabs are absolutely centred anyway.
- **Timeline toolbar (§4.9).** `TimelinePane` takes a `toolbarCenter` slot
  (two small hunks: the prop at its signature and one line before the right
  group). `EditorTab` puts the timeline switcher there, now a `Name ▾` menu
  (timelines as a radio list, then New / Rename / Duplicate / Size / Delete),
  and `PlayheadTimecode` (current / duration, written straight to its text
  node: no React render per played frame). The separate tab strip row is gone;
  a timeline with no tracks gets the same centre as its own row, since the
  pane then has no toolbar.

**AI parity.** `debug_get_ui_state` reports `editor.layout`. New
`debug_set_editor_layout {browserOpen?, browserWidth?, inspectorWidth?,
timelineHeight?}` (both servers, corpus re-captured, 264 -> 265 tools; release
count unchanged, debug tools are not in it). `debug_set_library_mode` now shows
the Edit browser (it opened the shell column before) and replies
`browserOpen`; `debug_set_sources_panel` drives the shell column on Motion and
Colorist only.

**Deviations from the spec.**
- The timeline toolbar's centre is a flex item between the left and right
  groups (`mx-auto`), not absolutely centred: the left group is wide enough at
  1280 that an absolute centre would overlap it. At 1440 and 1280 it sits
  within ~20 px of true centre (measured in Chromium).
- The browser's tab bar holds all eight libraries; Import stays in the Sources
  panel's own header rather than the tab bar (no room beside eight tabs at
  220 px).
- Zoom in the viewer header is `− Fit +` inline, not a `Fit ▾` menu: a menu
  would hide the three controls behind a click and break the D-218 cluster's
  disabled-at-a-bound contract.
- The transport timecode shows frames (`HH:MM:SS:FF`), as the mockup does;
  the old readout dropped them and showed `current / total`. The total is in
  the timeline toolbar now.
- The Inspector keeps its 320 px default (spec 300) until P4 rebuilds its rows.
- Clicking the selected browser tab does nothing (the rail collapsed the
  column); the viewer header's toggle hides the browser.
- Two `SourcesPanel` instances can be mounted at once (the Edit browser's and
  the shell column's on Motion / Colorist), each with its own search text.
- Not done in P5: the §4.13 empty states (the timeline's lives inside
  `TimelinePane`, which D-437 is rewriting), Cmd+4 for the Inspector, volume
  as a popover slider (it is still the hover-expanding one), and the toolbar's
  own regrouping beyond the centre slot (it is inside `TimelinePane`).

**Tests.** `EditorTab.layout.dom.test.tsx` (full-width timeline as a sibling
of the upper band, panel order, three separators, both toggles, the toolbar
centre, the empty-timeline row, no store write on mount),
`editLayout.test.ts` (clamp, junk, no-op writes, hydrate does not persist),
`editPoints.test.ts`, `Player.layout.dom.test.tsx` (header cells, transport
cells and wiring, the scrub bar's 3 px / 12 px geometry, keyboard steps,
Shift ×10, Home / End, a pointer drag as one start / end gesture, unmount
mid-drag), `Shell.chrome.dom.test.tsx` (breadcrumb, segmented tabs, Export
last, owned column) replacing `Shell.libraryRail.dom.test.tsx`,
`debugOps.editLayout.test.ts`; `EditLibraryPanel.dom.test.tsx` and
`TimelinePane.drop.dom.test.tsx` drive the browser tabs instead of the rail.
Rust: the MCP parity suite.

**Visual check.** `app/harness.html?mode=edit` (new: the real `Shell` +
`EditorTab` + an empty-but-seeded `SourcesPanel`, with Tauri window / OS
metadata stubbed) in Chromium, screenshots in `scratch/ui-redesign-p5/` of
the P5 worktree (`mockup.png`, `after-edit-tab.png`, `side-by-side.png`,
`after-titles-selected-1280.png`). Measured there: timeline 1440 px wide and
42 % tall, header 28, transport 40, scrub track 3 px in a 12 px hit area; a
real pointer drag on the timeline split committed one `user` write (311 ->
391 px) and a debug write moved all three splits to the requested sizes. Not
WKWebView.

**Needs the live app:** the persisted sizes surviving a relaunch
(`appSettings.editLayout`), panel resize at 60 fps, no panel under its
minimum at 1280×800 in the real window, the harness scenarios after the
layout change (the edit area is wider, so H11's outside-the-visible-area
misses should drop), and the scrub bar's feel on a trackpad.

## 6e. v0.3.0 gap closure as built (2026-11-03)

The eight gaps the 2026-11-01 comparison found (B-359) and B-354's P5
leftovers, closed against the approved mockup (owner: "loved the design",
"yes please" to pulling them into v0.3.0). One subsection per piece.

**Inspector header and tabs (B-359 item 1).**
- The 44 px header carries the clip's duration on the timeline on the right
  (`data-chroma-inspector-duration`, `HH:MM:SS:FF` in mono `text-secondary`,
  from `endFrame - start_frame` at the timeline's rate). The panel now gets the
  timeline fps as a prop, which is what P4 lacked.
- Four icon tabs, as the mockup: Video `FilmStrip`, Audio `SpeakerHigh`, Speed
  `Gauge`, Info `Info` (`CLIP_INSPECTOR_TABS`). Speed holds D-236's retime
  section, moved out of the Video tab; it is offered where that section ever
  rendered (not a title, not an adjustment clip). Info (`ClipInfoPanel.tsx`)
  is read-only: Media (name, format, resolution, frame rate, length, audio,
  folder, path), Source (in / out) and Timeline (start / end / duration), all
  from the clip and the media pool's existing probe; a title / caption /
  adjustment clip shows its kind and its timeline facts. A title now has a tab
  bar (Video, Info) where it had none.
- `debug_set_inspector_tab` accepts the four names (both servers' descriptions
  updated, corpus re-captured).
- Deviation: no codec row. The pool's probe (`MediaVideoInfo`) records no
  codec, and a codec guessed from the extension would be a guess shown as a
  fact; the container format (the extension) is shown as "Format" instead.

**Inspector rows (B-359 item 2).**
- `@apelles/ui` `InlineSlider` / `SliderField` (`slider-field.tsx`): Base UI
  slider drawn to §4.10 (3 px track, no fill, 12 px `text-primary` thumb),
  double-click resets, beside a 56 px `NumberScrubber` on the same value. The
  slider's span (`sliderMin`/`sliderMax`) is separate from the field's bounds,
  so a typed value past it is kept and pins the thumb.
- One gesture, one undo: a slider drag or one key press on the thumb calls the
  field's `onScrubStart` / `onScrubEnd` once (changes coalesced per frame, the
  last flushed first). `InspectorSliderField` brackets them with the store's
  history group, exactly as `InspectorNumber` does for a scrub.
- Scale (0-4), Rotation (-180..180 deg) and Opacity (0-1) rows carry the
  slider (`PropertyRow`'s new `slider` prop). Corner radius, crop and audio
  rows keep the bare field, as the mockup draws them.
- Position X / Y are one paired row (`PairedPropertyRow`: `X [..] Y [..]`,
  Final Cut's single Position parameter) behind one keyframe slot: the diamond
  animates both or stops every animated half, ‹ › go to the nearest key of
  either, ↺ resets both. The two halves are written as ONE keyframe array
  (`toggleParamKeyframes` / `resetParam` take a list of params), inside one
  history group: one undo step.
- Deviation: values stay in their stored units (Scale 1.12, Opacity 0.85)
  where the mockup shows percentages; display units are B-366's pass.

**Browser header (B-359 item 3).**
- `SourcesPanel` takes a `variant`: `'browser'` (the Edit browser's Sources
  tab) drops the "SOURCES · Select · + Import" row; `'panel'` (the Motion /
  Colorist column) keeps it. The Edit grid gains that row's ~37 px.
- `+ Import` sits on the browser's tab row (`EditBrowser.tabRowEnd`, injected
  by `Root.tsx` as `SourcesImportButton`). The word shows only when the row is
  at least 300 px wide (a container query on the row), so the eight tabs stay
  readable at the 220 px minimum; the icon and its tooltip are always there.
- The "All media" root row carries "N items" (what the grid is showing, so it
  follows the bin and the search) and, in the browser variant, the Select
  toggle (`aria-pressed`), beside New folder.
- The selected bin moved to `useShellStore.sourcesActiveFolder` so the tab-row
  Import imports into the bin on screen; both Imports run one hook
  (`useSourcesImport`).
- Deviation: the folder tree (D-436, built after the mockup) stays, so "All
  media · N items" is the tree's root row rather than a separate crumb row.

**Timeline toolbar (B-359 item 4, B-354).**
- 36 px, a `minmax(0,1fr) auto minmax(0,1fr)` grid (the mockup's `.ttool`),
  so the switcher and timecode sit at true centre; B-354's "about 20 px off
  centre" is gone. Groups carry `data-chroma-toolbar-group` (left / center /
  right).
- Left: the six trim tools as ONE rounded segmented group (`TrimToolbar`:
  `bg-secondary` track, 28 × 20 segments, `card-active` + accent for the
  active tool), a divider, then Split, Add marker, Transitions, then the
  contextual actions (trim-mode hint, drop error, Remove, Unlink, Link, Close
  gap, Move to), each shown only when it applies. The left group clips rather
  than pushing the centre.
- Right: Snapping, Skimming, **Beat grid**, Clip Appearance, a divider, then
  `MagnifyingGlassMinus`, a 96 px zoom slider and `MagnifyingGlassPlus`. The
  `20%` readout is gone; the percent is the slider's `aria-valuetext` and its
  tooltip. `=` / `-` and pinch are unchanged.
- The zoom slider (`TimelineZoomSlider`, shared with the Clip Appearance
  popover: one logarithmic mapping, `zoomSliderPosition` /
  `pxPerSecAtSliderPosition`) goes through the pane's `zoomBy`, so it anchors
  on the playhead like the buttons and writes the same per-timeline view store
  `editor_set_timeline_view` writes.
- Beat grid (`TimelineBeatControl.tsx`): one `Metronome` toggle, accent while
  a track's beats are on, opening a popover with the tempo ("128 BPM",
  "analysing beats…"), the beat-snapping switch, "Snap cuts to beats" and the
  last snap's result. The loose "128 BPM" text and the two loose buttons are
  gone from the row. With no beat track it says how to turn one on (the track
  header's Show beats toggle).
- Deviations: (1) Remove stays, as a contextual button, where §4.9 drops it:
  the clip has no context menu yet, so the toolbar is the pointer's only way
  to delete. (2) The mockup's Linked selection and Audio scrubbing toggles are
  not added: linked selection is not a mode in this app (links are per clip,
  Link / Unlink) and audio scrubbing's waveform toggle lives in the viewer
  header; Skimming takes that slot.

**Lines through the lanes (B-359 item 7).**
- The faint vertical lines the comparison saw were not markers (markers draw
  only in the ruler's marker strip, and always did): they were the beat grid's
  downbeats (D-413), which drew a 20 % accent line down through every track.
  At 128 BPM that is a line every ~1.9 s, which is what the screenshot shows.
- `BeatLane` now draws everything inside the ruler and marker band: the
  downbeat's full-band tick and bar number, and the beats' short ticks.
  Nothing reaches the lanes, as in the mockup and Final Cut's timeline.
  Snapping to beats is unchanged. Pinned by `TimelineBeats.dom.test.tsx`.

**Track headers: names and the target track (B-359 item 5, D-440).**
- Names were already real (P3: `Track.name`, the double-click rename,
  `editor_rename_track`); the comparison's "Video 1 / Audio 1" was that
  project's data. Nothing to build there.
- The target track: a flag on the track (`Track.target`, at most one), set by
  clicking the `V1` / `A1` pill (a button, `aria-pressed`, accent with
  `text-button-text` when set; a second click clears it; its press never
  starts the reorder drag) and by `editor_set_target_track {track | null}`.
  One `set_target_track` op, one undo step. It follows its track on a reorder
  and leaves with a removed track.
- It steers the edits that name no track when its kind fits the source
  (`destinationTrack`): the viewer's edit overlay drop and `editor_edit_in`
  without `track`. `editor_add_clip` without `track` still makes a new track
  (B-273), deliberately; see D-440.
- Deviation: the mockup's own track names ("Interview", "Dialogue") are its
  sample data; the app shows the user's names when set and "Video 1" style
  labels otherwise, as before.

**Empty states (§4.13, B-354, B-359 item 8).** `EditEmptyStates.tsx`:
- Timeline with no tracks: two placeholder lanes (V1 over A1, default
  height, the strip colours, `timeline-bg` / `lane-alt` banding, dimmed
  headers) under the switcher row, and one centred line, "Drag media here
  from the browser to start editing", with the Import button (the same
  injected `SourcesImportButton`, via `TimelinePane.emptyAction`). The dashed
  2 px box is gone; a drag over it rings the panel in the accent.
- Tracks but no clips: the same line centred over the lanes
  (`TimelineNoClipsHint`, `pointer-events-none` except the button).
- Browser, no media: the grid is a dashed `border-color` `--radius-md` zone
  with `FilmStrip` 24 px and "Import media"; a press opens the picker.
- Inspector: no selection already shows the timeline / project settings
  (P4, never blank). A selection that resolves to no single clip shows
  `InspectorEmptyState`, now `text-xs text-secondary` with a `CursorClick`
  glyph: "Select a clip to edit its properties." (the shared component gained
  an optional `icon`).
- No project: the same copy with a `FolderOpen` glyph, on the type scale.
- Deviations: the spec's "press E to append" and the browser zone's "⌘I" are
  not shown, because neither shortcut exists yet; the line names the drag
  instead, and the zone says media is referenced in place.

**Volume popover (B-354).** The transport's `SpeakerHigh` button
(`aria-label="Volume"`) opens a popover above it: the mute toggle, an
`InlineSlider` (keyboard: arrows / Shift / Home / End; double-click back to
100 %) and the level in percent, writing the same `onVolumeChange` /
`onMuteToggle` (the Edit tab's monitor volume). It replaces the slider that
slid out on hover and could not be reached from the keyboard. A `Player`
given only `onMuteToggle` keeps a plain mute button.

**Cmd+4 (B-354, §4.1).** `edit.toggle_inspector` (⌘4 / Ctrl+4, new Edit
"View" category in `@apelles/keymap`, rebindable in the Keyboard Shortcuts
window) shows / hides the Inspector, as in Final Cut, through the same
`inspectorOpen` flag the viewer header's toggle and
`debug_set_editor_inspector` write. Conflict-checked: Cmd+1..3 are the global
tab switches, Colorist's colour label is Shift+4, and `conflictingIds({})`
does not list it (pinned in `store.test.ts`).

**Verification (2026-11-03).**
- Unit / DOM: editor 3142 (the two `editJournal` B-274 cases timed out only
  while a Rust build saturated the machine; they pass alone), app 117, ui 19,
  keymap 112, motion 1047, ui-harness 95, debug 127, player 39; tsc editor 3 /
  app 65 (baselines); `cargo test -p apelles-mcp` (parity, 272 tools) and
  `apelles-timeline`'s new round-trip test; clippy clean.
- Live, a `tauri build --debug` bundle (`studio.apelles.perf3`, control port
  19797): the three new harness scenarios pass, and the full default suite is
  60/61 (only `zoom-trackpad-pinch`, the known second-instance magnify issue,
  roadmap 00r item 5).
- Screenshots, in the main checkout's `scratch/ui-compare/after-v030/`:
  `rest.png` (compare with `../mockup-rest.png`), `inspector-info.png`,
  `empty-timeline.png`. Taken on a synthetic demo project (the harness's test
  media): the owner's projects reference `~/Downloads`, which macOS blocks
  for a new bundle id until access is granted, so a copy of them could not
  open in the test bundle (its probes wait on that permission; not an app
  bug).
- Two defects seen only live and fixed: the empty line wrapped one word per
  row (a `@container` on a shrink-wrapped box), and the active Inspector tab
  had no `bg-secondary` chip (the line variant's group selector won, a P4
  leftover). A screenshot of an occluded window freezes CSS transitions, so
  the shots were taken with the bundle briefly frontmost
  (`debug_activate_app`, then restored).
- Known look difference, not fixed: at the default 320 px Inspector the
  inline sliders are short (about 40 px), because the row keeps P4's 80 px
  keyframe slot (the spec's is 36) beside the 56 px field. Widening the
  Inspector widens them; a narrower slot belongs to B-366's pass.

## 7. Human + AI parity

Every new GUI capability gets its MCP surface in the same phase (standing rule):

- Per-track height → `editor_set_track_height(track, height)`. The GUI zone and the `DotsThree` menu use the same store action.
- Clip Appearance (clip height, band ratio, names/badges) → `editor_set_timeline_view({clip_height, band_ratio, show_names, show_badges})`, reported in `editor_get_state`. **Landed first (2026-10-31, D-434 H2): the tool exists with one field, `zoom` (a multiplier of the default, or `"default"`), backed by `useTimelineViewStore` (`packages/editor/src/timelineView.ts`) and reported as `editor_get_state.timelineView`; the redesign adds its fields to this tool and store rather than a second one.** It is a view setting, stored with the UI prefs, not in the timeline document, as FCP does.
- The marker popover maps onto the existing `editor_add_marker` / `editor_set_marker` / `editor_remove_marker`; nothing new.
- The tool segmented control, snapping and linked selection map onto existing or new `editor_set_tool` (landed 2026-11-01, D-434 harness H12: reads or sets the palette tool through `useTimelineViewStore`) / `editor_set_snapping` / `editor_set_linked_selection` where they don't exist yet. Phase 2 audits this.
- The debug tools (`debug_screenshot`, `debug_dom_tree`) need no change. Phase 2 adds stable `data-chroma-*` hooks to the new strip, bracket and band elements so the harness can assert geometry.

## 8. Phased plan

Each phase builds on its own, ships on its own, and lands with its docs.

**P1 — Tokens and type.**
- Move the theme values into `@apelles/tokens`; `themes.ts` imports them.
- New dark values and the new names, with light and grey values for the new names.
- `@theme` aliases, the type scale, radii, shadows, and the system font as default.
- No component restyling beyond what the values change on their own.
- *Harness:*
  - Screenshot pass of all three tabs before and after; every diff should be an intended one.
  - A unit test that asserts contrast ≥ 4.5:1 for `text-primary` / `text-secondary` on `surface` and `bg-primary`, and for `clip-label` on every `clip-*-strip`.
  - A grep check that no new `rgba(`/`#hex` literal lands in `packages/*/src` component files.

**P2 — Clip block, handles, selection, playhead.**
- Replace `getActionRender`'s content with the strip / filmstrip / band anatomy.
- The new states, the override CSS for the library (stretch triangles, action background, cursor), the trim bracket, fade tabs, volume line, drag ghost, snap guide.
- *Harness:*
  - **Drag:** frame time p95 ≤ 8 ms (hard ceiling 16 ms) dragging one clip across a 300-clip, 8-track timeline.
  - **Zero `Layout` events** in a Performance trace during `pointermove` of a clip drag; only the drop may lay out.
  - Click→selected paint ≤ 50 ms (INP).
  - Trim hit-test succeeds anywhere 0–8 px inside an edge, and on both sides of an abutting cut.
  - Pixel assertions on a selected clip: a 2 px `#F5C542` inset outline, corner radius 2, no pixels painted outside the clip box.
  - **Edit tools (§5.1):**
    - For each of ripple, roll, slip and slide: the pane renders exactly 2 times per gesture.
    - Downstream clips move in the same frame as the edge for ripple (screen x of a downstream clip − edge delta = constant across the drag).
    - The limit bracket goes red at the clamp frame.
    - The settle animation lasts ≤ 120 ms with only `transform` changing.
    - Two-up frames are requested at most once per frame.

**P3 — Track headers, ruler, markers, per-track height.**
- Header redesign + resize, per-track heights + MCP, the adaptive ruler format, the Phosphor flag, open-on-create, the popover layout.
- *Harness:*
  - Vertical and horizontal scroll at 60 fps (p95 frame ≤ 16 ms) with 12 tracks × 300 clips.
  - A track-height drag commits one store op.
  - The marker popover is open and focused within one frame of `M` / the toolbar button.
  - `editor_set_track_height` round-trip.

**P4 — Inspector.**
- `NumberScrubber` and `InspectorRow` in `@apelles/ui`; sections, tabs and header restyled; every editor Inspector panel migrated.
- *Harness:*
  - Scrub-to-preview latency ≤ 1 frame at 60 Hz.
  - One undo step per scrub gesture.
  - Inspector swap on selection change ≤ 50 ms.
  - Keyboard: Enter, Esc, arrows.
  - No layout shift on row hover (the CLS of the Inspector during a hover sweep = 0).

**P5 — Chrome and layout.**
- *Done early (B-341, D-435, 2026-10-31):* the Agent activity dock became a top-bar button + popover with an unread badge, so it no longer covers the timeline.
- The FCP arrangement (full-width timeline), browser tabs replacing the rail, the viewer header, the transport, the window-chrome segmented tabs, the empty states.
- *Harness:* panel resize at 60 fps; layout sizes persist across relaunch; no panel narrower than its min at 1280×800.

P2 and P3 touch `TimelinePane.tsx` (4.9k lines). Doing them in order, not in parallel, avoids
merge pain. If the harness shows `@xzdarcy/react-timeline-editor` can't meet P2's
zero-layout-during-drag target (its interact.js drag writes `left`/`width` on every move),
replacing it is a separate D-NNN, not part of this redesign.

## 9. Open questions for the owner

**Answered 2026-10-31: see D-432** (terracotta accent, full-width timeline, separate A/V tracks, skimming on S with snapping on N; the rest take the defaults below).

1. **Accent colour.** macOS system blue (`#0A84FF`, FCP's own active-control colour) for controls, with amber kept for timeline selection and the playhead. Or should Apelles have a brand accent of its own?
2. **Layout.** Should the timeline go full width under all three upper panels (FCP), or stay under the viewer only (today)?
3. **Linked A/V display.** Keep the picture and its linked audio on separate V and A lanes, with the audio band in the video clip only as a reference (Resolve/Premiere)? Or offer an FCP-style collapsed view where the linked audio lives inside the video block and the A-lane clip is hidden?
4. **Light theme.** Redesign it in a follow-up, or keep dark-only for v0.4?
5. **Skimming.** FCP's skimmer previews the frame under the pointer without moving the playhead. Adopt it (off by default, ⇧S to toggle)?
6. **Viewer scrub bar.** Remove the big progress slider under the picture entirely, or keep a thin 3 px one?
7. **Number fields.** Do they need arithmetic (`+10`, `*2`), as Resolve and Premiere allow?
8. **Palmier's floating panels vs. FCP's flat panels.** The spec picks flat, per "calm, Mac-native". Confirm.


## Mockup vs app comparison (2026-11-01, after P1–P5 and D-437 S8)

Screenshots: `scratch/ui-compare/app-now.png` (the live dev app, "Nemotron Transcribe" › Voiceover v2) and `scratch/ui-compare/mockup-rest.png` (the mockup's "Rest" state). Static comparison of the rest state only; the mid-roll and marker-editor states were not re-checked live.

**Matches the mock:**
- top bar: breadcrumb, centred Edit/Motion/Colorist, Export on the right;
- the browser with its tab row, search and folder tree;
- the viewer header: format · fps, timeline name centred, `− Fit +`, the toggles;
- the transport: amber timecode, centred buttons, thin scrub line;
- the full-width timeline;
- the toolbar's centred timeline name and timecode;
- our ruler and the marker strip;
- the V/A badge track headers with no per-row trash;
- the FCP clip anatomy: name strip, filmstrip, waveform band;
- the collapsed Inspector sections.

**Intended differences:**
- terracotta accent instead of the mock's blue (owner, D-432);
- Inspector sections collapsed by default (owner, 2026-11-01).

**Gaps, open as B-359 — all closed 2026-11-03 (§6e has what was built and each deviation; the after screenshots are in `scratch/ui-compare/after-v030/`):**
1. The Inspector header lacks the clip duration timecode on the right, and has 2 icon tabs (Video / Audio) where the mock has 4 (Video / Audio / Speed / Info). P4 deviation. **Closed:** duration on the right, four tabs (Speed = the retime, Info = read-only facts).
2. Inspector rows: the mock pairs Position X / Y on one row and gives Scale / Rotation / Opacity inline sliders next to the value; the app uses one field per row and has no sliders. P4 deviation. **Closed:** a paired Position row, `SliderField` on Scale / Rotation / Opacity.
3. Browser: the app has an extra "SOURCES · Select · + Import" header row. The mock puts `+ Import` on the tab row and shows "All media · N items" as a single row, so the app has less room for thumbnails. **Closed:** Import on the tab row, "N items" and Select on the All media row.
4. Timeline toolbar: the mock's grouping is tools | markers | snapping/link/waveform | a zoom slider. The app has more loose icons, the "128 BPM" text and `− 20% +` instead of a slider. This is B-354's regroup. **Closed:** the three-column regroup, a zoom slider, the BPM inside a Beat grid popover.
5. Track headers: the mock highlights the target track's badge (accent V1) and shows the track's own name. The app's tracks are still "Video 1 / Audio 1" (the project's data), and there is no target-track concept yet. P3 deviation. **Closed:** the target track (D-440), the accent pill; names were already the user's own when set.
6. **The playhead is off screen after a seek through MCP:** `editor_set_playhead` to 0:06 left the timeline scrolled at 3:55–5:05 with zoom at 20 %. The view doesn't follow a programmatic seek, and the zoom a harness run left behind persists in the session's view store. To check: does the view follow a seek (the B-326 follow covers playback), and should the zoom be per timeline? **Fixed 2026-11-03 (B-359 item 6):** a paused jump outside the view centres it; zoom and scroll are per timeline.
7. Faint vertical lines run through the lanes at marker positions in the app; the mock has none. Decide whether markers should draw through the lanes; FCP draws them in the ruler only. **Closed:** they were the beat grid's downbeat lines, now in the ruler and marker band only.
8. Empty states and the volume popover are still missing (B-354). **Closed:** §4.13 empty states, the volume popover, Cmd+4.

# colorist-strip — analysis: the RapidRAW DAM shell inside the Colorist tab

**D-043.** The owner: *"it creates a separate app inside our app."* This note traces
every path by which RapidRAW's photo **DAM + welcome/library shell** still reaches the
user through the Colorist tab (`app/` = the vendored RapidRAW fork, mounted as
`{ id: 'colorist', element: <App/> }` in `app/src/main.tsx`), and ends with the concrete
removal plan.

Scope of "the shell / DAM layer": the welcome screen, the folder-tree "Sources" panel,
the "Library" photo grid, albums, culling, the web "Community" presets page, the "Home"
button, and RapidRAW branding. **Not** in scope (kept): the grading engine — the
canvas/wgpu preview, every `panel/right/*` adjustment panel, scopes, curves, wheels, LUT,
crop/transform, masks, AI masking, local grade presets, and every `components/chroma/*`
addition (D-032/34/36/37/38/41, the ShotStrip, the MCP bridge).

---

## 1. `activeView` — the router

`useUIStore.activeView: string` (default `'editor'`, `useUIStore.ts:273`). Only three
values are ever assigned anywhere in `app/src`: `'editor'`, `'library'`, `'community'`.
(`'projects'` is dead — D-037 briefly used it, D-039 moved the launcher to shell level.)

### Where it is *set*

| file:line | setter | to | keep? |
|---|---|---|---|
| `useUIStore.ts:273` | store default | `'editor'` | keep (becomes the only value) |
| `App.tsx:756` | `PresetsPanel onNavigateToCommunity` | `'community'` | **remove** |
| `useAppNavigation.ts:85` | `handleBackToLibrary` | `'library'` | **remove** (whole fn) |
| `useAppNavigation.ts:95` | `handleImageSelect` (`openInEditor`) | `'editor'` | keep (no-op after collapse) |
| `useAppNavigation.ts:276` | `handleSelectSubfolder` | `'library'` | **remove** (whole fn) |
| `useAppNavigation.ts:425` | `handleSelectAlbum` | `'library'` | **remove** (whole fn) |
| `useChromaControl.ts:374,389` | MCP `open` / `seek` ops | `'editor'` | keep (no-op after collapse) |
| `ProjectLauncher.tsx:81,222` | after open/new project | `'editor'` | keep (no-op after collapse) |
| `LibraryView.tsx:127,169` | Community back / nav | `'library'`/`'community'` | file deleted |

### Where it is *read*

- **`App.tsx`** — the only place it actually *routes*:
  - `:784` `hasMainContent = hasRoots || (activeView === 'editor' && !!selectedImage)`
    — gates the side panels + bottom bar. `hasRoots` is `useLibraryStore.rootPaths.length>0`
    (folder-tree state) → always `false` once the folder tree is gone.
  - `:788` `isWgpuActive` — `activeView === 'editor' && …` — the transparent-canvas flag.
  - `:915` editor pane visible: `activeView === 'editor' && selectedImage`.
  - `:949` the **other** pane (the `<LibraryView>` mount) visible: the negation of `:915`.
- **`useKeyboardShortcuts.ts`** — ~22 `shouldFire` guards. Split:
  - `activeView === 'editor' && selectedImage` (lines 153/163/173/185/197/228/240/252/259/280/288/304/437/534/548) — grading shortcuts, guard becomes redundant-true.
  - `activeView === 'library'` (92/138/410/430/609) and `!== 'library'` (401) and the
    Escape ladder (575–576) and select-all (137–140) — **library-only branches, delete**.
- **`useImageProcessing.ts:379,385,420`** — `activeView === 'editor'` guards on the
  crop-overlay / preview-request effects. Become redundant-true. Keep the effects.
- **`useLibraryActions.ts:149`**, **`useAppContextMenus.ts:361,483`**,
  **`useFileOperations.ts:36,73`** — `activeView === 'editor'` used to decide
  "operate on the selected image vs. the library multi-selection". Become redundant-true;
  the `libraryActivePath` fallback branch is dead.

**Collapse:** `activeView` has exactly one meaningful value after removal → **delete the
field**. Every `=== 'editor'` read becomes `true` (inline it away); every `=== 'library'`
/ `=== 'community'` read is a dead branch to delete.

---

## 2. Entry points into `LibraryView` / `MainLibrary` / `CommunityPage`

`LibraryView` (`components/views/LibraryView.tsx`, ~180 LOC) is the container. It renders
`CommunityPage` when `activeView === 'community'`, else `MainLibrary`
(`components/panel/MainLibrary.tsx`, ~640 LOC — the welcome splash + the photo grid host),
plus its own `<BottomBar isLibraryView />`. `MainLibrary` pulls in `panel/library/*`:
`LibraryGrid`, `LibraryHeader` (`SearchInput` + `ViewOptionsDropdown`), `LibraryItems`
(`Row`, `Thumbnail`), `CullingView` (~1150 LOC).

### The mount

`App.tsx:946-984` — `<LibraryView>` is rendered in the pane shown whenever
**not** (`activeView === 'editor' && selectedImage`). So it is the default screen with no
shot open, and the destination of every "back" below. 21 props are threaded App → LibraryView.

### The routes that reach it

1. **No shot open.** `_hydrateOpenDto` (`useSessionStore.ts`) with every shot offline / an
   empty project → `setEditor({ selectedImage: null })` → App shows the LibraryView pane.
   *This is the empty state that must become a Chroma message.*
2. **The "Home" button** — `handleGoHome` (`useAppNavigation.ts:44`): wipes
   `useLibraryStore` (`rootPaths`, `folderTrees`, `imageList`, …). Bound at
   `useKeyboardShortcuts.ts:576` (Escape ladder, library only) and passed as
   `onGoHome` → `LibraryView` → `MainLibrary` (`MainLibrary.tsx`, the splash-screen "Home").
3. **The editor "back"** — `handleBackToLibrary` (`useAppNavigation.ts:59`):
   `setUI({ activeView: 'library' })`. Wired to:
   - Escape — `useKeyboardShortcuts.ts:575` (`activeView === 'editor'` branch).
   - `EditorView` prop `handleBackToLibrary` → `<Editor onBackToLibrary>` (`EditorView.tsx:103`).
   - `useFileOperations(… handleBackToLibrary …)` — after a delete that removes the open image.
   - `useAppContextMenus({ handleBackToLibrary })`.
4. **"Continue Session"** — `handleContinueSession` (`useAppNavigation.ts:505`): restores
   the last folder / album from `appSettings.lastFolderState`. Passed
   `LibraryView` → `MainLibrary` as `onContinueSession` (the welcome-screen button).
5. **"Add Folder" / folder picker** — `handleOpenFolder` (`useAppNavigation.ts:457`):
   `open({ directory: true })` → pushes a root → `handleSelectSubfolder` →
   `activeView: 'library'`. Passed `LibraryView`/`MainLibrary` as `onOpenFolder`, and used
   by `FolderTree` (the left "Sources" panel — `App.tsx:726` `onOpenFolder`).
6. **Folder-tree / album navigation** — `handleSelectSubfolder` / `handleSelectAlbum`
   (`useAppNavigation.ts:254/415`), both `→ activeView: 'library'`. Callers:
   `FolderTree` panel (`App.tsx:724-726`), `handleLibraryRefresh` (`App.tsx:383`),
   `useTauriListeners` (fs-watch refresh), `useAppInitialization` preload.
7. **PresetsPanel → Community** — `App.tsx:756`
   `<PresetsPanel onNavigateToCommunity={() => setUI({ activeView: 'community' })} />`.
   Two triggers inside `PresetsPanel.tsx`: the `Users` icon button (`:1221`) and the
   empty-state "Get community presets" button (`:1278`).
8. **Context menus** — `useAppContextMenus.ts`:
   - `handleMainLibraryContextMenu` (`:1273`) — the empty-area menu; passed to
     `LibraryView`/`MainLibrary` **and** to `EditorView`→`BottomBar`
     (`onEmptyAreaContextMenu`, the filmstrip empty area).
   - `buildAddToAlbumMenu` (`:124`) + the per-image "Add to Album" / "Remove from Album"
     submenu — album CRUD via `Invokes.AddToAlbum` / `GetAlbums` / `SaveAlbums`.
9. **Keyboard** — grid navigation + select-all-in-library
   (`useKeyboardShortcuts.ts:92,137-140,410,430,609`).

### Media selection does **not** need any of this

Opening a project already installs the frame directly:
`useSessionStore._hydrateOpenDto` → `chroma_session_set_active` → `applyLoaded()`
(`useSessionStore.ts:225`) sets `useEditorStore.selectedImage` + video info + agent scope.
`ShotStrip.switchToShot` and the MCP `open` op go through the same `applyLoaded`.
`LibraryView` / `handleImageSelect` is the *photo-catalogue* selection path and is
irrelevant to the colourist flow. **Confirmed: the editor renders with no `LibraryView`.**

---

## 3. Branding strings & links

### User-visible (reachable today)

| file:line | string / link | surface |
|---|---|---|
| `MainLibrary.tsx:437` | `t('library.splash.imagesBy')` + "Timon Käch" → instagram.com/timonkaech.photography | welcome splash footer |
| `MainLibrary.tsx:448-476` | `t('library.splash.version', {version})` / `downloadVersion` / `newVersionAvailable` / `latestVersion` | welcome splash — "Version 1.6.2" |
| `MainLibrary.tsx:459` | `open('https://github.com/CyberTimon/RapidRAW/releases/latest')` | version click-to-download |
| `MainLibrary.tsx:483-495` | `href="https://ko-fi.com/cybertimon"` (`donate`) + `href="https://github.com/CyberTimon/RapidRAW"` (`contribute`) | welcome splash — "Donate on Ko-Fi · or · Contribute on GitHub" |
| `MainLibrary.tsx:300` | `fetch('https://api.github.com/repos/CyberTimon/RapidRAW/releases/latest')` | update check (network call in the DAM) |
| `CommunityPage.tsx:16` | `DEFAULT_PREVIEW_IMAGE_URL = 'https://raw.githubusercontent.com/CyberTimon/RapidRAW-Presets/main/sample-image.jpg'` | community preview fallback |
| `CommunityPage.tsx:344` | `href` → `github.com/CyberTimon/RapidRAW-Presets/issues/new?...preset_submission` | "Submit your preset" |
| `i18n/locales/en.json` `library.splash.*` | `brand: "RapidRAW"`, `welcomeBack: "Welcome back!"`, `continueSession`, `contribute`, `donate`, `openLibrary`, `descriptionDesktop` ("…RAW image editor…") | welcome splash copy (+ 13 other locale files mirror the block) |
| `i18n/locales/en.json` `settings.thanks.*` | credits — "…important in the development of RapidRAW", `you` etc. | Settings → About/Thanks (still routed) |
| `i18n/locales/*.json` `settings.nativeTitlebarDesc` | "…instead of RapidRAW's custom one" | Settings copy |
| `i18n/locales/*.json` `settings.processing.ai.*` | AI connector blurbs name "RapidRAW" repeatedly | Settings → Processing → AI |
| `i18n/locales/*.json` `*.rapidRawPreset` | "RapidRAW Preset" | preset-format label |
| `tauri.conf.json:15` | `"title": "RapidRAW"` | OS window title (shell chrome shows its own bar, but the window title is still this) |

### Not user-visible now, strip anyway

| file:line | string | note |
|---|---|---|
| `window/TitleBar.tsx:118` | `<p>…>RapidRAW</p>` | component **unrouted** since D-039 (shell owns chrome). Kept "for reference" — strip the literal. |
| `SettingsPanel.tsx:364` | `open('https://www.getrapidraw.com/dashboard')` | inside `CloudDashboard` — left as dead code by D-029 (`isPro` never true). Strip the link. |
| `SettingsPanel.tsx:400` | `open('https://www.getrapidraw.com/cloud')` "Upgrade" | same `CloudDashboard` dead block. |
| `tauri.conf.json:3` | `identifier: "io.github.CyberTimon.RapidRAW"` | **do NOT change** — bundle identifier is a Phase-4 packaging call. |
| `tauri.conf.json:96` | `version: "1.6.2"` | leave — versioning is a packaging call. |
| `Cargo.toml` package `RapidRAW` | crate name (see `cargo clean -p RapidRAW` in doc 09) | leave — packaging. |
| comments referencing "RapidRAW" in `utils/*`, `hooks/useChromaControl.ts`, `hooks/useAiMasking.ts`, `AIPanel.tsx`, `SettingsPanel.tsx:2305`, `chroma/*.tsx` headers | explanatory | **keep** — accurate provenance notes, not branding. |

---

## 4. Rust commands only the DAM uses

Verified against every frontend `invoke` string (`Invokes` enum in
`components/ui/AppProperties.tsx` + raw string literals).

### Tier 1 — remove with this commit (nothing Chroma keeps references them)

| command | impl | consumer (all deleted) |
|---|---|---|
| `fetch_community_presets` | `lib.rs:1175` | `CommunityPage` |
| `generate_all_community_previews` | `lib.rs:1199` | `CommunityPage` |
| `file_management::save_community_preset` | `file_management.rs:3222` | `PresetsPanel` "publish to community" ctx-menu item |
| `culling::cull_images` + **entire `mod culling`** | `culling.rs` (318 LOC) | `CullingView` / `CullingModal` |
| `file_management::get_albums` | `file_management.rs:871` | album nav / ctx-menu |
| `file_management::save_albums` | `file_management.rs:883` | album ctx-menu |
| `file_management::add_to_album` | `file_management.rs:891` | drag-to-album / ctx-menu |
| `file_management::get_album_images` | `file_management.rs:1022` | `handleSelectAlbum` |

Supporting Rust that becomes unused with the above: `file_management::get_albums_path`
(private helper), the `AlbumItem` / `Album` / `AlbumGroup` types + their frontend mirrors
in `AppProperties.tsx`, `CullingSettings` / `ImageAnalysisResult` / `CullGroup` /
`CullingSuggestions`. `mod culling;` line in `lib.rs`, `use crate::culling` sites.

`generate_handler!` lines to drop (`lib.rs:2299-2449`): `fetch_community_presets`,
`generate_all_community_previews`, `culling::cull_images`,
`file_management::{save_community_preset, get_albums, save_albums, add_to_album,
get_album_images}`.

### Tier 2 — the "Sources" folder tree + photo grid (bigger; see plan §6)

These are only reachable through `FolderTree` (the left panel) + `LibraryView`. If the
`FolderTree` panel and the folder-grid nav go in this pass, remove; otherwise they stay
live and this is a documented follow-up:

`file_management::{list_images_in_dir, list_images_recursive, get_folder_tree,
get_folder_children, get_pinned_folder_trees, get_folder_tree_sync (helper),
create_folder, delete_folder, rename_folder, move_files, copy_files, rename_files,
duplicate_file, import_files, create_virtual_copy, get_or_create_internal_library_root,
show_in_finder, delete_files_from_disk, delete_files_with_associated}`,
`tagging::{start_background_indexing, add_tag_for_paths, remove_tag_for_paths,
clear_ai_tags, clear_all_tags}` (grid tag/rating — `set_rating_for_paths` /
`set_color_label_for_paths` are also used by the editor `BottomBar` star rating, keep those).

### Keep (editor / Chroma uses them)

`load_metadata`, `load_presets`, `save_presets` (local grade presets — D-025-adjacent),
`load_and_parse_lut` + all `lut_processing::*`, `read_exif_for_paths`,
`get_supported_file_types`, `save_metadata_and_update_thumbnail`,
`apply_adjustments_to_paths` / `reset_adjustments_for_paths` (preset apply),
`load_image` / `is_image_cached`, `update_exif_fields`, `set_rating_for_paths` /
`set_color_label_for_paths`, all `chroma::*`, all `ai_commands::*`, `export_processing::*`,
`camera_tethering::*`, `denoising::*`, `focus_stacking::*`, `panorama_stitching::*`,
`negative_conversion::*`, `lens_correction::*`, `inpainting::*`, `mask_generation::*`.

---

## 5. What must be KEPT (grading engine + Chroma additions)

- **`components/views/EditorView.tsx`** and everything under it: `panel/Editor.tsx`, the
  canvas + wgpu render path (`gpu_processing.rs`, `render_core.rs`, `WgpuDisplay`),
  `panel/editor/*` (toolbar, `ChromaTimeline`).
- **`panel/right/*`** — every adjustment panel: `ControlsPanel`, `MetadataPanel`,
  `CropPanel`, `MasksPanel`, `AIPanel`, `PresetsPanel` (**local** presets — keep
  `load_presets`/`save_presets`, the folder tree, import/export; drop only
  `onNavigateToCommunity`), `TetheringPanel`, `ExportPanel`, `FolderTree` *(see §6)*.
- Scopes (`utils/scopes.ts`, the Rust waveform path), `ColorWheel`, `LUTControl`,
  `DepthRangePicker`, curves, wheels, crop/transform.
- **Settings** (`SettingsPanel.tsx`) minus the DAM rows (library/album/culling/community
  prefs) and the branding links.
- **`components/chroma/*`** — `ProjectLauncher`, `ShotStrip`, `AgentActivityDock`,
  `AgentChat`, etc. `store/useSessionStore.ts`, `useChromaStore`, `useAgentStore`.
  The MCP bridge (`hooks/useChromaControl.ts`, `chroma/control.rs`). D-032/34/36/37/38/41.
- **`useEditorStore`** (the canonical grade doc, D-020), **`useProcessStore`**,
  **`useSettingsStore`**.
- `store/useLibraryStore.ts` — **cannot be deleted**: 27 files import it, including keepers
  (`Editor.tsx`, `BottomBar.tsx`, `Filmstrip.tsx`, `MetadataPanel.tsx`,
  `useImageProcessing.ts`, `useImageLoader.ts`, `useEditorActions.ts`). The editor reads
  `multiSelectedPaths`, `imageRatings`, `imageList`, `isViewLoading`, `libraryActivePath`
  from it. **Prune** the album / culling / folder-tree fields + actions; keep the rest.

---

## 6. Removal plan

### Frontend — delete

- `components/views/LibraryView.tsx`
- `components/panel/MainLibrary.tsx` — move `export interface ColumnWidths` (used by
  `useLibraryStore.ts:11` + `library/LibraryItems.tsx`) → inline into `useLibraryStore.ts`
  (its only surviving consumer) or drop the `listColumnWidths` field if nothing reads it
  after `LibraryItems` dies (it doesn't — it's grid-only).
- `components/panel/library/` — whole dir (`CullingView.tsx`, `LibraryGrid.tsx`,
  `LibraryHeader.tsx`, `LibraryItems.tsx`).
- `components/panel/CommunityPage.tsx`

Grep confirms no importer outside this set (`App.tsx` for `LibraryView`;
`useLibraryStore` for the `ColumnWidths` *type* only).

### Frontend — gut / rewire

- **`App.tsx`**: drop the `LibraryView` import + its 21-prop mount; the non-editor pane
  becomes `<ColoristEmptyState />` (new, in `components/chroma/`). Remove
  `activeView`-derived routing — the editor pane is unconditional on `selectedImage`.
  Remove `handleGoHome` / `handleBackToLibrary` / `handleContinueSession` from the
  `useAppNavigation` destructure and every downstream `useFileOperations` /
  `useAppContextMenus` / `useKeyboardShortcuts` / `EditorView` prop. `PresetsPanel` loses
  `onNavigateToCommunity`. `isSettingsOpen && … && hasRoots` → drop the `hasRoots` gate
  (it's folder-tree state). `hasMainContent` → `!!selectedImage`.
- **`useUIStore.ts`**: delete `activeView`. Delete the album-modal + culling-modal state
  (`isCreateAlbumModalOpen`, `isRenameAlbumModalOpen`, `albumActionTarget`,
  `cullingModalState`, `CullingModalState`, `CullingSuggestions` import) and the
  `Panel.FolderTree` entries *if* FolderTree is removed (see below).
- **`useAppNavigation.ts`**: delete `handleGoHome`, `handleBackToLibrary`,
  `handleContinueSession`, `handleSelectAlbum`, `handleSelectSubfolder`,
  `handleOpenFolder` (all library nav). Keep `handleImageSelect` (drop its
  `setUI({activeView})` line). If nothing else remains, fold the survivor into its caller.
- **`useKeyboardShortcuts.ts`**: delete the `activeView === 'library'` branches
  (grid nav, select-all-in-library, exif toggle, the Escape `handleGoHome` rung),
  simplify `activeView === 'editor'` guards to `!!selectedImage`.
- **`useAppContextMenus.ts`**: delete `buildAddToAlbumMenu`, the Add/Remove-from-Album
  submenu, `handleMainLibraryContextMenu` (or reduce it to the filmstrip's minimal menu),
  `handleFolderTreeContextMenu` / `handleAlbumTreeContextMenu` (if FolderTree goes).
- **`useLibraryActions.ts` / `useFileOperations.ts` / `useProductivityActions.ts` /
  `useSortedLibrary.ts` / `useThumbnails.ts` / `useTauriListeners.ts`**: prune the
  folder-scan / album / rename-folder / import paths; keep what the filmstrip + editor
  rating + preset-apply need.
- **`useLibraryStore.ts`**: drop `folderTrees`, `pinnedFolderTrees`, `albumTree`,
  `activeAlbumId`, `expandedFolders`, `expandedAlbumGroups`, `rootPaths`,
  `currentFolderPath`, `listColumnWidths` + their setters; keep `imageList`,
  `multiSelectedPaths`, `libraryActivePath`, `imageRatings`, `isViewLoading`,
  `sortCriteria`, `filterCriteria`, `selectionAnchorPath`.
- **`BottomBar.tsx`**: drop the `isLibraryView` prop + its branches (only `LibraryView`
  passed `true`).
- **Branding**: `TitleBar.tsx:118` → `Chroma` (or remove the `<p>`); `SettingsPanel`
  `CloudDashboard` → delete the `getrapidraw.com` links; `SettingsPanel` Thanks/About →
  keep the OSS credits, drop the "…of RapidRAW" framing + Ko-Fi; `tauri.conf.json:15`
  `"title": "Chroma"`; `i18n/locales/*.json` — remove the `library.splash.*` block, fix
  `settings.thanks.description` / `nativeTitlebarDesc` / the AI-connector blurbs to say
  "Chroma", rename `*.rapidRawPreset` → "Preset".

### The "Sources" `FolderTree` panel — decision point

`components/panel/right/FolderTree.tsx` (~1126 LOC) is the folder-tree + album-tree left
panel. It is registered in the panel switcher (`Panel.FolderTree`, `useUIStore` default
layout `leftTop`) and is exactly the "Sources" browser the owner flagged. It is **not** in
D-043's explicit delete list, and the roadmap's "Media pool + Sources panel" item plans a
*replacement* global Sources panel. Recommendation: **remove `Panel.FolderTree` from the
switcher + delete `FolderTree.tsx`** in this pass (it has no editor role), which then also
lets Tier-2 Rust (`get_folder_tree*`, `list_images_*`, folder CRUD) go. If that widens the
blast radius too far for one commit, leave `FolderTree` mounted, land Tier 1, and file the
FolderTree + Tier-2 removal as the immediate D-043 follow-up on the roadmap.

### Rust

- Delete `culling.rs`; drop `mod culling;` + `culling::cull_images` from the handler.
- Delete `fetch_community_presets` + `generate_all_community_previews` from `lib.rs`
  (+ `CommunityPreset` struct if unused elsewhere) + their handler lines.
- Delete `file_management::{save_community_preset, get_albums, save_albums, add_to_album,
  get_album_images, get_albums_path}` + the `AlbumItem`/`Album`/`AlbumGroup` types +
  handler lines.
- Tier 2 (with FolderTree): `file_management::{list_images_in_dir, list_images_recursive,
  get_folder_tree, get_folder_children, get_pinned_folder_trees, get_folder_tree_sync,
  create_folder, delete_folder, rename_folder, rename_files, copy_files, move_files,
  duplicate_file, import_files, create_virtual_copy,
  get_or_create_internal_library_root}` + `tagging::{start_background_indexing,
  add_tag_for_paths, remove_tag_for_paths, clear_ai_tags, clear_all_tags}`.
- **Surgical guard:** `file_management.rs` (4222 LOC) also holds path helpers, EXIF I/O,
  metadata sidecar read/write, preset I/O, `load_image`-adjacent fs — **keep all of that**.
  If a kept fn calls a removed one, stop and reassess (you're cutting too deep).
- `docs/09-engine-notes.md` divergence entry (this is the largest single divergence).

### The empty state

`_hydrateOpenDto` already leaves `selectedImage: null` for an empty / all-offline project.
`App.tsx`'s non-editor pane renders `<ColoristEmptyState>` — a centred Chroma message
("Add or select a shot to start grading", pointing at the ShotStrip). No project at all is
the shell launcher's job (`main.tsx`), unchanged.

---

## 7. LOC / surface delta (estimate)

| bucket | delete | gut |
|---|---|---|
| `LibraryView` + `MainLibrary` + `panel/library/*` + `CommunityPage` | ~3800 | — |
| `FolderTree.tsx` (if Tier 2) | ~1126 | — |
| `App.tsx` | — | ~120 lines removed |
| `useAppNavigation` / `useKeyboardShortcuts` / `useAppContextMenus` / library hooks | — | ~800 lines removed |
| `useUIStore` / `useLibraryStore` | — | ~120 lines removed |
| `culling.rs` | 318 | — |
| `lib.rs` community fns + `file_management.rs` album/community fns | ~250 | — |
| Tier 2 Rust (folder tree / grid / tags) | ~600 | — |
| i18n `library.splash` block × 14 locales | ~300 | — |

Net: roughly **−7000 to −9000 LOC**, no new runtime code beyond `ColoristEmptyState`.

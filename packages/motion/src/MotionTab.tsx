/**
 * @chroma/motion — the Motion tab (D-039 roadmap "Motion tab MVP", D-046;
 * layer list D-081; catalog D-151).
 *
 * Wires the already-functional `@chroma/motion-engine` Remotion engine into
 * a real tab: a `@remotion/player` preview (`MotionPreview`) of whatever
 * manifest is loaded, a real scene/layer list (`LayerList`, D-081 — Phase 1
 * of `docs/notes/global-inspector.md`), a real property panel bound to that
 * selection (`InspectorPanel`, D-099 — Phase 2), a browsable primitive
 * Catalog that inserts a new layer into the selected scene (`CatalogPanel`,
 * D-151 — the first way to CREATE anything in this tab without hand-typing
 * JSON; see `docs/notes/motion-tab-audit.md`), and a JSON manifest editor
 * (`ManifestEditor`) that live-updates the preview and can save / render it.
 * Selecting a row in the layer list seeks the player to that scene's start
 * frame AND drives the Inspector's fields — both real, standalone-useful
 * pieces of navigation/editing, not just bookkeeping for something later.
 * The three right-hand panes (Layers/Catalog sidebar / Inspector / manifest
 * editor) are real resizable panels (`resizable.tsx`, D-099) per the
 * standing CLAUDE.md rule that a resizable-by-nature pane must actually be
 * resizable. Layers and Catalog share the sidebar pane as two tabs rather
 * than the Catalog taking a fifth column (D-151 — see the pane's own note).
 * Persistence and rendering are project-scoped
 * (`app/src-tauri/src/chroma/motion.rs`), so — same contract `@chroma/
 * editor`'s `EditorTab` already uses — a project must be open.
 *
 * `onRendered` (D-062, optional) fires with the rendered file's path after
 * a successful render — this package can't import it into the Sources pool
 * itself (`@chroma/bridge` is app/domain-layer, D-039 layer direction), so
 * the app-level composition (`app/src/main.tsx`) supplies this to do that.
 *
 * D-155/D-156 (Phase 0/1 of `docs/notes/motion-visual-builder-research.md`):
 * `transientManifest` is the ONE piece of new state here — a Phase 1 canvas
 * drag's in-flight preview override (0b), fed straight to `MotionPreview`
 * alongside the STABLE `m.manifest` (see that component's own doc comment
 * for why both are needed). Every whole-manifest write that should be
 * undoable — an Inspector field edit, and a drag's pointer-up commit — now
 * goes through `m.commit` (0c) instead of `m.setText(JSON.stringify(...))`
 * directly; `onCatalogAdd` deliberately still uses the plain `setText` path
 * (see its own comment below) — Phase 0c's own scope is "the Inspector's
 * existing edits as the first customer," not every mutation site in this
 * tab, and catalog inserts are a different, already-shipped (D-151)
 * customer this pass doesn't touch.
 *
 * D-162 (Phase 5b part 2 of `docs/notes/motion-keyframe-timeline-research.md`,
 * "per-row lanes"): the left `ResizablePanel` (the preview column) now
 * nests its OWN vertical `PanelGroup` — `<MotionPreview>` on top,
 * `<KeyframeTimeline>` below, a real `ResizableHandle` between them —
 * mirroring `@chroma/editor`'s own `EditorTab.tsx` (`PreviewPane` stacked
 * over `TimelinePane`, full-width of their shared column, not nested inside
 * the preview). See `KeyframeTimeline.tsx`'s own module doc comment for the
 * full layout decision and why D-160's `KeyframeStrip` (squeezed inside
 * `MotionPreview.tsx`) didn't survive becoming a per-row lane timeline.
 * `KeyframeTimeline` reuses this tab's own `onSelect` (row/marker clicks
 * select exactly like a `LayerList` row click) and the same
 * `onTransientChange`/`onCommit` pair `MotionCanvasOverlay` already uses.
 *
 * D-158 (Phase 3): `selection` (singular) becomes `selections: Selection[]`
 * — the owner said "multiple elements" first, so `LayerList.tsx`'s own
 * multi-select constraint (2+ entries ⇒ same-kind `layer`, same scene) now
 * flows through this tab too. Two callbacks replace the old single
 * `onSelect`: `onSelect` (replace-with-one + seek the player, unchanged
 * behaviour for `LayerList` row clicks and a plain canvas click) and
 * `onSelectionChange` (D-158, new — set the WHOLE array, no seek, for
 * shift-toggle/marquee/clear-on-empty-click, all of which only ever touch
 * the scene already on screen). A new effect keeps `selections` pointing at
 * the right layers as `m.manifest` changes underneath it (a commit, a
 * catalog insert, a hand-edit in the raw-JSON textarea) via
 * `manifestEdit.ts`'s `resolveSelections` — this is what makes the "stable
 * layer identity" prerequisite (§1g of the research doc) actually pay off
 * for a LIVE multi-selection, not just a theoretical one.
 */
import { useEffect, useRef, useState } from 'react';
import type { PlayerRef } from '@remotion/player';
import { sceneStartFrame } from '@chroma/motion-engine/src/engine/build';
import type { Manifest } from '@chroma/motion-engine/src/engine/schema';

import { Button } from './Button';
import { MotionPreview, type MotionCanvasMeasureApi } from './MotionPreview';
import { KeyframeTimeline } from './KeyframeTimeline';
import { LayerList, sameSelectionArray, type Selection } from './LayerList';
import { InspectorPanel } from './InspectorPanel';
import { CatalogPanel } from './CatalogPanel';
import { ManifestEditor } from './ManifestEditor';
import { addLayer, snapEmphasisToRect, resolveSelections, sceneIndexAtFrame, layerVisibleFrameRange } from './manifestEdit';
import type { PrimitiveUse } from './catalog';
import { useMotionManifest, type SceneRenderResult } from './useMotionManifest';
import { useMotionControl } from './useMotionControl';
import type { MotionEditLinks } from './motionOps';
import { PanelGroup, ResizablePanel, ResizableHandle } from './resizable';

/** the two views the left sidebar pane switches between (D-151) */
type SidebarTab = 'layers' | 'catalog';

/** A short, human label for an undo entry (D-155, extended D-158 for a
 *  multi-selection) — which selection kind an Inspector edit landed on.
 *  Not per-field (the Inspector's `onCommit` doesn't thread a field name up
 *  to here) — a deliberate, documented scope call: good enough for "Undo
 *  <label>," not worth plumbing a field name through `InspectorPanel`'s
 *  whole `FieldGroup`/`CameraKeyList`/`MultiLayerInspector` call chain for
 *  this pass. */
function labelForSelections(selections: Selection[]): string {
  if (selections.length === 0) return 'Edit';
  if (selections.length > 1) return `Edit ${selections.length} layers`;
  switch (selections[0].target.kind) {
    case 'scene':
      return 'Edit scene';
    case 'camera':
      return 'Edit camera';
    case 'scene3d-camera':
      return 'Edit 3D camera';
    case 'layer':
      return 'Edit layer';
    case 'scene3d-child':
      return 'Edit 3D layer';
    case 'layer-item':
      return 'Move card';
  }
}

export function MotionTab({
  onRendered,
  editLinks,
}: {
  /** D-062/D-259 — fires once per scene as its render finishes, with the
   *  scene's id and the file it landed at. The app layer imports/reconciles
   *  that file into Sources and refreshes any Edit clips already reading it;
   *  this package cannot do either (`@chroma/bridge`/`@chroma/editor` are the
   *  wrong side of D-039's layer direction for a tab). The `sceneId` is
   *  D-259's addition — the app layer needs it to stamp provenance, and the
   *  path alone could only be reverse-engineered back to a scene by
   *  duplicating the backend's own output-path math. */
  onRendered?: (r: SceneRenderResult) => void;
  /** D-259 — where each scene's render has ended up in the Edit tab, supplied
   *  by the app layer for the same layering reason. Drives BOTH the per-scene
   *  badge in the layer list and the `motion_get_edit_links` MCP tool, so the
   *  human and the agent can never be told different things. */
  editLinks?: MotionEditLinks;
}) {
  const m = useMotionManifest(onRendered);
  const playerRef = useRef<PlayerRef>(null);
  // D-157 — the preview's imperative measurement escape hatch (see
  // `MotionPreview.tsx`'s own doc comment), used ONLY by `onSnapToLayer`
  // below: the Inspector has no DOM access of its own to the live player.
  const measureApiRef = useRef<MotionCanvasMeasureApi | null>(null);
  // D-158: the whole live selection (was `Selection | null`) — see this
  // file's own module doc comment for the two-callback shape and the
  // resolve-on-manifest-change effect below.
  const [selections, setSelections] = useState<Selection[]>([]);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('layers');
  // D-156, Phase 0b — a Phase 1 drag's in-flight preview override; `null`
  // outside a drag. See `MotionPreview.tsx`'s own doc comment for why this
  // is kept separate from `m.manifest` rather than written into it directly.
  const [transientManifest, setTransientManifest] = useState<Manifest | null>(null);
  // D-181 (Phase 2 of 3) — solo-scene preview. `true` forces the pre-D-181
  // whole-video view regardless of the live selection; the default `false`
  // means "derive the soloed scene from the current selection" (below),
  // matching the owner's own framing ("select 'stack' → its own timeline").
  // `onSelect` (an explicit pick, never `onSelectionChange`'s marquee/
  // shift-toggle/clear — see that callback's own comment for why) flips
  // this back to `false`, so choosing something always re-engages solo mode
  // even after stepping back to the combined view.
  const [wholeVideo, setWholeVideo] = useState(false);
  // D-172 — the raw JSON panel is collapsed by default (D-153's own ask,
  // finally built to the shape its research doc originally scoped instead
  // of the smaller one D-153 shipped): gates the WHOLE ManifestEditor
  // ResizablePanel + its preceding ResizableHandle below, reclaiming its
  // width when hidden rather than just hiding the textarea inside a
  // panel that's still there. Save/Render/dirty/errors moved to this tab's
  // own always-visible toolbar so they never disappear with the panel.
  const [showManifest, setShowManifest] = useState(false);

  // Motion's half of the Chroma control server bridge (D-020's architecture,
  // reused — docs/notes/motion-mcp-surface-research.md). Mounted here (not
  // conditionally on any loadState) so it registers its Tauri listener from
  // boot, same as `useChromaControl` does in App.tsx — B-007 already
  // guarantees this component stays mounted regardless of which tab has
  // focus. Individual ops still check `m.loadState`/`m.manifest` themselves
  // for the "no project open" / "not loaded yet" cases. D-170 (Phase 4):
  // moved below the `playerRef`/`measureApiRef`/`setSelections` declarations
  // above (was directly after `useMotionManifest`) so it can be handed the
  // SAME ref objects and state setter `MotionPreview`/`onSelect` already use
  // — `useRef`'s object identity and `useState`'s setter identity are both
  // stable across renders (unlike `m`, a plain object literal returned fresh
  // every render), so no `mRef`-style per-render re-sync is needed for
  // these; see `useMotionControl.ts`'s own module doc comment.
  // D-257 — `selections` (the live value, not just the setter) is now passed
  // too: it is the READ half `motion_get_state` returns and the value
  // `motion_set_selection` replaces, the Motion analogue of D-216's
  // `editor_get_state`/`editor_set_selection` pair. It changes every render,
  // so the hook re-syncs it into a ref exactly the way it already does for
  // `m`; the other three are stable identities and need no re-sync.
  useMotionControl(m, { playerRef, measureApiRef, setSelections, selections, editLinks });

  // D-158 — keeps `selections` pointing at the right layers as the STABLE
  // manifest changes underneath it (a commit, a catalog insert, a hand-edit
  // in the raw-JSON textarea) — the moment a reorder/insert/delete could
  // otherwise strand a live multi-selection on the wrong indices. Depends
  // ONLY on `m.manifest` (never the transient override, which changes every
  // pointermove of a drag and never reorders anything) so this runs once per
  // commit, not once per frame of a gesture. Skips the `setSelections` call
  // entirely when nothing actually changed (`sameSelectionArray`) so a
  // resolve that changes nothing doesn't hand every selection-consuming
  // panel a new array reference to re-render over, and so this effect can't
  // loop on its own output. Placed before the loading/error early returns
  // below — React's rules of hooks require every hook to run unconditionally
  // in the same order every render, and this tab already follows that for
  // `useState` above.
  useEffect(() => {
    if (!m.manifest) return;
    const manifest = m.manifest;
    setSelections((prev) => {
      const resolved = resolveSelections(manifest, prev);
      return sameSelectionArray(resolved, prev) ? prev : resolved;
    });
  }, [m.manifest]);

  // B-058 — this screen is now driven by the app's own "a project is open"
  // signal (`motionProjectStore.openProjectPath`) and nothing else, so it can no
  // longer appear while a project genuinely is open. There is deliberately no
  // Retry here any more: there was never anything for it to retry: the fix is
  // to open (or save) a project, which flips the signal on its own.
  if (m.loadState === 'no-project') {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center gap-2 bg-bg-primary text-center px-6">
        <h1 className="text-lg font-semibold text-text-primary">No project open</h1>
        <p className="text-sm text-text-secondary max-w-md">
          A motion manifest is saved inside a project. Open one — or save this Untitled session as a
          project — in the Colorist tab to edit and render one.
        </p>
      </div>
    );
  }

  if (m.loadState === 'error') {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center gap-2 bg-bg-primary text-center px-6">
        <h1 className="text-lg font-semibold text-text-primary">Couldn't load the manifest</h1>
        <p className="text-sm text-text-secondary max-w-md">
          The project is open, but reading its motion manifest failed.
        </p>
        {m.loadError && <p className="text-[11px] text-text-secondary/60 max-w-md">{m.loadError}</p>}
        <Button className="mt-2" onClick={() => m.reload()}>
          Retry
        </Button>
      </div>
    );
  }

  if (m.loadState === 'loading') {
    return (
      <div className="h-full w-full flex items-center justify-center bg-bg-primary text-text-secondary text-sm">
        Loading…
      </div>
    );
  }

  // D-081: select a row → seek the player to that scene's start frame. Real
  // navigation, not just bookkeeping for a not-yet-built property panel —
  // useful the moment a manifest has more than one scene or layer. D-158:
  // this is the "replace with exactly one" path — `LayerList` row clicks
  // and a plain (non-shift, non-already-in-group) canvas click both still
  // want exactly this behaviour, unchanged from Phase 1.
  //
  // D-173 — fixes the exact rough edge D-156/D-162 both disclosed and left
  // open: only seek when the target is actually in a DIFFERENT scene than
  // whatever's currently under the playhead. A `LayerList` row click into a
  // scene you weren't looking at still jumps there (the point of that
  // gesture); a canvas click only ever selects a layer in the scene ALREADY
  // on screen (§1e), so it used to reset the playhead to that scene's start
  // on every single selection — breaking "scrub to a moment, then edit
  // what's there," the exact workflow this whole tab is for.
  const onSelect = (s: Selection) => {
    setSelections([s]);
    // D-181 — an explicit pick always re-engages solo-scene mode, even
    // after stepping back to "Whole video." `onSelectionChange` (marquee/
    // shift-toggle/clear) deliberately does NOT do this — those gestures
    // never touch a scene other than whichever is already on screen (D-158
    // §1e), so there's nothing for them to "engage."
    setWholeVideo(false);
    if (!m.manifest) return;
    const currentFrame = playerRef.current?.getCurrentFrame();
    if (currentFrame === undefined) return;

    // D-176 — a layer/scene3d-child target seeks to where it ACTUALLY
    // starts (`layerVisibleFrameRange`, `manifestEdit.ts`), but only when
    // the current frame isn't already somewhere inside its own visible
    // window. A canvas click (D-172/B-064's own case) is always already
    // inside that window — you cannot click something that isn't
    // currently rendering — so this can never re-introduce B-064's own
    // regression; a `LayerList` click on a layer that hasn't started yet,
    // or one in a scene you weren't looking at, now jumps to that layer's
    // OWN `at`, not just the scene's start, so the thing you just selected
    // actually appears instead of leaving a selection outline drawn over
    // nothing (the exact confusion reported live).
    const range = layerVisibleFrameRange(m.manifest, s);
    if (range) {
      if (currentFrame < range.start || currentFrame >= range.end) {
        playerRef.current?.seekTo(range.start);
      }
      return;
    }

    // Scene/camera/scene3d-camera targets have no `at`/`dur` of their own
    // — same scene-boundary check B-064 already established.
    const currentScene = sceneIndexAtFrame(m.manifest, currentFrame);
    if (currentScene !== s.sceneIndex) {
      playerRef.current?.seekTo(sceneStartFrame(m.manifest, s.sceneIndex));
    }
  };

  // D-158 — the array-level counterpart: shift-toggle, a completed marquee,
  // or clearing the selection on a sub-threshold empty click. No seek: all
  // three only ever touch layers in the scene ALREADY on screen (per the
  // research doc §1e, only one scene's layers are ever mounted at once), so
  // there is nothing to jump to.
  const onSelectionChange = (s: Selection[]) => setSelections(s);

  // D-099/D-155/D-158: an Inspector edit produces a new `Manifest` object
  // (pure, immutable — see `manifestEdit.ts`) — `m.commit` serializes it
  // back through the same `setText` path a manual `ManifestEditor` edit uses
  // AND pushes an undo entry (Phase 0c's first customer: real, testable
  // undo before Phase 1's drag exists at all).
  const onInspectorChange = (next: typeof m.manifest) => {
    if (next) m.commit(next, labelForSelections(selections));
  };

  // D-151/D-158: which scene a catalog insert lands in — the FIRST live
  // selection's scene, or the last scene when nothing is selected. A 2+
  // multi-selection is always same-scene by construction (`LayerList.tsx`'s
  // own constraint), so "first" is never an arbitrary pick among several
  // different answers. The schema guarantees at least one scene
  // (`scenes.min(1)`), so a loaded manifest always has a real target;
  // `?? null` covers only the moment before one is parsed.
  const targetSceneIndex = selections[0]?.sceneIndex ?? (m.manifest ? m.manifest.scenes.length - 1 : null);
  const targetSceneId =
    m.manifest && targetSceneIndex !== null ? (m.manifest.scenes[targetSceneIndex]?.id ?? null) : null;

  // D-181 — the soloed scene, or `null` for the whole-video view. Unlike
  // `targetSceneIndex` above, this does NOT fall back to the last scene when
  // nothing is selected — "nothing selected" means "show the whole video,"
  // not "solo whichever scene happens to be last."
  const activeSceneIndex = wholeVideo ? null : (selections[0]?.sceneIndex ?? null);
  const activeSceneId = activeSceneIndex !== null ? (m.manifest?.scenes[activeSceneIndex]?.id ?? null) : null;

  // D-151: insert a catalog primitive, then select it — so the Inspector is
  // immediately showing the new layer's fields and the player has jumped to
  // its scene. Writes back through the plain `setText` path (NOT `m.commit`
  // — D-155's Phase 0c scoped undo to "the Inspector's existing edits [and]
  // Phase 1's drag commits" specifically, not every mutation site in this
  // tab; a catalog insert is a separate, already-shipped D-151 customer
  // this pass doesn't extend undo coverage to), keeping the manifest text
  // the one place the document is serialized.
  const onCatalogAdd = (use: PrimitiveUse) => {
    if (!m.manifest || targetSceneIndex === null) return;
    const { manifest: next, selection: added } = addLayer(m.manifest, targetSceneIndex, use);
    m.setText(JSON.stringify(next, null, 2));
    if (added) onSelect(added);
  };

  // D-157 — "snap to layer": the Inspector's own target-picker (rendered
  // only when the current selection is an `emphasis` layer, `InspectorPanel`
  // §"Snap to layer") already knows WHICH other layer in the scene to snap
  // to (`targetLayerIndex`); this is the part it can't do itself — measuring
  // that target's real screen rect and the current camera world-map, both
  // of which require live DOM access the Inspector doesn't have (see
  // `MotionPreview.tsx`'s own doc comment on `measureApiRef`). A `null` from
  // either measurement (the target layer isn't in the DOM right now — wrong
  // scene under the playhead, or hasn't mounted yet) is a real, honest
  // no-op rather than a crash or a wrong guess: the owner sees nothing
  // happen, which is correct, since there is nothing real to measure yet.
  const onSnapToLayer = (targetLayerIndex: number) => {
    // "Snap to layer" only ever renders for a single `emphasis` selection
    // (`InspectorPanel.tsx`'s own gate) — a 2+ multi-selection never reaches
    // this callback in practice; the length check is this function's own
    // defensive floor, not a load-bearing branch.
    if (!m.manifest || selections.length !== 1) return;
    const selection = selections[0];
    const api = measureApiRef.current;
    if (!api) return;
    const targetRect = api.layerScreenBox(selection.sceneIndex, targetLayerIndex);
    const map = api.worldMap();
    if (!targetRect || !map) return;
    m.commit(snapEmphasisToRect(m.manifest, selection, targetRect, map), 'Snap to layer');
  };

  return (
    <div className="h-full w-full min-h-0 bg-bg-primary flex flex-col">
      {/* D-172 — the always-visible toolbar: the `</>` manifest toggle
          (with an error-state border when a parse error exists and the
          panel is currently collapsed — the exact indicator D-153's own
          research doc named as "the part most likely to be missed"), the
          dirty indicator, any save/render error or a successful render's
          output path, and Save/Render themselves. None of this lives inside
          the collapsible panel any more, so none of it can disappear along
          with the JSON. */}
      <div className="shrink-0 flex items-center justify-end gap-2 px-3 py-2 border-b border-border-color">
        <div className="flex items-center gap-1.5 min-w-0">
          <button
            type="button"
            onClick={() => setShowManifest((v) => !v)}
            title={showManifest ? 'Hide scene manifest' : 'Show scene manifest (JSON)'}
            aria-label={showManifest ? 'Hide scene manifest' : 'Show scene manifest'}
            aria-pressed={showManifest}
            className={[
              'shrink-0 h-6 w-6 flex items-center justify-center rounded-md font-mono text-[10px] leading-none border transition-colors',
              m.parseError && !showManifest
                ? 'border-red-500/60 bg-red-500/10 text-red-400'
                : 'border-border-color bg-surface/90 text-text-secondary hover:text-text-primary hover:bg-hover-color',
            ].join(' ')}
          >
            {'</>'}
          </button>
          <span className="text-xs font-medium text-text-secondary truncate">
            Scene manifest{m.dirty ? ' · unsaved' : ''}
          </span>
        </div>
        {/* D-181 — solo-scene indicator + the explicit way back to the
           combined view. Only rendered while actually soloed (selecting
           something is what engages it, `onSelect` above) — this is purely
           the escape hatch, not a scene picker of its own. */}
        {activeSceneIndex !== null && (
          <button
            type="button"
            onClick={() => setWholeVideo(true)}
            title="Preview stays scoped to this scene — click to see the whole combined video again"
            className="shrink-0 h-6 px-2 flex items-center gap-1 rounded-md border border-border-color bg-surface/90 text-text-secondary hover:text-text-primary hover:bg-hover-color text-[11px]"
          >
            Scene: {activeSceneId} <span className="underline">Whole video</span>
          </button>
        )}
        {m.saveError && (
          <span className="text-[11px] text-red-400 truncate max-w-[280px]" title={m.saveError}>
            save failed: {m.saveError}
          </span>
        )}
        {!m.saveError && m.renderError && (
          <span className="text-[11px] text-red-400 truncate max-w-[280px]" title={m.renderError}>
            render failed: {m.renderError}
          </span>
        )}
        {/* D-180 — Render now produces one file PER SCENE, never one
           combined video; this summarizes the whole batch rather than a
           single path. `title` carries the full per-scene breakdown for a
           hover, since the truncated one-line summary can't show every
           path for a manifest with more than a couple of scenes. */}
        {!m.saveError && !m.renderError && m.renderResult && m.renderResult.length > 0 && (
          <span
            className="text-[11px] text-text-secondary truncate max-w-[280px]"
            title={m.renderResult.map((r) => `${r.sceneId} → ${r.outputPath}`).join('\n')}
          >
            rendered {m.renderResult.length} scene{m.renderResult.length === 1 ? '' : 's'} →{' '}
            {m.renderResult[0].outputPath.replace(/[^/\\]+$/, '')}
          </span>
        )}
        <Button variant="secondary" disabled={!m.dirty || m.saving || !!m.parseError} onClick={m.save}>
          {m.saving ? 'Saving…' : 'Save'}
        </Button>
        <Button disabled={m.rendering || !!m.parseError} onClick={m.render}>
          {m.rendering ? 'Rendering…' : 'Render'}
        </Button>
      </div>
      <div className="flex-1 min-h-0">
      <PanelGroup>
        <ResizablePanel defaultSize={800} minSize={300}>
          {/* D-162 — a nested VERTICAL split: the preview on top, the
              per-row keyframe timeline full-width beneath it, independently
              resizable — see `KeyframeTimeline.tsx`'s own module doc
              comment for why this replaced D-160's `KeyframeStrip` living
              squeezed inside `MotionPreview.tsx` itself. */}
          <PanelGroup orientation="vertical">
            <ResizablePanel defaultSize={520} minSize={200}>
              <MotionPreview
                manifest={m.manifest}
                transientManifest={transientManifest}
                playerRef={playerRef}
                measureApiRef={measureApiRef}
                selections={selections}
                onSelect={onSelect}
                onSelectionChange={onSelectionChange}
                onTransientChange={setTransientManifest}
                onCommit={m.commit}
                activeSceneIndex={activeSceneIndex}
              />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel defaultSize={220} minSize={120} maxSize={480}>
              <KeyframeTimeline
                manifest={m.manifest}
                selections={selections}
                playerRef={playerRef}
                onSelect={onSelect}
                onTransientChange={setTransientManifest}
                onCommit={m.commit}
                activeSceneIndex={activeSceneIndex}
              />
            </ResizablePanel>
          </PanelGroup>
        </ResizablePanel>
        <ResizableHandle />
        {/* D-151: Layers and Catalog share one pane rather than the Catalog
            claiming a fifth — four panes across already leaves the sidebar at
            180px, and a catalog with real descriptions needs more than a
            slice of that. They also belong together: the Catalog is where a
            layer comes FROM and the layer list is where it lands, so
            "add here → appears there" reads as one place. The pane's own
            max width goes up to 420 to give the catalog room, and it stays
            fully resizable per the standing CLAUDE.md rule. */}
        <ResizablePanel defaultSize={220} minSize={140} maxSize={420}>
          <div className="h-full border-l border-border-color flex flex-col min-h-0">
            <div className="shrink-0 flex border-b border-border-color">
              {(['layers', 'catalog'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={[
                    'flex-1 h-7 text-[11px] capitalize transition-colors',
                    sidebarTab === t
                      ? 'text-text-primary border-b-2 border-accent'
                      : 'text-text-secondary hover:text-text-primary border-b-2 border-transparent',
                  ].join(' ')}
                  onClick={() => setSidebarTab(t)}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="flex-1 min-h-0">
              {sidebarTab === 'layers'
                ? m.manifest && (
                    <LayerList
                      manifest={m.manifest}
                      selections={selections}
                      onSelect={onSelect}
                      onCommit={m.commit}
                      editLinks={editLinks}
                    />
                  )
                : <CatalogPanel targetSceneId={targetSceneId} onAdd={onCatalogAdd} />}
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize={280} minSize={200} maxSize={480}>
          <div className="h-full border-l border-border-color">
            {m.manifest && (
              <InspectorPanel
                manifest={m.manifest}
                selections={selections}
                onChange={onInspectorChange}
                onSnapToLayer={onSnapToLayer}
              />
            )}
          </div>
        </ResizablePanel>
        {showManifest && (
          <>
            <ResizableHandle />
            <ResizablePanel defaultSize={420} minSize={280}>
              <div className="h-full border-l border-border-color">
                <ManifestEditor text={m.text} onChange={m.setText} parseError={m.parseError} />
              </div>
            </ResizablePanel>
          </>
        )}
      </PanelGroup>
      </div>
    </div>
  );
}

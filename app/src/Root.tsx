import { useCallback, useEffect, useMemo, useRef } from 'react';
import { toast } from 'react-toastify';
import { Shell, useActiveTab } from '@chroma/shell';
import { EditorExportDialog, EditorTab, useEditorTimelineStore } from '@chroma/editor';
import {
  MotionTab,
  clipReadsItem,
  computeEditLinks,
  useMotionProjectStore,
  type SceneRenderResult,
} from '@chroma/motion';
import { useMediaPoolStore, trackEvent } from '@chroma/bridge';
import App from './App';
import ProjectLauncher from './components/chroma/ProjectLauncher';
import { SourcesPanel } from './components/chroma/SourcesPanel';
import { selectProjectKey, useSessionStore } from './store/useSessionStore';

/**
 * `Root` — the app's composition root component (D-039), and *only* that.
 *
 * **This module must export nothing but React components** (D-201/B-081).
 * `@vitejs/plugin-react` makes a module a React Fast Refresh boundary only
 * when every one of its exports is a component; a module that fails that test
 * (including one with *no* exports at all, which is what `main.tsx` was while
 * it also held this component) invalidates instead, and Vite answers an
 * invalidated boundary with a **full page reload of the whole app**. Because
 * every `@chroma/*` barrel (`packages/editor/src/index.ts` &c.) re-exports
 * stores and plain functions alongside components, it is not a boundary
 * either, so an HMR update to any module behind a barrel propagates straight
 * up to whatever imports the barrel — this file. Keeping this file a valid
 * boundary is what stops that propagation and turns those edits into a
 * sub-second hot update instead of a full reload. See D-201 for the whole
 * chain, including the Tauri IPC-transport fallback (B-081) a reload caused.
 *
 * The app opens on the project launcher with no tab bar; opening/creating a
 * project sets `useSessionStore.projectPath` (or, for a loose-clip quick-open,
 * `projectName` = 'Untitled'), which flips the shell into the 3-tab layout.
 * "‹ Projects" calls `closeProject()` to come back.
 *
 * B-007: every tab stays mounted from boot (D-039), including underneath the
 * launcher, so the Edit tab's own mount never coincides with a project
 * actually opening — it would otherwise sit on the stale "no project" read it
 * took at startup until some unrelated window-focus event happened to fire.
 * This is the one place that legitimately spans both `app` (owns
 * `useSessionStore`, the real "project is open" signal) and `@chroma/editor`
 * (owns the timeline fetch); this is the composition root, so it's the
 * right place to bridge them, not a cross-package import in either direction.
 * B-034/D-112 turned that bridge from "fire a fetch and hope" into handing the
 * store the signal itself — see the effect's own comment below.
 *
 * B-083/D-203 — that signal is now the open project's **identity**
 * (`selectProjectKey`), not a "is one open" boolean, and every store that
 * caches per-project state gets it from here: the Edit tab's timeline, the
 * Motion tab's manifest, and the media pool. A boolean cannot see a switch
 * from project A straight to project B, which is exactly what
 * `open_project`/`new_project` do — so each of those stores silently served
 * the outgoing project's state for the rest of the session.
 */
export function Root() {
  const projectOpen = useSessionStore((s) => !!s.projectPath || !!s.projectName);
  // B-083/D-203 — *which* project is open, not merely whether one is. Every
  // bridge below that hands per-project state to a tab keys off this, because
  // `open_project`/`new_project` (GUI and MCP alike) swap one project for
  // another without ever passing through "closed" — a transition the boolean
  // above cannot see at all.
  const projectKey = useSessionStore(selectProjectKey);
  const activeTab = useActiveTab();

  // D-093: tab switches are the cheapest, highest-signal "what is the owner
  // actually doing right now" event, and `useShellStore` (`@chroma/shell`)
  // must not depend on `@chroma/bridge` (see that store's own file-header
  // note) — so this is tracked here, at the composition root, same layering
  // reasoning as the B-007/D-062 bridges just above/below. Skips the very
  // first render (mounting on `edit` isn't a "switch").
  const previousTab = useRef<string | null>(null);
  useEffect(() => {
    if (previousTab.current !== null && previousTab.current !== activeTab) {
      trackEvent('tab_switch', { from: previousTab.current, to: activeTab });
    }
    previousTab.current = activeTab;
  }, [activeTab]);

  // B-034/D-112 — the single bridge between the app's real "a project is
  // open" signal and the Edit tab. Supersedes D-085's version, which called
  // `load()` here and then re-called it once, 500ms later, if the first
  // attempt had landed on an error — a heuristic whose own comment admitted
  // it never proved the race it was guarding, and which by construction could
  // only ever paper over one failure at one fixed delay.
  //
  // The open project is now handed to the store as state, not used as a
  // trigger to fire a fetch and hope. The store owns everything downstream of
  // that: when to fetch, how many times to retry, what to show while it's
  // trying, and — the part that actually mattered — the fact that a *failed
  // fetch is not evidence that no project is open*. `setOpenProject` is
  // idempotent per key, so this effect re-running with an unchanged value
  // costs nothing.
  //
  // B-083/D-203 — what's handed over is the project's identity, not a
  // boolean. `open_project`/`new_project` switch projects in place, so the
  // boolean this used to pass stayed `true` across the switch and the Edit tab
  // kept serving (and letting the MCP layer edit) the *previous* project's
  // timeline, silently, for the rest of the session.
  useEffect(() => {
    useEditorTimelineStore.getState().setOpenProject(projectKey);
  }, [projectKey]);

  // B-058/D-150 — the same bridge for the Motion tab, which never had one: it
  // mounts at boot like every other tab (see this file's B-007 note), read its
  // manifest once right there with no project open, and — because it *inferred*
  // "no project" from that failure — sat on that answer for the rest of the
  // session. Its only escape was a window `focus` event, which opening a
  // project from the in-window launcher never produces.
  //
  // The signal is deliberately narrower than `projectKey` above: Motion's
  // manifest is a sidecar inside the project directory
  // (`<project>.chroma/motion/manifest.json`), so an in-memory "Untitled"
  // loose-clip session — `projectName` set, `projectPath` null — genuinely has
  // nowhere to read or write, and the tab should say so rather than fail a call
  // it was never able to make. So this passes the project *path* itself, which
  // is both the narrower signal and (B-083/D-203) Motion's own project
  // identity: a switch from project A to project B re-reads B's manifest
  // instead of leaving A's in the editor, where a save would have written it
  // straight into B's sidecar.
  const motionProjectPath = useSessionStore((s) => s.projectPath);
  useEffect(() => {
    useMotionProjectStore.getState().setOpenProject(motionProjectPath);
  }, [motionProjectPath]);

  // B-083/D-203 — the same bridge for the media pool, whose items are what
  // `editor_add_clip` resolves a `mediaId`/`sourcePath` against (B-084). It
  // had no bridge here at all: `SourcesPanel` fired the initial `refresh()`
  // from its own effect, keyed on the "a project is open" boolean, so a
  // project switch never re-read it and the Sources panel — and every MCP
  // caller reading through it — stayed on the outgoing project's media.
  useEffect(() => {
    useMediaPoolStore.getState().setOpenProject(projectKey);
  }, [projectKey]);

  // D-071: `chroma_timeline_set` (the Edit tab's own save path, fired on
  // every drag/trim/split) never runs `open_manifest`, so nothing else
  // tells Colorist a clip was added or removed on the timeline — confirmed
  // live: a clip dragged onto the Edit tab never showed up in the Colorist
  // shot strip, and a removed clip lingered there forever as a "ghost."
  // Same bridge shape as the B-007 fix above (app owns the tab-switch
  // signal, `useSessionStore` owns the resync) — re-syncs every time the
  // owner switches *to* Colorist, not on every keystroke on the Edit tab,
  // since `chroma_project_resync_clips` is specifically built to leave the
  // currently-active clip untouched when nothing relevant changed, making
  // a slightly-stale-until-the-next-tab-switch window an acceptable
  // trade-off against re-syncing on every single timeline edit.
  useEffect(() => {
    if (projectOpen && activeTab === 'colorist') {
      void useSessionStore.getState().resyncClips();
    }
  }, [projectOpen, activeTab]);

  // D-062: a Motion render used to just write a file and print its path as
  // plain text — nothing put it anywhere usable. `MotionTab` can't import
  // it into the pool itself (`@chroma/bridge` is app/domain-layer, D-039
  // layer direction: a tab package must not depend on it), so this is the
  // composition root's job, same reasoning as the `useEditorTimelineStore`
  // bridge above. Imports at the pool root (no folder) — a rendered motion
  // graphic isn't naturally "in" whatever folder happens to be active in
  // the Sources panel right now. Deliberately does NOT also splice it onto
  // the Edit tab's active timeline: the owner may not want it there yet, or
  // may want a specific track/position — dragging it in from Sources (like
  // any other clip) stays the one explicit action that actually places it.
  //
  // **D-260 — "auto re-render, auto-replace."** This used to call
  // `importPaths`, which by design SKIPS a path already in the pool, and then
  // fall back to a plain `refresh()` on the strength of a comment claiming
  // that made "its thumbnail/video info reflect the new render." It did not:
  // `refresh()` re-reads the project manifest, and the manifest is exactly
  // what held the stale probe and the stale thumbnail (B-128). It is now
  // `refreshPaths`, which reconciles the pool with what is actually on disk,
  // and it stamps the scene's id onto the item as provenance — the whole
  // Motion→Edit link (see `computeEditLinks`).
  //
  // Then the second half, the one that makes a re-render land by itself: the
  // refreshed item's real length/rate are pushed into every Edit clip already
  // reading that file (`refresh_media`). Nothing else is needed for the
  // picture — the file at that path has genuinely changed, both Edit engines
  // read the file, and every cache over it is `(mtime, len)`-keyed — but a
  // scene whose DURATION changed leaves those clips with a `source_len` from
  // the previous render, which is what bounds a trim. `applyOp` short-circuits
  // a no-op, so the common same-length re-render writes nothing and pushes no
  // undo entry.
  const onMotionRendered = useCallback(async (r: SceneRenderResult) => {
    const res = await useMediaPoolStore.getState().refreshPaths([r.outputPath], r.sceneId);
    if (!res.ok) {
      toast.error(`Rendered, but couldn't add to Sources: ${res.error}`);
      return;
    }
    const item = res.items?.find((it) => it.sourcePath === r.outputPath);
    // An item that failed to probe carries no `video` at all, and its length is
    // therefore UNKNOWN — not zero. Refreshing clips against a zero-length
    // source would clamp every one of them to a single frame, which is far
    // worse than leaving them pointing at a file whose new length we could not
    // read: the picture still updates either way (both Edit engines read the
    // file), only the trim ceiling stays as it was. Same "an absent value is
    // not the value" discipline `MediaItem::has_audio` and `Clip::source_fps`
    // already keep.
    const video = item?.video;
    if (!item || !video) {
      toast.success('Rendered — added to Sources');
      return;
    }
    const store = useEditorTimelineStore.getState();
    // `clipReadsItem` rather than a hand-written matcher here: it is the same
    // rule `computeEditLinks` counts the badge with and `refresh_media`
    // selects clips with, and three copies of it is how they would drift.
    const linked =
      store.timeline?.tracks.reduce(
        (n, t) => n + t.clips.filter((c) => clipReadsItem(c, item)).length,
        0,
      ) ?? 0;
    if (linked === 0) {
      toast.success('Rendered — added to Sources');
      return;
    }
    // A no-op when the re-render is the same length (the common case):
    // `applyOp` short-circuits it and pushes no undo entry. The toast still
    // reports the clips, because they DID get the new picture.
    store.applyOp({
      kind: 'refresh_media',
      media_id: item.id,
      source_path: item.sourcePath,
      source_len: video.frameCount,
      source_fps: video.fps,
    });
    toast.success(`Rendered — refreshed ${linked} Edit clip${linked === 1 ? '' : 's'}`);
  }, []);

  // D-260 — the Motion tab's view of what its scenes feed in Edit: the input
  // to both the per-scene "N in Edit" badge and the `motion_get_edit_links`
  // MCP tool, so a human and an agent are told the same thing from the same
  // value. Computed here because it spans the media pool and the Edit
  // timeline, neither of which `@chroma/motion` may import (D-039) — the same
  // reason `onRendered` above is a prop. `computeEditLinks` itself is pure and
  // takes plain arrays; see its own module doc for why its parameters are
  // structural rather than imported types.
  const mediaItems = useMediaPoolStore((s) => s.items);
  const editTracks = useEditorTimelineStore((s) => s.timeline?.tracks);
  const motionEditLinks = useMemo(
    () => computeEditLinks(mediaItems, editTracks ?? []),
    [mediaItems, editTracks],
  );

  return (
    <Shell
      projectOpen={projectOpen}
      launcher={<ProjectLauncher />}
      sourcesPanel={<SourcesPanel />}
      onCloseProject={() => {
        void useSessionStore.getState().closeProject();
      }}
      tabs={[
        // D-251 — Export moved from the Edit tab's own top strip (D-249) to
        // the shell's chrome bar, beside the tab switcher, per the owner's
        // live request. `headerAction` is `@chroma/shell`'s injection slot
        // for exactly this: `Root` (the composition root) supplies the real
        // `EditorExportDialog`, `Shell` only renders whatever node the active
        // tab registered — same `app → shell`/`app → editor` dependency
        // direction as `element` below, `Shell` itself still never imports
        // `@chroma/editor`. Motion/Colorist have no export action of their
        // own yet, so their entries omit it.
        { id: 'edit', label: 'Edit', element: <EditorTab />, headerAction: <EditorExportDialog /> },
        {
          id: 'motion',
          label: 'Motion',
          element: <MotionTab onRendered={onMotionRendered} editLinks={motionEditLinks} />,
        },
        { id: 'colorist', label: 'Colorist', element: <App /> },
      ]}
    />
  );
}

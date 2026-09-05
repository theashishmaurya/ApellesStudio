/**
 * @chroma/motion — the Motion tab (D-039 roadmap "Motion tab MVP", D-046;
 * layer list D-081).
 *
 * Wires the already-functional `@chroma/motion-engine` Remotion engine into
 * a real tab: a `@remotion/player` preview (`MotionPreview`) of whatever
 * manifest is loaded, a real scene/layer list (`LayerList`, D-081 — Phase 1
 * of `docs/notes/global-inspector.md`), a real property panel bound to that
 * selection (`InspectorPanel`, D-099 — Phase 2), and a JSON manifest editor
 * (`ManifestEditor`) that live-updates the preview and can save / render it.
 * Selecting a row in the layer list seeks the player to that scene's start
 * frame AND drives the Inspector's fields — both real, standalone-useful
 * pieces of navigation/editing, not just bookkeeping for something later.
 * The three right-hand panes (layer list / Inspector / manifest editor) are
 * real resizable panels (`resizable.tsx`, D-099) per the standing CLAUDE.md
 * rule that a resizable-by-nature pane must actually be resizable.
 * Persistence and rendering are project-scoped
 * (`app/src-tauri/src/chroma/motion.rs`), so — same contract `@chroma/
 * editor`'s `EditorTab` already uses — a project must be open.
 *
 * `onRendered` (D-062, optional) fires with the rendered file's path after
 * a successful render — this package can't import it into the Sources pool
 * itself (`@chroma/bridge` is app/domain-layer, D-039 layer direction), so
 * the app-level composition (`app/src/main.tsx`) supplies this to do that.
 */
import { useRef, useState } from 'react';
import type { PlayerRef } from '@remotion/player';
import { sceneStartFrame } from '@chroma/motion-engine/src/engine/build';

import { Button } from './Button';
import { MotionPreview } from './MotionPreview';
import { LayerList, type Selection } from './LayerList';
import { InspectorPanel } from './InspectorPanel';
import { ManifestEditor } from './ManifestEditor';
import { useMotionManifest } from './useMotionManifest';
import { PanelGroup, ResizablePanel, ResizableHandle } from './resizable';

export function MotionTab({ onRendered }: { onRendered?: (outputPath: string) => void }) {
  const m = useMotionManifest(onRendered);
  const playerRef = useRef<PlayerRef>(null);
  const [selection, setSelection] = useState<Selection | null>(null);

  // B-058 — this screen is now driven by the app's own "a project is open"
  // signal (`motionProjectStore.projectOpen`) and nothing else, so it can no
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
  // useful the moment a manifest has more than one scene or layer.
  const onSelect = (s: Selection) => {
    setSelection(s);
    if (m.manifest) playerRef.current?.seekTo(sceneStartFrame(m.manifest, s.sceneIndex));
  };

  // D-099: an Inspector edit produces a new `Manifest` object (pure,
  // immutable — see `manifestEdit.ts`) — writing it back through
  // `setText`/`JSON.stringify` keeps `useMotionManifest`'s text state the
  // one place the manifest is actually serialized, same as a manual edit
  // in `ManifestEditor`'s own textarea.
  const onInspectorChange = (next: typeof m.manifest) => {
    if (next) m.setText(JSON.stringify(next, null, 2));
  };

  return (
    <div className="h-full w-full min-h-0 bg-bg-primary">
      <PanelGroup>
        <ResizablePanel defaultSize={800} minSize={300}>
          <MotionPreview manifest={m.manifest} playerRef={playerRef} />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize={180} minSize={120} maxSize={320}>
          <div className="h-full border-l border-border-color">
            {m.manifest && <LayerList manifest={m.manifest} selection={selection} onSelect={onSelect} />}
          </div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize={280} minSize={200} maxSize={480}>
          <div className="h-full border-l border-border-color">
            {m.manifest && <InspectorPanel manifest={m.manifest} selection={selection} onChange={onInspectorChange} />}
          </div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize={420} minSize={280}>
          <div className="h-full border-l border-border-color">
            <ManifestEditor
              text={m.text}
              onChange={m.setText}
              parseError={m.parseError}
              dirty={m.dirty}
              saving={m.saving}
              saveError={m.saveError}
              onSave={m.save}
              rendering={m.rendering}
              renderError={m.renderError}
              renderResult={m.renderResult}
              onRender={m.render}
            />
          </div>
        </ResizablePanel>
      </PanelGroup>
    </div>
  );
}

/**
 * @chroma/motion — the Motion tab (D-039 roadmap "Motion tab MVP", D-046;
 * layer list D-081).
 *
 * Wires the already-functional `@chroma/motion-engine` Remotion engine into
 * a real tab: a `@remotion/player` preview (`MotionPreview`) of whatever
 * manifest is loaded, a real scene/layer list (`LayerList`, D-081 — Phase 1
 * of `docs/notes/global-inspector.md`, the selection-model prerequisite the
 * scoping doc identified before any property panel makes sense), and a JSON
 * manifest editor (`ManifestEditor`) that live-updates the preview and can
 * save / render it. Selecting a row in the layer list seeks the player to
 * that scene's start frame — real, standalone-useful navigation even before
 * Phase 2 (an actual property panel bound to the selection) exists.
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
import { ManifestEditor } from './ManifestEditor';
import { useMotionManifest } from './useMotionManifest';

export function MotionTab({ onRendered }: { onRendered?: (outputPath: string) => void }) {
  const m = useMotionManifest(onRendered);
  const playerRef = useRef<PlayerRef>(null);
  const [selection, setSelection] = useState<Selection | null>(null);

  if (m.loadState === 'no-project') {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center gap-2 bg-bg-primary text-center px-6">
        <h1 className="text-lg font-semibold text-text-primary">No project open</h1>
        <p className="text-sm text-text-secondary max-w-md">
          Open a project in the Colorist tab to edit and render a motion manifest.
        </p>
        <Button className="mt-2" onClick={() => m.reload()}>
          Retry
        </Button>
      </div>
    );
  }

  if (m.loadState === 'error') {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center gap-2 bg-bg-primary text-center px-6">
        <h1 className="text-lg font-semibold text-text-primary">Couldn't load the manifest</h1>
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

  return (
    <div className="h-full w-full flex min-h-0 bg-bg-primary">
      <div className="flex-1 min-w-0">
        <MotionPreview manifest={m.manifest} playerRef={playerRef} />
      </div>
      <div className="w-[180px] shrink-0 border-l border-border-color">
        {m.manifest && <LayerList manifest={m.manifest} selection={selection} onSelect={onSelect} />}
      </div>
      <div className="w-[420px] shrink-0 border-l border-border-color">
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
    </div>
  );
}

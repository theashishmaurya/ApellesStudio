/**
 * @chroma/motion — the Motion tab (D-039 roadmap "Motion tab MVP", D-046).
 *
 * Wires the already-functional `@chroma/motion-engine` Remotion engine into
 * a real tab: a `@remotion/player` preview (`MotionPreview`) of whatever
 * manifest is loaded, next to a JSON manifest editor (`ManifestEditor`)
 * that live-updates the preview and can save / render it. Persistence and
 * rendering are project-scoped (`app/src-tauri/src/chroma/motion.rs`), so —
 * same contract `@chroma/editor`'s `EditorTab` already uses — a project
 * must be open.
 *
 * `onRendered` (D-062, optional) fires with the rendered file's path after
 * a successful render — this package can't import it into the Sources pool
 * itself (`@chroma/bridge` is app/domain-layer, D-039 layer direction), so
 * the app-level composition (`app/src/main.tsx`) supplies this to do that.
 */
import { Button } from './Button';
import { MotionPreview } from './MotionPreview';
import { ManifestEditor } from './ManifestEditor';
import { useMotionManifest } from './useMotionManifest';

export function MotionTab({ onRendered }: { onRendered?: (outputPath: string) => void }) {
  const m = useMotionManifest(onRendered);

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

  return (
    <div className="h-full w-full flex min-h-0 bg-bg-primary">
      <div className="flex-1 min-w-0">
        <MotionPreview manifest={m.manifest} />
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

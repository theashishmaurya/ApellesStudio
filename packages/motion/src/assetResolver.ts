/**
 * @apelles/motion — the live preview's asset resolver (D-404).
 *
 * What it is: the app-side answer to "where is `sha256:<hex>.png`?" for the
 * Remotion PLAYER inside the webview. The render serves the project's asset
 * folder as Remotion's `public/` (`--public-dir`), but the player runs in the
 * webview, where a project folder is only reachable through Tauri's asset
 * protocol: this hook asks the backend for the folder (which also allows it
 * in the asset-protocol scope, `chroma_motion_assets_dir`) and builds URLs
 * with `convertFileSrc`. `MotionTab` provides the result to everything under it
 * (`AssetResolverProvider`), so the preview and the layer thumbnails both see
 * imported images.
 *
 * What it does NOT do: import anything (`manifestIO.importAsset`), or resolve
 * for a render (the engine's own `staticAssetResolver` does that).
 */
import { useEffect, useMemo, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { assetFileName } from '@apelles/motion-engine/src/lib/assetId';
import type { AssetResolver } from '@apelles/motion-engine/src/lib/assets';
import { getAssetsDir } from './manifestIO';

/** `dir` + an asset id → the webview URL of that file. Pure; exported for tests. */
export function assetUrl(dir: string, id: string, toUrl: (path: string) => string): string {
  return toUrl(`${dir.replace(/[\\/]+$/, '')}/${assetFileName(id)}`);
}

/** The resolver for the project at `projectPath` (re-fetched when it changes);
 *  until the folder is known it resolves to an empty string, which `<Img>`
 *  simply does not draw. */
export function useMotionAssetResolver(projectPath: string | null): AssetResolver {
  const [dir, setDir] = useState<string | null>(null);
  useEffect(() => {
    setDir(null);
    if (!projectPath) return;
    let live = true;
    getAssetsDir().then(
      (d) => {
        if (live) setDir(d);
      },
      () => {
        if (live) setDir(null);
      },
    );
    return () => {
      live = false;
    };
  }, [projectPath]);
  return useMemo<AssetResolver>(
    () => (id) => (dir ? assetUrl(dir, id, convertFileSrc) : ''),
    [dir],
  );
}

/**
 * Project assets addressed by content hash (D-404).
 *
 * What it is: how a manifest names a file (a logo, a screenshot) and how the
 * engine turns that name into a URL. A manifest never holds a path: it holds
 * `sha256:<64 hex>.<ext>`, the SHA-256 of the file's bytes plus its extension,
 * and the file lives in the project at `motion/assets/<hex>.<ext>`
 * (`motion_import_asset` copies it there). The same id always means the same
 * bytes, on any machine, so a render cannot change because a file elsewhere on
 * disk did — the render-path determinism rule.
 *
 * Resolution is injected, because the two runtimes reach the folder
 * differently: the Remotion render serves it as `public/` (`--public-dir`) and
 * the default resolver is `staticFile`; the app's live preview provides
 * `AssetResolverProvider` with a resolver built on Tauri's `convertFileSrc`
 * (`@apelles/motion`'s `MotionPreview`). The engine itself knows neither Tauri
 * nor the project path.
 *
 * What it does NOT do: check that a file exists (the render fails loudly on a
 * missing image, through `<Img>`'s own error), or import anything.
 */
import React, { createContext, useContext } from "react";
import { staticFile } from "remotion";
import { assetFileName } from "./assetId";

export { ASSET_ID_PATTERN, ASSET_IMAGE_EXTENSIONS, assetFileName } from "./assetId";

export type AssetResolver = (id: string) => string;

/** the render's resolver: the asset folder is Remotion's `public/`. */
export const staticAssetResolver: AssetResolver = (id) => staticFile(assetFileName(id));

const AssetContext = createContext<AssetResolver>(staticAssetResolver);

export const AssetResolverProvider: React.FC<{ resolve: AssetResolver; children: React.ReactNode }> = ({
  resolve,
  children,
}) => <AssetContext.Provider value={resolve}>{children}</AssetContext.Provider>;

export const useAssetResolver = (): AssetResolver => useContext(AssetContext);

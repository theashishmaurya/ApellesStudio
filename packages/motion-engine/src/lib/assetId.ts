/**
 * The shape of a project asset id (D-404) — pure, so the manifest schema can
 * use it without importing the React resolver (`assets.tsx`).
 *
 * An asset id is `sha256:<64 lowercase hex>.<ext>`: the SHA-256 of the file's
 * bytes plus its extension. The file itself lives at
 * `<project>.chroma/motion/assets/<hex>.<ext>`.
 */

/** the extensions an image asset may have (lowercase). */
export const ASSET_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "svg"] as const;

/** `sha256:<64 lowercase hex>.<ext>` */
export const ASSET_ID_PATTERN = new RegExp(`^sha256:[0-9a-f]{64}\\.(${ASSET_IMAGE_EXTENSIONS.join("|")})$`);

/** `sha256:ab…cd.png` → `ab…cd.png`, the file's name inside the asset folder. */
export function assetFileName(id: string): string {
  return id.startsWith("sha256:") ? id.slice("sha256:".length) : id;
}

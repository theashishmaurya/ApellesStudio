/**
 * The Phosphor icon library, by NAME, loaded on first use (D-405).
 *
 * What it is: the `icon` primitive's (and the Inspector icon picker's) way to
 * reach any Phosphor icon from a manifest string. Names are Phosphor's own
 * kebab-case names as phosphoricons.com shows them (`rocket-launch`,
 * `chart-line-up`), derived from the library's own React exports
 * (`RocketLaunch` → `rocket-launch`), so the vocabulary is exactly the
 * installed library's — never a hand-kept list, never a hand-drawn glyph
 * (CLAUDE.md's one-icon-library rule).
 *
 * Why lazy: importing every icon by name defeats tree-shaking (~5 MB of
 * minified JS measured here). `import("@phosphor-icons/react")` puts the whole
 * library in its own chunk, fetched only when an icon layer first renders or
 * the picker first opens, in both the app (Vite) and the Remotion bundle
 * (webpack). The render waits for it with `delayRender`, so a frame is never
 * drawn without its icon (deterministic).
 *
 * What it does NOT do: draw anything (that is `primitives/Icon.tsx`).
 */
import type { Icon } from "@phosphor-icons/react";

export type PhosphorWeight = "thin" | "light" | "regular" | "bold" | "fill" | "duotone";
export const PHOSPHOR_WEIGHTS: readonly PhosphorWeight[] = ["thin", "light", "regular", "bold", "fill", "duotone"];

/** `RocketLaunch` → `rocket-launch`; `NumberCircleOne` → `number-circle-one`. */
export function kebabFromPascal(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

export type PhosphorMap = ReadonlyMap<string, Icon>;

let cache: PhosphorMap | null = null;
let pending: Promise<PhosphorMap> | null = null;

/** Is `value` one of the library's icon components (a forwardRef object with
 *  a render function)? Filters out `IconBase`, `IconContext`, `SSR`. */
function isIconComponent(value: unknown): value is Icon {
  return (
    typeof value === "object" &&
    value !== null &&
    "render" in value &&
    typeof (value as { render: unknown }).render === "function" &&
    "displayName" in value
  );
}

/** Build the kebab-name map from the library module. Each icon is exported
 *  twice (`Acorn` and `AcornIcon`); the `…Icon` aliases are skipped. */
export function buildPhosphorMap(mod: Record<string, unknown>): PhosphorMap {
  const map = new Map<string, Icon>();
  for (const [exportName, value] of Object.entries(mod)) {
    if (exportName.endsWith("Icon") || exportName === "IconBase") continue;
    if (!isIconComponent(value)) continue;
    map.set(kebabFromPascal(exportName), value);
  }
  return map;
}

/** The library, loaded once per process. */
export function loadPhosphorIcons(): Promise<PhosphorMap> {
  pending ??= import("@phosphor-icons/react").then((mod) => {
    cache = buildPhosphorMap(mod as unknown as Record<string, unknown>);
    return cache;
  });
  return pending;
}

/** The library if it has already loaded, else `null` (callers then load it). */
export function phosphorIconsIfLoaded(): PhosphorMap | null {
  return cache;
}

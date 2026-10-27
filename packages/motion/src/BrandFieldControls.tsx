/**
 * @apelles/motion — the Inspector's asset picker and icon picker (D-404/D-405),
 * the human half of `motion_import_asset` and an `icon` layer's `name`.
 *
 * `AssetFieldControl` shows the current asset (a thumbnail through the tab's
 * asset resolver, and its short id) and a **Choose image…** button: a native
 * file dialog, then the same `chroma_motion_import_asset` the MCP tool calls,
 * then the new `sha256:` id is committed — so a picked file is stored by
 * content hash exactly as an agent's import is.
 *
 * `IconFieldControl` is the name as text plus a searchable grid of the real
 * Phosphor library (loaded on first open, `@apelles/motion-engine`'s
 * `phosphorIcons.ts`), each cell the library's own component — never a drawn
 * glyph. The grid shows the first matches only (`ICON_GRID_LIMIT`) so typing
 * stays instant over ~1,500 icons.
 *
 * Not `@apelles/ui`: the same `@react-three/fiber` JSX-typing conflict as the
 * rest of this package (see `Button.tsx`).
 */
import { useMemo, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useAssetResolver } from '@apelles/motion-engine/src/lib/assets';
import { ASSET_IMAGE_EXTENSIONS } from '@apelles/motion-engine/src/lib/assetId';
import { loadPhosphorIcons, type PhosphorMap } from '@apelles/motion-engine/src/lib/phosphorIcons';
import type { FieldSpec } from './propCatalog';
import { importAsset, type MotionAssetRecord } from './manifestIO';

/** most icons the picker grid shows at once. */
export const ICON_GRID_LIMIT = 96;

const label = 'text-[10px] text-text-secondary';
const inputBase =
  'w-full h-7 rounded border border-border-color bg-transparent px-1.5 text-[11px] text-text-primary focus:outline-none focus:border-accent';

/** the icon names matching `query` (substring, every word), in library order. */
export function filterIconNames(names: readonly string[], query: string, limit = ICON_GRID_LIMIT): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const n of names) {
    if (words.every((w) => n.includes(w))) out.push(n);
    if (out.length >= limit) break;
  }
  return out;
}

/** D-404 — a native file dialog for an image, then the import
 *  (`chroma_motion_import_asset`, the same one `motion_import_asset` runs).
 *  Resolves to the record, or `null` when the dialog was cancelled. Shared by
 *  the asset picker and the Catalog's "add image" row. */
export async function pickAndImportImage(): Promise<MotionAssetRecord | null> {
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'Images', extensions: [...ASSET_IMAGE_EXTENSIONS] }],
  });
  if (typeof picked !== 'string') return null;
  return importAsset(picked);
}

export function AssetFieldControl({
  spec,
  value,
  onCommit,
}: {
  spec: FieldSpec;
  value: unknown;
  onCommit: (v: unknown) => void;
}) {
  const resolve = useAssetResolver();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = typeof value === 'string' ? value : '';
  const url = id ? resolve(id) : '';

  const choose = async () => {
    setError(null);
    setBusy(true);
    try {
      const record = await pickAndImportImage();
      if (record) onCommit(record.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <span className={label}>{spec.label}</span>
      <div className="flex items-center gap-2">
        <div className="h-10 w-10 shrink-0 rounded border border-border-color overflow-hidden bg-surface">
          {url && <img src={url} alt="" className="h-full w-full object-contain" />}
        </div>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-text-secondary" title={id}>
          {id ? `${id.slice(0, 15)}…${id.slice(-8)}` : '(no image)'}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void choose()}
          className="h-7 shrink-0 rounded border border-border-color px-2 text-[10px] text-text-secondary hover:text-text-primary hover:border-accent disabled:opacity-40"
        >
          {busy ? 'Importing…' : 'Choose image…'}
        </button>
      </div>
      {error && (
        <p className="text-[10px] text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function IconFieldControl({
  spec,
  value,
  onCommit,
}: {
  spec: FieldSpec;
  value: unknown;
  onCommit: (v: unknown) => void;
}) {
  const [openGrid, setOpenGrid] = useState(false);
  const [icons, setIcons] = useState<PhosphorMap | null>(null);
  const [query, setQuery] = useState('');
  const name = typeof value === 'string' ? value : '';
  const names = useMemo(() => (icons ? [...icons.keys()] : []), [icons]);
  const shown = useMemo(() => filterIconNames(names, query), [names, query]);

  const toggle = () => {
    const next = !openGrid;
    setOpenGrid(next);
    if (next && !icons) void loadPhosphorIcons().then(setIcons);
  };

  return (
    <div className="flex flex-col gap-1">
      <span className={label}>{spec.label}</span>
      <div className="flex gap-1">
        <input
          type="text"
          className={inputBase}
          value={name}
          placeholder="rocket-launch"
          onChange={(e) => onCommit(e.target.value === '' ? undefined : e.target.value)}
        />
        <button
          type="button"
          onClick={toggle}
          aria-expanded={openGrid}
          className="h-7 shrink-0 rounded border border-border-color px-2 text-[10px] text-text-secondary hover:text-text-primary hover:border-accent"
        >
          {openGrid ? 'Close' : 'Browse…'}
        </button>
      </div>
      {openGrid && (
        <div className="flex flex-col gap-1 rounded border border-border-color p-1.5">
          <input
            type="search"
            className={inputBase}
            value={query}
            placeholder="Search icons"
            onChange={(e) => setQuery(e.target.value)}
          />
          {!icons ? (
            <p className="text-[10px] text-text-secondary">Loading icons…</p>
          ) : (
            <div className="grid grid-cols-6 gap-1 max-h-48 overflow-y-auto" role="listbox" aria-label="Phosphor icons">
              {shown.map((n) => {
                const Glyph = icons.get(n);
                if (!Glyph) return null;
                return (
                  <button
                    key={n}
                    type="button"
                    role="option"
                    aria-selected={n === name}
                    title={n}
                    onClick={() => onCommit(n)}
                    className={`h-8 flex items-center justify-center rounded border transition-colors ${
                      n === name ? 'border-accent text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary hover:border-border-color'
                    }`}
                  >
                    <Glyph size={18} />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

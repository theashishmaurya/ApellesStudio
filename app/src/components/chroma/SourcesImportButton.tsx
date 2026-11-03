// Apelles — importing into the media pool from anywhere a button can sit (v0.3.0,
// B-359 item 3; docs/notes/ui-redesign.md §6e).
//
// What it is: `useSourcesImport` — the one import action (the native picker,
// stills included since D-292, into the bin the Sources grid is showing, with
// the "already in the pool" notice) — and `SourcesImportButton`, the Edit
// browser's tab-row `+ Import` (§4.12: the mockup puts Import on the browser's
// header row, not on a row of its own). The Sources panel's own header Import
// (the Motion / Colorist column) runs the same hook, so both import the same
// way into the same bin (`useShellStore.sourcesActiveFolder`).
//
// What it does NOT do: hold the bin (the shell store does), refresh the pool
// (the pool store's `importPaths` does), or know about tabs.
import { useState } from 'react';
import { toast } from 'react-toastify';
import { PlusIcon } from '@phosphor-icons/react';
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@apelles/ui';
import { useShellStore } from '@apelles/shell';
import { useMediaPoolStore } from '@apelles/bridge';

import { pickClips } from './ProjectLauncher';

export function useSourcesImport(): { importing: boolean; doImport: () => Promise<void> } {
  const importPaths = useMediaPoolStore((s) => s.importPaths);
  const [importing, setImporting] = useState(false);
  const doImport = async () => {
    // D-292 — the media pool takes stills as first-class sources, so its picker
    // offers them; the project-creation picker on the launcher screen does not
    // (its paths become Colorist shots). See `pickClips`.
    const paths = await pickClips({ stills: true });
    if (!paths.length) return;
    setImporting(true);
    const folder = useShellStore.getState().sourcesActiveFolder;
    const res = await importPaths(paths, folder ?? undefined);
    setImporting(false);
    if (!res.ok) toast.error(`Import failed: ${res.error}`);
    else if (res.added && res.added.length < paths.length) {
      toast.info(`${paths.length - res.added.length} clip(s) were already in the pool`);
    }
  };
  return { importing, doImport };
}

/** The Edit browser's tab-row Import: `Plus` always, the word "Import" when
 *  the browser is wide enough to keep its eight tabs readable beside it (a
 *  container query on the row, so it follows the panel's width, not the
 *  window's). */
export function SourcesImportButton() {
  const { importing, doImport } = useSourcesImport();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void doImport()}
            disabled={importing}
            aria-label="Import media"
            data-testid="browser-import"
            className="h-6 shrink-0 gap-1 px-1.5 text-text-secondary hover:text-text-primary"
          >
            <PlusIcon className="size-3.5" />
            <span className="hidden @[300px]:inline">Import</span>
          </Button>
        }
      />
      <TooltipContent side="bottom">
        <span className="font-medium">Import media</span>
        <span className="ml-1.5 text-text-secondary">Referenced in place, never copied</span>
      </TooltipContent>
    </Tooltip>
  );
}

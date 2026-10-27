/**
 * `@apelles/editor` — "Music dropout here": the right-click music actions on a
 * transcript line or a marker (D-408).
 *
 * **What it is.** A context menu wrapped around a list whose rows each name a
 * stretch of the timeline. Right-clicking a row (the row reports itself
 * through `onContextMenu` before the menu opens) offers: cut a music dropout
 * over it, cut a one-second stop-time breath before it, or add the dropout to
 * the Music edits list for review. This is the edit-by-text gesture Descript
 * made familiar — select the words, act on them — applied to the music bed:
 * the transcript line IS the selection. Reference notes:
 * `scratch/music-edit-reference/`.
 *
 * **What it does NOT do.** It owns no edit logic: every item calls
 * `quickMusicEdit` (`musicEditOps.ts`), the same function the Music edits
 * panel's form calls, which resolves the bed and dispatches the one
 * `music_edits` op the MCP tools use. Its only state is the sentence it shows
 * after an action.
 */

import { useState, type ReactNode } from 'react';
import { MusicNotesMinusIcon, PauseIcon, ListPlusIcon, XIcon } from '@phosphor-icons/react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@apelles/ui';

import { breathBefore } from './musicEdits';
import { quickMusicEdit } from './musicEditOps';
import { timelineFps } from './timeline';
import { useEditorTimelineStore } from './timelineStore';

/** The stretch the right-clicked row names. A point (a marker without a
 *  duration) has `end === start` and only offers the breath. */
export interface MusicEditTarget {
  start: number;
  end: number;
  /** "this line" / "this marker" — the menu's wording. */
  noun: string;
  /** The row's words, kept on a review row. */
  text?: string;
}

export function MusicEditMenu({ target, children }: { target: MusicEditTarget | null; children: ReactNode }) {
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const fps = timelineFps(useEditorTimelineStore((s) => s.timeline));
  const breath = target ? breathBefore(target.start, fps) : null;
  const ranged = !!target && target.end > target.start;

  return (
    <>
      {notice && (
        <button
          type="button"
          data-chroma-music-edit-notice={notice.ok ? 'ok' : 'error'}
          onClick={() => setNotice(null)}
          title="Dismiss"
          className={`mb-1 flex w-full items-start gap-1 rounded border border-border-color px-2 py-1 text-left text-[11px] leading-snug ${
            notice.ok ? 'text-text-secondary' : 'text-destructive'
          }`}
        >
          <span className="flex-1">{notice.message}</span>
          <XIcon className="mt-0.5 size-3 shrink-0" />
        </button>
      )}
      <ContextMenu>
        <ContextMenuTrigger>{children}</ContextMenuTrigger>
        <ContextMenuContent data-chroma-music-edit-menu="">
          <ContextMenuGroup>
          <ContextMenuLabel className="text-[11px] text-text-secondary">Music</ContextMenuLabel>
          <ContextMenuItem
            disabled={!ranged}
            data-chroma-music-edit-action="dropout"
            onClick={() => target && setNotice(quickMusicEdit({ kind: 'dropout', start: target.start, end: target.end }))}
          >
            <MusicNotesMinusIcon className="size-3.5" /> Music dropout over {target?.noun ?? 'this'}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!breath}
            data-chroma-music-edit-action="breath"
            onClick={() => breath && setNotice(quickMusicEdit({ kind: 'breath', start: breath.start, end: breath.end }))}
          >
            <PauseIcon className="size-3.5" /> Stop-time breath before {target?.noun ?? 'this'}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={!ranged}
            data-chroma-music-edit-action="review"
            onClick={() =>
              target &&
              setNotice(
                quickMusicEdit({ kind: 'dropout', start: target.start, end: target.end, text: target.text, review: true }),
              )
            }
          >
            <ListPlusIcon className="size-3.5" /> Add dropout to Music edits for review
          </ContextMenuItem>
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>
    </>
  );
}

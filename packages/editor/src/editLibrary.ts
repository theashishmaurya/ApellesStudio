/**
 * @apelles/editor — the Edit tab's LIBRARY MODES (D-263).
 *
 * **What it is.** The closed set of things the one docked left-hand library
 * column can be showing — `sources` (the shell's shared media pool),
 * `titles`, `effects`, `subtitles` — their labels, and the parser that turns
 * an untyped id into one of them or refuses it by name (D-216's rule, the same
 * shape `clipInspectorTabs.ts`'s `parseClipInspectorTab` and
 * `panelRegistry.ts`'s `parsePanelId` already use).
 *
 * **What it does NOT do.** It holds no state (that is `timelineStore.ts`'s
 * `libraryMode`), renders nothing, and knows nothing about the panel's
 * contents — `EditLibraryRail.tsx` renders one button per mode and
 * `EditLibraryPanel.tsx` renders the content for the active one.
 *
 * **Why `sources` is in this list even though `@apelles/editor` does not own
 * it.** The Sources panel is shell-level (`Shell.tsx`'s `sourcesPanel`, D-046/
 * D-116) and lives in `app/`, so this package cannot render it. But it IS one
 * of the four things the rail switches between, and leaving it out would mean
 * the rail's active-mode state had a fourth value expressed some other way —
 * a boolean beside an enum, which is exactly how two sources of truth start.
 * `sources` is therefore the mode in which this package's own docked panel
 * renders NOTHING and the composition root (`Root.tsx`) hands `Shell` no
 * `libraryPanel`, so the shared Sources column shows instead. See D-263.
 */

/** Every mode the Edit tab's library column can be showing, in the order the
 *  rail renders them top-to-bottom. `sources` first: it is the shared media
 *  pool, the one every tab has and the one an edit starts from. */
export const EDIT_LIBRARY_MODES = ['sources', 'titles', 'effects', 'subtitles'] as const;

export type EditLibraryMode = (typeof EDIT_LIBRARY_MODES)[number];

/** The default: the media pool, which is what the docked column showed before
 *  this rail could switch it (D-046) and what an edit starts from. */
export const DEFAULT_EDIT_LIBRARY_MODE: EditLibraryMode = 'sources';

/** The rail's own tooltips and the docked panel's header, from one place so a
 *  button and the panel it opens can never disagree about what it is called. */
export const EDIT_LIBRARY_MODE_LABELS: Record<EditLibraryMode, string> = {
  sources: 'Sources',
  titles: 'Titles',
  effects: 'Effects',
  subtitles: 'Subtitles',
};

/** Parse an untyped library-mode id, or say why it is not one. Recognise or
 *  refuse by name — never coerce a typo into a silent no-op (D-216). */
export function parseEditLibraryMode(raw: unknown): EditLibraryMode | null {
  if (typeof raw !== 'string') return null;
  const normalised = raw.trim().toLowerCase();
  return (EDIT_LIBRARY_MODES as readonly string[]).includes(normalised)
    ? (normalised as EditLibraryMode)
    : null;
}

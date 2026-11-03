/**
 * @apelles/editor — one track's header in the timeline's left column
 * (D-432 P3, `docs/notes/ui-redesign.md` §4.8; reorder D-098, ducking D-149,
 * beat grid D-413; extracted from `TimelinePane.tsx`).
 *
 * What it is: the Resolve-style header row. Left to right: a 3 px strip in the
 * track's kind colour, the `V1` / `A1` / `C1` ID pill, the track's name
 * (double-click renames it inline), and its toggles — lock, sync lock, and
 * visibility (video) or mute / ducking / beat grid (audio). A toggle is shown
 * on row hover or keyboard focus, and always while it is in its non-default
 * state (a locked track always shows its lock), so the column is quiet at rest
 * (the owner's 2026-11-01 screenshot: every toggle and a red trash on every
 * row). A `DotsThree` menu, and the same menu on right-click, holds Rename,
 * Track height (S / M / L / XL / default) and Delete track — delete is not a
 * per-row button any more (§6 defect 9).
 *
 * The whole row is the reorder handle (dnd-kit sortable, D-098): press and
 * drag past dnd-kit's 4 px activation distance, `grab` / `grabbing` cursor —
 * no dots grip (§6 defect 10). The row's bottom 6 px is the height-drag zone
 * (`row-resize`); the drag itself is the pane's (`onHeightDragStart`), because
 * its guide line lives in the edit area.
 *
 * What it does NOT do: own any state but the inline rename draft. Every
 * toggle, the rename, the height and the delete are callbacks into the pane,
 * which applies the same ops the MCP tools do (`set_track_locked`,
 * `set_track_name`, `set_track_height`, …).
 */

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import {
  CaretDoubleDownIcon,
  DotsThreeIcon,
  EyeIcon,
  EyeSlashIcon,
  LinkSimpleHorizontalBreakIcon,
  LinkSimpleHorizontalIcon,
  LockSimpleIcon,
  LockSimpleOpenIcon,
  MetronomeIcon,
  PencilSimpleIcon,
  SpeakerSimpleHighIcon,
  SpeakerSimpleSlashIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrubbableNumberInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@apelles/ui';

import type { TrackHeaderDragData } from './dndTargets';
import { TIMELINE_TEST_IDS } from './timelineTestIds';
import { TRACK_NAME_MAX } from './trackOps';
import { TRACK_HEIGHT_PRESET_NAMES, TRACK_HEIGHT_PRESETS } from './trackHeight';
import type { Track } from './timeline';

/** The height-drag zone at the bottom of a header row (and of its lane), px. */
export const TRACK_HEIGHT_ZONE_PX = 6;

/** The menu's radio value for "no height of its own". */
const HEIGHT_DEFAULT = 'default';

/** D-098 — the dnd-kit sortable id of track `index` (shared with the pane's
 *  `SortableContext` and its drag-end handler). */
export function trackDragId(index: number): string {
  return `track:${index}`;
}

/** The track-kind colour strip at the row's far left (§4.8). */
const KIND_STRIP: Record<Track['kind'], string> = {
  video: 'bg-clip-video',
  audio: 'bg-clip-audio',
  subtitle: 'bg-clip-caption',
};

export interface TrackDuck {
  from: number | null;
  db: number;
  attackMs: number;
  releaseMs: number;
}

export interface TrackDuckPatch {
  duckFrom?: number | null;
  duckDb?: number;
  attackMs?: number;
  releaseMs?: number;
}

export interface TrackHeaderProps {
  index: number;
  kind: Track['kind'];
  /** the drawn height (the track's own, else the view default) */
  height: number;
  /** the track's own height, or `null` when it follows the view default */
  ownHeight: number | null;
  /** `V1` / `A1` / `C1` */
  badge: string;
  /** the name shown: the person's own, else the derived "Audio 2" */
  label: string;
  /** whether `label` is the person's own name (the menu offers a reset) */
  renamed: boolean;
  muted: boolean;
  locked: boolean;
  hidden: boolean;
  syncLocked: boolean;
  duck: TrackDuck;
  /** every track's label, for the "duck from" picker */
  trackLabels: string[];
  beatGrid: boolean;
  /** D-440 — this is the timeline's target track: the ID pill is accent. */
  target: boolean;
  /** D-440 — the pill's click: target this track, or clear the target when it
   *  already is (Premiere's targeting toggle). One `set_target_track`. */
  onToggleTarget: () => void;
  onToggleLock: () => void;
  onToggleHidden: () => void;
  onToggleMute: () => void;
  onToggleSyncLocked: () => void;
  onDuckChange: (patch: TrackDuckPatch) => void;
  onToggleBeats: () => void;
  onRename: (name: string | null) => void;
  onSetHeight: (height: number | null) => void;
  onRemove: () => void;
  /** press on the bottom-edge zone: the pane runs the drag (its guide line is
   *  in the edit area) and commits one `set_track_height` on release */
  onHeightDragStart: (e: ReactPointerEvent<HTMLElement>, track: number) => void;
}

/** A header toggle: 20 × 20 with a 14 px icon (§4.8), hidden until the row is
 *  hovered or focused unless `active` (its non-default state). */
function HeaderToggle({
  active,
  label,
  title,
  testId,
  pressed,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  title: string;
  testId?: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className={
        'size-5 shrink-0 rounded-sm [&_svg]:size-3.5 ' +
        (active
          ? 'text-text-primary'
          : 'hidden text-text-secondary group-hover/header:inline-flex group-focus-within/header:inline-flex')
      }
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      data-testid={testId}
      data-chroma-active={active ? '' : undefined}
      aria-pressed={pressed}
      aria-label={label}
      title={title}
    >
      {children}
    </Button>
  );
}

/** D-149 — the ducking control: which track ducks this one, and the three DSP
 *  numbers behind it. A popover rather than inline fields because the header
 *  row has room for one line only. Audio tracks only (post-D-129 a video's
 *  sound lives on its own linked audio track); `set_track_duck` over MCP still
 *  reaches any track. Moved here from `TimelinePane.tsx` with the header. */
function TrackDuckControl({
  index,
  duck,
  trackLabels,
  onChange,
}: {
  index: number;
  duck: TrackDuck;
  trackLabels: string[];
  onChange: (patch: TrackDuckPatch) => void;
}) {
  const active = duck.from != null && duck.db !== 0;
  const row = 'flex items-center justify-between gap-2';
  const num = 'h-6 w-16 px-1 text-2xs';
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className={
              'size-5 shrink-0 rounded-sm [&_svg]:size-3.5 ' +
              (active
                ? 'text-accent-text'
                : 'hidden text-text-secondary group-hover/header:inline-flex group-focus-within/header:inline-flex')
            }
            onPointerDown={(e) => e.stopPropagation()}
            data-testid={TIMELINE_TEST_IDS.trackDuck}
            data-chroma-active={active ? '' : undefined}
            aria-label={active ? 'Ducking settings (on)' : 'Ducking settings'}
            title={
              active
                ? `Ducked ${duck.db} dB by ${duck.from != null ? (trackLabels[duck.from] ?? `track ${duck.from + 1}`) : ''}`
                : 'Ducking — lower this track while another one plays'
            }
          >
            <CaretDoubleDownIcon />
          </Button>
        }
      />
      <PopoverContent className="w-64 p-3 text-xs">
        <div className="flex flex-col gap-2">
          <label className={row}>
            <span className="text-text-secondary">Duck from</span>
            <Select
              value={duck.from == null ? 'off' : String(duck.from)}
              onValueChange={(v) => onChange({ duckFrom: v === 'off' ? null : Number(v) })}
            >
              <SelectTrigger className="h-6 w-32 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Off</SelectItem>
                {trackLabels.map((label, i) =>
                  i === index ? null : (
                    <SelectItem key={i} value={String(i)}>
                      {label}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </label>
          <label className={row}>
            <span className="text-text-secondary">Amount (dB)</span>
            <ScrubbableNumberInput step={1} max={0} className={num} value={duck.db} onValueChange={(duckDb) => onChange({ duckDb })} />
          </label>
          <label className={row}>
            <span className="text-text-secondary">Attack (ms)</span>
            <ScrubbableNumberInput step={5} min={0} className={num} value={duck.attackMs} onValueChange={(attackMs) => onChange({ attackMs })} />
          </label>
          <label className={row}>
            <span className="text-text-secondary">Release (ms)</span>
            <ScrubbableNumberInput step={10} min={0} className={num} value={duck.releaseMs} onValueChange={(releaseMs) => onChange({ releaseMs })} />
          </label>
          <p className="pt-1 text-2xs leading-snug text-text-tertiary">
            Lowers this track while the chosen track has a clip playing. Attack is how fast it drops (short, so the duck beats
            the first word); release is how fast it comes back (long, so the bed doesn&apos;t pump between words).
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The row's menu items, shared by the `DotsThree` dropdown and the right-click
 *  context menu so the two can never offer different things. `Item` etc. are
 *  the two menus' own primitives (Base UI's menu and context menu share a
 *  shape but not components). */
interface MenuParts {
  Label: typeof DropdownMenuLabel | typeof ContextMenuLabel;
  Item: typeof DropdownMenuItem | typeof ContextMenuItem;
  Separator: typeof DropdownMenuSeparator | typeof ContextMenuSeparator;
  RadioGroup: typeof DropdownMenuRadioGroup | typeof ContextMenuRadioGroup;
  RadioItem: typeof DropdownMenuRadioItem | typeof ContextMenuRadioItem;
}

const DROPDOWN_PARTS: MenuParts = {
  Label: DropdownMenuLabel,
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  RadioGroup: DropdownMenuRadioGroup,
  RadioItem: DropdownMenuRadioItem,
};
const CONTEXT_PARTS: MenuParts = {
  Label: ContextMenuLabel,
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  RadioGroup: ContextMenuRadioGroup,
  RadioItem: ContextMenuRadioItem,
};

function TrackMenuItems({
  parts: { Label, Item, Separator, RadioGroup, RadioItem },
  ownHeight,
  renamed,
  onStartRename,
  onRename,
  onSetHeight,
  onRemove,
}: {
  parts: MenuParts;
  ownHeight: number | null;
  renamed: boolean;
  onStartRename: () => void;
  onRename: (name: string | null) => void;
  onSetHeight: (height: number | null) => void;
  onRemove: () => void;
}) {
  const heightValue =
    ownHeight == null
      ? HEIGHT_DEFAULT
      : (TRACK_HEIGHT_PRESET_NAMES.find((p) => TRACK_HEIGHT_PRESETS[p] === ownHeight) ?? `custom`);
  return (
    <>
      <Item onClick={onStartRename} data-testid={TIMELINE_TEST_IDS.trackRename}>
        <PencilSimpleIcon />
        Rename…
      </Item>
      {renamed && <Item onClick={() => onRename(null)}>Reset name</Item>}
      <Separator />
      <RadioGroup
        value={heightValue}
        onValueChange={(v: unknown) => {
          if (v === HEIGHT_DEFAULT) onSetHeight(null);
          else if (typeof v === 'string' && v in TRACK_HEIGHT_PRESETS) onSetHeight(TRACK_HEIGHT_PRESETS[v as keyof typeof TRACK_HEIGHT_PRESETS]);
        }}
      >
        {/* Inside the group: Base UI's group label must sit in its group. */}
        <Label>Track height</Label>
        {TRACK_HEIGHT_PRESET_NAMES.map((p) => (
          <RadioItem key={p} value={p} data-chroma-track-height-preset={p}>
            {p} <span className="ml-auto pl-3 font-mono text-text-tertiary">{TRACK_HEIGHT_PRESETS[p]}</span>
          </RadioItem>
        ))}
        <RadioItem value={HEIGHT_DEFAULT} data-chroma-track-height-preset={HEIGHT_DEFAULT}>
          Follow Clip Appearance
        </RadioItem>
      </RadioGroup>
      <Separator />
      <Item variant="destructive" onClick={onRemove} data-testid={TIMELINE_TEST_IDS.trackRemove}>
        <TrashIcon />
        Delete track
      </Item>
    </>
  );
}

export function TrackHeader(props: TrackHeaderProps) {
  const {
    index,
    kind,
    height,
    ownHeight,
    badge,
    label,
    renamed,
    muted,
    locked,
    hidden,
    syncLocked,
    duck,
    trackLabels,
    beatGrid,
    target,
    onToggleTarget,
    onToggleLock,
    onToggleHidden,
    onToggleMute,
    onToggleSyncLocked,
    onDuckChange,
    onToggleBeats,
    onRename,
    onSetHeight,
    onRemove,
    onHeightDragStart,
  } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: trackDragId(index),
    // B-122 — `'track-header'`, not `'track'`: a sortable is a droppable too,
    // and the lane droppable answers to `'track-lane'`. See `dndTargets.ts`.
    data: { type: 'track-header' as const, index } satisfies TrackHeaderDragData,
  });
  const [renaming, setRenaming] = useState(false);
  const isVideo = kind === 'video';
  const isAudio = kind === 'audio';

  const style: CSSProperties = {
    height,
    transform: DndCSS.Transform.toString(transform),
    transition,
    // §4.8 — the dragged header lifts at 0.9 (dnd-kit moves it; the others
    // slide out of the way).
    opacity: isDragging ? 0.9 : 1,
  };

  const menuProps = {
    ownHeight,
    renamed,
    onStartRename: () => setRenaming(true),
    onRename,
    onSetHeight,
    onRemove,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid={TIMELINE_TEST_IDS.trackHeader}
      data-chroma-track={index}
      data-chroma-track-locked={locked ? '' : undefined}
      className={
        'group/header relative cursor-grab border-b border-border-color active:cursor-grabbing ' +
        (isDragging ? 'z-10 bg-surface-raised ' : '')
      }
      {...attributes}
      {...listeners}
      // dnd-kit's attributes make the row a focusable `role="button"`; the
      // name says what pressing it does.
      aria-label={`${badge} ${label}: drag to reorder`}
    >
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div className="flex h-full items-center gap-1.5 pr-1 pl-0" />
          }
        >
          <span aria-hidden className={'h-full w-[3px] shrink-0 ' + KIND_STRIP[kind]} />
          {/* D-440 — the ID pill is the target-track control (§4.8: "the pill
              turns accent when the track is the target for edits"). A real
              button: click (or Enter / Space) targets the track, again clears
              it; its press never starts the header's reorder drag. */}
          <button
            type="button"
            data-testid={TIMELINE_TEST_IDS.trackBadge}
            data-chroma-target={target ? '' : undefined}
            aria-pressed={target}
            aria-label={target ? `${badge} is the target track: click to clear` : `Target ${badge}`}
            title={
              target
                ? 'Target track: edits that name no track land here (the viewer’s edit overlay). Click to clear.'
                : 'Make this the target track: edits that name no track land here'
            }
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onToggleTarget();
            }}
            className={
              'flex h-4 w-5 shrink-0 items-center justify-center rounded-xs font-mono text-2xs font-semibold outline-none focus-visible:ring-1 focus-visible:ring-focus-ring ' +
              (target ? 'bg-accent text-button-text' : 'bg-bg-secondary text-text-secondary hover:text-text-primary')
            }
          >
            {badge}
          </button>
          {renaming ? (
            <TrackNameInput
              initial={label}
              onCommit={(name) => {
                setRenaming(false);
                if (name !== label) onRename(name);
              }}
              onCancel={() => setRenaming(false)}
            />
          ) : (
            <span
              data-testid={TIMELINE_TEST_IDS.trackName}
              className={'min-w-0 flex-1 truncate text-xs ' + (locked ? 'text-text-secondary' : 'text-text-primary')}
              title={`${label} — double-click to rename`}
              onDoubleClick={(e) => {
                e.stopPropagation();
                setRenaming(true);
              }}
            >
              {label}
            </span>
          )}
          {/* The toggles sit OVER the name's right end rather than beside
              it: hidden ones take no room at rest (so the name gets the whole
              row), and revealing them on hover changes no layout. */}
          <div className="absolute inset-y-0 right-0 flex items-center bg-surface pr-1 empty:hidden">
            <HeaderToggle
              active={locked}
              pressed={locked}
              testId={TIMELINE_TEST_IDS.trackLock}
              label={locked ? 'Unlock track' : 'Lock track'}
              title={locked ? 'Unlock track' : 'Lock track (its clips cannot be edited)'}
              onClick={onToggleLock}
            >
              {locked ? <LockSimpleIcon /> : <LockSimpleOpenIcon />}
            </HeaderToggle>
            {/* D-106 — sync lock is ON by default, so OFF is the state that
                stays visible. */}
            <HeaderToggle
              active={!syncLocked}
              pressed={syncLocked}
              testId={TIMELINE_TEST_IDS.trackSyncLock}
              label={syncLocked ? 'Disable sync lock' : 'Enable sync lock'}
              title={
                syncLocked
                  ? 'Sync lock on — ripples on other tracks shift this one too'
                  : 'Sync lock off — ripples on other tracks skip this one'
              }
              onClick={onToggleSyncLocked}
            >
              {syncLocked ? <LinkSimpleHorizontalIcon /> : <LinkSimpleHorizontalBreakIcon />}
            </HeaderToggle>
            {isVideo && (
              <HeaderToggle
                active={hidden}
                pressed={!hidden}
                testId={TIMELINE_TEST_IDS.trackHide}
                label={hidden ? 'Show track' : 'Hide track'}
                title={hidden ? 'Show track (excluded from compositing)' : 'Hide track'}
                onClick={onToggleHidden}
              >
                {hidden ? <EyeSlashIcon /> : <EyeIcon />}
              </HeaderToggle>
            )}
            {isAudio && (
              <HeaderToggle
                active={muted}
                pressed={muted}
                testId={TIMELINE_TEST_IDS.trackMute}
                label={muted ? 'Unmute track' : 'Mute track'}
                title={muted ? 'Unmute track' : 'Mute track'}
                onClick={onToggleMute}
              >
                {muted ? <SpeakerSimpleSlashIcon /> : <SpeakerSimpleHighIcon />}
              </HeaderToggle>
            )}
            {isAudio && <TrackDuckControl index={index} duck={duck} trackLabels={trackLabels} onChange={onDuckChange} />}
            {isAudio && (
              <HeaderToggle
                active={beatGrid}
                pressed={beatGrid}
                testId={TIMELINE_TEST_IDS.trackBeats}
                label={beatGrid ? 'Hide beats' : 'Show beats'}
                title={beatGrid ? "Hide this track's beat grid" : "Show this track's beats on the timeline (and snap to them)"}
                onClick={onToggleBeats}
              >
                <MetronomeIcon />
              </HeaderToggle>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="hidden size-5 shrink-0 rounded-sm text-text-secondary group-hover/header:inline-flex group-focus-within/header:inline-flex data-[popup-open]:inline-flex [&_svg]:size-3.5"
                    onPointerDown={(e) => e.stopPropagation()}
                    data-testid={TIMELINE_TEST_IDS.trackMenu}
                    aria-label={`${label} track menu`}
                    title="Track menu"
                  >
                    <DotsThreeIcon weight="bold" />
                  </Button>
                }
              />
              <DropdownMenuContent align="start" className="min-w-48">
                <TrackMenuItems parts={DROPDOWN_PARTS} {...menuProps} />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-48">
          <TrackMenuItems parts={CONTEXT_PARTS} {...menuProps} />
        </ContextMenuContent>
      </ContextMenu>
      {/* §4.8 — the bottom-edge height zone: drag between 32 and 200 px,
          double-click resets to the view default. Its press is the pane's. */}
      <div
        data-testid={TIMELINE_TEST_IDS.trackHeightResize}
        data-chroma-track={index}
        aria-hidden
        className="absolute inset-x-0 bottom-0 cursor-row-resize"
        style={{ height: TRACK_HEIGHT_ZONE_PX }}
        onPointerDown={(e) => {
          e.stopPropagation();
          onHeightDragStart(e, index);
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onSetHeight(null);
        }}
      />
    </div>
  );
}

/** The inline rename field. Enter or blur commits, Esc cancels. Its presses
 *  never start a reorder drag (the row is the sortable handle). */
function TrackNameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(draft.trim());
    else onCancel();
  };
  return (
    <input
      ref={ref}
      data-testid={TIMELINE_TEST_IDS.trackNameInput}
      aria-label="Track name"
      maxLength={TRACK_NAME_MAX}
      className="h-5 min-w-0 flex-1 rounded-xs bg-bg-secondary px-1 text-xs text-text-primary outline-none focus-visible:ring-1 focus-visible:ring-focus-ring"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // The timeline's own shortcuts (Delete, V, M, …) must not fire while
        // typing a name.
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}

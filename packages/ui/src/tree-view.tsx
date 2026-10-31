/**
 * @apelles/ui — `TreeView` / `TreeItem` (D-436): a generic, domain-free
 * disclosure tree (folders, bins, outline rows).
 *
 * What it is: the WAI-ARIA tree pattern as two small components. `TreeView` is
 * the `role="tree"` container and owns the vertical arrow-key navigation;
 * `TreeItem` is one `role="treeitem"` with a disclosure caret, an icon, a
 * label, an optional trailing slot and nested `TreeItem` children. Nesting
 * depth (indent, `aria-level`) comes from context, so callers never pass it.
 *
 * Behaviour: clicking the caret toggles; clicking the row calls `onSelect`
 * (it never toggles — selecting a folder and folding it are different acts).
 * Keys on a focused row: Up/Down move through the VISIBLE rows (a closed
 * item's children are not mounted, so DOM order is visible order), Home/End
 * jump, Right expands a closed item or steps into its first child, Left
 * collapses an open item or steps to its parent, Enter/Space select.
 * `open` is controlled (`open` + `onOpenChange`) or uncontrolled (`defaultOpen`).
 *
 * What it does NOT do: know what a row represents, drag and drop, context
 * menus, or persist anything — a caller layers those through `rowProps` (any
 * div attributes: drag handlers, data attributes) and `wrapRow` (wrap the row
 * element, e.g. in a context-menu trigger). Colours are the existing
 * `--color-*` tokens through Tailwind utilities; the caret is Phosphor.
 */
import {
  Children,
  createContext,
  useContext,
  useState,
  type ComponentProps,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react';

import { cn } from './lib/utils';

/** Indent per nesting level and the base inset, in px (a named constant, not a
 *  magic number at the call site). */
const TREE_INDENT_PX = 14;
const TREE_BASE_INSET_PX = 4;

const TreeLevelContext = createContext(0);

const ROW_SELECTOR = '[data-tree-row]';

function visibleRows(from: HTMLElement): HTMLElement[] {
  const tree = from.closest('[role="tree"]');
  return tree ? Array.from(tree.querySelectorAll<HTMLElement>(ROW_SELECTOR)) : [];
}

export function TreeView({ className, onKeyDown, ...props }: ComponentProps<'div'>) {
  return (
    <div
      role="tree"
      data-slot="tree-view"
      className={cn('flex flex-col', className)}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;
        const target = e.target as HTMLElement;
        if (!target.matches(ROW_SELECTOR)) return;
        const rows = visibleRows(target);
        const i = rows.indexOf(target);
        const go = (to: number) => {
          e.preventDefault();
          rows[Math.max(0, Math.min(rows.length - 1, to))]?.focus();
        };
        if (e.key === 'ArrowDown') go(i + 1);
        else if (e.key === 'ArrowUp') go(i - 1);
        else if (e.key === 'Home') go(0);
        else if (e.key === 'End') go(rows.length - 1);
      }}
      {...props}
    />
  );
}

export interface TreeItemProps extends Omit<ComponentProps<'div'>, 'children' | 'onSelect'> {
  /** The row's text (or any node). */
  label: ReactNode;
  icon?: ReactNode;
  /** Rendered at the row's right edge (an action button, a count). */
  trailing?: ReactNode;
  selected?: boolean;
  onSelect?: () => void;
  /** Controlled open state; omit for uncontrolled. */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Show the caret and allow folding even with no children rendered yet
   *  (defaults to "has children"). */
  expandable?: boolean;
  /** Extra attributes for the focusable row element (drag handlers, ...). */
  rowProps?: HTMLAttributes<HTMLDivElement> & { [dataAttr: `data-${string}`]: string | undefined };
  /** Wrap the row element, e.g. `(row) => <ContextMenuTrigger>{row}</ContextMenuTrigger>`. */
  wrapRow?: (row: ReactElement) => ReactElement;
  /** Nested `TreeItem`s, shown while open. */
  children?: ReactNode;
}

export function TreeItem({
  label,
  icon,
  trailing,
  selected = false,
  onSelect,
  open: openProp,
  defaultOpen = true,
  onOpenChange,
  expandable,
  rowProps,
  wrapRow,
  className,
  children,
  ...props
}: TreeItemProps) {
  const level = useContext(TreeLevelContext);
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  const canExpand = expandable ?? Children.count(children) > 0;
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  };

  const { className: rowClassName, onKeyDown: rowKeyDown, onClick: rowClick, ...restRow } = rowProps ?? {};

  const row = (
    <div
      role="none"
      data-tree-row
      data-selected={selected || undefined}
      tabIndex={0}
      {...restRow}
      onClick={(e) => {
        rowClick?.(e);
        if (!e.defaultPrevented) onSelect?.();
      }}
      onKeyDown={(e) => {
        rowKeyDown?.(e);
        if (e.defaultPrevented || e.target !== e.currentTarget) return;
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          if (canExpand && open) setOpen(false);
          else {
            // Step to the parent row (the first row inside the enclosing item;
            // `wrapRow` may add elements, so no direct-child assumption).
            const own = e.currentTarget.closest('[role="treeitem"]');
            own?.parentElement?.closest('[role="treeitem"]')?.querySelector<HTMLElement>(ROW_SELECTOR)?.focus();
          }
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          if (canExpand && !open) setOpen(true);
          else e.currentTarget.closest('[role="treeitem"]')?.querySelector<HTMLElement>(`[role="group"] ${ROW_SELECTOR}`)?.focus();
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect?.();
        }
      }}
      className={cn(
        'flex items-center gap-1 py-1 pr-2 rounded text-[11px] cursor-pointer select-none outline-none',
        'focus-visible:ring-1 focus-visible:ring-accent',
        selected
          ? 'bg-accent/15 text-text-primary'
          : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover',
        rowClassName,
      )}
      style={{ paddingLeft: TREE_BASE_INSET_PX + level * TREE_INDENT_PX }}
    >
      <span
        data-tree-caret
        aria-hidden={!canExpand}
        onClick={(e) => {
          if (!canExpand) return;
          e.stopPropagation();
          setOpen(!open);
        }}
        className={cn(
          'shrink-0 size-4 flex items-center justify-center rounded hover:bg-surface-hover',
          !canExpand && 'invisible',
        )}
      >
        {open ? <CaretDownIcon className="size-3" /> : <CaretRightIcon className="size-3" />}
      </span>
      {icon}
      <span className="min-w-0 flex items-center gap-1 truncate">{label}</span>
      {trailing && <span className="ml-auto flex shrink-0 items-center">{trailing}</span>}
    </div>
  );

  return (
    <div
      role="treeitem"
      data-slot="tree-item"
      aria-level={level + 1}
      aria-selected={selected}
      aria-expanded={canExpand ? open : undefined}
      className={className}
      {...props}
    >
      {wrapRow ? wrapRow(row) : row}
      {canExpand && open && children != null && (
        <TreeLevelContext.Provider value={level + 1}>
          <div role="group">{children}</div>
        </TreeLevelContext.Provider>
      )}
    </div>
  );
}

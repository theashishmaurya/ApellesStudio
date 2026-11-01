/**
 * html5Drag.ts — `debug_pointer`'s `html5Drag` action: an HTML5 drag-and-drop
 * (`dragstart` → `dragenter`/`dragover` along a path → `drop` → `dragend`) with
 * one real `DataTransfer`, dispatched through the page's own handlers
 * (B-360, owner 2026-11-01: "please add this in the harness").
 *
 * Why it exists: a media drag from the Sources panel onto the timeline is an
 * HTML5 drag, and macOS starts the native drag session behind it
 * (`NSDraggingSession`) only from a real mouse-dragged event in a live event
 * loop. WebKit's injected `mouseDown:`/`mouseDragged:` (the `native` mode) do
 * not start one, so a native drag from a `draggable` element never produces a
 * `drop` (verified live 2026-11-01). This action drives the same handlers the
 * session would call instead: the source's `onDragStart` fills the transfer,
 * the drop target's `onDragOver` accepts it, and its `onDrop` reads it.
 *
 * What it does NOT do: test the OS drag session itself (the drag image, the
 * cursor badge, dragging in from Finder). Events are `isTrusted: false`; the
 * reply says so, so a pass is never mistaken for native delivery.
 *
 * Debug-only: reached only through `debug_pointer`, which is compiled out of a
 * release bundle (B-358's `APELLES_DEBUG_TOOLS`).
 */
import { describeElement } from './geometry';

export interface DragPoint {
  x: number;
  y: number;
}

export interface Html5DragReport {
  mode: 'synthetic-html5';
  trusted: false;
  /** The element `dragstart` went to (the nearest `[draggable="true"]` under the start point). */
  source: string | null;
  /** The element under the final point, which got `dragover` and `drop`. */
  dropTarget: string | null;
  /** Whether the source's `dragstart` put anything in the transfer. */
  dataTypes: string[];
  /** A drop happens only if the final `dragover` was accepted (its default prevented), as in a browser. */
  dropAccepted: boolean;
  dropped: boolean;
  /** `dragover` events dispatched along the path. */
  overEvents: number;
}

/** A transfer the page can write in `dragstart` and read in `drop`. WebKit and
 *  Chromium construct a real one; jsdom has none, so a minimal store stands in
 *  with the same `setData`/`getData`/`types` contract the handlers use. */
function makeTransfer(): DataTransfer {
  if (typeof DataTransfer === 'function') {
    try {
      return new DataTransfer();
    } catch {
      // fall through to the stand-in
    }
  }
  const store = new Map<string, string>();
  const stand = {
    dropEffect: 'none',
    effectAllowed: 'all',
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    get types() {
      return Array.from(store.keys());
    },
    setData: (format: string, data: string) => void store.set(format, data),
    getData: (format: string) => store.get(format) ?? '',
    clearData: (format?: string) => (format ? void store.delete(format) : store.clear()),
    setDragImage: () => {},
  };
  return stand as unknown as DataTransfer;
}

function dragEvent(type: string, p: DragPoint, dataTransfer: DataTransfer): Event {
  const init = { bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y };
  if (typeof DragEvent === 'function') {
    try {
      return new DragEvent(type, { ...init, dataTransfer });
    } catch {
      // some engines refuse a non-native transfer: fall through
    }
  }
  const e = new MouseEvent(type, init);
  Object.defineProperty(e, 'dataTransfer', { value: dataTransfer });
  return e;
}

const nextFrame = () =>
  new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });

function lerp(a: DragPoint, b: DragPoint, t: number): DragPoint {
  return { x: Math.round((a.x + (b.x - a.x) * t) * 10) / 10, y: Math.round((a.y + (b.y - a.y) * t) * 10) / 10 };
}

/** Run the drag from `points[0]` through `points[1..]`, `steps` interpolated
 *  `dragover`s per segment, one animation frame between events so the page's
 *  preview (React state set in `onDragOver`) renders as it does for a hand. */
export async function runHtml5Drag(points: readonly DragPoint[], steps = 8): Promise<Html5DragReport | { error: string }> {
  if (points.length < 2) return { error: "an html5Drag needs a 'target' (where the drag starts) and a 'to' (where it drops)" };
  const start = points[0];
  const under = document.elementFromPoint(start.x, start.y);
  const source = under?.closest('[draggable="true"]') ?? null;
  if (!source) {
    return { error: `nothing draggable at the start point (${describeElement(under) ?? 'no element'}): an html5Drag starts on a [draggable="true"] element` };
  }
  const transfer = makeTransfer();
  source.dispatchEvent(dragEvent('dragstart', start, transfer));
  const dataTypes = Array.from(transfer.types ?? []);
  await nextFrame();

  let current: Element | null = null;
  let overEvents = 0;
  let accepted = false;
  const segments = Math.max(1, Math.round(steps));
  for (let i = 1; i < points.length; i += 1) {
    for (let s = 1; s <= segments; s += 1) {
      const p = lerp(points[i - 1], points[i], s / segments);
      const el = document.elementFromPoint(p.x, p.y);
      if (el !== current) {
        current?.dispatchEvent(dragEvent('dragleave', p, transfer));
        el?.dispatchEvent(dragEvent('dragenter', p, transfer));
        current = el;
      }
      if (el) {
        const over = dragEvent('dragover', p, transfer);
        el.dispatchEvent(over);
        accepted = over.defaultPrevented;
        overEvents += 1;
      }
      await nextFrame();
    }
  }

  const end = points[points.length - 1];
  const dropTarget = document.elementFromPoint(end.x, end.y);
  let dropped = false;
  if (dropTarget && accepted) {
    dropTarget.dispatchEvent(dragEvent('drop', end, transfer));
    dropped = true;
  } else {
    dropTarget?.dispatchEvent(dragEvent('dragleave', end, transfer));
  }
  source.dispatchEvent(dragEvent('dragend', end, transfer));
  await nextFrame();
  return {
    mode: 'synthetic-html5',
    trusted: false,
    source: describeElement(source),
    dropTarget: describeElement(dropTarget),
    dataTypes,
    dropAccepted: accepted,
    dropped,
    overEvents,
  };
}

/**
 * gestureCursor.ts - the cursor an edit gesture shows everywhere while it runs
 * (D-432 P2 spec §5.1 "Cursors"; B-374, D-437 S11).
 *
 * What it is: one transparent, full-window layer (`fixed inset-0`, above the
 * page) that carries the gesture's CSS cursor. It is shown on the press and
 * hidden on the release, so a roll that passes over a clip body, a marker or the
 * Inspector shows `col-resize` the whole way instead of each element's own cursor.
 *
 * Why a layer and not a stylesheet rule: the rule this replaced,
 * `[data-chroma-edit-gesture] * { cursor: inherit !important }`, matched every
 * descendant of the edit area, so adding or removing the attribute invalidated
 * the style of every clip and everything inside it. At 300 clips that was a
 * ~20 ms style recalculation on the release frame (and again on the first move
 * frame), measured live in the production bundle. Showing or hiding one element
 * restyles one element.
 *
 * The layer takes the hit test while it is shown, which changes nothing for the
 * gesture: the clip body holds pointer capture and the gesture listens on
 * `window`. It also means the `click` a native release produces lands on the
 * layer's parent (`body`), not on a clip, the same as a release outside the
 * timeline.
 *
 * What it does NOT do: decide which cursor a gesture uses (`useEditGesture.ts`),
 * or style anything else.
 */

/** Test id, so a DOM test or the harness can find the layer. */
export const GESTURE_CURSOR_TEST_ID = 'timeline-gesture-cursor';

let layer: HTMLDivElement | null = null;

/** Show `cursor` over the whole window until {@link hideGestureCursor}. */
export function showGestureCursor(cursor: string, doc: Document = document): void {
  if (!layer || layer.ownerDocument !== doc || !layer.isConnected) {
    layer = doc.createElement('div');
    layer.dataset.testid = GESTURE_CURSOR_TEST_ID;
    layer.setAttribute('aria-hidden', 'true');
    // Above the page and its popovers (z-50, appended last); transparent.
    layer.className = 'fixed inset-0 z-50';
    doc.body.appendChild(layer);
  }
  layer.style.cursor = cursor;
  layer.hidden = false;
}

/** Hide the layer again (the element stays, so the next gesture only unhides it). */
export function hideGestureCursor(): void {
  if (layer) layer.hidden = true;
}

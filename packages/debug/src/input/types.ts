/**
 * types.ts — the shapes the UI-harness input tools speak (D-434).
 *
 * `LowEvent` is the wire format between the plan (`plan.ts`) and the two
 * dispatchers: the in-webview synthetic one (`dispatchSynthetic.ts`) and the
 * native one, which sends the same list to Rust
 * (`app/src-tauri/src/chroma/debug_input.rs`, which deserialises exactly
 * these field names). Coordinates are CSS pixels in viewport space — the same
 * space `getBoundingClientRect()` and `debug_dom_tree` report.
 */

export interface Modifiers {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  /** Cmd on macOS. */
  meta: boolean;
}

export const NO_MODIFIERS: Modifiers = { shift: false, ctrl: false, alt: false, meta: false };

export type MouseButton = 'left' | 'right' | 'middle';

/** One primitive input event, with how long to wait BEFORE dispatching it. */
export type LowEvent =
  | {
      kind: 'mouse';
      phase: 'move' | 'down' | 'up';
      x: number;
      y: number;
      button: MouseButton;
      /** DOM `buttons` bitmask held AFTER this event (left 1, right 2, middle 4). */
      buttons: number;
      clickCount: number;
      modifiers: Modifiers;
      delayMs: number;
    }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers: Modifiers; delayMs: number }
  | {
      kind: 'magnify';
      x: number;
      y: number;
      /** Relative change this event applies (0.1 = 10 % larger). */
      magnification: number;
      phase: 'begin' | 'change' | 'end';
      modifiers: Modifiers;
      delayMs: number;
    }
  | {
      kind: 'key';
      phase: 'down' | 'up';
      /** DOM `KeyboardEvent.code`, e.g. `KeyZ`, `Space`, `ArrowLeft`. */
      code: string;
      /** DOM `KeyboardEvent.key` as this press produces it, e.g. `z`, `Z`, ` `. */
      key: string;
      modifiers: Modifiers;
      delayMs: number;
    }
  | {
      kind: 'modifier';
      phase: 'down' | 'up';
      /** `ShiftLeft` / `ControlLeft` / `AltLeft` / `MetaLeft`. */
      code: string;
      key: string;
      /** The modifier state AFTER this press/release. */
      modifiers: Modifiers;
      delayMs: number;
    };

/** Where an input lands. Either raw CSS coordinates, or an element — found by
 *  exactly one of `selector` / `testid` / `nodeId` — and a point inside it. */
export type TargetSpec = PointSpec | RelativeSpec | ElementSpec;

export interface PointSpec {
  x: number;
  y: number;
}

/** Relative to the previous point of the same gesture (only for `to` /
 *  `path` entries): "drag 40 px right of where it was pressed". */
export interface RelativeSpec {
  byX: number;
  byY?: number;
}

export interface ElementSpec {
  selector?: string;
  /** Shorthand for `[data-testid="…"]`. */
  testid?: string;
  /** A `nodeId` from `debug_dom_tree`. */
  nodeId?: string;
  /** Which match, when several do (0-based; negative counts from the end). Default 0. */
  nth?: number;
  /** The point inside the element's box: `fx`/`fy` are fractions of its
   *  width/height (default 0.5 = centre), `dx`/`dy` CSS-px offsets added after. */
  at?: { fx?: number; fy?: number; dx?: number; dy?: number };
}

export interface Point {
  x: number;
  y: number;
}

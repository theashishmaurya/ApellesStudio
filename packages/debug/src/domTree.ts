/**
 * domTree.ts — a bounded, JSON-serialisable snapshot of the running webview's
 * real DOM (D-218, `docs/notes/debug-tooling.md` piece 4).
 *
 * What it is: the "why is this element positioned/sized/styled like that"
 *   answer, taken from the live document itself — element hierarchy, the
 *   attributes that carry meaning (`id`, `class`, `data-*`, `role`, `aria-*`),
 *   the real `getBoundingClientRect()`, and a small, caller-chosen set of
 *   computed styles. A screenshot says *what* it looks like; this says *why*.
 *
 * What it does NOT do: it is not a serialiser of the page. There is no
 *   `outerHTML` dump and no unbounded walk — an agent asking "where is the
 *   Inspector" does not want 20 000 nodes of Tailwind classes, and a payload
 *   that big is worse than useless because it pushes out the answer it
 *   contains. Every call is bounded three ways at once (a root `selector`, a
 *   `maxDepth`, a `maxNodes` budget), each bound is reported back when it
 *   actually bit, and the defaults are deliberately small. It also does not
 *   interpret anything: no React tree, no component names, no "this looks
 *   wrong" — it reports the DOM as it is.
 *
 * Coordinates are **CSS pixels in viewport space**, i.e. exactly what
 * `getBoundingClientRect()` returns. A screenshot from
 * `debug_screenshot` is in DEVICE pixels: multiply by that result's
 * `scaleFactor` to go from a rect here to a pixel there.
 *
 * Pure and injectable (`doc` is a parameter) so it is unit-testable under
 * jsdom without a Tauri window — see `domTree.test.ts`.
 */

/** The computed properties reported when the caller names none. Small on
 *  purpose: these are the ones that answer the layout questions that actually
 *  get asked ("is it displayed", "what box model is it in", "is something
 *  covering it", "is it the right colour"). Anything else is one explicit
 *  `styles` argument away. */
export const DEFAULT_STYLE_PROPS: readonly string[] = [
  'display',
  'position',
  'visibility',
  'opacity',
  'z-index',
  'overflow',
  'color',
  'background-color',
];

/** CSS property names are reported (and looked up) in their canonical
 *  kebab-case form, so `zIndex` and `z-index` from a caller are one key, not
 *  two — `getComputedStyle().getPropertyValue()` only understands the
 *  kebab form, and silently returns `''` for the other. */
export function cssPropName(prop: string): string {
  return prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** Bounds. Chosen so a default call on a real Chroma panel comes back in a
 *  few KB rather than a few MB, and so a caller who wants more has to say so. */
export const DEFAULT_MAX_DEPTH = 12;
export const DEFAULT_MAX_NODES = 300;
export const MAX_MAX_NODES = 5000;
/** Per-node caps — a Tailwind element can carry 40+ classes and a text node
 *  can be a whole paragraph; neither is what the question was about. */
export const MAX_CLASSES = 16;
export const MAX_TEXT_CHARS = 120;

/** Attributes always worth reporting, beyond `id`/`class`: the semantic ones a
 *  query or an assertion would be written against. `data-*` and `aria-*` are
 *  matched by prefix, so `data-chroma-panel` and `aria-pressed` come along
 *  without being enumerated here. */
const SEMANTIC_ATTRS = new Set(['role', 'type', 'name', 'title', 'href', 'src', 'alt', 'hidden', 'disabled']);
const SEMANTIC_ATTR_PREFIXES = ['data-', 'aria-'];

export interface DomRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DomNodeInfo {
  /** lowercased tag name, e.g. `div` */
  tag: string;
  id?: string;
  /** capped at {@link MAX_CLASSES}; `classesTruncated` says when it bit */
  classes?: string[];
  classesTruncated?: true;
  /** `id`/`class` are hoisted above; this is everything else worth keeping */
  attrs?: Record<string, string>;
  /** CSS pixels, viewport space — `getBoundingClientRect()` verbatim */
  rect: DomRect;
  /** only the properties the caller asked for (or {@link DEFAULT_STYLE_PROPS}) */
  styles?: Record<string, string>;
  /** the element's own direct text, trimmed and capped — not its subtree's */
  text?: string;
  /** `display:none` or `visibility:hidden` — this element and everything
   *  under it renders nothing. Its subtree is skipped unless `includeHidden`,
   *  because "why is this invisible" is answered by the flag and the styles
   *  right here, not by 200 more invisible children. */
  invisible?: true;
  /** the element's own box has no area. Deliberately NOT treated as
   *  `invisible` and deliberately not a reason to prune: a zero-size parent
   *  whose children still render is a real layout bug, and pruning there
   *  would hide exactly the thing the dump was opened to find. */
  zeroArea?: true;
  children?: DomNodeInfo[];
  /** children are missing, and this says which bound cut them off */
  childrenTruncated?: 'depth' | 'nodes' | 'invisible';
}

export interface DomTreeOptions {
  /** CSS selector for the root to dump. Default `body`. */
  selector?: string;
  maxDepth?: number;
  maxNodes?: number;
  /** computed style properties to report; `[]` reports none */
  styles?: readonly string[];
  /** walk into elements that render nothing (default false) */
  includeHidden?: boolean;
  /** include each element's own direct text (default true) */
  text?: boolean;
}

export interface DomTreeResult {
  selector: string;
  /** CSS pixels; `devicePixelRatio` converts a rect here to screenshot pixels */
  viewport: { width: number; height: number; devicePixelRatio: number };
  /** how many nodes are actually in `root` */
  nodeCount: number;
  /** the budget that was in force, so a caller can tell "300 nodes" from
   *  "300 nodes and there were more" without scanning for a flag */
  maxNodes: number;
  maxDepth: number;
  /** true when any bound cut the walk short anywhere */
  truncated: boolean;
  root: DomNodeInfo | null;
}

/** `getBoundingClientRect()` rounded to 0.1px. Sub-pixel layout is real and
 *  worth seeing (a half-pixel border seam is a genuine bug class), but 15
 *  decimal places of float noise per node is pure payload. */
function roundRect(rect: { x: number; y: number; width: number; height: number }): DomRect {
  const r = (n: number) => Math.round(n * 10) / 10;
  return { x: r(rect.x), y: r(rect.y), width: r(rect.width), height: r(rect.height) };
}

function isSemanticAttr(name: string): boolean {
  return SEMANTIC_ATTRS.has(name) || SEMANTIC_ATTR_PREFIXES.some((p) => name.startsWith(p));
}

/** The element's OWN text — direct child text nodes only, not its subtree's.
 *  `textContent` on a container returns every descendant's text concatenated,
 *  which for a panel is the whole panel and tells you nothing about the
 *  element you asked about. */
function ownText(el: Element): string | undefined {
  let out = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3 /* TEXT_NODE */) out += node.nodeValue ?? '';
  }
  const trimmed = out.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_TEXT_CHARS ? `${trimmed.slice(0, MAX_TEXT_CHARS)}…` : trimmed;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * Walk `selector`'s subtree and return it as bounded JSON.
 *
 * Throws nothing: an unmatched selector comes back as `root: null` with a
 * `nodeCount` of 0, which the caller turns into a real message. An invalid
 * selector is the one case that genuinely is an error, and it propagates as
 * the `DOMException` `querySelector` itself raises — the caller reports its
 * message, because "your selector is malformed" is a different answer from
 * "nothing matched".
 */
export function serializeDomTree(options: DomTreeOptions = {}, doc: Document = document): DomTreeResult {
  const selector = typeof options.selector === 'string' && options.selector.trim() ? options.selector.trim() : 'body';
  const maxDepth = clampInt(options.maxDepth, DEFAULT_MAX_DEPTH, 0, 64);
  const maxNodes = clampInt(options.maxNodes, DEFAULT_MAX_NODES, 1, MAX_MAX_NODES);
  const styleProps = options.styles === undefined ? DEFAULT_STYLE_PROPS : options.styles;
  const includeHidden = options.includeHidden === true;
  const wantText = options.text !== false;

  const view = doc.defaultView;
  const root = doc.querySelector(selector);

  const result: DomTreeResult = {
    selector,
    viewport: {
      width: view?.innerWidth ?? 0,
      height: view?.innerHeight ?? 0,
      devicePixelRatio: view?.devicePixelRatio ?? 1,
    },
    nodeCount: 0,
    maxNodes,
    maxDepth,
    truncated: false,
    root: null,
  };
  if (!root) return result;

  let budget = maxNodes;

  const visit = (el: Element, depth: number): DomNodeInfo => {
    budget -= 1;
    const info: DomNodeInfo = {
      tag: el.tagName.toLowerCase(),
      rect: roundRect(el.getBoundingClientRect()),
    };

    if (el.id) info.id = el.id;

    const classes = Array.from(el.classList);
    if (classes.length) {
      info.classes = classes.slice(0, MAX_CLASSES);
      if (classes.length > MAX_CLASSES) info.classesTruncated = true;
    }

    const attrs: Record<string, string> = {};
    for (const attr of Array.from(el.attributes)) {
      if (attr.name === 'id' || attr.name === 'class' || attr.name === 'style') continue;
      if (isSemanticAttr(attr.name)) attrs[attr.name] = attr.value;
    }
    if (Object.keys(attrs).length) info.attrs = attrs;

    const computed = view?.getComputedStyle(el);
    if (computed && styleProps.length) {
      const styles: Record<string, string> = {};
      for (const prop of styleProps) {
        const name = cssPropName(prop);
        const value = computed.getPropertyValue(name);
        if (value) styles[name] = value;
      }
      if (Object.keys(styles).length) info.styles = styles;
    }

    const invisible = computed?.display === 'none' || computed?.visibility === 'hidden';
    if (invisible) info.invisible = true;
    if (info.rect.width === 0 && info.rect.height === 0) info.zeroArea = true;

    if (wantText) {
      const text = ownText(el);
      if (text !== undefined) info.text = text;
    }

    if (invisible && !includeHidden) {
      if (el.children.length) {
        info.childrenTruncated = 'invisible';
        result.truncated = true;
      }
      return info;
    }
    if (!el.children.length) return info;
    if (depth >= maxDepth) {
      info.childrenTruncated = 'depth';
      result.truncated = true;
      return info;
    }

    const children: DomNodeInfo[] = [];
    for (const child of Array.from(el.children)) {
      if (budget <= 0) {
        info.childrenTruncated = 'nodes';
        result.truncated = true;
        break;
      }
      children.push(visit(child, depth + 1));
    }
    if (children.length) info.children = children;
    return info;
  };

  result.root = visit(root, 0);
  result.nodeCount = maxNodes - budget;
  return result;
}

/** One open dialog/modal, as the DOM actually reports it. */
export interface OpenDialogInfo {
  tag: string;
  role: string;
  /** the accessible name, when the dialog has one */
  label?: string;
  rect: DomRect;
}

/**
 * Every dialog currently on screen, read off the DOM rather than off a store.
 *
 * Deliberately DOM-derived: Chroma's modals are spread across a dozen
 * independent flags in three different stores (upstream RapidRAW's
 * `useUIStore` alone has seven `…ModalState` fields with seven different
 * shapes), and enumerating them would be a list that silently goes stale the
 * next time someone adds a modal. `role="dialog"` / `role="alertdialog"` /
 * `<dialog open>` is what every one of them renders — Base UI included — so
 * asking the document is both complete and self-maintaining.
 */
export function describeOpenDialogs(doc: Document = document): OpenDialogInfo[] {
  const view = doc.defaultView;
  const nodes = Array.from(doc.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]'));
  return nodes
    .filter((el) => {
      const computed = view?.getComputedStyle(el);
      return computed?.display !== 'none' && computed?.visibility !== 'hidden';
    })
    .map((el) => {
      const info: OpenDialogInfo = {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') ?? 'dialog',
        rect: roundRect(el.getBoundingClientRect()),
      };
      const label =
        el.getAttribute('aria-label') ??
        (el.getAttribute('aria-labelledby')
          ? (doc.getElementById(el.getAttribute('aria-labelledby') as string)?.textContent ?? null)
          : null);
      const trimmed = label?.replace(/\s+/g, ' ').trim();
      if (trimmed) info.label = trimmed.slice(0, MAX_TEXT_CHARS);
      return info;
    });
}

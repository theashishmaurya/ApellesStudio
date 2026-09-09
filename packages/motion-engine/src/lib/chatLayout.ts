/**
 * Chat thread layout + reveal scheduling — the pure core of the `claudechat`
 * primitive (D-258).
 *
 * What it is: deterministic, DOM-free arithmetic that turns a list of chat
 * messages into (a) a stacked vertical layout with a real pixel height per
 * block, (b) the frame each block is revealed on, and (c) the scroll offset
 * that keeps the newest revealed block in view.
 *
 * What it does NOT do: it renders nothing and imports no React — that is
 * `primitives/ClaudeChat.tsx`. It is a separate module for the same reason
 * `interpolateKeys.ts` is: this is the part with correct answers, so it is
 * the part that gets unit tests (CLAUDE.md, "Testing").
 *
 * **Why the text is measured, not asked.** A browser could measure the real
 * wrapped height of a paragraph, but the render-path determinism invariant
 * says the same doc and frame must produce identical pixels, and a
 * measure-then-reflow pass makes a frame's layout depend on font loading
 * having completed — a real source of frame-to-frame drift in a Remotion
 * render. So wrapping is ESTIMATED here from an average glyph width, purely
 * arithmetically, and the component renders into a box of exactly that
 * computed height. The estimate is deliberately conservative (it rounds a
 * partial line up), and every block also gets a real CSS box, so an
 * under-estimate shows as slightly loose spacing rather than clipped text.
 */

/**
 * How wide an average glyph is, as a fraction of the font size.
 *
 * Calibrated against real renders, not assumed: the reference conversation's
 * three assistant paragraphs and its user bubble were rendered through
 * `remotion still` at the primitive's own defaults (329px content column,
 * 17px serif / 15.5px sans) and their true wrapped line counts (3, 3, 1 and
 * 3) were solved back through `wrapLines`. Every ratio in 0.40–0.46 predicts
 * all four correctly for BOTH faces; 0.48 and above over-estimates the serif
 * paragraphs by a whole line each, which showed up in the render as visible
 * dead space under them. 0.45 sits mid-band, so a caller's text is unlikely
 * to fall off either edge.
 *
 * Exposed as `ThreadMetrics.glyphRatio` so a caller using a markedly wider or
 * narrower face can correct it without editing this module.
 */
export const AVG_GLYPH_RATIO = 0.45;

export type ToolIcon = "drive" | "search" | "web" | "code" | "doc" | "none";

/** One block in a thread. `kind` defaults to `'text'`, which is the only kind
 *  that uses `from`. Times (`at`) are in SECONDS, matching the manifest's own
 *  convention everywhere else. */
export interface ChatMessage {
  kind?: "text" | "tool" | "task" | "doc";
  /** `'text'` only — a user message draws a bubble, an assistant message draws
   *  bare serif prose on the page, exactly as the reference app does. */
  from?: "user" | "assistant";
  text?: string;
  /** small bold name printed above a user bubble ("Brooke" in the reference) */
  sender?: string;
  /** `'tool'` / `'task'` / `'doc'` card content */
  label?: string;
  title?: string;
  subtitle?: string;
  meta?: string;
  icon?: ToolIcon;
  /** absolute reveal time in seconds, scene-relative. Omit to use the
   *  automatic `stagger` cadence. */
  at?: number;
}

export interface Conversation {
  /** replaces the header's model chip for this conversation, e.g. "Sonnet 4" */
  model?: string;
  /** header title; defaults to "Claude" */
  title?: string;
  /** the centred greeting shown when this conversation has no messages —
   *  the reference app's welcome screen, expressed as an empty thread */
  welcome?: string;
  messages: ChatMessage[];
}

/** Every vertical metric the layout needs, in screen px. Defaults match the
 *  reference screenshot's proportions at a 393pt-wide screen. */
export interface ThreadMetrics {
  /** usable text width inside the thread's horizontal padding */
  contentWidth: number;
  bodySize: number;
  bodyLineHeight: number;
  bubbleSize: number;
  bubbleLineHeight: number;
  bubblePadX: number;
  bubblePadY: number;
  senderHeight: number;
  toolHeight: number;
  taskHeight: number;
  docHeight: number;
  /** vertical gap between two consecutive blocks */
  gap: number;
  glyphRatio: number;
}

export const DEFAULT_METRICS: ThreadMetrics = {
  contentWidth: 330,
  bodySize: 17,
  bodyLineHeight: 25,
  bubbleSize: 15.5,
  bubbleLineHeight: 22,
  bubblePadX: 14,
  bubblePadY: 12,
  senderHeight: 22,
  toolHeight: 46,
  taskHeight: 62,
  docHeight: 84,
  gap: 16,
  glyphRatio: AVG_GLYPH_RATIO,
};

/**
 * Greedy word-wrap line count for `text` at `fontSize` inside `width`.
 * Deterministic: a word's width is `word.length * fontSize * glyphRatio`, so
 * this depends only on its arguments. A single word longer than the line is
 * charged the number of lines it would occupy rather than overflowing.
 *
 * An explicit `\n` is a HARD break, counted as its own line, because the
 * component renders these blocks `white-space: pre-wrap` — a list of calendar
 * entries or steps authored one per line has to measure the way it draws, or
 * the block's computed height and its real height disagree.
 */
export function wrapLines(
  text: string,
  width: number,
  fontSize: number,
  glyphRatio = AVG_GLYPH_RATIO,
): number {
  if (text.includes("\n")) {
    return text
      .split("\n")
      .reduce((sum, line) => sum + wrapLines(line, width, fontSize, glyphRatio), 0);
  }
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  const per = fontSize * glyphRatio;
  const spaceW = per;
  let lines = 1;
  let used = 0;
  for (const w of words) {
    const ww = w.length * per;
    if (ww > width) {
      // an unbreakable run wider than the column: close the current line and
      // charge it the whole rows it needs.
      if (used > 0) {
        lines += 1;
        used = 0;
      }
      const rows = Math.ceil(ww / width);
      lines += rows - 1;
      used = ww - (rows - 1) * width + spaceW;
      continue;
    }
    const next = used === 0 ? ww : used + spaceW + ww;
    if (next > width) {
      lines += 1;
      used = ww;
    } else {
      used = next;
    }
  }
  return lines;
}

export interface BlockBox {
  /** y of the block's top, relative to the top of the thread content */
  top: number;
  height: number;
}

export interface ThreadLayout {
  blocks: BlockBox[];
  /** total content height, i.e. the bottom of the last block */
  total: number;
}

/** The height one message occupies on its own, excluding the inter-block gap. */
export function blockHeight(m: ChatMessage, mt: ThreadMetrics): number {
  switch (m.kind ?? "text") {
    case "tool":
      return mt.toolHeight;
    case "task":
      return mt.taskHeight;
    case "doc":
      return mt.docHeight;
    default: {
      const text = m.text ?? "";
      if (m.from === "user") {
        const inner = mt.contentWidth - mt.bubblePadX * 2;
        const lines = wrapLines(text, inner, mt.bubbleSize, mt.glyphRatio);
        const bubble = lines * mt.bubbleLineHeight + mt.bubblePadY * 2;
        return bubble + (m.sender ? mt.senderHeight : 0);
      }
      const lines = wrapLines(text, mt.contentWidth, mt.bodySize, mt.glyphRatio);
      return lines * mt.bodyLineHeight;
    }
  }
}

/** Stack every message top-to-bottom with `gap` between them. */
export function layoutThread(
  messages: ChatMessage[],
  mt: ThreadMetrics = DEFAULT_METRICS,
): ThreadLayout {
  const blocks: BlockBox[] = [];
  let y = 0;
  messages.forEach((m, i) => {
    const height = blockHeight(m, mt);
    blocks.push({ top: y, height });
    y += height + (i === messages.length - 1 ? 0 : mt.gap);
  });
  return { blocks, total: y };
}

/**
 * The frame each message is revealed on, relative to the frame the
 * conversation itself became active. A message with an explicit `at`
 * (seconds) pins to that; otherwise it lands `stagger` frames after the
 * previous one. The result is non-decreasing — an explicit `at` earlier than
 * the previous message's reveal is clamped forward rather than reordering the
 * thread, so a mis-authored time degrades to "appears with the one before it"
 * instead of scrambling the conversation.
 */
export function revealFrames(
  messages: ChatMessage[],
  fps: number,
  stagger: number,
  startFrame = 0,
): number[] {
  const out: number[] = [];
  let prev = startFrame - stagger;
  for (const m of messages) {
    const want = m.at !== undefined ? startFrame + Math.round(m.at * fps) : prev + stagger;
    const f = Math.max(want, prev);
    out.push(f);
    prev = f;
  }
  return out;
}

/**
 * How far the thread has scrolled up at `frame`, in px (0 = not scrolled).
 *
 * Bottom-anchored, the way a real chat is: once the revealed content is
 * taller than the viewport, the thread offsets so the newest revealed block's
 * bottom sits at the bottom of the viewport. The offset eases between the
 * previous message's resting offset and the new one across that message's own
 * reveal window, so the scroll and the message's entrance are one movement
 * rather than a jump after it.
 */
export function scrollOffset(
  layout: ThreadLayout,
  reveals: number[],
  frame: number,
  viewportHeight: number,
  revealFrames_ = 12,
): number {
  const resting = (i: number) => {
    if (i < 0) return 0;
    const b = layout.blocks[i];
    if (!b) return 0;
    return Math.max(0, b.top + b.height - viewportHeight);
  };
  // index of the last message whose reveal has started
  let last = -1;
  for (let i = 0; i < reveals.length; i++) {
    if (frame >= reveals[i]) last = i;
  }
  if (last < 0) return 0;
  const from = resting(last - 1);
  const to = resting(last);
  if (from === to) return to;
  const t = Math.min(1, Math.max(0, (frame - reveals[last]) / Math.max(1, revealFrames_)));
  // smoothstep — matches the "gentle settle" feel of design.ease.out without
  // pulling Remotion's interpolate into this DOM-free module.
  const e = t * t * (3 - 2 * t);
  return from + (to - from) * e;
}

/**
 * Which conversation is showing, and the frame it took over on.
 *
 * This is deliberately NOT a new scheduling mechanism: it reads the SAME
 * `active` step schedule (`schema.ts`'s `activeSchema`, `[{at, i}]` in
 * seconds, or a plain index) that `layers`/`layerstack` already use to say
 * "which card is lit when". `engine/registry.ts`'s `resolveActive` is defined
 * in terms of this function so there is one implementation, not two.
 *
 * `since` is what a multi-conversation thread needs on top of the index: the
 * message reveals restart from the moment the conversation appeared, so
 * switching conversations replays the new one's messages from its own zero
 * instead of showing it already fully built.
 */
export function resolveActiveStep(
  a: number | { at: number; i: number }[] | undefined,
  fps: number,
  frame: number,
  fallback = -1,
): { i: number; since: number } {
  if (a === undefined) return { i: fallback, since: 0 };
  if (typeof a === "number") return { i: a, since: 0 };
  let i = fallback;
  let since = 0;
  for (const step of [...a].sort((x, y) => x.at - y.at)) {
    const at = step.at * fps;
    if (frame >= at) {
      i = step.i;
      since = at;
    }
  }
  return { i, since };
}

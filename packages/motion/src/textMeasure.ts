/**
 * @apelles/motion — the webview's text measurer for `motion_validate` (B-309).
 *
 * What it is: a `TextMeasurer` (`@apelles/motion-engine`'s `engine/textFit.ts`)
 * that asks a 2D canvas for the width of a line in the layer's own face, size and
 * weight. It answers only for a face the document has actually loaded
 * (`document.fonts.check`): an unloaded face would be measured in the browser's
 * fallback and report a wrong width with confidence, so it declines and the
 * caller estimates instead (and flags only past a slack).
 *
 * What it does NOT do: touch the render path. This is a lint used while
 * authoring; renders never call it, so they stay deterministic.
 */
import type { TextMeasurer, TextStyle } from '@apelles/motion-engine/src/engine/textFit';

let context: CanvasRenderingContext2D | null | undefined;

function canvas2d(): CanvasRenderingContext2D | null {
  if (context === undefined) {
    context = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  }
  return context;
}

const fontShorthand = (style: TextStyle, font: string): string => `${style.weight} ${style.size}px ${font}`;

/** Canvas measurement on loaded fonts; null (decline) for anything else. */
export const canvasTextMeasurer: TextMeasurer = (text, style) => {
  const ctx = canvas2d();
  if (!ctx || style.font === undefined || typeof document === 'undefined' || !document.fonts) return null;
  const font = fontShorthand(style, style.font);
  if (!document.fonts.check(font, text)) return null;
  ctx.font = font;
  return ctx.measureText(text).width + [...text].length * style.letterSpacingPx;
};

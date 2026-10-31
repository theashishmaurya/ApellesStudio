/**
 * @apelles/tokens — UI font stacks (D-432 P1).
 *
 * The default UI face is the system stack (SF Pro on macOS); Poppins stays an
 * opt-in setting. Timecode and numeric readouts use the mono stack with
 * `tabular-nums`. Brand faces used deliberately elsewhere (Motion content, the
 * website) are not touched by this.
 */

export type UiFontId = 'system' | 'poppins';

export const DEFAULT_UI_FONT: UiFontId = 'system';

export const UI_FONT_STACKS: Record<UiFontId, string> = {
  system: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  poppins: "'Poppins', system-ui, sans-serif",
};

export const MONO_FONT_STACK = 'ui-monospace, "SF Mono", Menlo, monospace';

/** An unset or unknown setting falls back to the default, never to Poppins. */
export function resolveUiFontStack(setting: string | null | undefined): string {
  if (setting && Object.hasOwn(UI_FONT_STACKS, setting)) {
    return UI_FONT_STACKS[setting as UiFontId];
  }
  return UI_FONT_STACKS[DEFAULT_UI_FONT];
}

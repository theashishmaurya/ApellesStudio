/**
 * Test helper for `@apelles/ui`'s `NumberScrubber` (D-432, P4): the field is a
 * text input that commits on Enter / blur (not per keystroke), so "type a
 * value" is: set the text, fire the `input` event React listens to, press
 * Enter.
 */
import { actSync } from './pointerHarness';

export function typeNumber(input: HTMLInputElement, value: number | string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  actSync(() => {
    input.focus();
    setter?.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  actSync(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
}

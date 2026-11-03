// @vitest-environment jsdom
/**
 * B-362 — a Select with a long label must be able to shrink inside a narrow
 * column (the 220–280 px media browser) instead of forcing its row wider.
 * jsdom lays nothing out, so this pins the structural guards that make it
 * shrink; the measurement itself was done in headless Chromium (BUGS.md B-362).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { Select, SelectTrigger, SelectValue } from './components/ui/select';

afterEach(() => cleanup());

describe('SelectTrigger can shrink (B-362)', () => {
  it('carries min-w-0, and truncates its value instead of line-clamping it', () => {
    const { container } = render(
      <Select value="a">
        <SelectTrigger className="flex-1">
          <SelectValue placeholder="pick" />
        </SelectTrigger>
      </Select>,
    );
    const trigger = container.querySelector('[data-slot="select-trigger"]');
    expect(trigger, 'the trigger renders').not.toBeNull();
    const cls = trigger!.className;
    // A flex item's min-width is `auto` (its content width) unless told
    // otherwise, so a long label could never shrink below its own length.
    expect(cls).toContain('min-w-0');
    expect(cls).toContain('*:data-[slot=select-value]:min-w-0');
    expect(cls).toContain('*:data-[slot=select-value]:truncate');
    // `line-clamp-1` on a flex box cannot ellipsize; it was the old value style.
    expect(cls).not.toContain('line-clamp-1');
  });
});

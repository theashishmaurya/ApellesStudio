// @vitest-environment jsdom
/**
 * B-369 — the branded loader: the real mark, the phase in words, a determinate
 * bar when a fraction is known, and every loop gated on `motion-safe:` so
 * `prefers-reduced-motion: reduce` gets a still loader. jsdom evaluates no media
 * queries, so the reduced-motion half pins the structural guard: no animation
 * class outside a `motion-safe:` variant.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { BrandedLoader } from './branded-loader';

afterEach(() => cleanup());

const q = (c: HTMLElement, slot: string) => c.querySelector(`[data-slot="${slot}"]`);

describe('BrandedLoader (B-369)', () => {
  it('shows the Apelles mark from the bundled brand asset, never an inline SVG', () => {
    const { container } = render(<BrandedLoader label="Reading project…" />);
    const mark = q(container, 'branded-loader-mark') as HTMLImageElement;
    expect(mark.tagName).toBe('IMG');
    expect(mark.getAttribute('src')).toMatch(/apelles-mark-256\.png$/);
    expect(mark.alt).toBe('Apelles');
    expect(container.querySelector('svg')).toBeNull();
  });

  it('announces the phase in words as a polite status', () => {
    const { container, rerender } = render(<BrandedLoader title="Nemotron" label="Reading project…" variant="overlay" />);
    const root = q(container, 'branded-loader')!;
    expect(root.getAttribute('role')).toBe('status');
    expect(root.getAttribute('aria-live')).toBe('polite');
    expect(q(container, 'branded-loader-title')?.textContent).toBe('Nemotron');
    rerender(<BrandedLoader title="Nemotron" label="Checking media (120/288)…" variant="overlay" />);
    expect(q(container, 'branded-loader-label')?.textContent).toBe('Checking media (120/288)…');
  });

  it('is determinate when a fraction is known', () => {
    const { container } = render(<BrandedLoader label="Checking media (120/288)…" progress={120 / 288} />);
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('42');
    expect(q(container, 'branded-loader-indeterminate')).toBeNull();
  });

  it('is indeterminate without one, and hides that bar from assistive tech', () => {
    const { container } = render(<BrandedLoader label="Building timeline…" />);
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(q(container, 'branded-loader-indeterminate')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('animates only under motion-safe (prefers-reduced-motion gets a still loader)', () => {
    const { container } = render(<BrandedLoader label="Building timeline…" />);
    const animated = [...container.querySelectorAll('*')].flatMap((el) =>
      (el.getAttribute('class') ?? '').split(/\s+/).filter((c) => c.includes('animate-')),
    );
    expect(animated.length).toBeGreaterThan(0);
    for (const cls of animated) expect(cls.startsWith('motion-safe:')).toBe(true);
  });

  it('the compact card variant drops the title', () => {
    const { container } = render(<BrandedLoader title="Nemotron" label="Opening…" variant="compact" />);
    expect(q(container, 'branded-loader-title')).toBeNull();
    expect(q(container, 'branded-loader')?.getAttribute('data-variant')).toBe('compact');
  });
});

/**
 * beta.test.ts — the signup's validation and its placeholder guard (D-255,
 * role ordering added by D-264, endpoint moved to FormSubmit.co 2026-09-10).
 */
import { describe, it, expect } from 'vitest';
import {
  BETA_FORM_ENDPOINT,
  isPlaceholderEndpoint,
  isValidEmail,
  ROLES,
} from '../src/data/beta.ts';

describe('email validation', () => {
  it.each([
    'a@b.co',
    'first.last@studio.example.com',
    'someone+tag@domain.io',
    "o'brien@post.house",
  ])('accepts %s', (v) => {
    expect(isValidEmail(v)).toBe(true);
  });

  it.each(['', '   ', 'nope', 'no@domain', 'no-at.example.com', 'two @spaces.com', '@nolocal.com'])(
    'rejects %s',
    (v) => {
      expect(isValidEmail(v)).toBe(false);
    },
  );

  it('trims surrounding whitespace before judging', () => {
    expect(isValidEmail('  someone@example.com  ')).toBe(true);
  });
});

describe('the shipped endpoint is real, and the placeholder guard still works', () => {
  it('the shipped endpoint is not the placeholder', () => {
    expect(isPlaceholderEndpoint()).toBe(false);
  });

  it('is a real FormSubmit.co AJAX endpoint', () => {
    expect(BETA_FORM_ENDPOINT).toMatch(/^https:\/\/formsubmit\.co\/ajax\/[^\s]+@[^\s]+$/);
  });

  it('still recognises the literal placeholder, for a fresh clone or a different owner', () => {
    expect(isPlaceholderEndpoint('https://formspree.io/f/YOUR_FORM_ID')).toBe(true);
  });

  it('recognises any other real endpoint too', () => {
    expect(isPlaceholderEndpoint('https://formspree.io/f/abcdwxyz')).toBe(false);
  });
});

describe('the role options', () => {
  it('include a non-professional path — the product targets non-editors', () => {
    expect(ROLES.some((r) => /not your job|not my job/i.test(r))).toBe(true);
  });

  /**
   * D-264: the person this product is for reads first. A list that opens with
   * "I edit video professionally" quietly tells everyone else they are in the
   * wrong place, which is the opposite of the whole positioning.
   */
  it('put the non-editor first, ahead of the professional option', () => {
    const nonEditor = ROLES.findIndex((r) => /not my job|never tried/i.test(r));
    const professional = ROLES.findIndex((r) => /professionally/i.test(r));
    expect(nonEditor).toBe(0);
    expect(nonEditor).toBeLessThan(professional);
  });

  it('offer a path for someone who has never tried at all', () => {
    expect(ROLES.some((r) => /never tried/i.test(r))).toBe(true);
  });

  it('are all non-empty and unique', () => {
    expect(new Set(ROLES).size).toBe(ROLES.length);
    for (const r of ROLES) expect(r.trim().length).toBeGreaterThan(0);
  });
});

/**
 * beta.test.ts — the signup's validation and its placeholder guard (D-255,
 * role ordering added by D-264).
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

describe('the shipped endpoint is an obvious placeholder, not a fake-looking id', () => {
  it('is detected as a placeholder', () => {
    expect(isPlaceholderEndpoint()).toBe(true);
  });

  it('says YOUR_FORM_ID in the clear, so nobody mistakes it for a real form', () => {
    expect(BETA_FORM_ENDPOINT).toContain('YOUR_FORM_ID');
  });

  it('recognises a real endpoint once one is set', () => {
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

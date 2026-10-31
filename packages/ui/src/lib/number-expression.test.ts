import { describe, expect, it } from 'vitest';

import { evaluateNumberExpression as ev } from './number-expression';

describe('evaluateNumberExpression', () => {
  it('reads plain numbers, decimals and exponents', () => {
    expect(ev('12', 0)).toBe(12);
    expect(ev(' -3.5 ', 0)).toBe(-3.5);
    expect(ev('.25', 0)).toBe(0.25);
    expect(ev('1e2', 0)).toBe(100);
  });

  it('applies precedence, parentheses and unary minus', () => {
    expect(ev('2+3*4', 0)).toBe(14);
    expect(ev('(2+3)*4', 0)).toBe(20);
    expect(ev('10/4', 0)).toBe(2.5);
    expect(ev('-(2+3)', 0)).toBe(-5);
    expect(ev('2*-3', 0)).toBe(-6);
  });

  it('treats a leading + * / as relative to the current value', () => {
    expect(ev('+10', 5)).toBe(15);
    expect(ev('*2', 7)).toBe(14);
    expect(ev('/4', 8)).toBe(2);
    expect(ev('+=10', 5)).toBe(15);
    expect(ev('*=0.5', 8)).toBe(4);
  });

  it('keeps a leading - as a negative number; -= subtracts', () => {
    expect(ev('-5', 100)).toBe(-5);
    expect(ev('-=5', 100)).toBe(95);
  });

  it('tolerates the field’s own unit as a suffix', () => {
    expect(ev('50%', 0, '%')).toBe(50);
    expect(ev('+10%', 20, '%')).toBe(30);
    expect(ev('12°', 0, '°')).toBe(12);
  });

  it('refuses anything outside the grammar', () => {
    expect(ev('', 1)).toBeNull();
    expect(ev('abc', 1)).toBeNull();
    expect(ev('2+', 1)).toBeNull();
    expect(ev('(2', 1)).toBeNull();
    expect(ev('1/0', 1)).toBeNull();
    expect(ev('alert(1)', 1)).toBeNull();
    expect(ev('2 3', 1)).toBeNull();
    expect(ev('/0', 1)).toBeNull();
  });
});

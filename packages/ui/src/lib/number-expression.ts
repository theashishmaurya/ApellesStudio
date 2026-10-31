/**
 * @apelles/ui — arithmetic in a number field (D-432, P4).
 *
 * **What it is.** The parser behind `NumberScrubber`'s typed input: plain
 * numbers, `+ - * /` with the usual precedence, parentheses, unary minus, and
 * the *relative* forms Resolve / After Effects fields accept — a leading
 * `+`, `*` or `/` (or `+=`, `-=`, `*=`, `/=`) applies to the field's CURRENT
 * value, so `+10` adds ten and `*2` doubles.
 *
 * **What it does NOT do.** No variables, functions, unit conversion or
 * `eval`: it is a small recursive-descent parser over a closed grammar, so a
 * typed string can never run code. A leading `-` is deliberately a plain
 * negative number (`-5` means minus five, as it does everywhere else); to
 * subtract from the current value type `-=5`. A trailing `unit` the field
 * itself displays (`%`, `°`) is accepted and ignored, so what the field shows
 * can be typed back.
 *
 * Pure and DOM-free so it is directly unit-tested (`number-expression.test.ts`).
 */

/** Strip one trailing copy of the field's own unit (`50%` → `50`). */
function stripUnit(text: string, unit?: string): string {
  const trimmed = text.trim();
  if (unit && trimmed.endsWith(unit)) return trimmed.slice(0, trimmed.length - unit.length).trim();
  return trimmed;
}

/** Evaluate a closed arithmetic grammar; `null` when it is not valid. */
function evaluate(source: string): number | null {
  let pos = 0;
  const peek = (): string => source[pos] ?? '';
  const skip = (): void => {
    while (peek() === ' ') pos += 1;
  };

  const number = (): number | null => {
    const match = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(source.slice(pos));
    if (!match) return null;
    pos += match[0].length;
    return Number(match[0]);
  };

  // factor := ('-' | '+') factor | '(' expr ')' | number
  const factor = (): number | null => {
    skip();
    const c = peek();
    if (c === '-' || c === '+') {
      pos += 1;
      const inner = factor();
      return inner === null ? null : c === '-' ? -inner : inner;
    }
    if (c === '(') {
      pos += 1;
      const inner = expression();
      skip();
      if (inner === null || peek() !== ')') return null;
      pos += 1;
      return inner;
    }
    return number();
  };

  // term := factor (('*' | '/') factor)*
  const term = (): number | null => {
    let left = factor();
    while (left !== null) {
      skip();
      const op = peek();
      if (op !== '*' && op !== '/') break;
      pos += 1;
      const right = factor();
      if (right === null) return null;
      left = op === '*' ? left * right : left / right;
    }
    return left;
  };

  // expression := term (('+' | '-') term)*
  const expression = (): number | null => {
    let left = term();
    while (left !== null) {
      skip();
      const op = peek();
      if (op !== '+' && op !== '-') break;
      pos += 1;
      const right = term();
      if (right === null) return null;
      left = op === '+' ? left + right : left - right;
    }
    return left;
  };

  const result = expression();
  skip();
  if (result === null || pos !== source.length || !Number.isFinite(result)) return null;
  return result;
}

function apply(current: number, op: string, operand: number): number | null {
  const result =
    op === '+' ? current + operand : op === '-' ? current - operand : op === '*' ? current * operand : current / operand;
  return Number.isFinite(result) ? result : null;
}

/**
 * The value typed text means, or `null` when it is empty / not arithmetic.
 *
 * @param text    what the user typed
 * @param current the field's value before the edit (the operand of `+10`)
 * @param unit    the unit the field displays, tolerated as a suffix
 */
export function evaluateNumberExpression(text: string, current: number, unit?: string): number | null {
  const source = stripUnit(text, unit);
  if (source === '') return null;

  // `+=` `-=` `*=` `/=` — explicit relative forms, the only way to subtract.
  const compound = /^([+\-*/])=\s*(.+)$/.exec(source);
  if (compound) {
    const operand = evaluate(compound[2] ?? '');
    return operand === null ? null : apply(current, compound[1] ?? '+', operand);
  }

  // A leading `+`, `*` or `/` is relative to the current value. (`-` is not:
  // `-5` is minus five.)
  const relative = /^([+*/])\s*(.+)$/.exec(source);
  if (relative) {
    const operand = evaluate(relative[2] ?? '');
    return operand === null ? null : apply(current, relative[1] ?? '+', operand);
  }

  return evaluate(source);
}

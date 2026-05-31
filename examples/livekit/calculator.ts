// SPDX-License-Identifier: MIT
/**
 * Safe math-expression evaluator for the LiveKit example's `calculate` tool.
 *
 * Unlike the OpenAI-realtime reference (which used `new Function` + a regex
 * allowlist — NOT a sandbox), this is a tiny recursive-descent parser over a
 * fixed grammar. There is no `eval`/`Function`, no global scope reach, and any
 * token outside the allowlist is rejected with an error rather than coerced.
 *
 * Grammar (precedence low → high):
 *   expr    := term (('+' | '-') term)*
 *   term    := power (('*' | '/') power)*
 *   power   := unary ('^' power)?            // right-associative
 *   unary   := ('-' | '+') unary | atom
 *   atom    := NUMBER | CONST | FUNC '(' args ')' | '(' expr ')'
 *   args    := expr (',' expr)*
 *
 * Supported: numbers (incl. decimals like `.5`), `+ - * /`, `^` (and `pow(a,b)`),
 * unary minus, parentheses, constants `pi`/`e`, and functions
 * `sqrt sin cos tan log log10 exp abs round pow`.
 */

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'ident'; value: string }
  | { kind: 'op'; value: string }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'comma' };

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  log: Math.log,
  log10: Math.log10,
  exp: Math.exp,
  abs: Math.abs,
  round: Math.round,
  pow: Math.pow,
};

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

/** Arity for each function — used to validate call sites. */
const ARITY: Record<string, number> = {
  sqrt: 1,
  sin: 1,
  cos: 1,
  tan: 1,
  log: 1,
  log10: 1,
  exp: 1,
  abs: 1,
  round: 1,
  pow: 2,
};

export class CalculatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalculatorError';
  }
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      let j = i;
      while (j < input.length && /[0-9]/.test(input[j]!)) j++;
      if (input[j] === '.') {
        j++;
        while (j < input.length && /[0-9]/.test(input[j]!)) j++;
      }
      tokens.push({ kind: 'num', value: Number(input.slice(i, j)) });
      i = j;
      continue;
    }
    if (ch === '.') {
      // leading-dot decimal, e.g. ".5"
      let j = i + 1;
      while (j < input.length && /[0-9]/.test(input[j]!)) j++;
      if (j === i + 1) throw new CalculatorError(`Unexpected '.' at position ${i}`);
      tokens.push({ kind: 'num', value: Number(input.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[a-zA-Z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[a-zA-Z0-9]/.test(input[j]!)) j++;
      tokens.push({ kind: 'ident', value: input.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '^') {
      tokens.push({ kind: 'op', value: ch });
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ kind: 'comma' });
      i++;
      continue;
    }
    throw new CalculatorError(`Unexpected character '${ch}' at position ${i}`);
  }
  return tokens;
}

/** Evaluate a math expression. Throws CalculatorError on anything outside the grammar. */
export function evaluate(input: string): number {
  if (input.trim().length === 0) throw new CalculatorError('Empty expression');
  const tokens = tokenize(input);
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const next = (): Token | undefined => tokens[pos++];

  function parseExpr(): number {
    let value = parseTerm();
    for (;;) {
      const t = peek();
      if (t?.kind === 'op' && (t.value === '+' || t.value === '-')) {
        next();
        const rhs = parseTerm();
        value = t.value === '+' ? value + rhs : value - rhs;
      } else break;
    }
    return value;
  }

  function parseTerm(): number {
    let value = parsePower();
    for (;;) {
      const t = peek();
      if (t?.kind === 'op' && (t.value === '*' || t.value === '/')) {
        next();
        const rhs = parsePower();
        value = t.value === '*' ? value * rhs : value / rhs;
      } else break;
    }
    return value;
  }

  function parsePower(): number {
    const base = parseUnary();
    const t = peek();
    if (t?.kind === 'op' && t.value === '^') {
      next();
      const exponent = parsePower(); // right-associative
      return Math.pow(base, exponent);
    }
    return base;
  }

  function parseUnary(): number {
    const t = peek();
    if (t?.kind === 'op' && (t.value === '-' || t.value === '+')) {
      next();
      const operand = parseUnary();
      return t.value === '-' ? -operand : operand;
    }
    return parseAtom();
  }

  function parseAtom(): number {
    const t = next();
    if (t === undefined) throw new CalculatorError('Unexpected end of expression');
    if (t.kind === 'num') return t.value;
    if (t.kind === 'lparen') {
      const value = parseExpr();
      const close = next();
      if (close?.kind !== 'rparen') throw new CalculatorError('Expected ")"');
      return value;
    }
    if (t.kind === 'ident') {
      if (t.value in CONSTANTS) return CONSTANTS[t.value]!;
      if (t.value in FUNCTIONS) {
        const open = next();
        if (open?.kind !== 'lparen') throw new CalculatorError(`Expected "(" after ${t.value}`);
        const args: number[] = [parseExpr()];
        for (;;) {
          const sep = peek();
          if (sep?.kind === 'comma') {
            next();
            args.push(parseExpr());
          } else break;
        }
        const close = next();
        if (close?.kind !== 'rparen') throw new CalculatorError(`Expected ")" after ${t.value} args`);
        if (args.length !== ARITY[t.value]) {
          throw new CalculatorError(
            `${t.value} expects ${ARITY[t.value]} argument(s), got ${args.length}`,
          );
        }
        return FUNCTIONS[t.value]!(...args);
      }
      throw new CalculatorError(`Unknown name '${t.value}'`);
    }
    throw new CalculatorError(`Unexpected token`);
  }

  const result = parseExpr();
  if (pos !== tokens.length) throw new CalculatorError('Unexpected trailing input');
  if (!Number.isFinite(result)) throw new CalculatorError('Result is not a finite number');
  return result;
}

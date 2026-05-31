// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { CalculatorError, evaluate } from './calculator.js';

describe('calculator', () => {
  describe('accepted expressions', () => {
    it('basic arithmetic with precedence', () => {
      expect(evaluate('2 + 2')).toBe(4);
      expect(evaluate('2 + 3 * 4')).toBe(14);
      expect(evaluate('(2 + 3) * 4')).toBe(20);
      expect(evaluate('10 / 4')).toBe(2.5);
      expect(evaluate('25 * 17')).toBe(425);
    });

    it('decimals including leading dot', () => {
      expect(evaluate('3.14')).toBeCloseTo(3.14);
      expect(evaluate('.5 + .5')).toBe(1);
    });

    it('unary minus and plus', () => {
      expect(evaluate('-5')).toBe(-5);
      expect(evaluate('3 - -2')).toBe(5);
      expect(evaluate('-(2 + 3)')).toBe(-5);
    });

    it('exponentiation is right-associative', () => {
      expect(evaluate('2 ^ 10')).toBe(1024);
      expect(evaluate('2 ^ 3 ^ 2')).toBe(512); // 2^(3^2)
      expect(evaluate('pow(2, 10)')).toBe(1024);
    });

    it('constants', () => {
      expect(evaluate('pi')).toBeCloseTo(Math.PI);
      expect(evaluate('e')).toBeCloseTo(Math.E);
      expect(evaluate('sin(pi / 2)')).toBeCloseTo(1);
    });

    it('functions and nesting', () => {
      expect(evaluate('sqrt(16)')).toBe(4);
      expect(evaluate('abs(-7)')).toBe(7);
      expect(evaluate('round(3.6)')).toBe(4);
      expect(evaluate('sqrt(pow(3, 2) + pow(4, 2))')).toBe(5);
      expect(evaluate('log10(1000)')).toBeCloseTo(3);
    });

    it('is case-insensitive for names', () => {
      expect(evaluate('SQRT(16)')).toBe(4);
      expect(evaluate('PI')).toBeCloseTo(Math.PI);
    });
  });

  describe('rejected expressions', () => {
    const bad = [
      '',
      '   ',
      'foo',
      'foo(1)',
      '2 +',
      '* 2',
      '(2 + 3',
      '2 + 3)',
      'sqrt',
      'sqrt()', // wrong arity (0 args)
      'pow(2)', // wrong arity (1 arg)
      'sqrt(1, 2)', // wrong arity (2 args)
      'process.exit(1)',
      'globalThis',
      'this',
      '1; 2',
      '2 ** 3', // ** is not in the grammar
      '1 / 0', // non-finite result
    ];
    for (const expr of bad) {
      it(`rejects ${JSON.stringify(expr)}`, () => {
        expect(() => evaluate(expr)).toThrow(CalculatorError);
      });
    }
  });
});

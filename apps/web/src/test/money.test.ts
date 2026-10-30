import { describe, expect, it } from 'vitest';
import { formatMoney, formatRupees, minorToInput, parseRupees } from '../lib/money';

describe('parseRupees', () => {
  it.each([
    ['1500', 150_000],
    ['1500.5', 150_050],
    ['1500.50', 150_050],
    ['0.07', 7],
    ['0', 0],
    [' 1,500.25 ', 150_025],
    ['1000000000', 100_000_000_000],
    ['0.1', 10],
    ['19.99', 1999],
  ])('reads %j as %i paise', (text, minor) => {
    expect(parseRupees(text)).toBe(minor);
  });

  it.each([
    '',
    'abc',
    '-5',
    '1.234',
    '1.',
    '.5',
    '1e3',
    '1000000000.01',
    '9999999999999',
    '1,2,3x',
  ])('refuses %j', (text) => {
    expect(parseRupees(text)).toBeNull();
  });
});

describe('formatting', () => {
  it('uses Indian grouping and always two decimals', () => {
    expect(formatRupees(150_050)).toBe('1,500.50');
    expect(formatRupees(12_345_678_900)).toBe('12,34,56,789.00');
    expect(formatRupees(5)).toBe('0.05');
    expect(formatRupees(-150)).toBe('-1.50');
    expect(formatMoney(100)).toBe('₹1.00');
  });
  it('round-trips an amount through the input form', () => {
    for (const minor of [0, 1, 99, 100, 150_050, 100_000_000_000]) {
      expect(parseRupees(minorToInput(minor))).toBe(minor);
    }
  });
});

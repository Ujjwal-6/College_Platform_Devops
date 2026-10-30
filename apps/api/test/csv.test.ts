import { describe, expect, it } from 'vitest';
import { csvCell, formatMinor, toCsv } from '../src/modules/analytics/csv.js';

describe('CSV cells', () => {
  it('leaves plain text and numbers alone', () => {
    expect(csvCell('Tech Symposium')).toBe('Tech Symposium');
    expect(csvCell(42, 'number')).toBe('42');
    expect(csvCell(86.7, 'number')).toBe('86.7');
  });

  it('writes nothing for missing values', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined, 'number')).toBe('');
  });

  it('wraps text with a comma, quote or line break in quotes and doubles the quotes', () => {
    expect(csvCell('Talks, workshops')).toBe('"Talks, workshops"');
    expect(csvCell('The "big" day')).toBe('"The ""big"" day"');
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"');
    expect(csvCell('carriage\rreturn')).toBe('"carriage\rreturn"');
  });

  it.each([
    '=1+1',
    '+91 98765',
    '-2+3',
    '@SUM(A1)',
    '\tTabbed',
    '\rReturned',
    '=HYPERLINK("http://evil.test","x")',
  ])('stops a spreadsheet from running the text %j as a formula', (text) => {
    const out = csvCell(text);
    expect(out.replace(/^"/, '').startsWith("'")).toBe(true);
    expect(out).toContain(text.replace(/"/g, '""'));
  });

  it('does not touch a number, even a negative one', () => {
    expect(csvCell(-5, 'number')).toBe('-5');
    expect(csvCell('-5.00', 'number')).toBe('-5.00');
  });

  it('only guards the start of the text', () => {
    expect(csvCell('2 + 2 = 4')).toBe('2 + 2 = 4');
    expect(csvCell("it's fine")).toBe("it's fine");
  });
});

describe('a whole file', () => {
  it('uses CRLF line ends, ends with one, and guards only text columns', () => {
    const csv = toCsv(
      ['Name', 'Amount'],
      ['text', 'number'],
      [
        ['=cmd', -5],
        ['A, B', 7],
      ],
    );
    expect(csv).toBe('Name,Amount\r\n\'=cmd,-5\r\n"A, B",7\r\n');
  });

  it('is just the header when there are no rows', () => {
    expect(toCsv(['A', 'B'], ['text', 'text'], [])).toBe('A,B\r\n');
  });
});

describe('money', () => {
  it.each([
    [0, '0.00'],
    [5, '0.05'],
    [100, '1.00'],
    [150_050, '1500.50'],
    [-150, '-1.50'],
    [-5, '-0.05'],
    [100_000_000_000, '1000000000.00'],
    [300_000_000_001, '3000000000.01'],
  ])('writes %i paise as %s', (minor, text) => {
    expect(formatMinor(minor)).toBe(text);
  });
});

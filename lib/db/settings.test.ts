/**
 * Run with:  npx tsx --test settings.test.ts
 *
 * Pure ticker-normalization tests only — no DB access. v2.4 §5.6 / §0a.3:
 * `$`-prefixed index symbols are REJECTED with an explanatory message rather
 * than silently normalized.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTickers } from './settings';

describe('normalizeTickers — existing behaviour', () => {
  it('uppercases, trims, and dedupes', () => {
    assert.deepEqual(normalizeTickers([' spy ', 'SPY', 'tlt']), ['SPY', 'TLT']);
  });

  it('drops empty entries', () => {
    assert.deepEqual(normalizeTickers(['SPY', '', '   ']), ['SPY']);
  });

  it('rejects over-length and non-alphabetic tickers', () => {
    assert.throws(() => normalizeTickers(['TOOLONG']), /exceeds 5 characters/);
    assert.throws(() => normalizeTickers(['SP-Y']), /non-alphabetic/);
  });

  it('rejects more than 10 tickers', () => {
    const many = Array.from({ length: 11 }, (_, i) => `AA${String.fromCharCode(65 + i)}`);
    assert.throws(() => normalizeTickers(many), /Maximum 10 tickers/);
  });
});

describe('normalizeTickers — index symbols (v2.4 §5.6)', () => {
  it('accepts the four canonical index symbols', () => {
    assert.deepEqual(normalizeTickers(['XSP', 'SPX', 'NDX', 'RUT']), ['XSP', 'SPX', 'NDX', 'RUT']);
  });

  it('accepts them lowercase, as any other ticker', () => {
    assert.deepEqual(normalizeTickers(['xsp']), ['XSP']);
  });

  it('REJECTS a $-prefixed symbol instead of silently stripping the $', () => {
    assert.throws(() => normalizeTickers(['$SPX']), /use SPX, not \$SPX/);
    assert.throws(() => normalizeTickers(['$SPX']), /the \$ is added internally/);
  });

  it('rejects the $ form for every index', () => {
    for (const s of ['$XSP', '$SPX', '$NDX', '$RUT']) {
      assert.throws(() => normalizeTickers([s]), new RegExp(`use ${s.slice(1)}, not \\${s}`), s);
    }
  });

  it('rejects a bare $ without crashing on the empty suggestion', () => {
    assert.throws(() => normalizeTickers(['$']), /Invalid ticker/);
  });

  it('the $ message wins over the generic non-alphabetic one', () => {
    // '$SPX' also fails /^[A-Z]+$/ — the specific, actionable message must be
    // the one April sees.
    assert.throws(() => normalizeTickers(['$SPX']), (err: Error) => {
      assert.doesNotMatch(err.message, /non-alphabetic/);
      return true;
    });
  });
});

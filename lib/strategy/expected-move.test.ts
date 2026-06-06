/**
 * Run with:  npx tsx --test expected-move.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeExpectedMove, shortStrikeDistance } from './expected-move';

describe('computeExpectedMove', () => {
  it('EM = ATM straddle; pct = EM / underlying', () => {
    const em = computeExpectedMove({
      symbol: 'aapl',
      expiration: '2026-08-01',
      underlyingPrice: 190,
      atmCallMid: 4.2,
      atmPutMid: 4.2,
    });
    assert.ok(em);
    assert.equal(em!.symbol, 'AAPL');
    assert.equal(em!.straddlePrice, 8.4);
    assert.equal(em!.expectedMoveAbs, 8.4);
    assert.equal(em!.expectedMovePct, 0.0442); // 8.4 / 190 = 0.04421 → 0.0442
  });

  it('handles asymmetric call/put mids', () => {
    const em = computeExpectedMove({
      symbol: 'MSFT',
      expiration: '2026-07-31',
      underlyingPrice: 400,
      atmCallMid: 9,
      atmPutMid: 7,
    });
    assert.equal(em!.expectedMoveAbs, 16);
    assert.equal(em!.expectedMovePct, 0.04);
  });

  it('rejects non-positive underlying', () => {
    assert.equal(
      computeExpectedMove({ symbol: 'X', expiration: '2026-01-01', underlyingPrice: 0, atmCallMid: 1, atmPutMid: 1 }),
      null,
    );
  });

  it('rejects non-finite / negative mids', () => {
    assert.equal(
      computeExpectedMove({ symbol: 'X', expiration: '2026-01-01', underlyingPrice: 100, atmCallMid: NaN, atmPutMid: 1 }),
      null,
    );
    assert.equal(
      computeExpectedMove({ symbol: 'X', expiration: '2026-01-01', underlyingPrice: 100, atmCallMid: -1, atmPutMid: 1 }),
      null,
    );
  });

  it('rejects a zero straddle', () => {
    assert.equal(
      computeExpectedMove({ symbol: 'X', expiration: '2026-01-01', underlyingPrice: 100, atmCallMid: 0, atmPutMid: 0 }),
      null,
    );
  });
});

describe('shortStrikeDistance', () => {
  it('1.0× = at the EM, 1.25× = safety margin', () => {
    const em = computeExpectedMove({
      symbol: 'AAPL', expiration: '2026-08-01', underlyingPrice: 190, atmCallMid: 4, atmPutMid: 4,
    })!;
    assert.equal(shortStrikeDistance(em, 1.0), 8);
    assert.equal(shortStrikeDistance(em, 1.25), 10);
  });
});

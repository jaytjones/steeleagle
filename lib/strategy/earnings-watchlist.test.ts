/**
 * Run with:  npx tsx --test earnings-watchlist.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  tierOf,
  isWatchlisted,
  isTradeable,
  sizeFactorOf,
  maxContractsFor,
  tradeableSymbols,
  allWatchlistSymbols,
} from './earnings-watchlist';

describe('tierOf', () => {
  it('maps Tier 1 / 2 / 3 names', () => {
    assert.equal(tierOf('AAPL'), 1);
    assert.equal(tierOf('GOOGL'), 2);
    assert.equal(tierOf('TSLA'), 3);
  });
  it('is case-insensitive', () => {
    assert.equal(tierOf('msft'), 1);
  });
  it('returns null for off-watchlist names', () => {
    assert.equal(tierOf('SPY'), null);
    assert.equal(tierOf('FOO'), null);
  });
});

describe('isWatchlisted / isTradeable', () => {
  it('Tier 3 is watchlisted but NOT tradeable', () => {
    assert.equal(isWatchlisted('NVDA'), true);
    assert.equal(isTradeable('NVDA'), false);
  });
  it('Tier 1 and 2 are tradeable', () => {
    assert.equal(isTradeable('JPM'), true);
    assert.equal(isTradeable('CRM'), true);
  });
  it('off-watchlist is neither', () => {
    assert.equal(isWatchlisted('QQQ'), false);
    assert.equal(isTradeable('QQQ'), false);
  });
});

describe('sizeFactorOf', () => {
  it('Tier 1 = 1.0, Tier 2 = 0.5 (size down 50%), Tier 3 / off = 0', () => {
    assert.equal(sizeFactorOf('AAPL'), 1.0);
    assert.equal(sizeFactorOf('AMZN'), 0.5);
    assert.equal(sizeFactorOf('META'), 0);
    assert.equal(sizeFactorOf('SPY'), 0);
  });
});

describe('maxContractsFor', () => {
  it('1 contract for tradeable names below the $50k threshold', () => {
    assert.equal(maxContractsFor('AAPL', 30_000), 1);
    assert.equal(maxContractsFor('CRM', 10_000), 1);
  });
  it('2 contracts once equity exceeds $50k', () => {
    assert.equal(maxContractsFor('AAPL', 75_000), 2);
  });
  it('0 for Tier 3 / off-watchlist regardless of equity', () => {
    assert.equal(maxContractsFor('TSLA', 100_000), 0);
    assert.equal(maxContractsFor('SPY', 100_000), 0);
  });
});

describe('symbol lists', () => {
  it('tradeableSymbols excludes Tier 3', () => {
    const t = tradeableSymbols();
    assert.equal(t.length, 12);
    assert.ok(t.includes('AAPL'));
    assert.ok(!t.includes('TSLA'));
  });
  it('allWatchlistSymbols includes Tier 3', () => {
    const all = allWatchlistSymbols();
    assert.equal(all.length, 18);
    assert.ok(all.includes('NVDA'));
  });
});

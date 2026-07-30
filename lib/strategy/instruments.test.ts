/**
 * Run with:  npx tsx --test instruments.test.ts
 *
 * v2.4 spec §5: "unit tests pin every root in the table plus passthrough for
 * unknown roots". The passthrough cases matter as much as the mappings — they
 * are what keeps ETF behaviour byte-identical after the milestone.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  INDEX_SYMBOLS,
  INSTRUMENTS,
  apiSymbolFor,
  commissionRoundTrip,
  getInstrument,
  hasAmbiguousRoot,
  isKnownInstrument,
  isOrderFixturePinned,
  minWingWidthFor,
  occRootsFor,
  perContractFee,
  pillarOf,
  preferredRootFor,
  resolveUnderlying,
  sameIndexSiblings,
  unpinnedFixtureMessage,
} from './instruments';

describe('registry integrity', () => {
  it('covers the 21 ETFs + 4 indices', () => {
    assert.equal(INSTRUMENTS.length, 25);
    assert.equal(INSTRUMENTS.filter((i) => i.kind === 'index').length, 4);
    assert.deepEqual([...INDEX_SYMBOLS], ['XSP', 'SPX', 'NDX', 'RUT']);
  });

  it('has no duplicate symbols and no duplicate OCC roots', () => {
    const symbols = INSTRUMENTS.map((i) => i.symbol);
    assert.equal(new Set(symbols).size, symbols.length);
    const roots = INSTRUMENTS.flatMap((i) => i.occRoots);
    assert.equal(new Set(roots).size, roots.length, 'an OCC root maps to two underlyings');
  });

  it('every preferredRoot is one of that instrument’s own occRoots', () => {
    for (const i of INSTRUMENTS) {
      assert.ok(
        i.occRoots.includes(i.preferredRoot),
        `${i.symbol}: preferredRoot ${i.preferredRoot} not in occRoots`,
      );
    }
  });

  it('every OCC root is ≤ 6 chars — the OCC symbol root field width', () => {
    for (const root of INSTRUMENTS.flatMap((i) => i.occRoots)) {
      assert.ok(root.length <= 6, `root ${root} exceeds the 6-char OCC field`);
    }
  });
});

describe('resolveUnderlying — the load-bearing mapping (spec §5)', () => {
  it('maps every index root to its canonical underlying', () => {
    assert.equal(resolveUnderlying('SPXW'), 'SPX');
    assert.equal(resolveUnderlying('SPX'), 'SPX');
    assert.equal(resolveUnderlying('NDXP'), 'NDX');
    assert.equal(resolveUnderlying('NDX'), 'NDX');
    assert.equal(resolveUnderlying('RUTW'), 'RUT');
    assert.equal(resolveUnderlying('RUT'), 'RUT');
  });

  it('XSP has a single root that resolves to itself (Phase 0 V2)', () => {
    assert.equal(resolveUnderlying('XSP'), 'XSP');
    assert.deepEqual(occRootsFor('XSP'), ['XSP']);
  });

  it('every ETF root resolves to itself — ETF behaviour unchanged', () => {
    for (const i of INSTRUMENTS.filter((x) => x.kind === 'etf')) {
      assert.equal(resolveUnderlying(i.symbol), i.symbol);
    }
  });

  it('passes unknown roots through unchanged rather than crashing', () => {
    assert.equal(resolveUnderlying('ARKK'), 'ARKK');
    assert.equal(resolveUnderlying('XSPW'), 'XSPW'); // a root Schwab does not have today
  });

  it('normalizes case and surrounding whitespace', () => {
    assert.equal(resolveUnderlying(' spxw '), 'SPX');
    assert.equal(resolveUnderlying('rutw'), 'RUT');
  });
});

describe('apiSymbolFor — the $ boundary (Phase 0 V1)', () => {
  it('prefixes only index symbols', () => {
    assert.equal(apiSymbolFor('XSP'), '$XSP');
    assert.equal(apiSymbolFor('SPX'), '$SPX');
    assert.equal(apiSymbolFor('NDX'), '$NDX');
    assert.equal(apiSymbolFor('RUT'), '$RUT');
  });

  it('leaves ETFs and unknown tickers alone', () => {
    assert.equal(apiSymbolFor('SPY'), 'SPY');
    assert.equal(apiSymbolFor('TLT'), 'TLT');
    assert.equal(apiSymbolFor('ARKK'), 'ARKK');
  });

  it('never double-prefixes an already-$ symbol into the registry', () => {
    // '$SPX' is not a canonical symbol, so it falls through to passthrough —
    // it must not become '$$SPX'. Settings validation rejects it upstream.
    assert.equal(apiSymbolFor('$SPX'), '$SPX');
  });
});

describe('preferredRootFor — PM roots for new orders (spec §5)', () => {
  it('prefers the PM-settled root where a choice exists', () => {
    assert.equal(preferredRootFor('SPX'), 'SPXW');
    assert.equal(preferredRootFor('NDX'), 'NDXP');
    assert.equal(preferredRootFor('RUT'), 'RUTW');
  });

  it('XSP and ETFs use their own symbol as the root', () => {
    assert.equal(preferredRootFor('XSP'), 'XSP');
    assert.equal(preferredRootFor('SPY'), 'SPY');
    assert.equal(preferredRootFor('ARKK'), 'ARKK');
  });
});

describe('hasAmbiguousRoot — the exit-placement gate (v2.4 §8.3 decision)', () => {
  it('is true for the multi-root indices', () => {
    assert.equal(hasAmbiguousRoot('SPX'), true);
    assert.equal(hasAmbiguousRoot('NDX'), true);
    assert.equal(hasAmbiguousRoot('RUT'), true);
  });

  it('is false for XSP — the one index that can be auto-exited', () => {
    assert.equal(hasAmbiguousRoot('XSP'), false);
  });

  it('is false for every ETF and for unknown tickers', () => {
    for (const i of INSTRUMENTS.filter((x) => x.kind === 'etf')) {
      assert.equal(hasAmbiguousRoot(i.symbol), false, i.symbol);
    }
    assert.equal(hasAmbiguousRoot('ARKK'), false);
  });
});

describe('pillarOf — indices join the equity block (spec §7.1)', () => {
  it('maps all ten equity-block names to EQUITY', () => {
    for (const s of ['SPY', 'QQQ', 'IWM', 'DIA', 'EFA', 'EEM', 'XSP', 'SPX', 'NDX', 'RUT']) {
      assert.equal(pillarOf(s), 'EQUITY', s);
    }
  });

  it('leaves the other four pillars untouched', () => {
    assert.equal(pillarOf('TLT'), 'FIXED_INCOME');
    assert.equal(pillarOf('GLD'), 'COMMODITY');
    assert.equal(pillarOf('VXX'), 'VOLATILITY');
    assert.equal(pillarOf('UUP'), 'CURRENCY');
  });

  it('returns UNKNOWN off-universe', () => {
    assert.equal(pillarOf('ARKK'), 'UNKNOWN');
  });
});

describe('sameIndexSiblings — the WARN relation (spec §7.2)', () => {
  it('is symmetric across the S&P group', () => {
    assert.deepEqual(sameIndexSiblings('SPY').sort(), ['SPX', 'XSP']);
    assert.deepEqual(sameIndexSiblings('XSP').sort(), ['SPX', 'SPY']);
    assert.deepEqual(sameIndexSiblings('SPX').sort(), ['SPY', 'XSP']);
  });

  it('pairs QQQ↔NDX and IWM↔RUT', () => {
    assert.deepEqual(sameIndexSiblings('QQQ'), ['NDX']);
    assert.deepEqual(sameIndexSiblings('NDX'), ['QQQ']);
    assert.deepEqual(sameIndexSiblings('IWM'), ['RUT']);
    assert.deepEqual(sameIndexSiblings('RUT'), ['IWM']);
  });

  it('never includes the symbol itself', () => {
    for (const s of ['SPY', 'XSP', 'SPX', 'QQQ', 'NDX', 'IWM', 'RUT']) {
      assert.ok(!sameIndexSiblings(s).includes(s), s);
    }
  });

  it('is empty for instruments with no index sibling', () => {
    assert.deepEqual(sameIndexSiblings('DIA'), []);
    assert.deepEqual(sameIndexSiblings('TLT'), []);
    assert.deepEqual(sameIndexSiblings('ARKK'), []);
  });
});

describe('fees (spec §9)', () => {
  it('keeps the ETF round trip at exactly $5.20', () => {
    assert.equal(perContractFee('SPY'), 0.65);
    assert.equal(commissionRoundTrip('SPY'), 5.2);
    assert.equal(commissionRoundTrip('ARKK'), 5.2); // unknown → ETF rate
  });

  it('charges every index more than an ETF', () => {
    for (const s of INDEX_SYMBOLS) {
      assert.ok(perContractFee(s) > 0.65, s);
      assert.ok(commissionRoundTrip(s) > 5.2, s);
    }
  });

  it('XSP is the cheapest index and NDX/SPX the dearest', () => {
    assert.ok(perContractFee('XSP') < perContractFee('RUT'));
    assert.ok(perContractFee('RUT') < perContractFee('NDX'));
    assert.ok(perContractFee('NDX') < perContractFee('SPX'));
  });
});

describe('minWingWidthFor', () => {
  it('keeps the $10 floor for ETFs, XSP, and unknown tickers', () => {
    assert.equal(minWingWidthFor('SPY'), 10);
    assert.equal(minWingWidthFor('XSP'), 10);
    assert.equal(minWingWidthFor('ARKK'), 10);
  });

  it('scales the floor with the index level', () => {
    assert.equal(minWingWidthFor('RUT'), 25);
    assert.equal(minWingWidthFor('SPX'), 50);
    assert.equal(minWingWidthFor('NDX'), 200);
  });
});

describe('order-fixture gate (Schwab doctrine)', () => {
  it('XSP is PINNED — live place-and-cancel 2026-07-30 answered V7', () => {
    assert.equal(isOrderFixturePinned('XSP'), true);
  });

  it('SPX/NDX/RUT stay UNPINNED until each gets its own place-and-cancel', () => {
    for (const s of INDEX_SYMBOLS.filter((x) => x !== 'XSP')) {
      assert.equal(isOrderFixturePinned(s), false, s);
    }
  });

  it('every ETF stays pinned — the shipped v2.0 path is untouched', () => {
    for (const i of INSTRUMENTS.filter((x) => x.kind === 'etf')) {
      assert.equal(isOrderFixturePinned(i.symbol), true, i.symbol);
    }
  });

  it('unknown tickers are treated as pinned (they use the equity payload shape)', () => {
    assert.equal(isOrderFixturePinned('ARKK'), true);
  });

  it('the refusal message names the symbol and the way to resolve it', () => {
    const msg = unpinnedFixtureMessage('xsp');
    assert.match(msg, /XSP/);
    assert.match(msg, /place and cancel/i);
    assert.match(msg, /orderFixturePinned/);
  });
});

describe('getInstrument / isKnownInstrument', () => {
  it('is case- and whitespace-insensitive', () => {
    assert.equal(getInstrument(' xsp ')?.symbol, 'XSP');
    assert.equal(isKnownInstrument('spy'), true);
  });

  it('returns null / false off-universe', () => {
    assert.equal(getInstrument('ARKK'), null);
    assert.equal(isKnownInstrument('ARKK'), false);
    assert.equal(isKnownInstrument('$SPX'), false); // `$` form is never canonical
  });
});

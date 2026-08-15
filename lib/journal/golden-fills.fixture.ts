// ============================================================
// SteelEagle — v2.11 golden fill fixtures
//
// Seven REAL Schwab payloads pulled 2026-08-14 via
// `scripts/dump-filled-orders.ts`, trimmed to the fields the classifier reads
// and with `accountNumber` stripped (F4 — it is present on every raw order
// body, six occurrences in a 14-day window).
//
// These are the doctrine artefacts for v2.11. If a test fails against one of
// them after a refactor, the REFACTOR is wrong — these are Schwab's own
// records of April's actual trades, not our idea of what they should look like.
//
// Deliberately NOT a `.test.ts` file. Three test files consume these; when they
// lived in classify-fill.test.ts every importer re-registered its describe
// blocks and the same assertions ran three times, inflating the suite count and
// hiding how much is actually covered.
// ============================================================

import type { SchwabOrderDetail } from '../schwab/orders'

/** 4-leg entry. GLD 2026-09-18 330/350/400/420, NET_CREDIT 4.14. */
const GLD_ENTRY: SchwabOrderDetail = {
  orderId: 1007457102802,
  status: 'FILLED',
  enteredTime: '2026-08-04T15:14:55+0000',
  closeTime: '2026-08-04T15:40:43+0000',
  orderType: 'NET_CREDIT',
  complexOrderStrategyType: 'IRON_CONDOR',
  quantity: 1,
  filledQuantity: 1,
  price: 4.14,
  orderLegCollection: [
    { legId: 1, instruction: 'SELL_TO_OPEN', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'GLD   260918C00400000', putCall: 'CALL' } },
    { legId: 2, instruction: 'BUY_TO_OPEN', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'GLD   260918C00420000', putCall: 'CALL' } },
    { legId: 3, instruction: 'SELL_TO_OPEN', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'GLD   260918P00350000', putCall: 'PUT' } },
    { legId: 4, instruction: 'BUY_TO_OPEN', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'GLD   260918P00330000', putCall: 'PUT' } },
  ],
  orderActivityCollection: [
    {
      executionLegs: [
        { legId: 1, quantity: 1, price: 3.72, time: '2026-08-04T15:40:43+0000' },
        { legId: 2, quantity: 1, price: 1.41, time: '2026-08-04T15:40:43+0000' },
        { legId: 3, quantity: 1, price: 2.75, time: '2026-08-04T15:40:43+0000' },
        { legId: 4, quantity: 1, price: 0.92, time: '2026-08-04T15:40:43+0000' },
      ],
    },
  ],
}

/** 4-leg close of the v2.7 BUTTERFLY. SPY 2026-08-28 745/765/765/785, NET_DEBIT 14. */
const SPY_BUTTERFLY_CLOSE: SchwabOrderDetail = {
  orderId: 1007514529392,
  status: 'FILLED',
  enteredTime: '2026-08-07T16:09:02+0000',
  closeTime: '2026-08-07T16:25:32+0000',
  orderType: 'NET_DEBIT',
  complexOrderStrategyType: 'IRON_CONDOR',
  quantity: 1,
  filledQuantity: 1,
  price: 14,
  orderLegCollection: [
    { legId: 1, instruction: 'BUY_TO_CLOSE', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260828C00765000', putCall: 'CALL' } },
    { legId: 2, instruction: 'SELL_TO_CLOSE', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260828C00785000', putCall: 'CALL' } },
    { legId: 3, instruction: 'BUY_TO_CLOSE', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260828P00765000', putCall: 'PUT' } },
    { legId: 4, instruction: 'SELL_TO_CLOSE', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260828P00745000', putCall: 'PUT' } },
  ],
  orderActivityCollection: [
    {
      executionLegs: [
        { legId: 1, quantity: 1, price: 14.38, time: '2026-08-07T16:25:32+0000' },
        { legId: 2, quantity: 1, price: 4.03, time: '2026-08-07T16:25:32+0000' },
        { legId: 3, quantity: 1, price: 5.83, time: '2026-08-07T16:25:32+0000' },
        { legId: 4, quantity: 1, price: 2.18, time: '2026-08-07T16:25:32+0000' },
      ],
    },
  ],
}

/** Single-ticket roll, labelled CONDOR. SPY 2026-09-11 put side 700/715 → 725/740. */
const SPY_ROLL_CONDOR: SchwabOrderDetail = {
  orderId: 1007454721397,
  status: 'FILLED',
  enteredTime: '2026-08-04T14:39:22+0000',
  closeTime: '2026-08-04T14:39:22+0000',
  orderType: 'NET_CREDIT',
  complexOrderStrategyType: 'CONDOR',
  quantity: 1,
  filledQuantity: 1,
  price: 1.05,
  orderLegCollection: [
    { legId: 1, instruction: 'SELL_TO_OPEN', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260911P00740000', putCall: 'PUT' } },
    { legId: 2, instruction: 'BUY_TO_OPEN', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260911P00725000', putCall: 'PUT' } },
    { legId: 3, instruction: 'BUY_TO_CLOSE', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260911P00715000', putCall: 'PUT' } },
    { legId: 4, instruction: 'SELL_TO_CLOSE', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260911P00700000', putCall: 'PUT' } },
  ],
  orderActivityCollection: [
    {
      executionLegs: [
        { legId: 1, quantity: 1, price: 5.05, time: '2026-08-04T14:39:22+0000' },
        { legId: 2, quantity: 1, price: 3.25, time: '2026-08-04T14:39:22+0000' },
        { legId: 3, quantity: 1, price: 2.49, time: '2026-08-04T14:39:22+0000' },
        { legId: 4, quantity: 1, price: 1.74, time: '2026-08-04T14:39:22+0000' },
      ],
    },
  ],
}

/**
 * THE F2 FIXTURE. Structurally identical to SPY_ROLL_CONDOR — a four-leg
 * SPY 2026-09-11 put roll — but Schwab labelled it `CUSTOM`, not `CONDOR`.
 * This pair is the entire argument for never reading the strategy type.
 */
const SPY_ROLL_CUSTOM: SchwabOrderDetail = {
  orderId: 1007483420023,
  status: 'FILLED',
  enteredTime: '2026-08-05T17:55:58+0000',
  closeTime: '2026-08-05T17:56:00+0000',
  orderType: 'NET_CREDIT',
  complexOrderStrategyType: 'CUSTOM',
  quantity: 1,
  filledQuantity: 1,
  price: 0.62,
  orderLegCollection: [
    { legId: 1, instruction: 'SELL_TO_OPEN', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260911P00750000', putCall: 'PUT' } },
    { legId: 2, instruction: 'BUY_TO_CLOSE', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260911P00740000', putCall: 'PUT' } },
    { legId: 3, instruction: 'BUY_TO_OPEN', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260911P00735000', putCall: 'PUT' } },
    { legId: 4, instruction: 'SELL_TO_CLOSE', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260911P00725000', putCall: 'PUT' } },
  ],
  orderActivityCollection: [
    {
      executionLegs: [
        { legId: 1, quantity: 1, price: 5.77, time: '2026-08-05T17:56:00+0000' },
        { legId: 2, quantity: 1, price: 4.26, time: '2026-08-05T17:56:00+0000' },
        { legId: 3, quantity: 1, price: 3.69, time: '2026-08-05T17:56:00+0000' },
        { legId: 4, quantity: 1, price: 2.8, time: '2026-08-05T17:56:00+0000' },
      ],
    },
  ],
}

/** 2-LOT single-ticket roll. GLD 2026-09-18 put side 365/385 → 375/395. */
const GLD_ROLL_TWO_LOT: SchwabOrderDetail = {
  orderId: 1007598809028,
  status: 'FILLED',
  enteredTime: '2026-08-14T16:04:14+0000',
  closeTime: '2026-08-14T16:04:15+0000',
  orderType: 'NET_CREDIT',
  complexOrderStrategyType: 'CONDOR',
  quantity: 2,
  filledQuantity: 2,
  price: 2.02,
  orderLegCollection: [
    { legId: 1, instruction: 'SELL_TO_OPEN', quantity: 2, instrument: { assetType: 'OPTION', symbol: 'GLD   260918P00395000', putCall: 'PUT' } },
    { legId: 2, instruction: 'BUY_TO_CLOSE', quantity: 2, instrument: { assetType: 'OPTION', symbol: 'GLD   260918P00385000', putCall: 'PUT' } },
    { legId: 3, instruction: 'BUY_TO_OPEN', quantity: 2, instrument: { assetType: 'OPTION', symbol: 'GLD   260918P00375000', putCall: 'PUT' } },
    { legId: 4, instruction: 'SELL_TO_CLOSE', quantity: 2, instrument: { assetType: 'OPTION', symbol: 'GLD   260918P00365000', putCall: 'PUT' } },
  ],
  orderActivityCollection: [
    {
      executionLegs: [
        { legId: 1, quantity: 2, price: 6.83, time: '2026-08-14T16:04:15+0000' },
        { legId: 2, quantity: 2, price: 3.88, time: '2026-08-14T16:04:15+0000' },
        { legId: 3, quantity: 2, price: 2.1, time: '2026-08-14T16:04:15+0000' },
        { legId: 4, quantity: 2, price: 1.17, time: '2026-08-14T16:04:15+0000' },
      ],
    },
  ],
}

/** SPLIT ROLL, leg 1 of 2 — the close. SPY 2026-09-11, 15:59:25Z. */
const SPY_SPLIT_CLOSE: SchwabOrderDetail = {
  orderId: 1007598808689,
  status: 'FILLED',
  enteredTime: '2026-08-14T15:59:25+0000',
  closeTime: '2026-08-14T15:59:26+0000',
  orderType: 'NET_DEBIT',
  complexOrderStrategyType: 'VERTICAL',
  quantity: 1,
  filledQuantity: 1,
  price: 1.25,
  orderLegCollection: [
    { legId: 1, instruction: 'BUY_TO_CLOSE', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260911P00750000', putCall: 'PUT' } },
    { legId: 2, instruction: 'SELL_TO_CLOSE', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260911P00735000', putCall: 'PUT' } },
  ],
  orderActivityCollection: [
    {
      executionLegs: [
        { legId: 1, quantity: 1, price: 3.14, time: '2026-08-14T15:59:26+0000' },
        { legId: 2, quantity: 1, price: 1.89, time: '2026-08-14T15:59:26+0000' },
      ],
    },
  ],
}

/** SPLIT ROLL, leg 2 of 2 — the open. SPY 2026-09-11, 16:03:53Z (4m28s later). */
const SPY_SPLIT_OPEN: SchwabOrderDetail = {
  orderId: 1007598809002,
  status: 'FILLED',
  enteredTime: '2026-08-14T16:03:53+0000',
  closeTime: '2026-08-14T16:03:54+0000',
  orderType: 'NET_CREDIT',
  complexOrderStrategyType: 'VERTICAL',
  quantity: 1,
  filledQuantity: 1,
  price: 2.48,
  orderLegCollection: [
    { legId: 1, instruction: 'SELL_TO_OPEN', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260911P00765000', putCall: 'PUT' } },
    { legId: 2, instruction: 'BUY_TO_OPEN', quantity: 1, instrument: { assetType: 'OPTION', symbol: 'SPY   260911P00750000', putCall: 'PUT' } },
  ],
  orderActivityCollection: [
    {
      executionLegs: [
        { legId: 1, quantity: 1, price: 5.6, time: '2026-08-14T16:03:54+0000' },
        { legId: 2, quantity: 1, price: 3.12, time: '2026-08-14T16:03:54+0000' },
      ],
    },
  ],
}

export const GOLDEN_FILLS = {
  GLD_ENTRY,
  SPY_BUTTERFLY_CLOSE,
  SPY_ROLL_CONDOR,
  SPY_ROLL_CUSTOM,
  GLD_ROLL_TWO_LOT,
  SPY_SPLIT_CLOSE,
  SPY_SPLIT_OPEN,
}


# Charles Schwab Trader API – Consolidated Documentation

> **Source:** Charles Schwab Developer Portal – Trader API (Individual)  
> **Base URLs:**  
> - Market Data: `https://api.schwabapi.com/marketdata/v1`  
> - Accounts & Trading: `https://api.schwabapi.com/trader/v1`  
> - OAuth: `https://api.schwabapi.com/v1/oauth`  
> **Contact:** TraderAPI@schwab.com

---

## Table of Contents

1. [Market Data API – Endpoints & Schemas](#1-market-data-api)
2. [Accounts & Trading API – Endpoints & Schemas](#2-accounts--trading-api)
3. [OAuth 2.0 Authentication](#3-oauth-20-authentication)
4. [Order Samples](#4-order-samples)
5. [Streamer API (WebSocket)](#5-streamer-api-websocket)

---

## 1. Market Data API

**Base URL:** `https://api.schwabapi.com/marketdata/v1`

### Endpoints

#### Quotes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/quotes` | Get quotes by list of symbols |
| `GET` | `/{symbol_id}/quotes` | Get quote by single symbol |

#### Option Chains

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/chains` | Get option chain for an optionable symbol |
| `GET` | `/expirationchain` | Get option expiration chain for an optionable symbol |

#### Price History

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/pricehistory` | Get price history for a single symbol and date ranges |

#### Movers

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/movers/{symbol_id}` | Get movers for a specific index |

#### Market Hours

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/markets` | Get market hours for different markets |
| `GET` | `/markets/{market_id}` | Get market hours for a single market |

#### Instruments

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/instruments` | Get instruments by symbols and projections |
| `GET` | `/instruments/{cusip_id}` | Get instrument by specific CUSIP |

### Schemas

`Bond`, `FundamentalInst`, `Instrument`, `InstrumentResponse`, `Hours`, `Interval`, `Screener`, `Candle`, `CandleList`, `EquityResponse`, `QuoteError`, `ExtendedMarket`, `ForexResponse`, `Fundamental`, `FutureOptionResponse`, `FutureResponse`, `IndexResponse`, `MutualFundResponse`, `OptionResponse`, `QuoteEquity`, `QuoteForex`, `QuoteFuture`, `QuoteFutureOption`, `QuoteIndex`, `QuoteMutualFund`, `QuoteOption`, `QuoteRequest`, `QuoteResponse`, `QuoteResponseObject`, `ReferenceEquity`, `ReferenceForex`, `ReferenceFuture`, `ReferenceFutureOption`, `ReferenceIndex`, `ReferenceMutualFund`, `ReferenceOption`, `RegularMarket`, `AssetMainType`, `EquityAssetSubType`, `MutualFundAssetSubType`, `ContractType`, `SettlementType`, `ExpirationType`, `FundStrategy`, `ExerciseType`, `DivFreq`, `QuoteType`, `ErrorResponse`, `Error`, `ErrorSource`, `OptionChain`, `OptionContractMap`, `Underlying`, `OptionDeliverables`, `OptionContract`, `ExpirationChain`, `Expiration`

---

## 2. Accounts & Trading API

**Base URL:** `https://api.schwabapi.com/trader/v1`

### Endpoints

#### Accounts

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/accounts/accountNumbers` | Get list of account numbers and their encrypted values |
| `GET` | `/accounts` | Get linked account(s) balances and positions for the logged-in user |
| `GET` | `/accounts/{accountNumber}` | Get a specific account balance and positions |

#### Orders

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/accounts/{accountNumber}/orders` | Get all orders for a specific account |
| `POST` | `/accounts/{accountNumber}/orders` | Place order for a specific account |
| `GET` | `/accounts/{accountNumber}/orders/{orderId}` | Get a specific order by its ID |
| `DELETE` | `/accounts/{accountNumber}/orders/{orderId}` | Cancel an order for a specific account |
| `PUT` | `/accounts/{accountNumber}/orders/{orderId}` | Replace order for a specific account |
| `GET` | `/orders` | Get all orders for all accounts |
| `POST` | `/accounts/{accountNumber}/previewOrder` | Preview order for a specific account |

#### Transactions

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/accounts/{accountNumber}/transactions` | Get all transactions for a specific account |
| `GET` | `/accounts/{accountNumber}/transactions/{transactionId}` | Get a specific transaction |

#### User Preferences

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/userPreference` | Get user preference information for the logged-in user |

### Order Throttle Limits

Trader API applications are limited in the number of `PUT`/`POST`/`DELETE` order requests per minute per account. Throttle limits can be set from **0 to 120 requests per minute per account**. `GET` order requests are unthrottled. Contact TraderAPI@schwab.com for details.

### Option Symbol Format

```
Underlying Symbol (6 chars, space-padded) | Expiration YYMMDD (6 chars) | C/P (1 char) | Strike (8 chars: 5 whole + 3 decimal)
```

**Examples:**

| Option Symbol | Stock | Expiration | Type | Strike |
|---|---|---|---|---|
| `XYZ   210115C00050000` | XYZ | 2021-01-15 | Call | $50.00 |
| `XYZ   210115C00055000` | XYZ | 2021-01-15 | Call | $55.00 |
| `XYZ   210115C00062500` | XYZ | 2021-01-15 | Call | $62.50 |

### Order Instructions by Asset Type

| Instruction | EQUITY (Stocks/ETFs) | OPTION |
|---|---|---|
| `BUY` | ✅ | ❌ |
| `SELL` | ✅ | ❌ |
| `BUY_TO_OPEN` | ❌ | ✅ |
| `BUY_TO_COVER` | ✅ | ❌ |
| `BUY_TO_CLOSE` | ❌ | ✅ |
| `SELL_TO_OPEN` | ❌ | ✅ |
| `SELL_SHORT` | ✅ | ❌ |
| `SELL_TO_CLOSE` | ❌ | ✅ |

### Schemas

`AccountNumberHash`, `session`, `duration`, `orderType`, `orderTypeRequest`, `complexOrderStrategyType`, `requestedDestination`, `stopPriceLinkBasis`, `stopPriceLinkType`, `stopPriceOffset`, `stopType`, `priceLinkBasis`, `priceLinkType`, `taxLotMethod`, `specialInstruction`, `orderStrategyType`, `status`, `amountIndicator`, `settlementInstruction`, `OrderStrategy`, `OrderLeg`, `OrderBalance`, `OrderValidationResult`, `OrderValidationDetail`, `APIRuleAction`, `CommissionAndFee`, `Commission`, `CommissionLeg`, `CommissionValue`, `Fees`, `FeeLeg`, `FeeValue`, `FeeType`, `Account`, `DateParam`, `Order`, `OrderRequest`, `PreviewOrder`, `OrderActivity`, `ExecutionLeg`, `Position`, `ServiceError`, `OrderLegCollection`, `SecuritiesAccount`, `SecuritiesAccountBase`, `MarginAccount`, `MarginInitialBalance`, `MarginBalance`, `CashAccount`, `CashInitialBalance`, `CashBalance`, `TransactionBaseInstrument`, `AccountsBaseInstrument`, `AccountsInstrument`, `TransactionInstrument`, `TransactionCashEquivalent`, `CollectiveInvestment`, `instruction`, `assetType`, `Currency`, `TransactionEquity`, `TransactionFixedIncome`, `Forex`, `Future`, `Index`, `TransactionMutualFund`, `TransactionOption`, `Product`, `AccountCashEquivalent`, `AccountEquity`, `AccountFixedIncome`, `AccountMutualFund`, `AccountOption`, `AccountAPIOptionDeliverable`, `TransactionAPIOptionDeliverable`, `apiOrderStatus`, `TransactionType`, `Transaction`, `UserDetails`, `TransferItem`, `UserPreference`, `UserPreferenceAccount`, `StreamerInfo`, `Offer`

---

## 3. OAuth 2.0 Authentication

Schwab uses the **OAuth 2 Authorization Code (Three-Legged) flow** over HTTPS. Access tokens replace username/password for accessing protected resources.

**References:**
- OAuth 2: https://tools.ietf.org/html/rfc6749
- Bearer Token: https://tools.ietf.org/html/rfc6750

### Token Lifetimes

| Token | Validity |
|---|---|
| Access Token | **30 minutes** |
| Refresh Token | **7 days** |

### Key Terms

| Term | Description |
|---|---|
| **App** | OAuth registration entity in the Dev Portal. Has a Client ID and Client Secret. |
| **Client ID / Client Secret** | Unique values per App; Client Secret must be kept confidential. |
| **Callback URL** | `redirect_uri` – must be HTTPS. Multiple URLs supported (comma-separated, 255-char limit). `https://127.0.0.1` is supported for localhost. |
| **CAG** | Consent and Grant – user approval process via LMS. |
| **LMS** | Login Micro Site – Schwab's login portal for CAG activities. |
| **Access Token** | 30-minute bearer token used in `Authorization: Bearer {token}` header. |
| **Refresh Token** | 7-day token used to renew the access token without repeating the full OAuth flow. |
| **Bearer Token** | The access token used in an API Authorization header. |

### Flow: Step 1 – App Authorization

Direct the user to Schwab's LMS to perform CAG (Consent and Grant):

```
GET https://api.schwabapi.com/v1/oauth/authorize?client_id={CONSUMER_KEY}&redirect_uri={APP_CALLBACK_URL}
```

After CAG completes, the user is redirected to:

```
https://{APP_CALLBACK_URL}/?code={AUTHORIZATION_CODE_GENERATED}&session={SESSION_ID}
```

> Note: The page may show a 404, but the `code` parameter is in the URL. The `code` must be **URL decoded** before use (e.g., `%40` → `@`).

### Flow: Step 2 – Create Access Token

```bash
curl -X POST https://api.schwabapi.com/v1/oauth/token \
  -H 'Authorization: Basic {BASE64_ENCODED_Client_ID:Client_Secret}' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=authorization_code&code={AUTHORIZATION_CODE_VALUE}&redirect_uri=https://example_url.com/callback_example'
```

**Response:**
```json
{
  "expires_in": 1800,
  "token_type": "Bearer",
  "scope": "api",
  "refresh_token": "{REFRESH_TOKEN_HERE}",
  "access_token": "{ACCESS_TOKEN_HERE}",
  "id_token": "{JWT_HERE}"
}
```

### Flow: Step 3 – Make an API Call

```
Authorization: Bearer {access_token}
```

**Example:**
```
Authorization: Bearer I0.kC95zyI039S-YTEw=
```

### Flow: Step 4 – Refresh Access Token

```bash
curl -X POST https://api.schwabapi.com/v1/oauth/token \
  -H 'Authorization: Basic {BASE64_ENCODED_Client_ID:Client_Secret}' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=refresh_token&refresh_token={REFRESH_TOKEN_GENERATED_FROM_PRIOR_STEP}'
```

**Response:**
```json
{
  "expires_in": 1800,
  "token_type": "Bearer",
  "scope": "api",
  "refresh_token": "{REFRESH_TOKEN_HERE}",
  "access_token": "{NEW_ACCESS_TOKEN_HERE}",
  "id_token": "{JWT_HERE}"
}
```

### When to Restart OAuth vs. Refresh

The Refresh Token step (Step 4) **cannot** be used if the refresh token has expired (after 7 days) or been invalidated (e.g., user password reset). In those cases, restart from Step 1 (App Authorization) and Step 2 (Access Token Creation).

---

## 4. Order Samples

### Buy Market: Stock

Buy 15 shares of XYZ at the Market, good for the Day.

```json
{
  "orderType": "MARKET",
  "session": "NORMAL",
  "duration": "DAY",
  "orderStrategyType": "SINGLE",
  "orderLegCollection": [
    {
      "instruction": "BUY",
      "quantity": 15,
      "instrument": {
        "symbol": "XYZ",
        "assetType": "EQUITY"
      }
    }
  ]
}
```

### Buy Limit: Single Option

Buy to open 10 contracts of the XYZ March 15, 2024 $50 CALL at a Limit of $6.45, good for the Day.

```json
{
  "complexOrderStrategyType": "NONE",
  "orderType": "LIMIT",
  "session": "NORMAL",
  "price": "6.45",
  "duration": "DAY",
  "orderStrategyType": "SINGLE",
  "orderLegCollection": [
    {
      "instruction": "BUY_TO_OPEN",
      "quantity": 10,
      "instrument": {
        "symbol": "XYZ   240315C00500000",
        "assetType": "OPTION"
      }
    }
  ]
}
```

### Buy Limit: Vertical Put Spread

Buy to open 2 contracts of the XYZ March 15, 2024 $45 Put and sell to open 2 contracts of the XYZ March 15, 2024 $43 Put at a NET_DEBIT price of $0.10, good for the Day.

```json
{
  "orderType": "NET_DEBIT",
  "session": "NORMAL",
  "price": "0.10",
  "duration": "DAY",
  "orderStrategyType": "SINGLE",
  "orderLegCollection": [
    {
      "instruction": "BUY_TO_OPEN",
      "quantity": 2,
      "instrument": {
        "symbol": "XYZ   240315P00045000",
        "assetType": "OPTION"
      }
    },
    {
      "instruction": "SELL_TO_OPEN",
      "quantity": 2,
      "instrument": {
        "symbol": "XYZ   240315P00043000",
        "assetType": "OPTION"
      }
    }
  ]
}
```

### Conditional: One Triggers Another (OTA)

Buy 10 shares of XYZ at $34.97 Limit, Day. If filled, immediately submit a sell order at $42.03 Limit, Day.

```json
{
  "orderType": "LIMIT",
  "session": "NORMAL",
  "price": "34.97",
  "duration": "DAY",
  "orderStrategyType": "TRIGGER",
  "orderLegCollection": [
    {
      "instruction": "BUY",
      "quantity": 10,
      "instrument": { "symbol": "XYZ", "assetType": "EQUITY" }
    }
  ],
  "childOrderStrategies": [
    {
      "orderType": "LIMIT",
      "session": "NORMAL",
      "price": "42.03",
      "duration": "DAY",
      "orderStrategyType": "SINGLE",
      "orderLegCollection": [
        {
          "instruction": "SELL",
          "quantity": 10,
          "instrument": { "symbol": "XYZ", "assetType": "EQUITY" }
        }
      ]
    }
  ]
}
```

### Conditional: One Cancels Another (OCO)

Sell 2 shares of XYZ at a Limit of $45.97 and Sell 2 shares with a Stop Limit (stop $37.03 / limit $37.00). If one fills, the other is cancelled.

```json
{
  "orderStrategyType": "OCO",
  "childOrderStrategies": [
    {
      "orderType": "LIMIT",
      "session": "NORMAL",
      "price": "45.97",
      "duration": "DAY",
      "orderStrategyType": "SINGLE",
      "orderLegCollection": [
        {
          "instruction": "SELL",
          "quantity": 2,
          "instrument": { "symbol": "XYZ", "assetType": "EQUITY" }
        }
      ]
    },
    {
      "orderType": "STOP_LIMIT",
      "session": "NORMAL",
      "price": "37.00",
      "stopPrice": "37.03",
      "duration": "DAY",
      "orderStrategyType": "SINGLE",
      "orderLegCollection": [
        {
          "instruction": "SELL",
          "quantity": 2,
          "instrument": { "symbol": "XYZ", "assetType": "EQUITY" }
        }
      ]
    }
  ]
}
```

### Conditional: One Triggers an OCO (1st Trigger OCO)

Buy 5 shares of XYZ at $14.97 Limit, Day. Once filled, submit OCO: Sell 5 at $15.27 Limit GTC and Sell 5 at $11.27 Stop GTC.

```json
{
  "orderStrategyType": "TRIGGER",
  "session": "NORMAL",
  "duration": "DAY",
  "orderType": "LIMIT",
  "price": 14.97,
  "orderLegCollection": [
    {
      "instruction": "BUY",
      "quantity": 5,
      "instrument": { "assetType": "EQUITY", "symbol": "XYZ" }
    }
  ],
  "childOrderStrategies": [
    {
      "orderStrategyType": "OCO",
      "childOrderStrategies": [
        {
          "orderStrategyType": "SINGLE",
          "session": "NORMAL",
          "duration": "GOOD_TILL_CANCEL",
          "orderType": "LIMIT",
          "price": 15.27,
          "orderLegCollection": [
            {
              "instruction": "SELL",
              "quantity": 5,
              "instrument": { "assetType": "EQUITY", "symbol": "XYZ" }
            }
          ]
        },
        {
          "orderStrategyType": "SINGLE",
          "session": "NORMAL",
          "duration": "GOOD_TILL_CANCEL",
          "orderType": "STOP",
          "stopPrice": 11.27,
          "orderLegCollection": [
            {
              "instruction": "SELL",
              "quantity": 5,
              "instrument": { "assetType": "EQUITY", "symbol": "XYZ" }
            }
          ]
        }
      ]
    }
  ]
}
```

### Sell Trailing Stop: Stock

Sell 10 shares of XYZ with a Trailing Stop at a -$10 offset, good for the Day.

```json
{
  "complexOrderStrategyType": "NONE",
  "orderType": "TRAILING_STOP",
  "session": "NORMAL",
  "stopPriceLinkBasis": "BID",
  "stopPriceLinkType": "VALUE",
  "stopPriceOffset": 10,
  "duration": "DAY",
  "orderStrategyType": "SINGLE",
  "orderLegCollection": [
    {
      "instruction": "SELL",
      "quantity": 10,
      "instrument": { "symbol": "XYZ", "assetType": "EQUITY" }
    }
  ]
}
```

---

## 5. Streamer API (WebSocket)

The Streamer API uses **WebSockets** with **JSON formatting** to stream market data and account activity in real time. Authentication uses the **Access Token** from the POST Token endpoint. Connection info is provided by the **GET User Preference** endpoint.

### Available Services

| Service Name | Description | Delivery Type |
|---|---|---|
| `LEVELONE_EQUITIES` | Level 1 Equities | Change |
| `LEVELONE_OPTIONS` | Level 1 Options | Change |
| `LEVELONE_FUTURES` | Level 1 Futures | Change |
| `LEVELONE_FUTURES_OPTIONS` | Level 1 Futures Options | Change |
| `LEVELONE_FOREX` | Level 1 Forex | Change |
| `NYSE_BOOK` | Level 2 book for Equities | Whole |
| `NASDAQ_BOOK` | Level 2 book for Equities | Whole |
| `OPTIONS_BOOK` | Level 2 book for Options | Whole |
| `CHART_EQUITY` | Chart candle for Equities | All Sequence |
| `CHART_FUTURES` | Chart candle for Futures | All Sequence |
| `SCREENER_EQUITY` | Advances and Decliners for Equities | Whole |
| `SCREENER_OPTION` | Advances and Decliners for Options | Whole |
| `ACCT_ACTIVITY` | Account activity (order fills, etc.) | All Sequence |

### Delivery Types

| Type | Description |
|---|---|
| **All Sequence** | All data streamed with a sequence number; no conflation by streamer (underlying source may conflate). |
| **Change** | Only changed fields are streamed; data is conflated by the streamer. |
| **Whole** | Data streamed as a whole unit in throttled mode. |

### Request Format

Each request is an array of command objects:

| Field | Required | Description |
|---|---|---|
| `service` | ✅ | Service name (e.g., `LEVELONE_EQUITIES`) |
| `command` | ✅ | `LOGIN`, `SUBS`, `ADD`, `UNSUBS`, `VIEW`, `LOGOUT` |
| `requestid` | ✅ | Unique integer identifying the request |
| `SchwabClientCustomerId` | ✅ | From GET User Preference endpoint |
| `SchwabClientCorrelId` | ✅ | Unique session correlation ID from GET User Preference endpoint |
| `parameters` | ➖ | Optional: fields, keys, version, credential, etc. |

### Commands

| Command | Description |
|---|---|
| `LOGIN` | Must be first request; must succeed before any other commands |
| `SUBS` | Subscribes to a set of symbols, **overwriting** all previously subscribed symbols for that service |
| `ADD` | Adds symbols to existing subscription without removing prior symbols |
| `UNSUBS` | Unsubscribes specific symbols from a service |
| `VIEW` | Changes the field subscription for a service (applies to all symbols in that service) |
| `LOGOUT` | Logs out and closes the streamer connection |

**Single Request Example:**
```json
{
  "requestid": "0",
  "service": "LEVELONE_EQUITIES",
  "command": "SUBS",
  "SchwabClientCustomerId": "Someone",
  "SchwabClientCorrelId": "3be0b7e7-5b8b-4fd3-9bed-7f49106cfe1",
  "parameters": {
    "keys": "AAPL",
    "fields": "0,1,2,3,4,5,6,7,8,9,10"
  }
}
```

**Multiple Requests Example (with LOGIN):**
```json
{
  "requests": [
    {
      "requestid": "1",
      "service": "ADMIN",
      "command": "LOGIN",
      "SchwabClientCustomerId": "Someone",
      "SchwabClientCorrelId": "2be0b7e7-5b8b-4fd3-9bed-7f49106cfe1",
      "parameters": {
        "Authorization": "PN",
        "SchwabClientChannel": "IO",
        "SchwabClientFunctionId": "Tradeticket"
      }
    },
    {
      "requestid": "3",
      "service": "LEVELONE_EQUITIES",
      "command": "SUBS",
      "SchwabClientCustomerId": "Someone",
      "SchwabClientCorrelId": "2be0b7e7-5b8b-4fd3-9bed-7f49106cfe1",
      "parameters": {
        "keys": "AAPL",
        "fields": "0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19"
      }
    }
  ]
}
```

### Response Format

Three response types exist:

| Type | Description |
|---|---|
| `response` | Reply to a request |
| `notify` | Heartbeat notifications |
| `data` | Streaming market data |

**Heartbeat Example:**
```json
{"notify":[{"heartbeat":"1668715930582"}]}
```

**Subscription Confirmation Example:**
```json
{
  "response": [{
    "service": "LEVELONE_EQUITIES",
    "command": "SUBS",
    "requestid": "0",
    "SchwabClientCorrelId": "3be0b7e7-5b8b-4fd3-9bed-7f49106cfe1",
    "timestamp": 1668715930582,
    "content": { "code": 0, "msg": "SUBS command succeeded" }
  }]
}
```

### Response Codes

| Code | Name | Connection Severed | Notes |
|---|---|---|---|
| 0 | `SUCCESS` | No | Request was successful |
| 3 | `LOGIN_DENIED` | Yes | Reconnect and re-login with a new token |
| 9 | `UNKNOWN_FAILURE` | TBD | Contact TraderAPI@Schwab.com with `schwabClientCorrelId` |
| 11 | `SERVICE_NOT_AVAILABLE` | No | Unsupported service or service not running; contact TraderAPI@Schwab.com |
| 12 | `CLOSE_CONNECTION` | Yes | Maximum connections reached (limit: 1 connection per user at any given time) |
| 19 | `REACHED_SYMBOL_LIMIT` | No | Subscribe/Add has exceeded total symbol subscription limit |
| 20 | `STREAM_CONN_NOT_FOUND` | TBD | Cannot find connection; often a race condition or modified correlation IDs |
| 21 | `BAD_COMMAND_FORMAT` | No | Command does not match specification |
| 22 | `FAILED_COMMAND_SUBS` | No | Subscribe command failed; contact TraderAPI@Schwab.com |
| 23 | `FAILED_COMMAND_UNSUBS` | No | Unsubscribe command failed |
| 24 | `FAILED_COMMAND_ADD` | No | Add command failed |
| 25 | `FAILED_COMMAND_VIEW` | No | View command failed |
| 26 | `SUCCEEDED_COMMAND_SUBS` | No | Subscribe succeeded |
| 27 | `SUCCEEDED_COMMAND_UNSUBS` | No | Unsubscribe succeeded |
| 28 | `SUCCEEDED_COMMAND_ADD` | No | Add succeeded |
| 29 | `SUCCEEDED_COMMAND_VIEW` | No | View succeeded |
| 30 | `STOP_STREAMING` | Yes | Streaming terminated (administrator action, inactivity, slowness, or no subscriptions) |

---

### 5.1 Admin Service

#### Login Request

| Field | Type | Description |
|---|---|---|
| `service` | String | `ADMIN` |
| `command` | String | `LOGIN` |
| `requestid` | Integer | Unique request identifier |
| `SchwabClientCustomerId` | String | From GET User Preference |
| `SchwabClientCorrelId` | String | Unique session correlation ID |
| `parameters.Authorization` | String | Access Token from POST Token endpoint |
| `parameters.SchwabClientChannel` | String (2 chars) | Channel ID from GET User Preferences |
| `parameters.SchwabClientFunctionId` | String (5 chars) | Page/source identifier from GET User Preferences |

**Login Request Example:**
```json
{
  "requests": [{
    "requestid": "1",
    "service": "ADMIN",
    "command": "LOGIN",
    "SchwabClientCustomerId": "Someone",
    "SchwabClientCorrelId": "5be0b7e7-5b8b-4fd3-9bed-7f49106cfe96",
    "parameters": {
      "Authorization": "Access Token",
      "SchwabClientChannel": "N9",
      "SchwabClientFunctionId": "APIAPP"
    }
  }]
}
```

**Login Successful Response:**
```json
{
  "response": [{
    "service": "ADMIN",
    "command": "LOGIN",
    "requestid": "1",
    "SchwabClientCorrelId": "5be0b7e7-5b8b-4fd3-9bed-7f49106cfe96",
    "timestamp": 1669828276886,
    "content": { "code": 0, "msg": "server=s0166bdv-1;status=PN" }
  }]
}
```

Login `status` values: `PN` (Non-Paying Pro), `NP` (Non-Pro), `PP` (Paying-Pro). Without entitlements, the client receives NFL/delayed quotes.

**Login Denied Response:**
```json
{
  "response": [{
    "service": "ADMIN",
    "command": "LOGIN",
    "requestid": "1",
    "SchwabClientCorrelId": "5be0b7e7-5b8b-4fd3-9bed-7f49106cfe96",
    "timestamp": 1669828982588,
    "content": { "code": 3, "msg": "Login Denied.: token is invalid or has expired." }
  }]
}
```

#### Logout

**Logout Response Example:**
```json
{
  "response": [{
    "service": "ADMIN",
    "command": "LOGOUT",
    "requestid": "0",
    "SchwabClientCorrelId": "5be0b7e7-5b8b-4fd3-9bed-7f49106cfe95",
    "timestamp": 1669830137089,
    "content": { "code": 0, "msg": "SUCCESS" }
  }]
}
```

---

### 5.2 LEVELONE_EQUITIES

**Symbol format:** Schwab-standard uppercase ticker (e.g., `AAPL,TSLA,IBM`)

**Request Example:**
```json
{
  "requests": [{
    "service": "LEVELONE_EQUITIES",
    "requestid": 1,
    "command": "SUBS",
    "SchwabClientCustomerId": "Someone",
    "SchwabClientCorrelId": "29bdf6d-b9d0-46dd-8786-424e1577bd",
    "parameters": {
      "keys": "SCHW,AAPL,SPY",
      "fields": "0,1,2,3,4,5,8,10"
    }
  }]
}
```

#### Response: Initial Fields

| Field | Type | Description |
|---|---|---|
| `key` | String | Ticker symbol |
| `delayed` | Boolean | `false` = SIP (real-time); `true` = NFL (delayed or subset) |
| `assetMainType` | String | `BOND`, `EQUITY`, `ETF`, `EXTENDED`, `FOREX`, `FUTURE`, `FUTURE_OPTION`, `FUNDAMENTAL`, `INDEX`, `INDICATOR`, `MUTUAL_FUND`, `OPTION`, `UNKNOWN` |
| `assetSubType` | String | `ADR`, `CEF`, `COE`, `ETF`, `ETN`, `GDR`, `OEF`, `PRF`, `RGT`, `UIT`, `WAR` |
| `cusip` | String | 9-digit CUSIP |

#### Numeric Fields

| Field # | Name | Type | Description |
|---|---|---|---|
| 0 | Symbol | String | Ticker in upper case |
| 1 | Bid Price | Double | Current bid |
| 2 | Ask Price | Double | Current ask |
| 3 | Last Price | Double | Last trade price |
| 4 | Bid Size | Int | Shares for bid (units: lots, typically 100 shares) |
| 5 | Ask Size | Int | Shares for ask |
| 6 | Ask ID | Char | Exchange with the ask |
| 7 | Bid ID | Char | Exchange with the bid |
| 8 | Total Volume | Long | Aggregated shares traded (including pre/post market); resets at 7:28am ET |
| 9 | Last Size | Long | Shares traded with last trade |
| 10 | High Price | Double | Day's high; resets at 3:30am ET |
| 11 | Low Price | Double | Day's low; resets at 3:30am ET |
| 12 | Close Price | Double | Previous day's closing price; updated from DB at 3:30am ET |
| 13 | Exchange ID | Char | Primary listing exchange (A=AMEX, Q=NASDAQ, N=NYSE, P=Pacific, 9=Pinks, etc.) |
| 14 | Marginable | Boolean | Eligible for margin collateral |
| 15 | Description | String | Company, index, or fund name; loaded at 7:29:50am ET |
| 16 | Last ID | Char | Exchange where last trade executed |
| 17 | Open Price | Double | Day's open; resets at 3:30am ET |
| 18 | Net Change | Double | Last Price – Close Price |
| 19 | 52 Week High | Double | Highest price in past 52 weeks |
| 20 | 52 Week Low | Double | Lowest price in past 52 weeks |
| 21 | PE Ratio | Double | Price-to-earnings ratio |
| 22 | Annual Dividend Amount | Double | Annual dividend amount |
| 23 | Dividend Yield | Double | Dividend yield |
| 24 | NAV | Double | Mutual fund net asset value |
| 25 | Exchange Name | String | Display name of exchange |
| 26 | Dividend Date | String | Dividend date |
| 27 | Regular Market Quote | Boolean | Is last quote a regular quote? |
| 28 | Regular Market Trade | Boolean | Is last trade a regular trade? |
| 29 | Regular Market Last Price | Double | Regular session last price |
| 30 | Regular Market Last Size | Integer | Regular session last size (size/100) |
| 31 | Regular Market Net Change | Double | Regular Market Last Price – Close Price |
| 32 | Security Status | String | `Normal`, `Halted`, `Closed` |
| 33 | Mark Price | Double | Mark price |
| 34 | Quote Time in Long | Long | Last bid/ask update time (ms since epoch) |
| 35 | Trade Time in Long | Long | Last trade time (ms since epoch) |
| 36 | Regular Market Trade Time in Long | Long | Regular market trade time (ms since epoch) |
| 37 | Bid Time | Long | Last bid time (ms since epoch) |
| 38 | Ask Time | Long | Last ask time (ms since epoch) |
| 39 | Ask MIC ID | String | 4-char Market Identifier Code |
| 40 | Bid MIC ID | String | 4-char Market Identifier Code |
| 41 | Last MIC ID | String | 4-char Market Identifier Code |
| 42 | Net Percent Change | Double | Net Change / Close Price × 100 |
| 43 | Regular Market Percent Change | Double | Regular Market Net Change / Close Price × 100 |
| 44 | Mark Price Net Change | Double | Mark price net change |
| 45 | Mark Price Percent Change | Double | Mark price percent change |
| 46 | Hard to Borrow Quantity | Integer | -1 = NULL; ≥ 0 = valid quantity |
| 47 | Hard To Borrow Rate | Double | null = NULL; range: -99,999.999 to +99,999.999 |
| 48 | Hard to Borrow | Integer | -1 = NULL, 1 = true, 0 = false |
| 49 | Shortable | Integer | -1 = NULL, 1 = true, 0 = false |
| 50 | Post-Market Net Change | Double | Post-Market Last Price – Regular Market Last Price |
| 51 | Post-Market Percent Change | Double | Post-Market Net Change / Regular Market Last Price × 100 |

---

### 5.3 LEVELONE_OPTIONS

**Symbol format:** `RRRRRR YYMMDD s WWWWW nnn`  
Where: `R` = space-filled root, `s` = C/P (call/put), `WWWWW` = whole strike, `nnn` = decimal strike  
Example: `AAPL  251219C00200000`

#### Field Definitions

| Field # | Name | Type | Description |
|---|---|---|---|
| 0 | Symbol | String | Ticker in upper case |
| 1 | Description | String | Company/fund name (loaded daily at 3:30am ET) |
| 2 | Bid Price | Double | Current bid |
| 3 | Ask Price | Double | Current ask |
| 4 | Last Price | Double | Last trade price |
| 5 | High Price | Double | Day's high; resets at 3:30am ET |
| 6 | Low Price | Double | Day's low |
| 7 | Close Price | Double | Previous close; updated at 7:29am ET |
| 8 | Total Volume | Long | Contracts traded; resets at 3:30am ET |
| 9 | Open Interest | Int | Open interest |
| 10 | Volatility | Double | Implied volatility; resets at 3:30am ET |
| 11 | Money Intrinsic Value | Double | In-the-money value (positive = ITM, negative = OTM) |
| 12 | Expiration Year | Int | |
| 13 | Multiplier | Double | |
| 14 | Digits | Int | Number of decimal places |
| 15 | Open Price | Double | Day's open |
| 16 | Bid Size | Int | Number of contracts for bid |
| 17 | Ask Size | Int | Number of contracts for ask |
| 18 | Last Size | Int | Contracts traded with last trade |
| 19 | Net Change | Double | Last – Close |
| 20 | Strike Price | Double | Contract strike price |
| 21 | Contract Type | Char | |
| 22 | Underlying | String | |
| 23 | Expiration Month | Int | |
| 24 | Deliverables | String | |
| 25 | Time Value | Double | |
| 26 | Expiration Day | Int | |
| 27 | Days to Expiration | Int | |
| 28 | Delta | Double | |
| 29 | Gamma | Double | |
| 30 | Theta | Double | |
| 31 | Vega | Double | |
| 32 | Rho | Double | |
| 33 | Security Status | String | `Normal`, `Halted`, `Closed` |
| 34 | Theoretical Option Value | Double | |
| 35 | Underlying Price | Double | |
| 36 | UV Expiration Type | Char | |
| 37 | Mark Price | Double | Mark price |
| 38 | Quote Time in Long | Long | Last quote time (ms since epoch) |
| 39 | Trade Time in Long | Long | Last trade time (ms since epoch) |
| 40 | Exchange | Char | Exchange character |
| 41 | Exchange Name | String | Display name |
| 42 | Last Trading Day | Long | Last trading day |
| 43 | Settlement Type | Char | |
| 44 | Net Percent Change | Double | |
| 45 | Mark Price Net Change | Double | |
| 46 | Mark Price Percent Change | Double | |
| 47 | Implied Yield | Double | |
| 48 | isPennyPilot | Boolean | |
| 49 | Option Root | String | |
| 50 | 52 Week High | Double | |
| 51 | 52 Week Low | Double | |
| 52 | Indicative Ask Price | Double | Index options only (0 for others) |
| 53 | Indicative Bid Price | Double | Index options only (0 for others) |
| 54 | Indicative Quote Time | Long | Latest indicative bid/ask update (ms since epoch); index options only |
| 55 | Exercise Type | Char | |

---

### 5.4 LEVELONE_FUTURES

**Symbol format:** `'/' + root symbol + month code + year code`

**Month Codes:** F=Jan, G=Feb, H=Mar, J=Apr, K=May, M=Jun, N=Jul, Q=Aug, U=Sep, V=Oct, X=Nov, Z=Dec  
**Year code:** Last two digits (e.g., `24` = 2024)

**Common Root Symbols:** `ES` (E-Mini S&P 500), `NQ` (E-Mini Nasdaq 100), `CL` (Light Sweet Crude Oil), `GC` (Gold), `HO` (Heating Oil), `BZ` (Brent Crude Oil), `YM` (Mini Dow Jones)

#### Field Definitions

| Field # | Name | Type | Description |
|---|---|---|---|
| 0 | Symbol | String | Ticker in upper case |
| 1 | Bid Price | Double | Current best bid |
| 2 | Ask Price | Double | Current best ask |
| 3 | Last Price | Double | Last trade price |
| 4 | Bid Size | Long | Contracts for bid |
| 5 | Ask Size | Long | Contracts for ask |
| 6 | Bid ID | Char | Exchange with best bid (currently "?" for CME) |
| 7 | Ask ID | Char | Exchange with best ask |
| 8 | Total Volume | Long | Aggregated contracts traded |
| 9 | Last Size | Long | Contracts traded with last trade |
| 10 | Quote Time | Long | Last quote time (ms since epoch) |
| 11 | Trade Time | Long | Last trade time (ms since epoch) |
| 12 | High Price | Double | Day's high |
| 13 | Low Price | Double | Day's low |
| 14 | Close Price | Double | Previous close |
| 15 | Exchange ID | Char | Primary listing exchange |
| 16 | Description | String | Product description |
| 17 | Last ID | Char | Exchange where last trade executed |
| 18 | Open Price | Double | Day's open |
| 19 | Net Change | Double | Last – Close |
| 20 | Future Percent Change | Double | (Last – Close) / Close |
| 21 | Exchange Name | String | Exchange name |
| 22 | Security Status | String | `Normal`, `Halted`, `Closed` |
| 23 | Open Interest | Int | Total open contracts for the day |
| 24 | Mark | Double | Mark-to-market value; = last if within spread, else (bid+ask)/2 |
| 25 | Tick | Double | Minimum price movement |
| 26 | Tick Amount | Double | Tick × multiplier |
| 27 | Product | String | Futures product |
| 28 | Future Price Format | String | Fraction or decimal format (e.g., `D,D` for equity futures; `3,32` for fixed income) |
| 29 | Future Trading Hours | String | Trading hours by day |
| 30 | Future Is Tradable | Boolean | Is this contract tradable? |
| 31 | Future Multiplier | Double | Point value |
| 32 | Future Is Active | Boolean | Is this contract active? |
| 33 | Future Settlement Price | Double | Closing price |
| 34 | Future Active Symbol | String | Symbol of the active contract |
| 35 | Future Expiration Date | Long | Expiration date (ms since epoch) |
| 36 | Expiration Style | String | |
| 37 | Ask Time | Long | Last ask-side quote time (ms since epoch) |
| 38 | Bid Time | Long | Last bid-side quote time (ms since epoch) |
| 39 | Quoted In Session | Boolean | Quoted during active session? |
| 40 | Settlement Date | Long | Settlement date (ms since epoch) |

> For fractional price format details, see: https://www.cmegroup.com/confluence/display/EPICSANDBOX/Fractional+Pricing+-+Display+Examples

---

### 5.5 LEVELONE_FUTURES_OPTIONS

**Symbol format:** `'.' + '/' + root symbol + month code + year code + Call/Put code + Strike Price`  
**Example:** `./OZCZ23C565`

#### Field Definitions

| Field # | Name | Type | Description |
|---|---|---|---|
| 0 | Symbol | String | Ticker in upper case |
| 1 | Bid Price | Double | Current bid |
| 2 | Ask Price | Double | Current ask |
| 3 | Last Price | Double | Last trade price |
| 4 | Bid Size | Long | Contracts for bid |
| 5 | Ask Size | Long | Contracts for ask |
| 6 | Bid ID | Char | Exchange with bid |
| 7 | Ask ID | Char | Exchange with ask |
| 8 | Total Volume | Long | Contracts traded |
| 9 | Last Size | Long | Contracts traded with last trade |
| 10 | Quote Time | Long | Last quote time (ms since epoch) |
| 11 | Trade Time | Long | Last trade time (ms since epoch) |
| 12 | High Price | Double | Day's high |
| 13 | Low Price | Double | Day's low |
| 14 | Close Price | Double | Previous close |
| 15 | Last ID | Char | Exchange where last trade executed |
| 16 | Description | String | Product description |
| 17 | Open Price | Double | Day's open |
| 18 | Open Interest | Double | |
| 19 | Mark | Double | Mark-to-market value |
| 20 | Tick | Double | Minimum price movement |
| 21 | Tick Amount | Double | Tick × multiplier |
| 22 | Future Multiplier | Double | Point value |
| 23 | Future Settlement Price | Double | Closing price |
| 24 | Underlying Symbol | String | Underlying symbol |
| 25 | Strike Price | Double | Strike price |
| 26 | Future Expiration Date | Long | Expiration date (ms since epoch) |
| 27 | Expiration Style | String | |
| 28 | Contract Type | Char | |
| 29 | Security Status | String | `Normal`, `Halted`, `Closed` |
| 30 | Exchange | Char | Exchange character |
| 31 | Exchange Name | String | Display name of exchange |

---

### 5.6 LEVELONE_FOREX

**Symbol format:** `CURRENCY_PAIR` (e.g., `EUR/USD`, `USD/JPY`, `AUD/CAD`)

#### Field Definitions

| Field # | Name | Type | Description |
|---|---|---|---|
| 0 | Symbol | String | Ticker in upper case |
| 1 | Bid Price | Double | Current bid |
| 2 | Ask Price | Double | Current ask |
| 3 | Last Price | Double | Last trade price |
| 4 | Bid Size | Long | Currency pairs for bid |
| 5 | Ask Size | Long | Currency pairs for ask |
| 6 | Total Volume | Long | Aggregated pairs traded |
| 7 | Last Size | Long | Pairs traded with last trade |
| 8 | Quote Time | Long | Last quote time (ms since epoch) |
| 9 | Trade Time | Long | Last trade time (ms since epoch) |
| 10 | High Price | Double | Day's high |
| 11 | Low Price | Double | Day's low |
| 12 | Close Price | Double | Previous close |
| 13 | Exchange | Char | |
| 14 | Description | String | Product description |
| 15 | Open Price | Double | Day's open |
| 16 | Net Change | Double | Last – Close |
| 17 | Percent Change | Double | (Last – Close) / Close |
| 18 | Exchange Name | String | Exchange name |
| 19 | Digits | Int | Valid decimal points |
| 20 | Security Status | String | `Normal`, `Halted`, `Closed` |
| 21 | Tick | Double | Minimum price increment |
| 22 | Tick Amount | Double | Tick × multiplier |
| 23 | Product | String | Product name |
| 24 | Trading Hours | String | Trading hours |
| 25 | Is Tradable | Boolean | Is this forex pair tradable? |
| 26 | Market Maker | String | |
| 27 | 52 Week High | Double | Highest price in past 52 weeks |
| 28 | 52 Week Low | Double | Lowest price in past 52 weeks |
| 29 | Mark | Double | Mark-to-market value |

---

### 5.7 BOOK Services (NYSE_BOOK, NASDAQ_BOOK, OPTIONS_BOOK)

**Symbol format:** Uppercase symbols separated by commas (e.g., `AAPL,TSLA,IBM`)

#### Top-Level Fields

| Field # | Name | Type | Description |
|---|---|---|---|
| 0 | Symbol | String | Ticker in upper case |
| 1 | Market Snapshot Time | Long | Timestamp (ms since epoch) |
| 2 | Bid Side Levels | Array | Bid price level array |
| 3 | Ask Side Levels | Array | Ask price level array |

#### Price Level Sub-Fields

| Field # | Name | Type | Description |
|---|---|---|---|
| 0 | Price | Double | Price for this level |
| 1 | Aggregate Size | Int | Total size at this level |
| 2 | Market Maker Count | Int | Number of market makers at this level |
| 3 | Market Makers Array | Array | Array of individual market maker data |

#### Market Maker Sub-Fields

| Field # | Name | Type | Description |
|---|---|---|---|
| 0 | Market Maker ID | String | Market maker identifier |
| 1 | Size | Long | Market maker size at this level |
| 2 | Quote Time | Long | Market maker quote time (ms) |

---

### 5.8 CHART_EQUITY

**Symbol format:** Uppercase equities symbols (e.g., `AAPL,TSLA,IBM`)

#### Field Definitions

| Field # | Name | Type | Description |
|---|---|---|---|
| 0 | key | String | Ticker in upper case |
| 1 | Open Price | Double | Opening price for the minute |
| 2 | High Price | Double | Highest price for the minute |
| 3 | Low Price | Double | Lowest price for the minute |
| 4 | Close Price | Double | Closing price for the minute |
| 5 | Volume | Double | Total volume for the minute |
| 6 | Sequence | Long | Identifies the candle minute |
| 7 | Chart Time | Long | Milliseconds since epoch |
| 8 | Chart Day | Int | |

---

### 5.9 CHART_FUTURES

Same futures symbol format as LEVELONE_FUTURES.

#### Field Definitions

| Field # | Name | Type | Description |
|---|---|---|---|
| 0 | key | String | Ticker in upper case |
| 1 | Chart Time | Long | Milliseconds since epoch |
| 2 | Open Price | Double | Opening price for the minute |
| 3 | High Price | Double | Highest price for the minute |
| 4 | Low Price | Double | Lowest price for the minute |
| 5 | Close Price | Double | Closing price for the minute |
| 6 | Volume | Double | Total volume for the minute |

---

### 5.10 SCREENER Services (SCREENER_EQUITY, SCREENER_OPTION)

**Key format:** `{PREFIX}_{SORTFIELD}_{FREQUENCY}`

**PREFIX options:**
- Indices: `$COMPX`, `$DJI`, `$SPX`, `INDEX_ALL`
- Exchanges: `NYSE`, `NASDAQ`, `OTCBB`, `EQUITY_ALL`
- Options: `OPTION_PUT`, `OPTION_CALL`, `OPTION_ALL`

**SORTFIELD options:** `VOLUME`, `TRADES`, `PERCENT_CHANGE_UP`, `PERCENT_CHANGE_DOWN`, `AVERAGE_PERCENT_VOLUME`

**FREQUENCY options:** `0` (all day), `1`, `5`, `10`, `30`, `60` (minutes)

#### Response Fields

| Index | Field | Type | Description |
|---|---|---|---|
| 0 | symbol | String | Subscribed symbol |
| 1 | timestamp | Long | Market snapshot timestamp (ms since epoch) |
| 2 | sortField | String | Field used to sort |
| 3 | frequency | Integer | Data frequency |
| 4 | items | Array | See items sub-fields below |

**Items Sub-Fields:**

| Field | Type | Description |
|---|---|---|
| description | String | Instrument description |
| lastPrice | Double | Last trade price (2 decimal places) |
| marketShare | Double | Market share percentage (2 decimal places) |
| netChange | Double | Net change (2 decimal places) |
| netPercentChange | Double | Net percent change (4 decimal places) |
| symbol | String | Stock or option symbol |
| totalVolume | Long | Total volume for the day |
| trades | Long | Number of trades for the frequency |
| volume | Long | Volume for the frequency |

---

### 5.11 ACCT_ACTIVITY

**Keys:** A client-provided string that streamer populates updates with (only the first key is used if multiple are provided).  
**Fields:** `"0,1,2,3"` expected.

**Request Example:**
```json
{
  "requests": [{
    "service": "ACCT_ACTIVITY",
    "requestid": "2",
    "command": "SUBS",
    "SchwabClientCustomerId": "Someone",
    "SchwabClientCorrelId": "f308b89-19a7-2d18-4a0a-1c5e7120336",
    "parameters": {
      "keys": "Account Activity",
      "fields": "0,1,2,3"
    }
  }]
}
```

#### Response Fields

| Field | Name | Type | Description |
|---|---|---|---|
| seq | Sequence | Integer | Message number; duplicate seq numbers on reconnect can be ignored |
| key | Key | String | Identifies the subscription this response belongs to |
| 1 | Account | String | Account number where the activity occurred |
| 2 | Message Type | String | Dictates format of Message Data field |
| 3 | Message Data | String | Core data — JSON-formatted update, NULL in some cases, or plain text for ERROR |

---

*Document assembled from Charles Schwab Developer Portal – Trader API (Individual). All API endpoints, schemas, and streamer services are subject to change. Always refer to the official Developer Portal for the latest specifications.*

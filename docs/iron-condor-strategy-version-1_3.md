# Iron Condor Strategy - Version 1.3

## 1. Strategy Philosophy: The "Insurance Company" (TOMIC)
This strategy follows the **The Option Method Insurance Company (TOMIC)** framework. Instead of "betting" on market direction, you are acting as an insurer, collecting premiums by underwriting "catastrophe policies" (out-of-the-money options). Your edge comes from the fact that **Implied Volatility (IV)** historically overstates the actual move of the underlying asset.

---

## 2. Core Trade Architecture
We utilize a **Wide-Wing Iron Condor** to maximize the probability of profit while maintaining a "Black Swan" safety net.

| Component | Target | Role |
| :--- | :--- | :--- |
| **Short Legs** | **~16 Delta** | The "Income" generator. Statistically represents a 1-standard deviation move. |
| **Long Legs** | **~5 Delta** | The "Catastrophe" protection. Limits max loss and reduces buying power requirement. |
| **Wing Width** | **$10 standard** | Wider wings dilute per-contract commission friction (see Section 7). Narrower $5 wings only acceptable in extremely low-priced underlyings (≤$30). |

* **DTE (Days to Expiration):** Target **30–45 days** at entry.
* **Asset Selection:** High-liquidity equity ETF options only. See Pillar menus in Section 3.
* **Target Credit:** ~$150–$200 per condor (15–20% of $10 wing width = $1.50–$2.00 per share).

---

## 3. The Five Pillars (Diversification)
To maintain **Delta Neutrality** and avoid sector-specific wipes, rotate trades across these five uncorrelated pillars. Each pillar has a **Primary** instrument (default choice) and **Alternates** that serve as either **substitutes** (swap in when IV Rank is too low on the primary) or **supplements** (add alongside the primary when you want more exposure within the pillar).

> **Hedge Fund Rule:** Always check **IV Rank** before entry. Only "sell insurance" when the IV Rank is **> 25%**. If an asset has low IV, it is not worth the risk; move to the next pillar or alternate.

---

### Pillar 1 — Equities
*Risk Driver: Broad market sentiment, earnings cycles, macro data*

| Instrument | Role | Notes |
| :--- | :--- | :--- |
| **SPY** *(Primary)* | S&P 500 — anchor position | Highest liquidity, tightest bid/ask. Default first choice. |
| **QQQ** *(Alternate)* | Nasdaq 100 — tech-heavy, higher beta | Substitute or supplement SPY. Higher IV during tech selloffs. See correlation note below. |
| **IWM** *(Alternate)* | Russell 2000 — small caps | Best diversification from SPY (~0.80 correlation vs QQQ's ~0.95). Tends to carry higher IV Rank. |
| **DIA** *(Alternate)* | Dow Jones 30 — value/industrial tilt | Lower beta than SPY; useful when broad market IV is compressed. |
| **EFA** *(Alternate)* | MSCI Developed Markets ex-US (Europe, Japan, Australia) | Captures foreign equity + currency risk. Moderate correlation to SPY (~0.85); driven by European/Japanese macro which can diverge meaningfully from US cycles. Good substitute when US equity IV is compressed. |
| **EEM** *(Alternate)* | MSCI Emerging Markets (China, India, Brazil, etc.) | Lower correlation to SPY than EFA; driven by EM-specific factors (China policy, commodity exports, EM currencies). Historically carries higher IV Rank. Size conservatively given event risk around EM political cycles. |

> ⚠️ **Correlation Risk — Domestic vs. Foreign Equities:** SPY and QQQ move together ~95% of the time — running both simultaneously is not diversification. EFA and EEM offer more genuine separation from US equity risk, but correlations compress toward 1.0 during global sell-offs (e.g., 2008, 2020). Treat any combination of SPY, QQQ, EFA, and EEM as **equity-class exposure** when tallying your overall portfolio concentration. Do not run more than two equity-pillar positions simultaneously.

---

### Pillar 2 — Fixed Income
*Risk Driver: Interest rate expectations, Fed policy, credit spreads*

| Instrument | Role | Notes |
| :--- | :--- | :--- |
| **TLT** *(Primary)* | 20+ Year Treasury — long duration | Most liquid bond ETF for options. High sensitivity to rate moves; often inversely correlated to SPY. |
| **IEF** *(Alternate)* | 7–10 Year Treasury — intermediate duration | Lower volatility than TLT; useful as substitute when TLT IV is compressed or for a smaller BPR commitment. |
| **HYG** *(Alternate)* | High Yield Corporate Bonds | Carries credit risk in addition to rate risk; IV spikes in risk-off environments alongside equities. Use as supplement, not a hedge. |
| **LQD** *(Alternate)* | Investment Grade Corporate Bonds | Sits between TLT and HYG in risk/reward. Good substitute when you want credit exposure with less volatility than HYG. |

> ⚠️ **Credit Risk Note — HYG & LQD:** Unlike treasuries, corporate bond ETFs carry issuer default risk. During equity sell-offs, HYG in particular can move *with* SPY (not against it), reducing the diversification benefit of the Fixed Income pillar. Check HYG/SPY correlation during high-stress periods before treating it as a true equity hedge.

---

### Pillar 3 — Commodities
*Risk Driver: Inflation, geopolitical events, supply/demand cycles*

| Instrument | Role | Notes |
| :--- | :--- | :--- |
| **GLD** *(Primary)* | Gold — inflation & safe-haven hedge | Anchor commodity position. Liquid options chain, low correlation to both SPY and TLT. |
| **SLV** *(Alternate)* | Silver — industrial + monetary metal | Higher beta than GLD (more volatile). Good substitute when GLD IV is low; can supplement GLD during metals runs. |
| **USO** *(Alternate)* | Crude Oil | Carries geopolitical and energy-cycle risk. IV can be extreme around OPEC decisions or supply shocks. Size conservatively. |
| **DBA** *(Alternate)* | Agriculture (grains, softs, livestock basket) | Low correlation to all other pillars. Good diversifier; IV spikes around weather events and crop reports. |

> ⚠️ **Contango Risk — USO:** USO holds oil futures contracts and suffers from "roll decay" in contango markets (when future prices exceed spot). This causes USO to underperform spot crude over time, which can affect how the underlying drifts. Be aware of the futures roll schedule when holding USO positions near expiration.

---

### Pillar 4 — Volatility
*Risk Driver: Market fear, VIX spikes, macro uncertainty*

This pillar is **structurally different** from the others. Volatility instruments are mean-reverting and carry significant decay risk. Iron condors here are viable but require tighter management. Risk control comes from **position count** (max one open vol position at a time), not from undersizing — at $10 wings, commission friction makes undersized vol trades unprofitable.

| Instrument | Role | Notes |
| :--- | :--- | :--- |
| **VXX** *(Primary)* | Short-term VIX futures — fear gauge | Most liquid vol ETF for options. Subject to heavy decay (contango in VIX futures); benefits short premium sellers over time. |
| **UVXY** *(Alternate)* | 1.5x leveraged short-term VIX futures | Higher premium, but decay is amplified and spikes are sharper. Treat as a high-intensity substitute for VXX — not a supplement. |
| **SVXY** *(Alternate)* | Inverse short-term VIX futures | Moves opposite to VIX. Use iron condors here only when volatility has recently spiked and mean reversion is expected. Sizing should be especially conservative; SVXY can suffer catastrophic drawdowns during vol spikes (see Feb 2018). |

> ⚠️ **Critical Warning — Volatility Instruments:** VXX, UVXY, and SVXY are **not** traditional buy-and-hold ETFs. They are designed for short-term trading and behave asymmetrically: VXX/UVXY can spike 50–100%+ overnight during a market panic, turning a high-probability iron condor into a max-loss scenario almost instantly. **Always:**
> - Hold **only one open Volatility pillar position at a time** (risk management via position count, not size)
> - Keep stop losses tighter (consider **1.5x** credit received as your stop, vs. the standard 2–3x)
> - Monitor actively in the final 30 days; exit at **21 DTE without exception**

---

### Pillar 5 — Currencies
*Risk Driver: Central bank policy divergence, macro flight-to-safety, trade flows, geopolitical stress*

Currencies are the most genuinely uncorrelated asset class available for this framework. Unlike equities, bonds, and commodities — which all tend to correlate during broad risk-off events — currency moves are driven by **relative** central bank policy (Fed vs. ECB vs. BOJ), making them structurally independent from the other four pillars. The options chains on currency ETFs are thinner than SPY or TLT, so bid/ask discipline and limit orders are especially important here.

| Instrument | Role | Notes |
| :--- | :--- | :--- |
| **UUP** *(Primary)* | US Dollar Index (DXY basket) | Anchor currency position. Tends to move *inversely* to commodities and risk assets; strengthens during flight-to-safety events. Most liquid currency ETF options chain. |
| **FXY** *(Alternate)* | Japanese Yen | One of the few true safe-haven currencies. Often rallies sharply during equity crashes (yen carry trade unwinds). Provides genuine anti-correlation to the Equity pillar. Substitute for UUP when BOJ policy diverges from Fed direction. |
| **FXE** *(Alternate)* | Euro | Driven by ECB policy and European macro; can diverge significantly from USD during EU-specific stress events (sovereign debt crises, energy shocks). Good substitute when UUP IV is low. |
| **FXB** *(Alternate)* | British Pound | Less liquid than FXE; useful when UK-specific macro events (BOE decisions, trade policy) create elevated IV. Treat as a low-frequency supplement only. |

> ⚠️ **Liquidity Warning — Currency ETFs:** Options volume on FXY, FXE, and FXB is significantly lower than equity or bond ETFs. Always check open interest and bid/ask spread before entry. If the spread on the iron condor exceeds **25% of the total credit**, pass and wait for better conditions. Hold **only one open Currency pillar position at a time** — risk management for this pillar comes from position count, not from undersizing.

> ⚠️ **Carry Trade Risk — FXY:** The Japanese Yen is heavily influenced by the "yen carry trade" (borrowing cheap JPY to buy higher-yielding assets). When this trade unwinds — often suddenly and violently — FXY can move 5–10% in days. This is a feature (high IV = good premium) but can also make the short side of a condor vulnerable during rapid unwinds. Favor iron condors with wider wings on FXY and monitor BOJ policy announcements closely.

---

## 4. Capital Management (The $10k Bankroll)
Strict adherence to these rules prevents the "Sequence of Returns" risk from blowing the account.

* **Total Utilization:** Never use more than **50% ($5,000)** of your account as buying power. Keep the rest in cash for adjustments and margin spikes.
* **Position Sizing:** Allocate **~$1,000 in Buying Power Reduction (BPR)** per Iron Condor (driven by the $10 wing standard from Section 2). Adjust upward to $1,500 only for higher-priced underlyings where the wing-width math forces a larger BPR.
* **Maximum Concurrent Positions:** At $1,000 BPR per trade and a $5,000 BPR cap, the account supports **up to 5 open positions** at any time. Choose the 5 pillars (or top pillar candidates) with the highest current IV Rank.
* **Trade Frequency:** **1–2 new trades per week** is the practical range on a $10k account. 3+ trades/week quickly exceeds the 5-position cap given the ~2–3 week average holding period.
* **Laddering:** Do not enter all trades at once. Open one "pillar" every 7–10 days to diversify across time.
* **Compound Scaling:** As the account grows past $15k, scale BPR proportionally (5% of capital, clamped $1,000–$2,000). Position count cap (5) stays the same — bigger positions, not more of them.

---

## 5. Defensive Mechanics & Trade Management
Success is determined by **management**, not entry.

### Profit & Loss Targets
* **Profit Take:** Mechanically close the trade at **50% of the maximum credit received**.
* **Stop Loss:** Close or adjust if the loss reaches **2x to 3x the credit received** (use **1.5x** for Volatility Pillar positions).

### The 21-Day Rule
* **Mechanical Exit:** Regardless of profit or loss, **close the trade at 21 DTE**.
* **Rationale:** "Gamma Risk" increases exponentially in the final 20 days. Professional funds exit early to avoid the "Gamma Squeeze."

### Adjustments
* If one side is tested (price touches your 16 $\Delta$ short strike), **roll the untested side** closer to the money (e.g., from 16 $\Delta$ to 30 $\Delta$). This collects more premium and moves your break-even point further out on the tested side.

---

## 6. Execution Workflow
1.  **Scan:** Check IV Rank across all five pillars: Equities (SPY → QQQ → IWM → DIA → EFA → EEM), Fixed Income (TLT → IEF → HYG → LQD), Commodities (GLD → SLV → USO → DBA), Volatility (VXX → UVXY), Currencies (UUP → FXY → FXE → FXB).
2.  **Select:** Choose the instrument within each pillar with IV Rank **> 25%**. If multiple qualify, prefer the primary. If none qualify in a pillar, skip that pillar for this cycle.
3.  **Filter:** Avoid individual tech stocks (AAPL, NVDA, TSLA) during earnings weeks. For Currency pillar entries, verify bid/ask spread does not exceed 25% of total credit before committing.
4.  **Entry:** Use **Limit Orders** only. Aim for a total credit that is at least **15–20% of the wing width** (i.e., **$150–$200 on a $10-wide condor**). Reject any fill below this threshold — the friction math from Section 7 only works if credit clears the minimum.
5.  **Monitor:** Check **Portfolio Beta-Weighted Delta**. If the portfolio leans too far in one direction, the next "laddered" trade should be used to neutralize that delta. Count any combination of SPY, QQQ, EFA, and EEM as a single equity-class exposure block — do not run more than two simultaneously.

---

## 7. Commission Cost Awareness
Options commissions are charged per contract per leg and accumulate quickly with mechanically-closed positions. This pillar of the strategy is non-negotiable: **wing width and minimum credit thresholds exist primarily to defend against commission drag.**

**Per-trade commission math** (Schwab/thinkorswim retail rate of $0.65/contract):
* Iron condor = 4 legs to open + 4 legs to close = **8 contract fills**
* Per 1-contract iron condor: **$5.20 round-trip**
* Per 2-contract iron condor: **$10.40 round-trip**
* Scales linearly with contract count

**Friction as percentage of profit:**

| Wing Width | Avg Credit | 50% Profit Win | Commission | Friction (% of win) |
| :--- | ---: | ---: | ---: | ---: |
| $5 wide | ~$90 | $45 | $5.20 | **11.5%** ❌ |
| $10 wide | ~$180 | $90 | $5.20 | **5.8%** ✅ |
| $20 wide | ~$360 | $180 | $5.20 | **2.9%** ✅ |

> ⚠️ **The $5 Wing Problem:** At $5-wide wings, commission friction consumes more than 100% of the per-trade edge over a year (~50 trades × $5.20 = $260 in costs vs. ~$210 in expected gross profit). $10-wide wings are the **minimum economic threshold** for this strategy at the $10k account scale.

**Annual commission budget** (assuming 85% IV qualifying weeks):
* 1 trade/week: ~44 trades × $5.20 = **~$230/year**
* 2 trades/week: ~88 trades × $5.20 = **~$460/year**

**Tax treatment:** All iron condor profits are taxed as **short-term capital gains** at the trader's marginal rate (assume 22% bracket for planning). Losses offset gains within the same tax year. Plan to set aside ~22% of realized profits in a separate account for the April tax bill — do not let it compound in the trading account if not earmarked.

---
**Version:** 1.3
**Last Updated:** May 16, 2026
**Changes from 1.2:** Moved to **$10-wide wings as the strategy standard** to defend against commission friction. Updated BPR sizing to ~$1,000 per trade (from $500–$1,000 range). Set explicit cap of 5 concurrent positions. Removed dollar-based BPR caps on Volatility and Currency pillars; risk management on those pillars now controlled via **position count** (max 1 open at a time per pillar). Added **Section 7: Commission Cost Awareness** with explicit friction math and tax planning note. Updated execution workflow credit targets to dollar values ($150–$200 minimum).

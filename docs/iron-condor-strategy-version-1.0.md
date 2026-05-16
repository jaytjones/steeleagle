# Iron Condor Strategy - Version 1.0

## 1. Strategy Philosophy: The "Insurance Company" (TOMIC)
This strategy follows the **The Option Method Insurance Company (TOMIC)** framework. Instead of "betting" on market direction, you are acting as an insurer, collecting premiums by underwriting "catastrophe policies" (out-of-the-money options). Your edge comes from the fact that **Implied Volatility (IV)** historically overstates the actual move of the underlying asset.

---

## 2. Core Trade Architecture
We utilize a **Wide-Wing Iron Condor** to maximize the probability of profit while maintaining a "Black Swan" safety net.

| Component | Target Delta ($\Delta$) | Role |
| :--- | :--- | :--- |
| **Short Legs** | **~16 Delta** | The "Income" generator. Statistically represents a 1-standard deviation move. |
| **Long Legs** | **~5 Delta** | The "Catastrophe" protection. Limits max loss and reduces buying power requirement. |

* **DTE (Days to Expiration):** Target **30–45 days** at entry.
* **Asset Selection:** High-liquidity underlyings (SPY, TLT, GLD).

---

## 3. The Trinity Portfolio (Diversification)
To maintain **Delta Neutrality** and avoid sector-specific wipes, rotate trades across these three uncorrelated pillars:

1.  **Equities (SPY):** Broad market risk.
2.  **Fixed Income (TLT):** Interest rate risk (often moves inversely to SPY).
3.  **Commodities (GLD):** Inflation/Geopolitical risk.

> **Hedge Fund Rule:** Always check **IV Rank** before entry. Only "sell insurance" when the IV Rank is **> 25%**. If an asset has low IV, it is not worth the risk; move to the next pillar.

---

## 4. Capital Management (The $10k Bankroll)
Strict adherence to these rules prevents the "Sequence of Returns" risk from blowing the account.

* **Total Utilization:** Never use more than **50% ($5,000)** of your account as buying power. Keep the rest in cash for adjustments and margin spikes.
* **Position Sizing:** Allocate **$500–$1,000 in Buying Power Reduction (BPR)** per Iron Condor.
* **Laddering:** Do not enter all trades at once. Open one "pillar" every 7–10 days to diversify across time.

---

## 5. Defensive Mechanics & Trade Management
Success is determined by **management**, not entry.

### Profit & Loss Targets
* **Profit Take:** Mechanically close the trade at **50% of the maximum credit received**.
* **Stop Loss:** Close or adjust if the loss reaches **2x to 3x the credit received**.

### The 21-Day Rule
* **Mechanical Exit:** Regardless of profit or loss, **close the trade at 21 DTE**.
* **Rationale:** "Gamma Risk" increases exponentially in the final 20 days. Professional funds exit early to avoid the "Gamma Squeeze."

### Adjustments
* If one side is tested (price touches your 16 $\Delta$ short strike), **roll the untested side** closer to the money (e.g., from 16 $\Delta$ to 30 $\Delta$). This collects more premium and moves your break-even point further out on the tested side.

---

## 6. Execution Workflow
1.  **Scan:** Check IV Rank for SPY, TLT, and GLD.
2.  **Filter:** Avoid individual tech stocks (AAPL, NVDA, TSLA) during earnings weeks.
3.  **Entry:** Use **Limit Orders** only. Aim for a total credit that is at least **15–20% of the wing width**.
4.  **Monitor:** Check **Portfolio Beta-Weighted Delta**. If the portfolio leans too far in one direction, the next "laddered" trade should be used to neutralize that delta.

---
**Version:** 1.0
**Last Updated:** May 10, 2026

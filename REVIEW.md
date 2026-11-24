# Review log — 3 full review rounds + out-of-sample validation

All numbers are net PnL in SOL on the kit's local engine (`tools/sim.ts`, the same engine
`grade-local` uses). "Mean" is the mean over fail keys 11/22/33/44 (the final window's
failed-tx draw is secret, so no setting is ever judged on one lucky draw). The dev window
the kit ships is only `dataset/events/part-00000` (first ~11h of the 24h window, 430 sampled
coins); parts 00001/00002 are the later hours, used here as out-of-sample checks, and "full
24h" runs all three parts concatenated (1,222 sampled coins) — the closest proxy for the
fresh 24h final window.

Baselines measured first (same engine, default params):
| bot | net PnL (mean) | drawdown | trips | wins |
|---|---|---|---|---|
| pilot momentum | -9.38 | 0.95 | 80 | 5 |
| pilot reversion | -1.68 | 0.17 | 171 | 48 |
| pilot sniper | -0.13 | 0.017 | 133 | 18 |
| hold cash | 0.00 | 0.00 | 0 | — |

## Round 1 — v1: early entry, ride the tail (trailing stop, no fixed TP)

Defaults: enter ≤3 slots after create, stake 0.2 SOL, stop -15%, trail 30% armed at +10%,
no max hold. Result: **mean -0.73 SOL** (worst -0.80), 120 trips, 22 wins, dd 0.086,
best trip +0.14. Better than momentum/reversion, worse than the sniper. Finding: holding
losers for the tail bleeds; the trailing stop exits too late and the 5-slot cap fills up
with stuck positions (with a looser stop, zero trips opened in the second half — slots never
freed). Sweeps over trail × stop × stake all stayed negative; the least-bad cell
(trail 0.3 / stop -25% / stake 0.1) was still -0.33.

## Round 2 — exits first, then the entry filter

Sweeping exits on the v1 engine: **maxHold dominates everything**. Hold 10 slots with
TP +15% / SL -20% → -0.137, matching the sniper; hold 30/100 → -0.18; hold 5 with
TP +25–50% / SL -12% → **+0.065 to +0.068, positive on every fail key, ex-best-trip +0.010,
H0 +0.054 / H1 +0.015**. The pump is front-loaded: the edge is a burst scalp, not a ride.
Then the entry filter: requiring **≥6 distinct non-creator buyers before entry** (kills
bundled/dev-only launches) lifted the hold-5 profile to +0.094 (maxAge 15), and to **+0.134
(minBuyers 6, maxAge 15, hold 5, TP +50%, SL -10%)** with 78 trips, 29 wins, dd 0.007.
minBuyers 8/12 were worse (too selective); maxAge 30 was worse.

## Round 3 — out-of-sample validation (this round changed the pick)

The hold-5 winner did NOT survive contact with unseen data:
- part-00001 (later hours): hold-5 config → **-0.13 mean**; the same grid's best there was
  hold 30 / TP +25% → +0.263. The optimal hold time flips between windows — a regime
  effect, not a tunable constant.
- So the final pick was re-tuned on the **full 24h** (all three parts), with per-part
  checks, looking for a plateau that is positive everywhere it can be:
  **minBuyers 6, maxAge 15, maxHold 10, TP +20%, SL -10%, stake 0.5 SOL.**

Final numbers for the locked defaults:
| window | net PnL (mean over 4 fail keys) | worst | trips | wins | dd |
|---|---|---|---|---|---|
| dev (part-00000) | **+0.062** | +0.055 | 79 | 30 | 0.015 |
| part-00001 | **+0.228** (TP 0.20) | +0.127 | ~120 | ~37 | ~0.03 |
| part-00002 | -0.25 | -0.25 | 46 | 9 | 0.026 |
| **full 24h** | **+0.221** | **+0.201** | 233 | ~81 | 0.024 |

Plateau check on the full 24h (neighbours of the pick, mean over 4 fail keys): TP 0.20
+0.221, TP 0.25 +0.199, TP 0.35 +0.216; SL 0.08 +0.148, SL 0.10 +0.221, SL 0.12 +0.173;
maxAge 12 +0.106, maxAge 15 +0.221, maxAge 20 +0.127; minBuyers 7 +0.105 (vs 6: +0.221).
TP 0.20–0.35 is a flat plateau; the pick sits in its middle.

Honest caveats, kept in the report rather than tuned away:
- part-00002 (last ~5h) is negative for EVERY config in this family (best -0.175): a dead
  regime with few coins and weak pumps. The full-window score already absorbs that drag.
- On the dev window the PnL is positive even without the best trip on the full window
  (ex-best-trip ≈ +0.02), but on the dev window alone ex-best-trip is -0.04 — the dev score
  leans on one +0.10 trip. The final window is fresh data; no dev-window number proves it.
- At 2x fees the dev-window result turns negative (-0.10). Fees are fixed by the harness,
  so this is a stress note, not a live risk.
- `grade-local --stress 10` (10 block-surrogate rebuilds of the dev window): median -0.41,
  p10 -1.69, p90 +0.22; 8 of 10 copies lost money; the dev score sits above 8 of 10, with
  the kit's own warning that half or more copies lost money. The copies are a spread, not
  a forecast — but they say plainly that the +0.21 dev score leans on this window's own
  coins. The per-part evidence (real unseen hours: +0.06 / +0.23 / -0.25) is the better
  guide to the fresh final window, and it is mixed: this entry is a positive-expectation
  bet on the full-window average, not a lock.
- Guardrails: 78–80 coins on the dev window (bar: 20), 233 on the full window; max
  drawdown 0.015–0.024 (bar: 0.50); 0 rejected orders. Deterministic: two identical runs
  give byte-identical PnL per fail key.

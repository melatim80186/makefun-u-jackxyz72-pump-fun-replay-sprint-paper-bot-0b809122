[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/melatim80186/makefun-u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/melatim80186/makefun-u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

# Pump.fun Replay Sprint — Early-Entry Paper Bot

A paper-trading bot for the [Pump.fun Replay Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) competition. The house replays the bot on 24 hours of recorded pump.fun bonding-curve activity with 10 SOL of paper money; entries are ranked by net PnL after every fee. Paper money only — nothing is traded for real.

## Strategy: buy early, ride the tail, cut losers fast

Measured on the kit's dev window (430 sampled coins, first ~11h of 24h):

- **Buying after the run-up loses.** The pilot momentum bot buys mature curves on accelerating inflow and lost **-9.38 SOL** with a 95% drawdown — it buys the top. The pilot reversion bot (buy 30–45% dips on mature curves) lost **-1.7 SOL**. The pilot sniper (buy fresh launches, exit at +15% / -12% within 10 slots) lost only **-0.13 SOL**.
- **The money is in the tail.** 19 of 430 coins reach 10–50x their create price at some point and 13 complete the curve. A fixed +15% take-profit banks small wins and throws the tail away.
- **So this bot scalps the burst:** it enters within 15 slots of a coin's `CreateEvent`,
  but only once at least 6 distinct non-creator buyers have stepped in — that one filter
  is the whole edge (it kills bundled/dev-only launches) — in a small size, then exits on
  **+20% / -10% or after 10 slots**, whichever comes first. No trailing stop, no riding:
  the exits are TP / SL / time. A completing curve is closed by the replay at its final
  reserves, so a runner that completes inside the window still pays in full.
- **Risk discipline:** at most 5 positions, small per-coin stake, a cap on total exposure, and a cooldown before a coin can be re-entered. A probe mechanism keeps the run above the guardrail pace (round trips of ≥ 0.01 SOL on at least 20 coins) when the main signal goes quiet.

The bot is a pure function of the batches the harness sends — no clock, no randomness, no I/O — so the two graded executions produce byte-identical action logs.

## How it runs

The grader runs `node /bot/main.ts` on Node 22. `main.ts` hands the strategy in `strategy.ts` to the vendored SDK shim (`vendor/agentfun-bot.ts`, a byte-identical copy of the kit's `sdk/ts` file).

Local backtest (needs the unpacked kit):

```sh
node tools/backtest.ts <kit dir> ['{"stakeSol":0.2}'] [--trips] [--halves]
node tools/sweep.ts <kit dir> '{}' '{"trail":[0.3,0.5],"stopLoss":[0.1,0.2]}' 10
```

`tools/sim.ts` is the kit's local engine port. Backtests report net PnL as the mean over four fail-key draws (the final window's failed-tx draw is secret), plus the worst draw, the net without the best trip, and the per-half split — a setting that wins only in one half is a fluke, not an edge.

## Backtest results (dev window)

Locked defaults (`strategy.ts` `DEFAULT_PARAMS`): enter within 15 slots of create once
≥ 6 distinct non-creator buyers have stepped in, stake 0.5 SOL (capped at 1% of the
curve's real reserves), exit at +20% / -10% or after 10 slots, exit if the creator sells.

| window | net PnL (mean, 4 fail keys) | worst | trips | wins | coins | max drawdown |
|---|---|---|---|---|---|---|
| dev window (kit part-00000) | **+0.062 SOL** | +0.055 | 79 | 30 | 79 | 0.015 |
| full 24h (all 3 parts) | **+0.221 SOL** | +0.201 | 233 | ~81 | 233 | 0.024 |

vs baselines on the dev window: hold cash 0.00, equal-weight (holds, never sells),
pilot sniper -0.13, pilot reversion -1.68, pilot momentum -9.38. Full review log with all
three rounds, the out-of-sample checks, and the honest caveats: [REVIEW.md](REVIEW.md).

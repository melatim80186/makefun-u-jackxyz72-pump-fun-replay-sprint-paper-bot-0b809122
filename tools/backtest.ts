// Offline backtest of strategy.ts on the kit's dev window with the local engine port (tools/sim.ts).
//
//   node tools/backtest.ts <kit dir> ['{"stakeSol":0.4}'] [--trips] [--halves]
//
// Prints net PnL per fail key (mean/worst), fills, coins, drawdown and reject reasons.
// --halves also prints net PnL on the first and second half of the window separately
// (a setting that wins only in one half is a fluke, not an edge).

import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { loadDataset, makeHello, phaseSeed, simulate } from './sim.ts';

const kit = process.argv[2];
if (kit === undefined) {
  console.error('usage: node tools/backtest.ts <kit dir> [params json] [--trips] [--halves]');
  process.exit(2);
}
const overrides = process.argv[3] !== undefined && process.argv[3].startsWith('{') ? (JSON.parse(process.argv[3]) as Partial<Params>) : {};
const ds = loadDataset(kit);
const hello = makeHello(phaseSeed('pilot-pumpfun-replay', 'dev', ds.sha256));
const params = { ...DEFAULT_PARAMS, ...overrides };
const sol = (x: bigint) => (Number(x) / 1e9).toFixed(4);
const FAIL_KEYS = [11n, 22n, 33n, 44n];
let sum = 0;
let worst = Infinity;
let fills = Infinity;
let coins = Infinity;
let dd = 0;
let first: ReturnType<typeof simulate> | null = null;
for (const fk of FAIL_KEYS) {
  const r = simulate(ds, hello, createStrategy(params), { failKey: fk });
  if (first === null) first = r;
  const net = Number(r.netPnl) / 1e9;
  sum += net;
  worst = Math.min(worst, net);
  fills = Math.min(fills, r.fills);
  coins = Math.min(coins, r.mints);
  dd = Math.max(dd, r.maxDrawdown);
  const wins = r.trips.filter((t) => t.pnl > 0n).length;
  const best = r.trips.map((t) => Number(t.pnl) / 1e9).sort((a, b) => b - a);
  console.log(
    `failKey ${fk}: net ${sol(r.netPnl)} SOL fills ${r.fills} coins ${r.mints} trips ${r.trips.length} wins ${wins} dd ${r.maxDrawdown.toFixed(3)} rejected ${r.rejected} ${JSON.stringify(r.rejectReasons)} failed ${r.failed} bestTrip ${(best[0] ?? 0).toFixed(3)} exBest ${(net - (best[0] ?? 0)).toFixed(3)} ex2 ${(net - (best[0] ?? 0) - (best[1] ?? 0)).toFixed(3)}`,
  );
}
console.log(`MEAN net ${(sum / FAIL_KEYS.length).toFixed(4)} SOL worst ${worst.toFixed(4)} fills>=${fills} coins>=${coins} dd<=${dd.toFixed(3)}`);
const noFail = simulate(ds, hello, createStrategy(params), { failKey: null });
const twoX = simulate(ds, hello, createStrategy(params), { feeMultiplier: 2n });
console.log(`without failed txs ${sol(noFail.netPnl)}  at 2x fees ${sol(twoX.netPnl)}`);
if (process.argv.includes('--halves') && first !== null) {
  const mid = Math.floor(ds.batches.length / 2);
  const midSlot = ds.batches[mid].slot;
  const h0 = first.trips.filter((t) => t.open < midSlot).reduce((s, t) => s + Number(t.pnl) / 1e9, 0);
  const h1 = first.trips.filter((t) => t.open >= midSlot).reduce((s, t) => s + Number(t.pnl) / 1e9, 0);
  console.log(`H0 (trips opened first half): ${h0.toFixed(4)}  H1: ${h1.toFixed(4)}`);
}
if (process.argv.includes('--trips')) {
  const r = simulate(ds, hello, createStrategy(params), { failKey: 11n });
  for (const t of [...r.trips].sort((a, b) => Number(b.pnl - a.pnl)).slice(0, 15)) console.log(t.mint.slice(0, 8), t.open, t.close - t.open, sol(t.pnl));
}

// Parameter sweep over tools/sim.ts: every combination of the given values, ranked by mean
// net PnL over 4 fail keys (never one lucky draw), with worst key, ex-best-trip and halves.
//
//   node tools/sweep.ts <kit dir> '<base params json>' '<grid json: {"key":[v1,v2],...}>' [top N]

import { createStrategy, DEFAULT_PARAMS, type Params } from '../strategy.ts';
import { loadDataset, makeHello, phaseSeed, simulate } from './sim.ts';

const [kit, baseJson, gridJson, topArg] = process.argv.slice(2);
if (kit === undefined || gridJson === undefined) {
  console.error("usage: node tools/sweep.ts <kit dir> '<base json>' '<grid json>' [top]");
  process.exit(2);
}
const base = { ...DEFAULT_PARAMS, ...(JSON.parse(baseJson ?? '{}') as Partial<Params>) };
const grid = JSON.parse(gridJson) as Record<string, unknown[]>;
const ds = loadDataset(kit);
const hello = makeHello(phaseSeed('pilot-pumpfun-replay', 'dev', ds.sha256));
const keys = Object.keys(grid);
const combos: Record<string, unknown>[] = [{}];
for (const k of keys) {
  const next: Record<string, unknown>[] = [];
  for (const c of combos) for (const v of grid[k]!) next.push({ ...c, [k]: v });
  combos.splice(0, combos.length, ...next);
}
const FAIL_KEYS = [11n, 22n, 33n, 44n];
const mid = Math.floor(ds.batches.length / 2);
const midSlot = ds.batches[mid].slot;
interface Row { c: Record<string, unknown>; net: number; worst: number; exBest: number; fills: number; coins: number; dd: number; trips: number; wins: number; h0: number; h1: number }
const rows: Row[] = [];
for (const c of combos) {
  let sum = 0;
  let worst = Infinity;
  let exBest = 0;
  let fills = Infinity;
  let coins = Infinity;
  let dd = 0;
  let trips = 0;
  let wins = 0;
  for (const failKey of FAIL_KEYS) {
    const r = simulate(ds, hello, createStrategy({ ...base, ...c } as Params), { failKey });
    const pnl = r.trips.map((t) => Number(t.pnl) / 1e9).sort((a, b) => b - a);
    const net = Number(r.netPnl) / 1e9;
    sum += net;
    worst = Math.min(worst, net);
    exBest += (net - (pnl[0] ?? 0)) / FAIL_KEYS.length;
    fills = Math.min(fills, r.fills);
    coins = Math.min(coins, r.mints);
    dd = Math.max(dd, r.maxDrawdown);
    trips = r.trips.length;
    wins = r.trips.filter((t) => t.pnl > 0n).length;
  }
  const r11 = simulate(ds, hello, createStrategy({ ...base, ...c } as Params), { failKey: 11n });
  const h0 = r11.trips.filter((t) => t.open < midSlot).reduce((s, t) => s + Number(t.pnl) / 1e9, 0);
  const h1 = r11.trips.filter((t) => t.open >= midSlot).reduce((s, t) => s + Number(t.pnl) / 1e9, 0);
  rows.push({ c, net: sum / FAIL_KEYS.length, worst, exBest, fills, coins, dd, trips, wins, h0, h1 });
}
rows.sort((a, b) => b.net - a.net);
for (const r of rows.slice(0, Number(topArg ?? 25))) {
  console.log(
    `mean ${r.net.toFixed(3)} worst ${r.worst.toFixed(3)} exBest ${r.exBest.toFixed(3)} [H0 ${r.h0.toFixed(3)} H1 ${r.h1.toFixed(3)}] fills ${r.fills} coins ${r.coins} trips ${r.trips} wins ${r.wins} dd ${r.dd.toFixed(3)} ${JSON.stringify(r.c)}`,
  );
}
console.log(`${combos.length} combos`);

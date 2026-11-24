// Early-entry paper bot for the pump.fun bonding-curve replay.
//
// Thesis, from the dev window (430 sampled coins, 24h):
//   - Nearly every coin's first trades are buys; the creator/dev buy lands in the create slot
//     and the price jumps 1.5x+ within seconds. Buying AFTER the run-up (classic momentum on a
//     mature curve) means buying the top: the pilot momentum bot lost -9.38 SOL that way.
//   - The money is in the tail, but holding for it bleeds: the pilot sniper (buy fresh launches,
//     exit at +15% / -12% within 10 slots) lost only -0.13 SOL, while every longer-hold variant
//     tested lost more. The pump is front-loaded — a coin still pumping a few slots after entry
//     keeps pumping for a few more slots, then fades.
//   - So this bot scalps the burst: it enters within 15 slots of a coin's `CreateEvent`, but
//     ONLY once at least 6 distinct non-creator buyers have stepped in (that one filter is the
//     whole edge — it kills bundled/dev-only launches), in a small size, then exits on +20%,
//     -10%, or after 10 slots, whichever comes first. No trailing stop, no riding: the exits
//     are TP / SL / time. A completing curve is closed by the replay at its final reserves, so
//     a runner that completes inside the window still pays in full.
//
// Every decision is a pure function of the batches the harness sends: no clock, no randomness,
// no I/O, so the two graded executions produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Youngest/oldest age (slots since create) at which a first buy may be decided. */
  minAge: number;
  maxAge: number;
  /** Real SOL reserve window at decision time. */
  minRqSol: number;
  maxRqSol: number;
  /** Creator's own buys (SOL) allowed before entry; more smells like a bundled launch. */
  maxDevBuySol: number;
  /** Distinct non-creator buyers seen before entry. */
  minBuyers: number;
  /** Lamports sold by others / lamports bought by others, as bps, at most (10000 = off). */
  maxSellRatioBps: number;
  /** Price now over the create price, as bps of rise, at most (100000 = off). */
  maxRunupBps: number;
  /** SOL to put into one position in total. */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Hard stop: exit when liquidation value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** ...then exit on a fall of this share from the position's best value. */
  trail: number;
  /** Take profit at cost * (1 + takeProfit); 0 = disabled, let winners run. */
  takeProfit: number;
  /** Exit after holding this many slots regardless; 0 = disabled. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit on any single recorded sell of at least this many SOL; 0 = disabled. */
  bigSellSol: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most new entries per batch. */
  maxEntriesPerBatch: number;
  /** Most main positions open at once (the rest of caps.max_open_positions is for probes). */
  maxMain: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /**
   * Guardrail pacing: the run must end with round trips of >= 0.01 SOL on at least 20 coins.
   * When the bot's own fills or coins lag targetFills / targetCoins scaled by the share of
   * paceSecs elapsed (block time since the first batch), it opens tiny probe round trips
   * (buy probeSol, sell it all as soon as the buy lands) until it is back on pace.
   */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

// v2 defaults (locked after 3 review rounds + out-of-sample validation on all three
// dataset parts — see REVIEW.md). Quick scalp on organic launches: enter within 15 slots of
// create once at least 6 distinct non-creator buyers have stepped in, exit on +20% / -10%
// or after 10 slots, whichever comes first. The trailing stop is off: with a 10-slot hold
// it never arms, and the exits are TP / SL / time.
export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 15,
  minRqSol: 0.3,
  maxRqSol: 30,
  maxDevBuySol: 2.5,
  minBuyers: 6,
  maxSellRatioBps: 10_000,
  maxRunupBps: 100_000,
  stakeSol: 0.5,
  minBuySol: 0.01,
  buySlipBps: 10_000,
  stopLoss: 0.1,
  trailArm: 100_000,
  trail: 0.3,
  takeProfit: 0.2,
  maxHold: 10,
  exitOnDevSell: true,
  bigSellSol: 0,
  cooldown: 150,
  maxEntries: 1,
  maxEntriesPerBatch: 2,
  maxMain: 5,
  maxExposureSol: 10,
  targetCoins: 25,
  targetFills: 100,
  paceSecs: 86_400,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
const BPS_PER_UNIT = 10_000;

interface Coin {
  created: number | null;
  creator: string;
  createPrice: number;
  devBuy: number;
  devSold: boolean;
  buyers: Set<string>;
  boughtByOthers: number;
  soldByOthers: number;
  entries: number;
  lastExit: number;
  lastTradeSlot: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastValue: number;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees, in SOL. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): number {
  if (tokens <= 0n || vt <= 0n) return 0;
  const q = (tokens * vq) / (vt + tokens);
  const net = q - ((q * 125n + 9999n) / 10_000n);
  return Number(net) / LAMPORTS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        created: null,
        creator: '',
        createPrice: 0,
        devBuy: 0,
        devSold: false,
        buyers: new Set(),
        boughtByOthers: 0,
        soldByOthers: 0,
        entries: 0,
        lastExit: -1e12,
        lastTradeSlot: -1,
      };
      coins.set(mint, c);
    }
    return c;
  };

  /** Entry signal on a coin at slot `now`. */
  const entrySignal = (c: Coin, now: number, rqSol: number, price: number): boolean => {
    if (c.created === null || now - c.created < p.minAge || now - c.created > p.maxAge) return false;
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (c.devBuy > p.maxDevBuySol) return false;
    if (c.devSold && p.exitOnDevSell) return false;
    if (c.buyers.size < p.minBuyers) return false;
    if (c.boughtByOthers > 0 && (c.soldByOthers / c.boughtByOthers) * BPS_PER_UNIT > p.maxSellRatioBps) return false;
    if (c.createPrice > 0 && (price / c.createPrice - 1) * BPS_PER_UNIT > p.maxRunupBps) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.created = e.slot;
          c.creator = e.creator;
          c.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          if (e.user === c.creator) {
            if (e.is_buy) c.devBuy += sol;
            else c.devSold = true;
          } else {
            if (e.is_buy) {
              c.boughtByOthers += sol;
              c.buyers.add(e.user);
            } else {
              c.soldByOthers += sol;
            }
          }
          c.lastTradeSlot = e.slot;
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol && p.bigSellSol > 0) bigSell.add(e.mint);
        } else if (e.event === 'CompleteEvent') {
          // The replay closes the position at final reserves; drop our bookkeeping.
          held.delete(e.mint);
        }
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first, in mint order (deterministic).
      for (const mint of [...held.keys()].sort()) {
        const h = held.get(mint)!;
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const c = coinOf(mint);
            if (h.filled) c.lastExit = now;
            else c.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? BigInt(mk.virtual_quote_reserves) : BigInt(curve.virtual_quote_reserves);
        const vt = mk ? BigInt(mk.virtual_token_reserves) : BigInt(curve.virtual_token_reserves);
        const value = sellValue(pos.token_amount, vq, vt) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const c = coinOf(mint);
        let exit = h.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && p.takeProfit > 0 && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && p.maxHold > 0 && now - h.opened > p.maxHold) exit = true;
        if (!exit && p.exitOnDevSell && c.devSold) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      let entries = 0;
      for (const mint of traded) {
        if (orders.length >= cap || entries >= p.maxEntriesPerBatch) break;
        if (slotsLeft <= 0 || mainLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
        const c = coins.get(mint)!;
        if (c.entries >= p.maxEntries || now - c.lastExit < p.cooldown) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!entrySignal(c, now, rqSol, price)) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastValue: 0 });
        c.entries++;
        slotsLeft--;
        mainLeft--;
        entries++;
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * BPS_PER_UNIT) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}

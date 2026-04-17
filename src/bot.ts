import * as fs from "fs";
import * as path from "path";
import { writeDecisionAudit } from "./decisionAudit";
import {
  getBtcPrice,
  setRoundSecsLeft,
  setRoundStartPrice,
  startPriceFeed,
  stopPriceFeed,
} from "./btcPrice";
import { logger } from "./logger";
import { getCurrentRound15m, prefetchNextRound, type Round15m } from "./market";
import { clearPaperRuntimeState, loadPaperRuntimeState, savePaperRuntimeState, type PaperRuntimeState } from "./paperRuntimeState";
import { getLiveHistoryFilePath, getPaperHistoryFilePath } from "./instancePaths";
import { getLatencySnapshot } from "./latency";
import { Trader, type BookLevel, type TraderDiagnostics } from "./trader";

const ROUND_DURATION = 900;
const LOOP_SLEEP_MS = 500;
const MIN_BALANCE_TO_TRADE = 5;
const MIN_ENTRY_SECS = 60;
const MIN_SHARES = 3;
const MAX_SHARES = 250;
const PAIR_BUDGET_PCT = 0.9;
const TAKER_FEE = 0.02;
const SIGNAL_SLIPPAGE_BUFFER = 0.01;
const MAX_SIGNAL_PAIR_COST = 0.985;
const MAX_EXEC_PAIR_COST = 0.995;
const MIN_LOCKED_EDGE = 0.015;
const LOWEST_COST_LOOKBACK_MS = 45_000;
const NEAR_LOW_TOLERANCE = 0.01;
const SETTLEMENT_SAMPLE_DELAY_MS = 500;
const HOT_BOOK_MAX_AGE_MS = 350;
const ENTRY_RETRY_COOLDOWN_MS = 1_500;
const STAGED_SINGLE_LIVE_ENABLED = process.env.ENABLE_STAGED_SINGLE === "1";
const SINGLE_BUDGET_PCT = 0.12;
const SINGLE_MAX_SHARES = 60;
const SINGLE_MAX_EFFECTIVE_COST = 0.38;
const SINGLE_MAX_PROJECTED_PAIR_COST = 1.025;
const SINGLE_ENTRY_MIN_SECS = 180;
const SINGLE_HEDGE_CUTOFF_SECS = 75;
const SINGLE_MAX_HOLD_MS = 90_000;
const SINGLE_NEAR_LOW_TOLERANCE = 0.01;

type EngineMode = "live" | "paper";
type PairState = "off" | "watching" | "single_pending" | "single_open" | "pair_pending" | "pair_open" | "done";
type PairLegSide = "up" | "down";

export type PaperSessionMode = "session" | "persistent";

export interface Hedge15mStartOptions {
  mode?: EngineMode;
  paperBalance?: number;
  paperSessionMode?: PaperSessionMode;
}

export interface HedgeHistoryEntry {
  time: string;
  result: string;
  leg1Dir: string;
  leg1Price: number;
  totalCost: number;
  profit: number;
  cumProfit: number;
  exitType?: string;
  exitReason?: string;
  leg1Shares?: number;
  leg1FillPrice?: number;
  orderId?: string;
  estimated?: boolean;
  profitBreakdown?: string;
  entrySource?: string;
  entryTrendBias?: string;
  entrySecondsLeft?: number;
  entryWinRate?: number;
  entryBsFair?: number;
  entryEffectiveCost?: number;
  entryEffectiveEdge?: number;
  entryEdgeTier?: string;
  pairMatchedShares?: number;
  upFilledShares?: number;
  downFilledShares?: number;
  upFillPrice?: number;
  downFillPrice?: number;
  expectedPayout?: number;
  pairSignalCost?: number;
  pairObservedCost?: number;
  winningLeg?: string;
}

/** Web/API 推送用快照（仅含当前面板与排障所需字段） */
export interface Hedge15mState {
  botRunning: boolean;
  tradingMode: EngineMode;
  paperSessionMode: PaperSessionMode;
  status: string;
  roundDecision: string;
  btcPrice: number;
  secondsLeft: number;
  roundElapsed: number;
  roundProgressPct: number;
  entryWindowLeft: number;
  canOpenNewPosition: boolean;
  nextRoundIn: number;
  currentMarket: string;
  upAsk: number;
  downAsk: number;
  balance: number;
  totalProfit: number;
  wins: number;
  losses: number;
  skips: number;
  totalRounds: number;
  history: HedgeHistoryEntry[];
  hedgeState: string;
  hedgeLeg1Price: number;
  dumpDetected: string;
  sessionROI: number;
  effectiveMaxAsk: number;
  askSum: number;
  leg1EffectiveCost: number;
  leg1EffectiveEdge: number;
  leg1EdgeTier: string;
  upEffectiveCost: number;
  downEffectiveCost: number;
  upNetEdge: number;
  downNetEdge: number;
  rtMinEntrySecs: number;
  latencyP50: number;
  latencyNetworkSource: string;
  diagnostics: TraderDiagnostics;
  pairMatchedShares: number;
  pairSignalCost: number;
  pairObservedCost: number;
  pairBestObservedCost: number;
  pairLockedEdge: number;
  pairExpectedPayout: number;
}

interface PairPositionSnapshot {
  conditionId: string;
  upToken: string;
  downToken: string;
  upHeldShares: number;
  downHeldShares: number;
  upAvgFill: number;
  downAvgFill: number;
  totalCost: number;
  matchedShares: number;
  signalCost: number;
  observedCost: number;
  lockedEdge: number;
  roundStartBtcPrice: number;
  filledAt: number;
  activeStrategyMode?: string;
  singleSide?: PairLegSide | "";
}

interface BookSnapshot {
  bid: number | null;
  ask: number | null;
  spread: number;
  askDepth: number;
  bidDepth: number;
  askLevels: BookLevel[];
  bidLevels: BookLevel[];
}

interface LegFillResult {
  filled: number;
  avgPrice: number;
  orderId: string;
}

interface BuyLegQuote {
  shares: number;
  rawCost: number;
  avgPrice: number;
  maxPrice: number;
  depth: number;
}

interface PairQuote {
  shares: number;
  up: BuyLegQuote;
  down: BuyLegQuote;
  rawCostPerPair: number;
  signalCost: number;
  lockedEdge: number;
  expectedProfit: number;
}

interface SingleLegQuote {
  side: PairLegSide;
  shares: number;
  leg: BuyLegQuote;
  opposite: BuyLegQuote;
  effectiveCost: number;
  projectedPairCost: number;
  hedgeGap: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeStr(): string {
  return new Date().toTimeString().slice(0, 8);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function defaultDiagnostics(): TraderDiagnostics {
  return {
    marketWsConnected: false,
    userWsConnected: false,
    marketWsAgeMs: 0,
    userWsAgeMs: 0,
    orderbookSource: "idle",
    localBookReady: false,
    trackedTokenCount: 0,
    localBookTokenCount: 0,
    fallbackActive: false,
    marketWsDisconnects: 0,
    userWsDisconnects: 0,
    marketWsReconnects: 0,
    userWsReconnects: 0,
    fallbackTransitions: 0,
    lastFallbackAt: 0,
    localBookMaxDepth: 0,
    localBookStaleCount: 0,
    localBookCrossedCount: 0,
  };
}

async function getHotBestPrices(trader: Trader, tokenId: string): Promise<BookSnapshot | null> {
  const cached = trader.peekBestPrices(tokenId, HOT_BOOK_MAX_AGE_MS, HOT_BOOK_MAX_AGE_MS);
  if (cached) return cached;
  try {
    return await trader.getBestPrices(tokenId);
  } catch {
    return null;
  }
}

export class Hedge15mEngine {
  running = false;

  private trader: Trader | null = null;
  private tradingMode: EngineMode = "live";
  private paperSessionMode: PaperSessionMode = "session";
  private historyFile = getLiveHistoryFilePath();
  private loopRunId = 0;

  private status = "空闲";
  private roundDecision = "等待市场";
  private balance = 0;
  private initialBankroll = 0;
  private totalProfit = 0;
  private sessionProfit = 0;
  private wins = 0;
  private losses = 0;
  private skips = 0;
  private totalRounds = 0;
  private rollingPnL: Array<{ ts: number; profit: number }> = [];
  private history: HedgeHistoryEntry[] = [];

  private secondsLeft = 0;
  private currentMarket = "";
  private currentConditionId = "";
  private currentNegRisk = false;
  private upAsk = 0;
  private downAsk = 0;
  private roundStartBtcPrice = 0;

  private hedgeState: PairState = "off";
  private activeStrategyMode = "none";
  private pairAttemptedThisRound = false;
  private pairEntryInFlight = false;
  private pairRetryAfter = 0;
  private singleAttemptedThisRound = false;
  private singleRetryAfter = 0;
  private singleSide: PairLegSide | null = null;
  private singleOpenedAt = 0;

  private upToken = "";
  private downToken = "";
  private upHeldShares = 0;
  private downHeldShares = 0;
  private upAvgFill = 0;
  private downAvgFill = 0;
  private upOrderId = "";
  private downOrderId = "";
  private totalCost = 0;
  private matchedShares = 0;
  private signalCost = 0;
  private observedCost = 0;
  private bestObservedCost = 0;
  private lockedEdge = 0;
  private entryReason = "";
  private filledAt = 0;

  private recentPairCosts: Array<{ ts: number; cost: number }> = [];
  private recentSingleCosts: Record<PairLegSide, Array<{ ts: number; cost: number }>> = {
    up: [],
    down: [],
  };
  private diagnostics = defaultDiagnostics();

  private loadHistory(): void {
    try {
      if (!fs.existsSync(this.historyFile)) {
        this.history = [];
        return;
      }
      const raw = JSON.parse(fs.readFileSync(this.historyFile, "utf8"));
      this.history = Array.isArray(raw?.history) ? raw.history as HedgeHistoryEntry[] : [];
    } catch {
      this.history = [];
    }
  }

  private saveHistory(): void {
    const dir = path.dirname(this.historyFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.historyFile, JSON.stringify({ updatedAt: new Date().toISOString(), history: this.history }, null, 2), "utf8");
  }

  private getSessionROI(): number {
    if (this.initialBankroll <= 0) return 0;
    return (this.sessionProfit / this.initialBankroll) * 100;
  }

  private getRolling4hPnL(): number {
    const cutoff = Date.now() - 4 * 60 * 60 * 1000;
    this.rollingPnL = this.rollingPnL.filter((item) => item.ts >= cutoff);
    return this.rollingPnL.reduce((sum, item) => sum + item.profit, 0);
  }

  private recordRollingPnL(profit: number): void {
    this.rollingPnL.push({ ts: Date.now(), profit });
    this.getRolling4hPnL();
  }

  private calcSignalPairCost(upAsk: number, downAsk: number): number {
    return (upAsk * (1 + TAKER_FEE)) + (downAsk * (1 + TAKER_FEE)) + SIGNAL_SLIPPAGE_BUFFER;
  }

  private getAskLevels(book: BookSnapshot): BookLevel[] {
    if (book.askLevels.length > 0) return book.askLevels;
    if (book.ask != null && book.ask > 0 && book.askDepth > 0) {
      return [{ price: book.ask, size: book.askDepth }];
    }
    return [];
  }

  private quoteBuyShares(book: BookSnapshot, shares: number): BuyLegQuote | null {
    if (!Number.isFinite(shares) || shares <= 0) return null;
    const levels = this.getAskLevels(book);
    let remaining = shares;
    let rawCost = 0;
    let filled = 0;
    let maxPrice = 0;
    let depth = 0;
    for (const level of levels) {
      if (level.price <= 0 || level.size <= 0) continue;
      depth += level.size;
      if (remaining <= 0) continue;
      const take = Math.min(remaining, level.size);
      rawCost += take * level.price;
      filled += take;
      maxPrice = Math.max(maxPrice, level.price);
      remaining -= take;
    }
    if (filled + 1e-9 < shares || rawCost <= 0) return null;
    return {
      shares,
      rawCost,
      avgPrice: rawCost / shares,
      maxPrice,
      depth,
    };
  }

  private buildExecutablePairQuote(upBook: BookSnapshot, downBook: BookSnapshot): PairQuote | null {
    const upDepth = this.getAskLevels(upBook).reduce((sum, level) => sum + level.size, 0);
    const downDepth = this.getAskLevels(downBook).reduce((sum, level) => sum + level.size, 0);
    const maxDepthShares = Math.floor(Math.min(upDepth, downDepth, MAX_SHARES));
    if (maxDepthShares < MIN_SHARES) return null;

    let monitorQuote: PairQuote | null = null;
    let bestExecutableQuote: PairQuote | null = null;
    for (let shares = maxDepthShares; shares >= MIN_SHARES; shares -= 1) {
      const upQuote = this.quoteBuyShares(upBook, shares);
      const downQuote = this.quoteBuyShares(downBook, shares);
      if (!upQuote || !downQuote) continue;

      const rawCost = upQuote.rawCost + downQuote.rawCost;
      const feeAdjustedCost = rawCost * (1 + TAKER_FEE);
      if (feeAdjustedCost > this.balance * PAIR_BUDGET_PCT) continue;

      const rawCostPerPair = rawCost / shares;
      const signalCost = (feeAdjustedCost / shares) + SIGNAL_SLIPPAGE_BUFFER;
      const quote = {
        shares,
        up: upQuote,
        down: downQuote,
        rawCostPerPair,
        signalCost,
        lockedEdge: 1 - signalCost,
        expectedProfit: shares * (1 - signalCost),
      };
      if (!monitorQuote) monitorQuote = quote;
      if (signalCost <= MAX_SIGNAL_PAIR_COST && quote.lockedEdge >= MIN_LOCKED_EDGE) {
        if (
          !bestExecutableQuote ||
          quote.expectedProfit > bestExecutableQuote.expectedProfit + 1e-9 ||
          (Math.abs(quote.expectedProfit - bestExecutableQuote.expectedProfit) <= 1e-9 && quote.lockedEdge > bestExecutableQuote.lockedEdge)
        ) {
          bestExecutableQuote = quote;
        }
      }
    }

    return bestExecutableQuote ?? monitorQuote;
  }

  private quotePairCost(firstTotalCost: number, secondRawCost: number, shares: number): number {
    if (!Number.isFinite(shares) || shares <= 0) return Number.POSITIVE_INFINITY;
    return (firstTotalCost + (secondRawCost * (1 + TAKER_FEE))) / shares + SIGNAL_SLIPPAGE_BUFFER;
  }

  private getSideBook(side: PairLegSide, upBook: BookSnapshot, downBook: BookSnapshot): BookSnapshot {
    return side === "up" ? upBook : downBook;
  }

  private getOppositeSide(side: PairLegSide): PairLegSide {
    return side === "up" ? "down" : "up";
  }

  private getSideToken(rnd: Round15m, side: PairLegSide): string {
    return side === "up" ? rnd.upToken : rnd.downToken;
  }

  private getHeldShares(side: PairLegSide): number {
    return side === "up" ? this.upHeldShares : this.downHeldShares;
  }

  private getSideAvgFill(side: PairLegSide): number {
    return side === "up" ? this.upAvgFill : this.downAvgFill;
  }

  private isStagedSingleEnabled(): boolean {
    return this.tradingMode === "paper" || STAGED_SINGLE_LIVE_ENABLED;
  }

  private buildStagedSingleQuoteForSide(side: PairLegSide, upBook: BookSnapshot, downBook: BookSnapshot): SingleLegQuote | null {
    const legBook = this.getSideBook(side, upBook, downBook);
    const oppositeBook = this.getSideBook(this.getOppositeSide(side), upBook, downBook);
    const maxDepthShares = Math.floor(Math.min(
      this.getAskLevels(legBook).reduce((sum, level) => sum + level.size, 0),
      SINGLE_MAX_SHARES,
    ));
    if (maxDepthShares < MIN_SHARES) return null;

    let best: SingleLegQuote | null = null;
    for (let shares = maxDepthShares; shares >= MIN_SHARES; shares -= 1) {
      const legQuote = this.quoteBuyShares(legBook, shares);
      const oppositeQuote = this.quoteBuyShares(oppositeBook, shares);
      if (!legQuote || !oppositeQuote) continue;

      const legTotalCost = legQuote.rawCost * (1 + TAKER_FEE);
      if (legTotalCost > this.balance * SINGLE_BUDGET_PCT) continue;

      const effectiveCost = legTotalCost / shares;
      const projectedPairCost = this.quotePairCost(legTotalCost, oppositeQuote.rawCost, shares);
      if (effectiveCost > SINGLE_MAX_EFFECTIVE_COST || projectedPairCost > SINGLE_MAX_PROJECTED_PAIR_COST) continue;

      const quote: SingleLegQuote = {
        side,
        shares,
        leg: legQuote,
        opposite: oppositeQuote,
        effectiveCost,
        projectedPairCost,
        hedgeGap: projectedPairCost - MAX_SIGNAL_PAIR_COST,
      };

      if (
        !best ||
        quote.projectedPairCost < best.projectedPairCost - 1e-9 ||
        (Math.abs(quote.projectedPairCost - best.projectedPairCost) <= 1e-9 && quote.shares > best.shares)
      ) {
        best = quote;
      }
    }
    return best;
  }

  private buildStagedSingleQuotes(upBook: BookSnapshot, downBook: BookSnapshot): SingleLegQuote[] {
    return (["up", "down"] as PairLegSide[])
      .map((side) => this.buildStagedSingleQuoteForSide(side, upBook, downBook))
      .filter((quote): quote is SingleLegQuote => quote != null)
      .sort((left, right) => {
        if (Math.abs(left.projectedPairCost - right.projectedPairCost) > 1e-9) {
          return left.projectedPairCost - right.projectedPairCost;
        }
        return left.effectiveCost - right.effectiveCost;
      });
  }

  private getRecentLowestPairCost(): number {
    const cutoff = Date.now() - LOWEST_COST_LOOKBACK_MS;
    this.recentPairCosts = this.recentPairCosts.filter((item) => item.ts >= cutoff);
    let best = Number.POSITIVE_INFINITY;
    for (const item of this.recentPairCosts) {
      if (item.cost > 0 && item.cost < best) best = item.cost;
    }
    return best;
  }

  private pushPairCost(cost: number): void {
    if (!Number.isFinite(cost) || cost <= 0) return;
    this.recentPairCosts.push({ ts: Date.now(), cost });
    this.bestObservedCost = this.getRecentLowestPairCost();
  }

  private getRecentLowestSingleCost(side: PairLegSide): number {
    const cutoff = Date.now() - LOWEST_COST_LOOKBACK_MS;
    this.recentSingleCosts[side] = this.recentSingleCosts[side].filter((item) => item.ts >= cutoff);
    let best = Number.POSITIVE_INFINITY;
    for (const item of this.recentSingleCosts[side]) {
      if (item.cost > 0 && item.cost < best) best = item.cost;
    }
    return best;
  }

  private pushSingleCost(side: PairLegSide, cost: number): void {
    if (!Number.isFinite(cost) || cost <= 0) return;
    this.recentSingleCosts[side].push({ ts: Date.now(), cost });
    this.getRecentLowestSingleCost(side);
  }

  private getEntryEdgeTier(edge: number): string {
    if (edge >= 0.06) return "strong";
    if (edge >= 0.03) return "normal";
    if (edge >= 0.015) return "small";
    return "weak";
  }

  private clearOpenPosition(): void {
    this.upToken = "";
    this.downToken = "";
    this.upHeldShares = 0;
    this.downHeldShares = 0;
    this.upAvgFill = 0;
    this.downAvgFill = 0;
    this.upOrderId = "";
    this.downOrderId = "";
    this.totalCost = 0;
    this.matchedShares = 0;
    this.signalCost = 0;
    this.observedCost = 0;
    this.lockedEdge = 0;
    this.entryReason = "";
    this.filledAt = 0;
    this.singleSide = null;
    this.singleOpenedAt = 0;
  }

  private resetRoundState(): void {
    this.hedgeState = "watching";
    this.status = this.isStagedSingleEnabled() ? "监控双腿错价/单边低价" : "监控双腿错价";
    this.roundDecision = this.isStagedSingleEnabled() ? "等待最低配对成本或单边低价" : "等待最低配对成本";
    this.activeStrategyMode = "paired-arb";
    this.pairAttemptedThisRound = false;
    this.pairEntryInFlight = false;
    this.pairRetryAfter = 0;
    this.singleAttemptedThisRound = false;
    this.singleRetryAfter = 0;
    this.singleSide = null;
    this.singleOpenedAt = 0;
    this.upAsk = 0;
    this.downAsk = 0;
    this.recentPairCosts = [];
    this.recentSingleCosts = { up: [], down: [] };
    this.bestObservedCost = 0;
  }

  private setRoundSkipped(reason: string): void {
    this.hedgeState = "done";
    this.status = `跳过: ${reason}`;
    this.roundDecision = this.status;
    this.skips += 1;
  }

  private persistRuntimeState(): void {
    if (this.tradingMode !== "paper") return;
    if (this.paperSessionMode === "session" && this.matchedShares <= 0 && this.upHeldShares <= 0 && this.downHeldShares <= 0) {
      clearPaperRuntimeState();
      return;
    }
    const openPosition: PairPositionSnapshot | null = (this.upHeldShares > 0 || this.downHeldShares > 0) ? {
      conditionId: this.currentConditionId,
      upToken: this.upToken,
      downToken: this.downToken,
      upHeldShares: this.upHeldShares,
      downHeldShares: this.downHeldShares,
      upAvgFill: this.upAvgFill,
      downAvgFill: this.downAvgFill,
      totalCost: this.totalCost,
      matchedShares: this.matchedShares,
      signalCost: this.signalCost,
      observedCost: this.observedCost,
      lockedEdge: this.lockedEdge,
      roundStartBtcPrice: this.roundStartBtcPrice,
      filledAt: this.filledAt,
      activeStrategyMode: this.activeStrategyMode,
      singleSide: this.singleSide || "",
    } : null;
    const primarySingleSide = this.singleSide || (this.upHeldShares > this.downHeldShares ? "up" : this.downHeldShares > this.upHeldShares ? "down" : null);
    const primaryShares = primarySingleSide ? this.getHeldShares(primarySingleSide) : this.matchedShares;
    const primaryAvgFill = primarySingleSide ? this.getSideAvgFill(primarySingleSide) : this.observedCost;
    const primaryToken = primarySingleSide === "up" ? this.upToken : primarySingleSide === "down" ? this.downToken : this.upToken;
    const primaryOrderId = primarySingleSide === "up" ? this.upOrderId : primarySingleSide === "down" ? this.downOrderId : this.upOrderId;
    const state: PaperRuntimeState = {
      balance: this.balance,
      initialBankroll: this.initialBankroll,
      sessionProfit: this.sessionProfit,
      rollingPnL: this.rollingPnL,
      updatedAt: new Date().toISOString(),
      openPosition: openPosition ? {
        ...openPosition,
        leg1Dir: this.matchedShares > 0 ? "PAIR" : (primarySingleSide ? primarySingleSide.toUpperCase() : "PAIR"),
        leg1Token: primaryToken,
        leg1Shares: primaryShares,
        leg1FillPrice: primaryAvgFill,
        leg1OrderId: primaryOrderId,
        entrySource: this.activeStrategyMode,
      } : null,
    };
    savePaperRuntimeState(state);
  }

  private restorePaperRuntimeState(): void {
    const state = loadPaperRuntimeState();
    if (!state) return;
    this.balance = state.balance > 0 ? state.balance : this.balance;
    this.initialBankroll = state.initialBankroll > 0 ? state.initialBankroll : this.initialBankroll;
    this.sessionProfit = state.sessionProfit;
    this.rollingPnL = state.rollingPnL || [];
    const pos = state.openPosition;
    if (!pos) return;
    const upHeld = pos.upHeldShares ?? pos.leg1Shares ?? 0;
    const downHeld = pos.downHeldShares ?? pos.leg1Shares ?? 0;
    if (upHeld <= 0 && downHeld <= 0) return;
    this.currentConditionId = pos.conditionId || "";
    this.upToken = pos.upToken || pos.leg1Token || "";
    this.downToken = pos.downToken || "";
    this.upHeldShares = upHeld;
    this.downHeldShares = downHeld;
    this.upAvgFill = pos.upAvgFill ?? pos.leg1FillPrice ?? 0;
    this.downAvgFill = pos.downAvgFill ?? pos.leg1FillPrice ?? 0;
    this.totalCost = pos.totalCost || 0;
    this.matchedShares = pos.matchedShares ?? Math.min(this.upHeldShares, this.downHeldShares);
    this.signalCost = pos.signalCost ?? this.totalCost;
    this.observedCost = pos.observedCost ?? (this.matchedShares > 0 ? this.totalCost / this.matchedShares : 0);
    this.lockedEdge = pos.lockedEdge ?? (this.matchedShares > 0 ? (this.matchedShares - this.totalCost) / this.matchedShares : 0);
    this.roundStartBtcPrice = pos.roundStartBtcPrice || 0;
    this.filledAt = pos.filledAt || 0;
    this.activeStrategyMode = pos.activeStrategyMode || pos.entrySource || "paired-arb";
    const restoredSingleSide = (pos.singleSide === "up" || pos.singleSide === "down")
      ? pos.singleSide
      : upHeld > downHeld
        ? "up"
        : downHeld > upHeld
          ? "down"
          : null;
    this.singleSide = this.matchedShares > 0 ? null : restoredSingleSide;
    this.singleOpenedAt = this.singleSide ? this.filledAt : 0;
    this.hedgeState = this.singleSide ? "single_open" : "pair_open";
    this.status = this.singleSide
      ? `恢复单边低价: ${this.singleSide.toUpperCase()} ${this.getHeldShares(this.singleSide).toFixed(0)}份`
      : `恢复双腿仓位: ${this.matchedShares.toFixed(0)}对`;
    this.roundDecision = "已恢复持仓";
  }

  private isActiveRun(runId: number): boolean {
    return this.running && this.loopRunId === runId;
  }

  private async refreshBalance(): Promise<void> {
    if (!this.trader) return;
    try {
      this.balance = await this.trader.getBalance();
    } catch (error: any) {
      logger.warn(`balance refresh failed: ${error.message}`);
    }
  }

  private async executeBuyLeg(trader: Trader, tokenId: string, shares: number, maxRawSpend: number, negRisk = false): Promise<LegFillResult | null> {
    const amount = Math.max(0, maxRawSpend);
    if (shares <= 0 || amount <= 0) return null;
    const response = await trader.placeFakBuy(tokenId, amount, negRisk);
    const orderId = response?.orderID || response?.order_id || "";
    if (!orderId) return null;
    const details = await trader.waitForOrderFillDetails(orderId, 1500);
    if (!Number.isFinite(details.filled) || details.filled <= 0 || !Number.isFinite(details.avgPrice) || details.avgPrice <= 0) {
      return null;
    }
    return { filled: details.filled, avgPrice: details.avgPrice, orderId: String(orderId).slice(0, 12) };
  }

  private async executeSellLeg(trader: Trader, tokenId: string, shares: number): Promise<LegFillResult | null> {
    const response = await trader.placeFakSell(tokenId, shares, this.currentNegRisk);
    const orderId = response?.orderID || response?.order_id || "";
    if (!orderId) return null;
    const details = await trader.waitForOrderFillDetails(orderId, 1500);
    if (!Number.isFinite(details.filled) || details.filled <= 0 || !Number.isFinite(details.avgPrice) || details.avgPrice <= 0) {
      return null;
    }
    return { filled: details.filled, avgPrice: details.avgPrice, orderId: String(orderId).slice(0, 12) };
  }

  private async flattenResidual(trader: Trader): Promise<void> {
    const extraUp = Math.max(0, this.upHeldShares - this.matchedShares);
    const extraDown = Math.max(0, this.downHeldShares - this.matchedShares);
    if (extraUp >= 0.0001 && this.upToken) {
      const unwind = await this.executeSellLeg(trader, this.upToken, extraUp);
      if (unwind) {
        this.upHeldShares = Math.max(0, this.upHeldShares - unwind.filled);
        this.totalCost -= unwind.filled * unwind.avgPrice * (1 - TAKER_FEE);
      }
    }
    if (extraDown >= 0.0001 && this.downToken) {
      const unwind = await this.executeSellLeg(trader, this.downToken, extraDown);
      if (unwind) {
        this.downHeldShares = Math.max(0, this.downHeldShares - unwind.filled);
        this.totalCost -= unwind.filled * unwind.avgPrice * (1 - TAKER_FEE);
      }
    }
    this.matchedShares = Math.min(this.upHeldShares, this.downHeldShares);
    this.observedCost = this.matchedShares > 0 ? this.totalCost / this.matchedShares : 0;
    this.lockedEdge = this.matchedShares > 0 ? (this.matchedShares - this.totalCost) / this.matchedShares : 0;
  }

  private async abortUnhedgedPosition(trader: Trader): Promise<boolean> {
    if (this.upHeldShares > 0 && this.upToken) {
      const closeUp = await this.executeSellLeg(trader, this.upToken, this.upHeldShares);
      if (closeUp) {
        this.totalCost -= closeUp.filled * closeUp.avgPrice * (1 - TAKER_FEE);
        this.upHeldShares = Math.max(0, this.upHeldShares - closeUp.filled);
      }
    }
    if (this.downHeldShares > 0 && this.downToken) {
      const closeDown = await this.executeSellLeg(trader, this.downToken, this.downHeldShares);
      if (closeDown) {
        this.totalCost -= closeDown.filled * closeDown.avgPrice * (1 - TAKER_FEE);
        this.downHeldShares = Math.max(0, this.downHeldShares - closeDown.filled);
      }
    }
    this.matchedShares = 0;
    this.signalCost = 0;
    this.observedCost = 0;
    this.lockedEdge = 0;
    await this.refreshBalance();
    const residualUp = this.upHeldShares;
    const residualDown = this.downHeldShares;
    if (residualUp <= 0.0001 && residualDown <= 0.0001) {
      this.clearOpenPosition();
      return true;
    }

    this.matchedShares = Math.min(residualUp, residualDown);
    if (this.matchedShares >= MIN_SHARES) {
      this.observedCost = this.totalCost / this.matchedShares;
      this.lockedEdge = (this.matchedShares - this.totalCost) / this.matchedShares;
      this.hedgeState = "pair_open";
      this.activeStrategyMode = "rollback-residual-pair";
      this.singleSide = null;
      this.status = `回滚未完全成交, 残余配对 ${this.matchedShares.toFixed(0)}对`;
    } else {
      this.singleSide = residualUp >= residualDown ? "up" : "down";
      this.singleOpenedAt = this.singleOpenedAt || Date.now();
      const held = this.getHeldShares(this.singleSide);
      this.observedCost = held > 0 ? this.totalCost / held : 0;
      this.lockedEdge = 0;
      this.hedgeState = "single_open";
      this.activeStrategyMode = "rollback-residual-single";
      this.status = `回滚未完全成交, 残余${this.singleSide.toUpperCase()} ${held.toFixed(0)}份`;
    }
    logger.warn(`abort rollback left residual: up=${residualUp.toFixed(4)} down=${residualDown.toFixed(4)}`);
    this.persistRuntimeState();
    return false;
  }

  private shouldOpenPair(pairCost: number): boolean {
    const recentLow = this.getRecentLowestPairCost();
    const nearRecentLow = !Number.isFinite(recentLow) || pairCost <= recentLow + NEAR_LOW_TOLERANCE;
    const lockedEdge = 1 - pairCost;
    return Date.now() >= this.pairRetryAfter && pairCost > 0 && pairCost <= MAX_SIGNAL_PAIR_COST && lockedEdge >= MIN_LOCKED_EDGE && nearRecentLow;
  }

  private shouldOpenStagedSingle(quote: SingleLegQuote, secondsLeft: number): boolean {
    if (!this.isStagedSingleEnabled()) return false;
    if (secondsLeft <= SINGLE_ENTRY_MIN_SECS) return false;
    if (this.singleAttemptedThisRound || Date.now() < this.singleRetryAfter) return false;
    const recentLow = this.getRecentLowestSingleCost(quote.side);
    const nearRecentLow = !Number.isFinite(recentLow) || quote.effectiveCost <= recentLow + SINGLE_NEAR_LOW_TOLERANCE;
    return nearRecentLow &&
      quote.effectiveCost <= SINGLE_MAX_EFFECTIVE_COST &&
      quote.projectedPairCost > MAX_SIGNAL_PAIR_COST &&
      quote.projectedPairCost <= SINGLE_MAX_PROJECTED_PAIR_COST;
  }

  private allowNoExposureRetry(): void {
    this.pairAttemptedThisRound = false;
    this.pairRetryAfter = Date.now() + ENTRY_RETRY_COOLDOWN_MS;
  }

  private allowSingleNoExposureRetry(): void {
    this.singleAttemptedThisRound = false;
    this.singleRetryAfter = Date.now() + ENTRY_RETRY_COOLDOWN_MS;
  }

  private async openHedgePair(
    trader: Trader,
    rnd: Round15m,
    upBook: BookSnapshot,
    downBook: BookSnapshot,
    pairQuote: PairQuote,
  ): Promise<void> {
    if (this.hedgeState !== "watching" || this.pairEntryInFlight || this.pairAttemptedThisRound) return;
    if (!upBook.ask || !downBook.ask) return;

    const targetShares = pairQuote.shares;
    if (targetShares < MIN_SHARES) {
      this.roundDecision = `错价触发但仓位不足 (${targetShares}份)`;
      return;
    }

    this.pairEntryInFlight = true;
    this.pairAttemptedThisRound = true;
    this.hedgeState = "pair_pending";
    this.status = `双腿下单中: ${targetShares}对`;
    this.roundDecision = `准备配对成本 ${pairQuote.signalCost.toFixed(3)} VWAP ${pairQuote.rawCostPerPair.toFixed(3)} 预期+$${pairQuote.expectedProfit.toFixed(2)}`;

    try {
      const firstSide: PairLegSide = pairQuote.up.depth <= pairQuote.down.depth ? "up" : "down";
      const secondSide: PairLegSide = firstSide === "up" ? "down" : "up";
      const firstToken = firstSide === "up" ? rnd.upToken : rnd.downToken;
      const secondToken = secondSide === "up" ? rnd.upToken : rnd.downToken;
      const firstQuote = firstSide === "up" ? pairQuote.up : pairQuote.down;

      const firstFill = await this.executeBuyLeg(trader, firstToken, targetShares, firstQuote.rawCost, rnd.negRisk);
      if (!firstFill) {
        this.roundDecision = "第一腿未成交";
        this.status = "双腿下单失败";
        this.hedgeState = "watching";
        this.allowNoExposureRetry();
        return;
      }

      if (firstSide === "up") {
        this.upToken = rnd.upToken;
        this.upHeldShares = firstFill.filled;
        this.upAvgFill = firstFill.avgPrice;
        this.upOrderId = firstFill.orderId;
      } else {
        this.downToken = rnd.downToken;
        this.downHeldShares = firstFill.filled;
        this.downAvgFill = firstFill.avgPrice;
        this.downOrderId = firstFill.orderId;
      }
      this.totalCost += firstFill.filled * firstFill.avgPrice * (1 + TAKER_FEE);

      const secondBook = await getHotBestPrices(trader, secondToken);
      const secondAsk = secondBook?.ask ?? null;
      const secondShares = Math.floor(Math.min(firstFill.filled, targetShares));
      const secondQuote = secondBook && secondShares >= MIN_SHARES ? this.quoteBuyShares(secondBook, secondShares) : null;
      if (!secondAsk || !secondQuote) {
        const cleared = await this.abortUnhedgedPosition(trader);
        this.roundDecision = cleared ? "第二腿盘口丢失, 已回滚" : "第二腿盘口丢失, 回滚残余继续管理";
        if (cleared) {
          this.status = "配对失败, 已回滚";
          this.hedgeState = "watching";
        }
        return;
      }

      const projectedRawCost = (firstFill.avgPrice * secondShares) + secondQuote.rawCost;
      const projectedCost = ((projectedRawCost * (1 + TAKER_FEE)) / secondShares) + SIGNAL_SLIPPAGE_BUFFER;
      if (projectedCost > MAX_EXEC_PAIR_COST) {
        const cleared = await this.abortUnhedgedPosition(trader);
        this.roundDecision = cleared
          ? `第二腿追价过高 ${projectedCost.toFixed(3)}, 已回滚`
          : `第二腿追价过高 ${projectedCost.toFixed(3)}, 回滚残余继续管理`;
        if (cleared) {
          this.status = "配对失败, 已回滚";
          this.hedgeState = "watching";
        }
        return;
      }

      const secondFill = await this.executeBuyLeg(trader, secondToken, secondShares, secondQuote.rawCost, rnd.negRisk);
      if (!secondFill) {
        const cleared = await this.abortUnhedgedPosition(trader);
        this.roundDecision = cleared ? "第二腿未成交, 已回滚" : "第二腿未成交, 回滚残余继续管理";
        if (cleared) {
          this.status = "配对失败, 已回滚";
          this.hedgeState = "watching";
        }
        return;
      }

      if (secondSide === "up") {
        this.upToken = rnd.upToken;
        this.upHeldShares = secondFill.filled;
        this.upAvgFill = secondFill.avgPrice;
        this.upOrderId = secondFill.orderId;
      } else {
        this.downToken = rnd.downToken;
        this.downHeldShares = secondFill.filled;
        this.downAvgFill = secondFill.avgPrice;
        this.downOrderId = secondFill.orderId;
      }
      this.totalCost += secondFill.filled * secondFill.avgPrice * (1 + TAKER_FEE);

      this.matchedShares = Math.min(this.upHeldShares, this.downHeldShares);
      this.signalCost = pairQuote.signalCost;
      this.observedCost = this.matchedShares > 0 ? this.totalCost / this.matchedShares : 0;
      this.lockedEdge = this.matchedShares > 0 ? (this.matchedShares - this.totalCost) / this.matchedShares : 0;

      await this.flattenResidual(trader);
      if (this.matchedShares < MIN_SHARES) {
        const cleared = await this.abortUnhedgedPosition(trader);
        this.roundDecision = cleared ? "配对份额不足, 已回滚" : "配对份额不足, 回滚残余继续管理";
        if (cleared) {
          this.status = "配对失败, 已回滚";
          this.hedgeState = "watching";
        }
        return;
      }
      if (this.lockedEdge <= 0) {
        const cleared = await this.abortUnhedgedPosition(trader);
        this.roundDecision = cleared
          ? `实际成本无利润 ${this.observedCost.toFixed(3)}, 已回滚`
          : `实际成本无利润 ${this.observedCost.toFixed(3)}, 回滚残余继续管理`;
        if (cleared) {
          this.status = "配对实际无edge, 已回滚";
          this.hedgeState = "watching";
        }
        return;
      }

      this.currentConditionId = rnd.conditionId;
      this.roundStartBtcPrice = this.roundStartBtcPrice > 0 ? this.roundStartBtcPrice : getBtcPrice();
      this.entryReason = `PAIR cost=${this.observedCost.toFixed(3)} best=${(this.bestObservedCost || pairQuote.signalCost).toFixed(3)}`;
      this.filledAt = Date.now();
      this.hedgeState = "pair_open";
      this.activeStrategyMode = "paired-arb";
      this.status = `双腿已配对: ${this.matchedShares.toFixed(0)}对 @${this.observedCost.toFixed(3)}`;
      this.roundDecision = `拿到低错价 ${this.observedCost.toFixed(3)} edge ${(this.lockedEdge * 100).toFixed(2)}%`;
      await this.refreshBalance();
      this.persistRuntimeState();
      writeDecisionAudit("pair-opened", {
        conditionId: rnd.conditionId,
        market: rnd.question,
        matchedShares: this.matchedShares,
        upAvgFill: this.upAvgFill,
        downAvgFill: this.downAvgFill,
        observedCost: this.observedCost,
        lockedEdge: this.lockedEdge,
      });
      logger.info(`PAIR OPENED: ${this.matchedShares.toFixed(0)}对 cost=${this.observedCost.toFixed(3)} edge=${(this.lockedEdge * 100).toFixed(2)}%`);
    } finally {
      this.pairEntryInFlight = false;
    }
  }

  private async openStagedSingle(
    trader: Trader,
    rnd: Round15m,
    quote: SingleLegQuote,
  ): Promise<void> {
    if (this.hedgeState !== "watching" || this.pairEntryInFlight || this.singleAttemptedThisRound) return;

    this.pairEntryInFlight = true;
    this.singleAttemptedThisRound = true;
    this.hedgeState = "single_pending";
    this.status = `单边低价下单中: ${quote.side.toUpperCase()} ${quote.shares}份`;
    this.roundDecision = `单边${quote.side.toUpperCase()} ${quote.effectiveCost.toFixed(3)} 等待补腿, 预计配对 ${quote.projectedPairCost.toFixed(3)}`;

    try {
      const token = this.getSideToken(rnd, quote.side);
      const fill = await this.executeBuyLeg(trader, token, quote.shares, quote.leg.rawCost, rnd.negRisk);
      if (!fill) {
        this.status = "单边低价未成交";
        this.roundDecision = "单边第一腿未成交, 冷却后继续";
        this.hedgeState = "watching";
        this.allowSingleNoExposureRetry();
        return;
      }

      if (quote.side === "up") {
        this.upToken = rnd.upToken;
        this.upHeldShares = fill.filled;
        this.upAvgFill = fill.avgPrice;
        this.upOrderId = fill.orderId;
      } else {
        this.downToken = rnd.downToken;
        this.downHeldShares = fill.filled;
        this.downAvgFill = fill.avgPrice;
        this.downOrderId = fill.orderId;
      }
      this.totalCost += fill.filled * fill.avgPrice * (1 + TAKER_FEE);
      this.singleSide = quote.side;
      this.singleOpenedAt = Date.now();
      this.signalCost = quote.projectedPairCost;
      this.observedCost = fill.filled > 0 ? this.totalCost / fill.filled : 0;
      this.lockedEdge = 0;
      this.entryReason = `SINGLE ${quote.side.toUpperCase()} @${this.observedCost.toFixed(3)} hedge<=${MAX_EXEC_PAIR_COST.toFixed(3)}`;
      this.filledAt = Date.now();
      this.currentConditionId = rnd.conditionId;
      this.currentNegRisk = rnd.negRisk;
      this.roundStartBtcPrice = this.roundStartBtcPrice > 0 ? this.roundStartBtcPrice : getBtcPrice();
      if (fill.filled < MIN_SHARES) {
        const cleared = await this.abortUnhedgedPosition(trader);
        if (cleared) {
          this.status = "单边成交份额不足, 已回滚";
          this.roundDecision = this.status;
          this.hedgeState = "watching";
          this.allowSingleNoExposureRetry();
        } else {
          this.roundDecision = "单边小额残余未完全回滚, 继续管理";
        }
        return;
      }
      this.hedgeState = "single_open";
      this.activeStrategyMode = "staged-single";
      this.status = `单边低价持仓: ${quote.side.toUpperCase()} ${fill.filled.toFixed(0)}份 @${this.observedCost.toFixed(3)}`;
      this.roundDecision = `等待补${this.getOppositeSide(quote.side).toUpperCase()}腿对冲`;
      await this.refreshBalance();
      this.persistRuntimeState();
      writeDecisionAudit("single-opened", {
        conditionId: rnd.conditionId,
        market: rnd.question,
        side: quote.side,
        filled: fill.filled,
        avgFill: fill.avgPrice,
        effectiveCost: this.observedCost,
        projectedPairCost: quote.projectedPairCost,
      });
      logger.info(`SINGLE OPENED: ${quote.side.toUpperCase()} ${fill.filled.toFixed(0)}份 cost=${this.observedCost.toFixed(3)} projectedPair=${quote.projectedPairCost.toFixed(3)}`);
    } finally {
      this.pairEntryInFlight = false;
    }
  }

  private async abortStagedSingle(trader: Trader, reason: string): Promise<void> {
    const cleared = await this.abortUnhedgedPosition(trader);
    if (cleared) {
      this.hedgeState = "watching";
      this.activeStrategyMode = "paired-arb";
      this.status = `单边已回滚: ${reason}`;
      this.roundDecision = this.status;
      this.singleRetryAfter = Date.now() + ENTRY_RETRY_COOLDOWN_MS;
    } else {
      this.roundDecision = `单边回滚未完全成交: ${reason}`;
    }
    this.persistRuntimeState();
  }

  private async hedgeStagedSingle(
    trader: Trader,
    rnd: Round15m,
    upBook: BookSnapshot,
    downBook: BookSnapshot,
  ): Promise<void> {
    if (this.hedgeState !== "single_open" || !this.singleSide || this.pairEntryInFlight) return;

    const side = this.singleSide;
    const oppositeSide = this.getOppositeSide(side);
    const heldShares = Math.floor(this.getHeldShares(side));
    if (heldShares < MIN_SHARES) {
      await this.abortStagedSingle(trader, "持仓份额不足");
      return;
    }

    const oppositeBook = this.getSideBook(oppositeSide, upBook, downBook);
    const oppositeQuote = this.quoteBuyShares(oppositeBook, heldShares);
    const heldAgeMs = this.singleOpenedAt > 0 ? Date.now() - this.singleOpenedAt : 0;
    const expired = heldAgeMs >= SINGLE_MAX_HOLD_MS || rnd.secondsLeft <= SINGLE_HEDGE_CUTOFF_SECS;
    if (!oppositeQuote) {
      this.status = `单边${side.toUpperCase()}等待对冲: 盘口深度不足`;
      if (expired) await this.abortStagedSingle(trader, "等待对冲超时");
      return;
    }

    const projectedCost = this.quotePairCost(this.totalCost, oppositeQuote.rawCost, heldShares);
    const projectedEdge = 1 - projectedCost;
    this.signalCost = projectedCost;
    this.status = `单边${side.toUpperCase()}等待对冲: pair ${projectedCost.toFixed(3)} edge ${(projectedEdge * 100).toFixed(2)}%`;
    this.roundDecision = `补${oppositeSide.toUpperCase()}阈值 ≤${MAX_EXEC_PAIR_COST.toFixed(3)} / 当前 ${projectedCost.toFixed(3)}`;

    if (projectedCost > MAX_EXEC_PAIR_COST || projectedEdge < MIN_LOCKED_EDGE) {
      if (expired) await this.abortStagedSingle(trader, "未等到可锁利对冲");
      return;
    }

    this.pairEntryInFlight = true;
    this.hedgeState = "pair_pending";
    this.roundDecision = `单边补腿锁利: ${projectedCost.toFixed(3)}`;
    try {
      const secondToken = this.getSideToken(rnd, oppositeSide);
      const secondFill = await this.executeBuyLeg(trader, secondToken, heldShares, oppositeQuote.rawCost, rnd.negRisk);
      if (!secondFill) {
        this.hedgeState = "single_open";
        this.roundDecision = "补腿未成交, 继续等待或回滚";
        if (expired) await this.abortStagedSingle(trader, "补腿未成交");
        return;
      }

      if (oppositeSide === "up") {
        this.upToken = rnd.upToken;
        this.upHeldShares = secondFill.filled;
        this.upAvgFill = secondFill.avgPrice;
        this.upOrderId = secondFill.orderId;
      } else {
        this.downToken = rnd.downToken;
        this.downHeldShares = secondFill.filled;
        this.downAvgFill = secondFill.avgPrice;
        this.downOrderId = secondFill.orderId;
      }
      this.totalCost += secondFill.filled * secondFill.avgPrice * (1 + TAKER_FEE);
      this.matchedShares = Math.min(this.upHeldShares, this.downHeldShares);
      this.observedCost = this.matchedShares > 0 ? this.totalCost / this.matchedShares : 0;
      this.lockedEdge = this.matchedShares > 0 ? (this.matchedShares - this.totalCost) / this.matchedShares : 0;
      await this.flattenResidual(trader);

      if (this.matchedShares < MIN_SHARES || this.lockedEdge <= 0) {
        const cleared = await this.abortUnhedgedPosition(trader);
        this.roundDecision = cleared ? "单边补腿后无有效edge, 已回滚" : "单边补腿后无有效edge, 回滚残余继续管理";
        if (cleared) {
          this.hedgeState = "watching";
          this.status = "单边对冲失败, 已回滚";
        }
        return;
      }

      this.singleSide = null;
      this.singleOpenedAt = 0;
      this.hedgeState = "pair_open";
      this.activeStrategyMode = "staged-single-hedged";
      this.entryReason = `STAGED cost=${this.observedCost.toFixed(3)} edge=${(this.lockedEdge * 100).toFixed(2)}%`;
      this.status = `单边已补腿成对: ${this.matchedShares.toFixed(0)}对 @${this.observedCost.toFixed(3)}`;
      this.roundDecision = `单边低价对冲完成 edge ${(this.lockedEdge * 100).toFixed(2)}%`;
      await this.refreshBalance();
      this.persistRuntimeState();
      writeDecisionAudit("single-hedged", {
        conditionId: rnd.conditionId,
        side,
        oppositeSide,
        matchedShares: this.matchedShares,
        observedCost: this.observedCost,
        lockedEdge: this.lockedEdge,
      });
      logger.info(`SINGLE HEDGED: ${this.matchedShares.toFixed(0)}对 cost=${this.observedCost.toFixed(3)} edge=${(this.lockedEdge * 100).toFixed(2)}%`);
    } finally {
      this.pairEntryInFlight = false;
    }
  }

  private async resolveWinningDirection(): Promise<PairLegSide> {
    const samples: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const price = getBtcPrice();
      if (price > 0) samples.push(price);
      if (index < 2) await sleep(SETTLEMENT_SAMPLE_DELAY_MS);
    }
    samples.sort((left, right) => left - right);
    const btcNow = samples.length > 0 ? samples[Math.floor(samples.length / 2)] : 0;
    if (this.roundStartBtcPrice > 0 && btcNow > 0) {
      return btcNow > this.roundStartBtcPrice ? "up" : "down";
    }
    return "down";
  }

  private async settlePair(): Promise<void> {
    if (this.matchedShares <= 0 && this.upHeldShares <= 0 && this.downHeldShares <= 0) {
      this.hedgeState = "done";
      return;
    }

    const preSettleBalance = this.balance;
    const winningLeg = await this.resolveWinningDirection();
    const lockedPayout = this.matchedShares;
    const residualUp = Math.max(0, this.upHeldShares - this.matchedShares);
    const residualDown = Math.max(0, this.downHeldShares - this.matchedShares);
    let returnVal = lockedPayout;
    if (winningLeg === "up") returnVal += residualUp;
    else returnVal += residualDown;

    const profit = returnVal - this.totalCost;
    const result = profit >= 0 ? "WIN" : "LOSS";
    if (result === "WIN") this.wins += 1;
    else this.losses += 1;
    this.totalProfit += profit;
    this.sessionProfit += profit;
    this.recordRollingPnL(profit);
    this.trader?.creditSettlement(returnVal);
    await sleep(1000);
    await this.refreshBalance();

    const entryEffectiveEdge = this.matchedShares > 0 ? (this.matchedShares - this.totalCost) / this.matchedShares : 0;
    const primarySide = this.matchedShares > 0
      ? null
      : this.singleSide || (this.upHeldShares > this.downHeldShares ? "up" : this.downHeldShares > this.upHeldShares ? "down" : null);
    const primaryShares = this.matchedShares > 0 ? this.matchedShares : (primarySide ? this.getHeldShares(primarySide) : 0);
    const primaryFillPrice = this.matchedShares > 0 ? this.observedCost : (primarySide ? this.getSideAvgFill(primarySide) : 0);
    this.history.push({
      time: timeStr(),
      result,
      leg1Dir: this.matchedShares > 0 ? "PAIR" : (primarySide ? primarySide.toUpperCase() : "PAIR"),
      leg1Price: this.signalCost,
      totalCost: round2(this.totalCost),
      profit: round2(profit),
      cumProfit: round2(this.totalProfit),
      exitType: "settlement",
      exitReason: this.matchedShares > 0
        ? `结算赢家: ${winningLeg.toUpperCase()} | 配对${this.matchedShares.toFixed(0)}对`
        : `结算赢家: ${winningLeg.toUpperCase()} | 单边${primarySide?.toUpperCase() || "-"} ${primaryShares.toFixed(0)}份`,
      leg1Shares: primaryShares,
      leg1FillPrice: round2(primaryFillPrice),
      orderId: [this.upOrderId, this.downOrderId].filter(Boolean).join("/"),
      estimated: false,
      profitBreakdown: `回收$${returnVal.toFixed(2)} - 成本$${this.totalCost.toFixed(2)} = ${profit >= 0 ? "+" : ""}$${profit.toFixed(2)}`,
      entrySource: this.activeStrategyMode,
      entryTrendBias: "flat",
      entrySecondsLeft: Math.floor(this.secondsLeft),
      entryWinRate: this.matchedShares > 0 ? 1 : 0.5,
      entryBsFair: 1,
      entryEffectiveCost: round2(this.observedCost),
      entryEffectiveEdge,
      entryEdgeTier: this.getEntryEdgeTier(entryEffectiveEdge),
      pairMatchedShares: this.matchedShares,
      upFilledShares: this.upHeldShares,
      downFilledShares: this.downHeldShares,
      upFillPrice: this.upAvgFill,
      downFillPrice: this.downAvgFill,
      expectedPayout: round2(returnVal),
      pairSignalCost: round2(this.signalCost),
      pairObservedCost: round2(this.observedCost),
      winningLeg,
    });
    if (this.history.length > 200) this.history.shift();
    this.saveHistory();

    writeDecisionAudit("pair-settled", {
      conditionId: this.currentConditionId,
      matchedShares: this.matchedShares,
      winningLeg,
      totalCost: this.totalCost,
      returnVal,
      profit,
      preSettleBalance,
      postSettleBalance: this.balance,
    });

    logger.info(`PAIR SETTLED: ${result} winning=${winningLeg} payout=$${returnVal.toFixed(2)} cost=$${this.totalCost.toFixed(2)} profit=$${profit.toFixed(2)}`);
    this.status = `结算: ${result} ${profit >= 0 ? "+" : ""}$${profit.toFixed(2)}`;
    this.roundDecision = `结算完成 ${winningLeg.toUpperCase()} 回收$${returnVal.toFixed(2)}`;
    this.clearOpenPosition();
    this.hedgeState = "done";
    this.persistRuntimeState();
  }

  private async mainLoop(runId: number): Promise<void> {
    let currentRoundId = "";

    while (this.isActiveRun(runId)) {
      try {
        const round = await getCurrentRound15m();
        if (!this.isActiveRun(runId)) break;

        if (!round) {
          this.status = "无15分钟市场,等待中...";
          this.roundDecision = "等待新市场";
          this.secondsLeft = 0;
          setRoundSecsLeft(999);
          if (this.trader) {
            this.trader.setTrackedTokens([]);
            this.trader.setTrackedMarkets([]);
          }
          await sleep(3000);
          continue;
        }

        if (this.trader) {
          this.trader.setTrackedTokens([round.upToken, round.downToken]);
          this.trader.setTrackedMarkets([round.conditionId]);
        }
        this.currentMarket = round.question;
        this.currentConditionId = round.conditionId;
        this.currentNegRisk = round.negRisk;
        this.secondsLeft = round.secondsLeft;
        setRoundSecsLeft(round.secondsLeft);

        if (currentRoundId && round.conditionId !== currentRoundId && (this.matchedShares > 0 || this.upHeldShares > 0 || this.downHeldShares > 0)) {
          await this.settlePair();
        }

        if (round.conditionId !== currentRoundId) {
          currentRoundId = round.conditionId;
          this.totalRounds += 1;
          this.roundStartBtcPrice = getBtcPrice();
          setRoundStartPrice(this.roundStartBtcPrice);
          this.clearOpenPosition();
          await this.refreshBalance();
          this.resetRoundState();
          logger.info(`PAIR ROUND: ${round.question}, ${Math.floor(round.secondsLeft)}s left`);
          writeDecisionAudit("round-start", {
            market: round.question,
            secondsLeft: round.secondsLeft,
            conditionId: round.conditionId,
          });

          if (this.balance < MIN_BALANCE_TO_TRADE) {
            this.setRoundSkipped(`余额$${this.balance.toFixed(2)} < $${MIN_BALANCE_TO_TRADE}`);
          } else if (round.secondsLeft <= MIN_ENTRY_SECS) {
            this.setRoundSkipped(`剩余${Math.floor(round.secondsLeft)}s < ${MIN_ENTRY_SECS}s`);
          }
        }

        if (round.secondsLeft <= 75) void prefetchNextRound();

        const trader = this.trader;
        if (!trader) {
          await sleep(LOOP_SLEEP_MS);
          continue;
        }

        const [upBook, downBook] = await Promise.all([
          getHotBestPrices(trader, round.upToken),
          getHotBestPrices(trader, round.downToken),
        ]);
        this.upAsk = upBook?.ask ?? 0;
        this.downAsk = downBook?.ask ?? 0;

        if (this.hedgeState === "single_open" && upBook && downBook) {
          await this.hedgeStagedSingle(trader, round, upBook, downBook);
        } else if (this.hedgeState === "pair_open") {
          this.status = `双腿已配对: ${this.matchedShares.toFixed(0)}对 @${this.observedCost.toFixed(3)} edge ${(this.lockedEdge * 100).toFixed(2)}%`;
          if (round.secondsLeft <= 2) {
            this.status = "即将结算...";
            await this.settlePair();
          }
        } else if (this.hedgeState === "watching" && this.upAsk > 0 && this.downAsk > 0) {
          const pairQuote = upBook && downBook ? this.buildExecutablePairQuote(upBook, downBook) : null;
          const signalCost = pairQuote?.signalCost ?? this.calcSignalPairCost(this.upAsk, this.downAsk);
          this.signalCost = signalCost;
          if (pairQuote) this.pushPairCost(signalCost);
          const recentLow = this.getRecentLowestPairCost();
          const lockedEdge = 1 - signalCost;
          this.status = pairQuote
            ? `监控双腿错价: ${pairQuote.shares}对 VWAP cost ${signalCost.toFixed(3)} edge ${(lockedEdge * 100).toFixed(2)}% exp +$${pairQuote.expectedProfit.toFixed(2)}`
            : `监控双腿错价: 可执行深度不足 cost ${signalCost.toFixed(3)}`;
          this.roundDecision = `最低 ${Number.isFinite(recentLow) ? recentLow.toFixed(3) : "--"} / 当前 ${signalCost.toFixed(3)}`;

          if (round.secondsLeft > MIN_ENTRY_SECS && pairQuote && this.shouldOpenPair(signalCost) && upBook && downBook) {
            await this.openHedgePair(trader, round, upBook, downBook, pairQuote);
          } else if (upBook && downBook && !this.shouldOpenPair(signalCost)) {
            const singleQuotes = this.buildStagedSingleQuotes(upBook, downBook);
            for (const quote of singleQuotes) this.pushSingleCost(quote.side, quote.effectiveCost);
            const singleQuote = singleQuotes.find((quote) => this.shouldOpenStagedSingle(quote, round.secondsLeft));
            if (singleQuote) {
              await this.openStagedSingle(trader, round, singleQuote);
            }
          }
        } else if (this.hedgeState === "done" && round.secondsLeft > MIN_ENTRY_SECS) {
          this.status = "本轮已完成";
        }

        this.diagnostics = trader.getDiagnostics();
        this.persistRuntimeState();
        await trader.waitForOrderbookUpdate(trader.getOrderbookVersion(), LOOP_SLEEP_MS);
      } catch (error: any) {
        logger.error(`mainLoop error: ${error.message}`);
        this.status = `错误: ${error.message}`;
        this.roundDecision = "主循环异常";
        await sleep(1000);
      }
    }
  }

  async start(options: Hedge15mStartOptions = {}): Promise<void> {
    if (this.running) return;

    this.tradingMode = options.mode === "paper" ? "paper" : "live";
    this.paperSessionMode = options.paperSessionMode === "persistent" ? "persistent" : "session";
    this.historyFile = this.tradingMode === "paper" ? getPaperHistoryFilePath() : getLiveHistoryFilePath();
    this.loadHistory();

    this.trader = new Trader();
    await this.trader.init({
      mode: this.tradingMode,
      paperBalance: options.paperBalance,
    });

    await startPriceFeed();
    this.running = true;
    this.loopRunId += 1;
    this.status = this.tradingMode === "paper" ? "仿真盘就绪" : "实盘就绪";
    this.roundDecision = "等待市场";

    await this.refreshBalance();
    if (this.initialBankroll <= 0) {
      this.initialBankroll = this.balance > 0 ? this.balance : (options.paperBalance || 100);
    }
    if (this.tradingMode === "paper" && this.paperSessionMode === "persistent") {
      this.restorePaperRuntimeState();
    }
    void this.mainLoop(this.loopRunId);
  }

  stop(): void {
    this.running = false;
    this.loopRunId += 1;
    this.status = "已停止";
    this.roundDecision = "手动停止";
    this.hedgeState = "off";
    this.persistRuntimeState();
    stopPriceFeed();
    this.trader?.stopOrderbookLoop();
  }

  getHistoryFilePath(): string {
    return this.historyFile;
  }

  getState(): Hedge15mState {
    const pairCandidateCost = (this.upAsk > 0 && this.downAsk > 0) ? this.calcSignalPairCost(this.upAsk, this.downAsk) : 0;
    const livePairEdge = pairCandidateCost > 0 ? 1 - pairCandidateCost : 0;
    const secondsLeft = Math.max(0, this.secondsLeft);
    const roundElapsed = clamp(ROUND_DURATION - secondsLeft, 0, ROUND_DURATION);
    const lat = getLatencySnapshot();

    return {
      botRunning: this.running,
      tradingMode: this.tradingMode,
      paperSessionMode: this.paperSessionMode,
      status: this.status,
      roundDecision: this.roundDecision,
      btcPrice: getBtcPrice(),
      secondsLeft,
      roundElapsed,
      roundProgressPct: (roundElapsed / ROUND_DURATION) * 100,
      entryWindowLeft: Math.max(0, secondsLeft - MIN_ENTRY_SECS),
      canOpenNewPosition: this.hedgeState === "watching" && secondsLeft > MIN_ENTRY_SECS && !this.pairAttemptedThisRound && Date.now() >= this.pairRetryAfter,
      nextRoundIn: secondsLeft,
      currentMarket: this.currentMarket,
      upAsk: this.upAsk,
      downAsk: this.downAsk,
      balance: this.balance,
      totalProfit: this.totalProfit,
      wins: this.wins,
      losses: this.losses,
      skips: this.skips,
      totalRounds: this.totalRounds,
      history: this.history,
      hedgeState: this.hedgeState,
      hedgeLeg1Price: this.observedCost,
      dumpDetected: this.entryReason,
      sessionROI: this.getSessionROI(),
      effectiveMaxAsk: MAX_SIGNAL_PAIR_COST,
      askSum: this.upAsk + this.downAsk,
      leg1EffectiveCost: this.observedCost,
      leg1EffectiveEdge: this.lockedEdge,
      leg1EdgeTier: this.getEntryEdgeTier(this.lockedEdge),
      upEffectiveCost: this.upAsk > 0 ? this.upAsk * (1 + TAKER_FEE) : 0,
      downEffectiveCost: this.downAsk > 0 ? this.downAsk * (1 + TAKER_FEE) : 0,
      upNetEdge: livePairEdge,
      downNetEdge: livePairEdge,
      rtMinEntrySecs: MIN_ENTRY_SECS,
      latencyP50: lat.networkP50,
      latencyNetworkSource: lat.networkSource,
      diagnostics: this.diagnostics,
      pairMatchedShares: this.matchedShares,
      pairSignalCost: this.signalCost || pairCandidateCost,
      pairObservedCost: this.observedCost,
      pairBestObservedCost: this.bestObservedCost,
      pairLockedEdge: this.lockedEdge,
      pairExpectedPayout: this.matchedShares,
    };
  }
}

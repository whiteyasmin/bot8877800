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
const MIN_LOCKED_EDGE = 0.04;
const LOWEST_COST_LOOKBACK_MS = 45_000;
const NEAR_LOW_TOLERANCE = 0.01;
const SETTLEMENT_SAMPLE_DELAY_MS = 500;
const HOT_BOOK_MAX_AGE_MS = 350;
const ENTRY_RETRY_COOLDOWN_MS = 1_500;
const MIN_OBSERVATION_MS = 30_000;
const STAGED_SINGLE_LIVE_ENABLED = process.env.ENABLE_STAGED_SINGLE !== "0";
const SINGLE_BUDGET_PCT = 0.12;
const SINGLE_BUDGET_PCT_CAP = 0.2;
const SINGLE_PROFIT_REINVEST_PCT = 0.35;
const SINGLE_MAX_SHARES = 60;
const FIRST_LEG_MAX_ENTRY = 0.20;
const SINGLE_MAX_PROJECTED_PAIR_COST = 1 - MIN_LOCKED_EDGE;
const SINGLE_ENTRY_MIN_SECS = 180;
const SINGLE_HEDGE_CUTOFF_SECS = 75;
const SINGLE_MAX_HOLD_MS = 90_000;
const SINGLE_NEAR_LOW_TOLERANCE = 0.015;
const SINGLE_MIN_DROP_FROM_HIGH = 0.08;
const SINGLE_MIN_DROP_PCT = 0.18;
const SINGLE_LOW_REBOUND_CONFIRM = 0.01;
const SINGLE_LOW_CONFIRM_AFTER_MS = 1_500;
const FIRST_LEG_TREND_WINDOW = 5;
const FIRST_LEG_DOWNTREND_MIN_DROP = 0.01;
const FIRST_LEG_DOWNTREND_LOW_PAD = 0.015;
const FIRST_LEG_FLAT_RANGE = 0.005;
const FIRST_LEG_FLAT_NEAR_LOW = 0.015;
const FIRST_LEG_OPPOSITE_HEADROOM = 0.02;
const BUY_REPRICE_TOLERANCE = 0.01;
const SECOND_LEG_TARGET_DISCOUNT = 0.06;
const SECOND_LEG_TARGET_DISCOUNT_DEEP = 0.08;
const SECOND_LEG_TARGET_DISCOUNT_EXTREME = 0.10;
const SECOND_LEG_NEAR_LOW_TOLERANCE = 0.006;
const SECOND_LEG_REBOUND_FROM_LOW = 0.02;
const SECOND_LEG_TREND_WINDOW = 5;
const SECOND_LEG_ENTRY_PAD = 0.008;
const SECOND_LEG_ENTRY_PAD_DEEP = 0.015;
const SECOND_LEG_ENTRY_PAD_EXTREME = 0.025;
const SECOND_LEG_DYNAMIC_TARGET_PAD = 0.002;
const SECOND_LEG_DYNAMIC_ENTRY_PAD = 0.003;
const SECOND_LEG_FLAT_RANGE = 0.005;
const SECOND_LEG_FLAT_NEAR_LOW = 0.006;
const SECOND_LEG_LOW_LOCK_PAD = 0.003;
const SECOND_LEG_LOW_LOCK_WINDOW_MS = 15_000;
const SECOND_LEG_LOW_LOCK_MIN_SWING = 0.025;
const SECOND_LEG_LOW_LOCK_MIN_EDGE = MIN_LOCKED_EDGE + 0.01;
const SINGLE_ESCAPE_LOSS_PER_SHARE = 0.035;
const SINGLE_ESCAPE_LOSS_PCT = 0.14;
const SINGLE_ESCAPE_BTC_MOVE_PCT = 0.001;
const SINGLE_STOP_MAX_LOSS_PER_SHARE = SINGLE_ESCAPE_LOSS_PER_SHARE;
const SINGLE_STOP_MAX_LOSS_PCT = SINGLE_ESCAPE_LOSS_PCT;
const SINGLE_STOP_REBOUND_KEEP_PROFIT = 0.015;
const SINGLE_STOP_BTC_MOVE_PCT = SINGLE_ESCAPE_BTC_MOVE_PCT;

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

/** Web/API 鎺ㄩ€佺敤蹇収锛堜粎鍚綋鍓嶉潰鏉夸笌鎺掗殰鎵€闇€瀛楁锛?*/
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
  singleSide: string;
  singleHeldShares: number;
  singleEntryPrice: number;
  secondLegQuality: string;
  secondLegWaitSecs: number;
  secondLegWaitMaxSecs: number;
  secondLegTargetPrice: number;
  secondLegMaxPrice: number;
  secondLegLowestPrice: number;
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
  upEffectiveCost: number;
  downEffectiveCost: number;
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

interface SingleQuoteBuildResult {
  quote: SingleLegQuote | null;
  reason: string;
}

interface EntryCheck {
  ok: boolean;
  reason: string;
}

interface SingleSecondLegPlan {
  quality: "normal" | "deep" | "extreme";
  holdMs: number;
  hedgeCutoffSecs: number;
  targetDiscount: number;
  entryPad: number;
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

  private status = "绌洪棽";
  private roundDecision = "waiting for market";
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
  private secondLegLowestPrice = Number.POSITIVE_INFINITY;
  private secondLegLowestAt = 0;
  private secondLegTargetPrice = 0;
  private secondLegMaxPrice = 0;
  private secondLegRecentPrices: Array<{ ts: number; price: number }> = [];
  private singleEntryBtcPrice = 0;
  private singleEntryEffectiveCost = 0;
  private singleBestExitBid = 0;

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
  private recentSideCosts: Record<PairLegSide, Array<{ ts: number; cost: number }>> = {
    up: [],
    down: [],
  };
  private sideRecentEffectiveCosts: Record<PairLegSide, Array<{ ts: number; cost: number }>> = {
    up: [],
    down: [],
  };
  private roundStatsStartedAt = 0;
  private roundLowestPairCost = Number.POSITIVE_INFINITY;
  private roundHighestPairCost = 0;
  private roundLowestSideCost: Record<PairLegSide, number> = {
    up: Number.POSITIVE_INFINITY,
    down: Number.POSITIVE_INFINITY,
  };
  private roundHighestSideCost: Record<PairLegSide, number> = {
    up: 0,
    down: 0,
  };
  private roundLowestSideCostAt: Record<PairLegSide, number> = {
    up: 0,
    down: 0,
  };
  private recentSingleCosts: Record<PairLegSide, Array<{ ts: number; cost: number }>> = {
    up: [],
    down: [],
  };
  private diagnostics = defaultDiagnostics();
  private lastNoTradeAuditReason = "";
  private lastNoTradeAuditAt = 0;

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

  private maybeAuditNoTrade(reason: string, extra: Record<string, unknown> = {}): void {
    const normalized = String(reason || "").trim();
    if (!normalized) return;
    const now = Date.now();
    if (normalized === this.lastNoTradeAuditReason && now - this.lastNoTradeAuditAt < 15_000) return;
    this.lastNoTradeAuditReason = normalized;
    this.lastNoTradeAuditAt = now;
    writeDecisionAudit("no-trade", {
      conditionId: this.currentConditionId,
      market: this.currentMarket,
      reason: normalized,
      hedgeState: this.hedgeState,
      secondsLeft: this.secondsLeft,
      ...extra,
    });
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
    const singleEntryEffective = this.singleSide ? this.singleEntryEffectiveCost || this.observedCost : 0;
    const secondLegPlan = singleEntryEffective > 0 ? this.buildSecondLegPlan(singleEntryEffective) : null;
    const secondLegWaitSecs = this.singleSide && this.singleOpenedAt > 0
      ? Math.max(0, Math.floor((Date.now() - this.singleOpenedAt) / 1000))
      : 0;
    const secondLegWaitMaxSecs = secondLegPlan ? Math.floor(this.getSecondLegActiveHoldMs(secondLegPlan) / 1000) : 0;
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
        upEffectiveCost: upQuote.rawCost * (1 + TAKER_FEE) / shares,
        downEffectiveCost: downQuote.rawCost * (1 + TAKER_FEE) / shares,
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

  private getMaxRawOtherPriceForLockedEdge(firstEffectiveCost: number, minEdge = MIN_LOCKED_EDGE): number {
    return ((1 - minEdge - SIGNAL_SLIPPAGE_BUFFER) - firstEffectiveCost) / (1 + TAKER_FEE);
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

  private getSingleBudgetUsd(): number {
    const baseBudget = this.balance * SINGLE_BUDGET_PCT;
    const reinvestBudget = Math.max(0, this.sessionProfit) * SINGLE_PROFIT_REINVEST_PCT;
    const cappedBudget = this.balance * SINGLE_BUDGET_PCT_CAP;
    return Math.max(0, Math.min(baseBudget + reinvestBudget, cappedBudget));
  }

  private buildSecondLegPlan(firstEffectiveCost: number): SingleSecondLegPlan {
    if (firstEffectiveCost <= 0.18) {
      return {
        quality: "extreme",
        holdMs: 360_000,
        hedgeCutoffSecs: 30,
        targetDiscount: SECOND_LEG_TARGET_DISCOUNT_EXTREME,
        entryPad: SECOND_LEG_ENTRY_PAD_EXTREME,
      };
    }
    if (firstEffectiveCost <= 0.24) {
      return {
        quality: "deep",
        holdMs: 300_000,
        hedgeCutoffSecs: 45,
        targetDiscount: SECOND_LEG_TARGET_DISCOUNT_DEEP,
        entryPad: SECOND_LEG_ENTRY_PAD_DEEP,
      };
    }
    return {
      quality: "normal",
      holdMs: 240_000,
      hedgeCutoffSecs: 60,
      targetDiscount: SECOND_LEG_TARGET_DISCOUNT,
      entryPad: SECOND_LEG_ENTRY_PAD,
    };
  }

  private getSecondLegActiveHoldMs(plan: SingleSecondLegPlan): number {
    if (plan.quality === "extreme") return Math.floor(plan.holdMs * 2);
    if (plan.quality === "deep") return Math.floor(plan.holdMs * 1.5);
    return plan.holdMs;
  }

  private getSingleEntryMinSecs(firstEffectiveCost: number): number {
    const plan = this.buildSecondLegPlan(firstEffectiveCost);
    if (plan.quality === "extreme") return 120;
    if (plan.quality === "deep") return 180;
    return 300;
  }

  private getFirstLegQualityReason(effectiveCost: number, sideLow: number): string | null {
    if (effectiveCost > FIRST_LEG_MAX_ENTRY) return `first leg above ${FIRST_LEG_MAX_ENTRY.toFixed(2)}`;
    const distanceToMid = 0.5 - effectiveCost;
    if (distanceToMid <= 0.04) return "first leg too close to 0.5";
    if (effectiveCost >= 0.42) return "first leg quality too weak";
    if (!Number.isFinite(sideLow)) return null;

    const reboundFromLow = effectiveCost - sideLow;
    if (effectiveCost >= 0.38 && reboundFromLow > 0.006) return "first leg bounced too far off low";
    if (effectiveCost >= 0.30 && reboundFromLow > 0.01) return "first leg bounced too far off low";
    return null;
  }

  private getExitBidForSide(side: PairLegSide, upBook: BookSnapshot, downBook: BookSnapshot): number | null {
    const book = this.getSideBook(side, upBook, downBook);
    return book.bid != null && book.bid > 0 ? book.bid : null;
  }

  private getBtcMoveAgainstSingle(side: PairLegSide): number {
    const entry = this.singleEntryBtcPrice || this.roundStartBtcPrice;
    const now = getBtcPrice();
    if (entry <= 0 || now <= 0) return 0;
    const move = (now - entry) / entry;
    return side === "up" ? -move : move;
  }

  private isStagedSingleEnabled(): boolean {
    return this.tradingMode === "paper" || STAGED_SINGLE_LIVE_ENABLED;
  }

  private buildStagedSingleQuoteForSide(side: PairLegSide, upBook: BookSnapshot, downBook: BookSnapshot): SingleQuoteBuildResult {
    const legBook = this.getSideBook(side, upBook, downBook);
    const oppositeBook = this.getSideBook(this.getOppositeSide(side), upBook, downBook);
    const maxDepthShares = Math.floor(Math.min(
      this.getAskLevels(legBook).reduce((sum, level) => sum + level.size, 0),
      SINGLE_MAX_SHARES,
    ));
    if (maxDepthShares < MIN_SHARES) return { quote: null, reason: `${side.toUpperCase()} book depth too thin` };

    let best: SingleLegQuote | null = null;
    let bestFailureReason = `${side.toUpperCase()} book depth too thin`;
    for (let shares = maxDepthShares; shares >= MIN_SHARES; shares -= 1) {
      const legQuote = this.quoteBuyShares(legBook, shares);
      const oppositeQuote = this.quoteBuyShares(oppositeBook, shares);
      if (!legQuote || !oppositeQuote) {
        bestFailureReason = `${side.toUpperCase()} book depth too thin`;
        continue;
      }

      const legTotalCost = legQuote.rawCost * (1 + TAKER_FEE);
      if (legTotalCost > this.getSingleBudgetUsd()) {
        bestFailureReason = `${side.toUpperCase()} exceeds single-leg budget`;
        continue;
      }

      const effectiveCost = legTotalCost / shares;
      const projectedPairCost = this.quotePairCost(legTotalCost, oppositeQuote.rawCost, shares);

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
        quote.effectiveCost < best.effectiveCost - 1e-9 ||
        (Math.abs(quote.effectiveCost - best.effectiveCost) <= 1e-9 && quote.projectedPairCost < best.projectedPairCost - 1e-9) ||
        (Math.abs(quote.effectiveCost - best.effectiveCost) <= 1e-9 && Math.abs(quote.projectedPairCost - best.projectedPairCost) <= 1e-9 && quote.shares > best.shares)
      ) {
        best = quote;
      }
    }
    return { quote: best, reason: best ? "" : bestFailureReason };
  }

  private buildStagedSingleQuotes(upBook: BookSnapshot, downBook: BookSnapshot): { quotes: SingleLegQuote[]; reasons: string[] } {
    const results = (["up", "down"] as PairLegSide[])
      .map((side) => this.buildStagedSingleQuoteForSide(side, upBook, downBook));
    const quotes = results
      .map((result) => result.quote)
      .filter((quote): quote is SingleLegQuote => quote != null)
      .sort((left, right) => {
        if (Math.abs(left.effectiveCost - right.effectiveCost) > 1e-9) {
          return left.effectiveCost - right.effectiveCost;
        }
        if (Math.abs(left.projectedPairCost - right.projectedPairCost) > 1e-9) {
          return left.projectedPairCost - right.projectedPairCost;
        }
        return right.shares - left.shares;
      });
    const reasons = results.filter((result) => !result.quote && result.reason).map((result) => result.reason);
    return { quotes, reasons };
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

  private getRecentLowestSideCost(side: PairLegSide): number {
    const cutoff = this.roundStatsStartedAt > 0 ? this.roundStatsStartedAt : Date.now() - LOWEST_COST_LOOKBACK_MS;
    this.recentSideCosts[side] = this.recentSideCosts[side].filter((item) => item.ts >= cutoff);
    let best = Number.POSITIVE_INFINITY;
    for (const item of this.recentSideCosts[side]) {
      if (item.cost > 0 && item.cost < best) best = item.cost;
    }
    return best;
  }

  private getRecentHighestSideCost(side: PairLegSide): number {
    const cutoff = this.roundStatsStartedAt > 0 ? this.roundStatsStartedAt : Date.now() - LOWEST_COST_LOOKBACK_MS;
    this.recentSideCosts[side] = this.recentSideCosts[side].filter((item) => item.ts >= cutoff);
    let worst = 0;
    for (const item of this.recentSideCosts[side]) {
      if (item.cost > worst) worst = item.cost;
    }
    return worst;
  }

  private pushSideCost(side: PairLegSide, cost: number): void {
    if (!Number.isFinite(cost) || cost <= 0) return;
    this.recentSideCosts[side].push({ ts: Date.now(), cost });
    this.sideRecentEffectiveCosts[side].push({ ts: Date.now(), cost });
    if (this.sideRecentEffectiveCosts[side].length > FIRST_LEG_TREND_WINDOW) {
      this.sideRecentEffectiveCosts[side] = this.sideRecentEffectiveCosts[side].slice(-FIRST_LEG_TREND_WINDOW);
    }
  }

  private getSideCostTrend(side: PairLegSide): { falling: boolean; drop: number; flat: boolean; range: number } {
    const samples = this.sideRecentEffectiveCosts[side];
    if (samples.length < 3) return { falling: false, drop: 0, flat: false, range: 0 };
    const prices = samples.map((item) => item.cost);
    const first = prices[0];
    const last = prices[prices.length - 1];
    let fallingSteps = 0;
    for (let index = 1; index < prices.length; index += 1) {
      if (prices[index] <= prices[index - 1]) fallingSteps += 1;
    }
    const drop = first - last;
    const high = Math.max(...prices);
    const low = Math.min(...prices);
    const range = high - low;
    return {
      falling: drop >= FIRST_LEG_DOWNTREND_MIN_DROP && fallingSteps >= prices.length - 2,
      drop,
      flat: samples.length >= FIRST_LEG_TREND_WINDOW && range <= FIRST_LEG_FLAT_RANGE,
      range,
    };
  }

  private resetRoundCostStats(): void {
    this.roundStatsStartedAt = Date.now();
    this.roundLowestPairCost = Number.POSITIVE_INFINITY;
    this.roundHighestPairCost = 0;
    this.roundLowestSideCost = { up: Number.POSITIVE_INFINITY, down: Number.POSITIVE_INFINITY };
    this.roundHighestSideCost = { up: 0, down: 0 };
    this.roundLowestSideCostAt = { up: 0, down: 0 };
  }

  private pushRoundCostStats(pairQuote: PairQuote): void {
    if (!Number.isFinite(pairQuote.signalCost) || pairQuote.signalCost <= 0) return;
    this.roundLowestPairCost = Math.min(this.roundLowestPairCost, pairQuote.signalCost);
    this.roundHighestPairCost = Math.max(this.roundHighestPairCost, pairQuote.signalCost);
    if (pairQuote.upEffectiveCost < this.roundLowestSideCost.up) {
      this.roundLowestSideCost.up = pairQuote.upEffectiveCost;
      this.roundLowestSideCostAt.up = Date.now();
    }
    if (pairQuote.downEffectiveCost < this.roundLowestSideCost.down) {
      this.roundLowestSideCost.down = pairQuote.downEffectiveCost;
      this.roundLowestSideCostAt.down = Date.now();
    }
    this.roundHighestSideCost.up = Math.max(this.roundHighestSideCost.up, pairQuote.upEffectiveCost);
    this.roundHighestSideCost.down = Math.max(this.roundHighestSideCost.down, pairQuote.downEffectiveCost);
  }

  private hasEnoughRoundObservation(secondsLeft: number): boolean {
    const observedMs = this.roundStatsStartedAt > 0 ? Date.now() - this.roundStatsStartedAt : 0;
    const elapsedSecs = ROUND_DURATION - secondsLeft;
    return observedMs >= MIN_OBSERVATION_MS || elapsedSecs >= MIN_OBSERVATION_MS / 1000;
  }

  private pushSecondLegPrice(price: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    this.secondLegRecentPrices.push({ ts: Date.now(), price });
    if (this.secondLegRecentPrices.length > SECOND_LEG_TREND_WINDOW) {
      this.secondLegRecentPrices = this.secondLegRecentPrices.slice(-SECOND_LEG_TREND_WINDOW);
    }
  }

  private getSecondLegFlatSignal(): { flat: boolean; range: number } {
    if (this.secondLegRecentPrices.length < SECOND_LEG_TREND_WINDOW) return { flat: false, range: 0 };
    const prices = this.secondLegRecentPrices.map((item) => item.price);
    const high = Math.max(...prices);
    const low = Math.min(...prices);
    const range = high - low;
    return {
      flat: range <= SECOND_LEG_FLAT_RANGE,
      range,
    };
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

  private getRecentHighestPairCost(): number {
    const cutoff = Date.now() - LOWEST_COST_LOOKBACK_MS;
    this.recentPairCosts = this.recentPairCosts.filter((item) => item.ts >= cutoff);
    let worst = 0;
    for (const item of this.recentPairCosts) {
      if (item.cost > worst) worst = item.cost;
    }
    return worst;
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
    this.secondLegLowestPrice = Number.POSITIVE_INFINITY;
    this.secondLegLowestAt = 0;
    this.secondLegTargetPrice = 0;
    this.secondLegMaxPrice = 0;
    this.secondLegRecentPrices = [];
    this.singleEntryBtcPrice = 0;
    this.singleEntryEffectiveCost = 0;
    this.singleBestExitBid = 0;
  }

  private recordAbortCloseOutcome(
    reason: string,
    grossCost: number,
    recoveredValue: number,
    primarySide: PairLegSide | null,
    primaryShares: number,
    fillPrice: number,
    signalCost: number,
    observedCost: number,
    upFillPrice: number,
    downFillPrice: number,
  ): void {
    const profit = recoveredValue - grossCost;
    const result = profit >= 0 ? "WIN" : "LOSS";
    if (result === "WIN") this.wins += 1;
    else this.losses += 1;
    this.totalProfit += profit;
    this.sessionProfit += profit;
    this.recordRollingPnL(profit);
    this.history.push({
      time: timeStr(),
      result,
      leg1Dir: primarySide ? primarySide.toUpperCase() : "PAIR",
      leg1Price: signalCost || observedCost,
      totalCost: round2(grossCost),
      profit: round2(profit),
      cumProfit: round2(this.totalProfit),
      exitType: "abort",
      exitReason: reason,
      leg1Shares: primaryShares,
      leg1FillPrice: round2(fillPrice),
      orderId: [this.upOrderId, this.downOrderId].filter(Boolean).join("/"),
      estimated: false,
      profitBreakdown: `recovered $${recoveredValue.toFixed(2)} - cost $${grossCost.toFixed(2)} = ${profit >= 0 ? "+" : ""}$${profit.toFixed(2)}` ,
      entrySource: this.activeStrategyMode,
      pairMatchedShares: 0,
      upFilledShares: this.upHeldShares,
      downFilledShares: this.downHeldShares,
      upFillPrice: round2(upFillPrice),
      downFillPrice: round2(downFillPrice),
      expectedPayout: 0,
      pairSignalCost: round2(signalCost),
      pairObservedCost: round2(observedCost),
      winningLeg: "",
    });
    this.saveHistory();
  }

  private resetRoundState(): void {
    this.hedgeState = "watching";
    this.status = "watch first-leg low";
    this.roundDecision = "wait for UP/DN near lows";
    this.status = "waiting first-leg low";
    this.roundDecision = "take low first leg then wait second leg to lock edge";
    this.activeStrategyMode = "staged-single";
    this.pairAttemptedThisRound = false;
    this.pairEntryInFlight = false;
    this.pairRetryAfter = 0;
    this.singleAttemptedThisRound = false;
    this.singleRetryAfter = 0;
    this.singleSide = null;
    this.singleOpenedAt = 0;
    this.secondLegLowestPrice = Number.POSITIVE_INFINITY;
    this.secondLegLowestAt = 0;
    this.secondLegTargetPrice = 0;
    this.secondLegMaxPrice = 0;
    this.secondLegRecentPrices = [];
    this.singleEntryBtcPrice = 0;
    this.singleEntryEffectiveCost = 0;
    this.singleBestExitBid = 0;
    this.lastNoTradeAuditReason = "";
    this.lastNoTradeAuditAt = 0;
    this.upAsk = 0;
    this.downAsk = 0;
    this.recentPairCosts = [];
    this.recentSideCosts = { up: [], down: [] };
    this.sideRecentEffectiveCosts = { up: [], down: [] };
    this.recentSingleCosts = { up: [], down: [] };
    this.resetRoundCostStats();
    this.bestObservedCost = 0;
  }

  private setRoundSkipped(reason: string): void {
    this.hedgeState = "done";
    this.status = `璺宠繃: ${reason}`;
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
    if (this.singleSide) {
      const held = this.getHeldShares(this.singleSide);
      const firstEffectiveCost = held > 0 ? this.totalCost / held : 0;
      const maxOther = this.getMaxRawOtherPriceForLockedEdge(firstEffectiveCost);
      this.secondLegMaxPrice = maxOther;
      this.secondLegTargetPrice = Math.max(0.01, maxOther - SECOND_LEG_TARGET_DISCOUNT);
      this.secondLegLowestPrice = Number.POSITIVE_INFINITY;
      this.secondLegLowestAt = 0;
      this.secondLegRecentPrices = [];
      this.singleEntryEffectiveCost = firstEffectiveCost;
      this.singleEntryBtcPrice = this.roundStartBtcPrice || getBtcPrice();
      this.singleBestExitBid = 0;
    }
    this.hedgeState = this.singleSide ? "single_open" : "pair_open";
    this.status = this.singleSide
      ? `restored single ${this.singleSide.toUpperCase()} ${this.getHeldShares(this.singleSide).toFixed(0)} shares`
      : `restored pair ${this.matchedShares.toFixed(0)} pairs`;
    this.roundDecision = "restored position";
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

  private async executeBuyLeg(
    trader: Trader,
    tokenId: string,
    shares: number,
    maxRawSpend: number,
    maxAvgPrice: number,
    negRisk = false,
  ): Promise<LegFillResult | null> {
    const amount = Math.max(0, maxRawSpend);
    if (shares <= 0 || amount <= 0 || maxAvgPrice <= 0) return null;
    const latestBook = await getHotBestPrices(trader, tokenId);
    const latestQuote = latestBook ? this.quoteBuyShares(latestBook, shares) : null;
    if (!latestQuote) return null;
    if (latestQuote.avgPrice > maxAvgPrice + BUY_REPRICE_TOLERANCE) return null;
    if (latestQuote.rawCost > amount + (shares * BUY_REPRICE_TOLERANCE)) return null;
    const response = await trader.placeFakBuy(tokenId, amount, negRisk);
    const orderId = response?.orderID || response?.order_id || "";
    if (!orderId) return null;
    const details = await trader.waitForOrderFillDetails(orderId, 1500);
    if (!Number.isFinite(details.filled) || details.filled <= 0 || !Number.isFinite(details.avgPrice) || details.avgPrice <= 0) {
      return null;
    }
    if (details.avgPrice > maxAvgPrice + BUY_REPRICE_TOLERANCE) {
      logger.warn(`buy fill repriced too high: token=${tokenId.slice(0, 12)} avg=${details.avgPrice.toFixed(3)} max=${maxAvgPrice.toFixed(3)}`);
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

  private async abortUnhedgedPosition(trader: Trader, reason = "abort-close"): Promise<boolean> {
    const grossCost = this.totalCost;
    const primarySide: PairLegSide | null = this.singleSide || (this.upHeldShares > 0 ? "up" : this.downHeldShares > 0 ? "down" : null);
    const primaryShares = primarySide ? this.getHeldShares(primarySide) : Math.max(this.upHeldShares, this.downHeldShares);
    const fillPrice = primarySide ? this.getSideAvgFill(primarySide) : 0;
    const signalCost = this.signalCost;
    const observedCost = this.observedCost;
    const upFillPrice = this.upAvgFill;
    const downFillPrice = this.downAvgFill;
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
      const recoveredValue = grossCost - this.totalCost;
      if (grossCost > 0) {
        this.recordAbortCloseOutcome(reason, grossCost, recoveredValue, primarySide, primaryShares, fillPrice, signalCost, observedCost, upFillPrice, downFillPrice);
      }
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
      this.status = `rollback residual pair ${this.matchedShares.toFixed(0)} pairs`;
    } else {
      this.singleSide = residualUp >= residualDown ? "up" : "down";
      this.singleOpenedAt = this.singleOpenedAt || Date.now();
      const held = this.getHeldShares(this.singleSide);
      this.observedCost = held > 0 ? this.totalCost / held : 0;
      this.lockedEdge = 0;
      this.hedgeState = "single_open";
      this.activeStrategyMode = "rollback-residual-single";
      this.status = `rollback residual ${this.singleSide.toUpperCase()} ${held.toFixed(0)} shares`;
    }
    logger.warn(`abort rollback left residual: up=${residualUp.toFixed(4)} down=${residualDown.toFixed(4)}`);
    this.persistRuntimeState();
    return false;
  }

  private shouldOpenPair(pairQuote: PairQuote, secondsLeft: number): boolean {
    void pairQuote;
    void secondsLeft;
    return false;
  }

  private evaluateStagedSingleEntry(quote: SingleLegQuote, secondsLeft: number): EntryCheck {
    if (!this.isStagedSingleEnabled()) return { ok: false, reason: "staged single disabled" };
    if (this.singleAttemptedThisRound) return { ok: false, reason: "single already attempted" };
    if (Date.now() < this.singleRetryAfter) return { ok: false, reason: "single cooldown" };
    if (!this.hasEnoughRoundObservation(secondsLeft)) return { ok: false, reason: "observation too short" };

    const sideLow = this.roundLowestSideCost[quote.side];
    const nearRoundLow = Number.isFinite(sideLow) && quote.effectiveCost <= sideLow + SINGLE_NEAR_LOW_TOLERANCE;
    const trend = this.getSideCostTrend(quote.side);
    const lowFlat = trend.flat && Number.isFinite(sideLow) && quote.effectiveCost <= sideLow + FIRST_LEG_FLAT_NEAR_LOW;
    const reboundedFromLow = Number.isFinite(sideLow) &&
      quote.effectiveCost >= sideLow + 0.002 &&
      quote.effectiveCost <= sideLow + FIRST_LEG_DOWNTREND_LOW_PAD &&
      !trend.falling;
    const maxOther = this.getMaxRawOtherPriceForLockedEdge(quote.effectiveCost);
    const minSecsRequired = this.getSingleEntryMinSecs(quote.effectiveCost);
    const firstLegQualityReason = this.getFirstLegQualityReason(quote.effectiveCost, sideLow);

    if (secondsLeft <= minSecsRequired) return { ok: false, reason: `only ${Math.floor(secondsLeft)}s left (<${minSecsRequired}s)` };
    if (!nearRoundLow) return { ok: false, reason: `${quote.side.toUpperCase()} not near round low` };
    if (!lowFlat && !reboundedFromLow) return { ok: false, reason: `${quote.side.toUpperCase()} still falling` };
    if (firstLegQualityReason) return { ok: false, reason: firstLegQualityReason };
    if (maxOther <= 0) return { ok: false, reason: "second leg cannot lock edge" };

    return { ok: true, reason: `first leg ${quote.side.toUpperCase()} allowed` };
  }

  private shouldOpenStagedSingle(quote: SingleLegQuote, secondsLeft: number): boolean {
    return this.evaluateStagedSingleEntry(quote, secondsLeft).ok;
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
      this.roundDecision = `pair target shares too small (${targetShares})`;
      return;
    }

    this.pairEntryInFlight = true;
    this.pairAttemptedThisRound = true;
    this.hedgeState = "pair_pending";
    this.status = `pair order pending ${targetShares} pairs`;
    this.roundDecision = `prepare pair cost ${pairQuote.signalCost.toFixed(3)} VWAP ${pairQuote.rawCostPerPair.toFixed(3)} expected +$${pairQuote.expectedProfit.toFixed(2)}`;

    try {
      const firstSide: PairLegSide = pairQuote.up.depth <= pairQuote.down.depth ? "up" : "down";
      const secondSide: PairLegSide = firstSide === "up" ? "down" : "up";
      const firstToken = firstSide === "up" ? rnd.upToken : rnd.downToken;
      const secondToken = secondSide === "up" ? rnd.upToken : rnd.downToken;
      const firstQuote = firstSide === "up" ? pairQuote.up : pairQuote.down;

      const firstFill = await this.executeBuyLeg(trader, firstToken, targetShares, firstQuote.rawCost, firstQuote.avgPrice, rnd.negRisk);
      if (!firstFill) {
        this.roundDecision = "first leg not filled";
        this.status = "pair order failed";
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
        this.roundDecision = cleared ? "second leg book missing, rolled back" : "second leg book missing, residual managed";
        if (cleared) {
          this.status = "pair failed, rolled back";
          this.hedgeState = "watching";
        }
        return;
      }

      const projectedRawCost = (firstFill.avgPrice * secondShares) + secondQuote.rawCost;
      const projectedCost = ((projectedRawCost * (1 + TAKER_FEE)) / secondShares) + SIGNAL_SLIPPAGE_BUFFER;
      if (projectedCost > MAX_EXEC_PAIR_COST) {
        const cleared = await this.abortUnhedgedPosition(trader);
        this.roundDecision = cleared
          ? `second leg too expensive ${projectedCost.toFixed(3)}, rolled back`
          : `second leg too expensive ${projectedCost.toFixed(3)}, residual managed`;
        if (cleared) {
          this.status = "pair failed, rolled back";
          this.hedgeState = "watching";
        }
        return;
      }

      const secondFill = await this.executeBuyLeg(trader, secondToken, secondShares, secondQuote.rawCost, secondQuote.avgPrice, rnd.negRisk);
      if (!secondFill) {
        const cleared = await this.abortUnhedgedPosition(trader);
        this.roundDecision = cleared ? "second leg not filled, rolled back" : "second leg not filled, residual managed";
        if (cleared) {
          this.status = "pair failed, rolled back";
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
        this.roundDecision = cleared ? "pair shares too small, rolled back" : "pair shares too small, residual managed";
        if (cleared) {
          this.status = "pair failed, rolled back";
          this.hedgeState = "watching";
        }
        return;
      }
      if (this.lockedEdge <= 0) {
        const cleared = await this.abortUnhedgedPosition(trader);
        this.roundDecision = cleared
          ? `observed cost has no edge ${this.observedCost.toFixed(3)}, rolled back`
          : `observed cost has no edge ${this.observedCost.toFixed(3)}, residual managed`;
        if (cleared) {
          this.status = "pair no edge, rolled back";
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
      this.status = `pair opened ${this.matchedShares.toFixed(0)} pairs @${this.observedCost.toFixed(3)}`;
      this.roundDecision = `captured low mispricing ${this.observedCost.toFixed(3)} edge ${(this.lockedEdge * 100).toFixed(2)}%`;
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
      logger.info(`PAIR OPENED: ${this.matchedShares.toFixed(0)} pairs cost=${this.observedCost.toFixed(3)} edge=${(this.lockedEdge * 100).toFixed(2)}%`);
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
    this.status = `single order pending ${quote.side.toUpperCase()} ${quote.shares} shares`;
    const maxOther = this.getMaxRawOtherPriceForLockedEdge(quote.effectiveCost);
    this.roundDecision = `single ${quote.side.toUpperCase()} ${quote.effectiveCost.toFixed(3)} wait other <= ${maxOther.toFixed(3)}`;

    try {
      const token = this.getSideToken(rnd, quote.side);
      const fill = await this.executeBuyLeg(trader, token, quote.shares, quote.leg.rawCost, quote.leg.avgPrice, rnd.negRisk);
      if (!fill) {
        this.status = "first leg not filled";
        this.roundDecision = "first leg not filled, retry after cooldown";
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
      const filledEffectiveCost = this.observedCost;
      const filledMaxOther = this.getMaxRawOtherPriceForLockedEdge(filledEffectiveCost);
      const secondLegPlan = this.buildSecondLegPlan(filledEffectiveCost);
      const targetOther = Math.max(0.01, filledMaxOther - secondLegPlan.targetDiscount);
      this.secondLegMaxPrice = filledMaxOther;
      this.secondLegTargetPrice = targetOther;
      this.secondLegLowestPrice = Number.POSITIVE_INFINITY;
      this.secondLegLowestAt = 0;
      this.secondLegRecentPrices = [];
      this.singleEntryEffectiveCost = filledEffectiveCost;
      this.singleEntryBtcPrice = getBtcPrice();
      this.singleBestExitBid = 0;
      this.entryReason = `SINGLE ${quote.side.toUpperCase()} @${this.observedCost.toFixed(3)} other<=${filledMaxOther.toFixed(3)}`;
      this.filledAt = Date.now();
      this.currentConditionId = rnd.conditionId;
      this.currentNegRisk = rnd.negRisk;
      this.roundStartBtcPrice = this.roundStartBtcPrice > 0 ? this.roundStartBtcPrice : getBtcPrice();
      if (fill.filled < MIN_SHARES) {
        const cleared = await this.abortUnhedgedPosition(trader);
        if (cleared) {
          this.status = "single shares too small, rolled back";
          this.roundDecision = this.status;
          this.hedgeState = "watching";
          this.allowSingleNoExposureRetry();
        } else {
          this.roundDecision = "small residual after rollback, continue managing";
        }
        return;
      }
      this.hedgeState = "single_open";
      this.activeStrategyMode = "staged-single";
      this.status = `single open ${quote.side.toUpperCase()} ${fill.filled.toFixed(0)} shares @${this.observedCost.toFixed(3)}`;
      this.roundDecision = `wait ${this.getOppositeSide(quote.side).toUpperCase()} target<=${targetOther.toFixed(3)} max<=${filledMaxOther.toFixed(3)}`;
      this.roundDecision = `wait ${this.getOppositeSide(quote.side).toUpperCase()} target<=${targetOther.toFixed(3)} max<=${filledMaxOther.toFixed(3)} ${secondLegPlan.quality}/${Math.floor(secondLegPlan.holdMs / 1000)}s`;
      await this.refreshBalance();
      this.persistRuntimeState();
      writeDecisionAudit("single-opened", {
        conditionId: rnd.conditionId,
        market: rnd.question,
        side: quote.side,
        filled: fill.filled,
        avgFill: fill.avgPrice,
        effectiveCost: this.observedCost,
        maxOther: filledMaxOther,
      });
      logger.info(`SINGLE OPENED: ${quote.side.toUpperCase()} ${fill.filled.toFixed(0)} shares cost=${this.observedCost.toFixed(3)} maxOther=${filledMaxOther.toFixed(3)}`);
    } finally {
      this.pairEntryInFlight = false;
    }
  }

  private async abortStagedSingle(trader: Trader, reason: string): Promise<void> {
    const cleared = await this.abortUnhedgedPosition(trader, reason);
    if (cleared) {
      this.hedgeState = "watching";
      this.activeStrategyMode = "staged-single";
      this.status = `single rolled back ${reason}`;
      this.roundDecision = this.status;
      this.singleRetryAfter = Date.now() + ENTRY_RETRY_COOLDOWN_MS;
    } else {
      this.roundDecision = `single rollback incomplete ${reason}`;
    }
    this.persistRuntimeState();
  }

  private getSingleStopReason(side: PairLegSide, upBook: BookSnapshot, downBook: BookSnapshot): string | null {
    const bid = this.getExitBidForSide(side, upBook, downBook);
    if (bid == null) return null;
    const exitEffective = bid * (1 - TAKER_FEE);
    const entryEffective = this.singleEntryEffectiveCost || this.getSideAvgFill(side) * (1 + TAKER_FEE);
    if (entryEffective <= 0) return null;

    this.singleBestExitBid = Math.max(this.singleBestExitBid, bid);
    const lossPerShare = entryEffective - exitEffective;
    const lossPct = lossPerShare / entryEffective;
    if (lossPerShare >= SINGLE_STOP_MAX_LOSS_PER_SHARE && lossPct >= SINGLE_STOP_MAX_LOSS_PCT) {
      return `single stop: loss ${lossPerShare.toFixed(3)}/share (${(lossPct * 100).toFixed(1)}%)`;
    }

    const bestExitEffective = this.singleBestExitBid * (1 - TAKER_FEE);
    const gaveBackProfit = bestExitEffective - exitEffective;
    if (bestExitEffective > entryEffective && gaveBackProfit >= SINGLE_STOP_REBOUND_KEEP_PROFIT) {
      return `take-profit giveback ${gaveBackProfit.toFixed(3)} per share`;
    }

    const adverseBtcMove = this.getBtcMoveAgainstSingle(side);
    if (adverseBtcMove >= SINGLE_STOP_BTC_MOVE_PCT && lossPerShare > 0) {
      return `single stop: BTC adverse ${(adverseBtcMove * 100).toFixed(2)}%`;
    }

    return null;
  }

  private getSingleEscapeReason(side: PairLegSide, upBook: BookSnapshot, downBook: BookSnapshot): string | null {
    const bid = this.getExitBidForSide(side, upBook, downBook);
    if (bid == null) return null;
    const exitEffective = bid * (1 - TAKER_FEE);
    const entryEffective = this.singleEntryEffectiveCost || this.getSideAvgFill(side) * (1 + TAKER_FEE);
    if (entryEffective <= 0) return null;

    this.singleBestExitBid = Math.max(this.singleBestExitBid, bid);
    const heldAgeMs = this.singleOpenedAt > 0 ? Date.now() - this.singleOpenedAt : 0;
    const lossPerShare = entryEffective - exitEffective;
    const lossPct = lossPerShare / entryEffective;
    const adverseBtcMove = this.getBtcMoveAgainstSingle(side);
    const secondLegPlan = this.buildSecondLegPlan(entryEffective);
    const bestExitEffective = this.singleBestExitBid * (1 - TAKER_FEE);
    const recoveredPerShare = Math.max(0, bestExitEffective - entryEffective);
    const baseHoldMs = this.getSecondLegActiveHoldMs(secondLegPlan);
    const extendedHoldMs = recoveredPerShare >= 0.01 ? Math.floor(baseHoldMs * 1.5) : baseHoldMs;

    if (lossPerShare >= SINGLE_ESCAPE_LOSS_PER_SHARE && lossPct >= SINGLE_ESCAPE_LOSS_PCT && adverseBtcMove >= SINGLE_ESCAPE_BTC_MOVE_PCT) {
      return `single invalidated: loss ${lossPerShare.toFixed(3)}/share BTC ${(adverseBtcMove * 100).toFixed(2)}%`;
    }

    if (heldAgeMs >= extendedHoldMs && lossPerShare > 0 && adverseBtcMove > 0) {
      return `single stale and adverse ${Math.floor(heldAgeMs / 1000)}s`;
    }

    return null;
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
      await this.abortStagedSingle(trader, "single shares below minimum");
      return;
    }

    const stopReason = this.getSingleEscapeReason(side, upBook, downBook);
    if (stopReason) {
      this.maybeAuditNoTrade(stopReason, {
        side,
        heldShares,
        entryEffectiveCost: round2(this.singleEntryEffectiveCost || this.observedCost),
      });
      await this.abortStagedSingle(trader, stopReason);
      return;
    }

    const oppositeBook = this.getSideBook(oppositeSide, upBook, downBook);
    const oppositeQuote = this.quoteBuyShares(oppositeBook, heldShares);
    const heldAgeMs = this.singleOpenedAt > 0 ? Date.now() - this.singleOpenedAt : 0;
    const secondLegPlan = this.buildSecondLegPlan(this.singleEntryEffectiveCost || (heldShares > 0 ? this.totalCost / heldShares : Number.POSITIVE_INFINITY));
    const activeHoldMs = this.getSecondLegActiveHoldMs(secondLegPlan);
    const timeExpired = heldAgeMs >= activeHoldMs;
    const cutoffExpired = rnd.secondsLeft <= secondLegPlan.hedgeCutoffSecs;
    const expired = timeExpired || cutoffExpired;
    if (!oppositeQuote) {
      this.status = `single ${side.toUpperCase()} waiting hedge: insufficient book depth`;
      if (expired) await this.abortStagedSingle(trader, "hedge wait timeout");
      return;
    }

    const projectedCost = this.quotePairCost(this.totalCost, oppositeQuote.rawCost, heldShares);
    const projectedEdge = 1 - projectedCost;
    const firstEffectiveCost = heldShares > 0 ? this.totalCost / heldShares : Number.POSITIVE_INFINITY;
    const maxOther = this.secondLegMaxPrice > 0
      ? this.secondLegMaxPrice
      : this.getMaxRawOtherPriceForLockedEdge(firstEffectiveCost);
    this.pushSecondLegPrice(oppositeQuote.avgPrice);
    const flat = this.getSecondLegFlatSignal();
    const recentHigh = this.secondLegRecentPrices.length > 0
      ? Math.max(...this.secondLegRecentPrices.map((item) => item.price))
      : oppositeQuote.avgPrice;
    if (oppositeQuote.avgPrice < this.secondLegLowestPrice) {
      this.secondLegLowestPrice = oppositeQuote.avgPrice;
      this.secondLegLowestAt = Date.now();
    }
    const lowAgeMs = this.secondLegLowestAt > 0 ? Date.now() - this.secondLegLowestAt : Number.POSITIVE_INFINITY;
    const dynamicLowTarget = Number.isFinite(this.secondLegLowestPrice)
      ? this.secondLegLowestPrice + SECOND_LEG_DYNAMIC_TARGET_PAD
      : Math.max(0.01, maxOther - secondLegPlan.targetDiscount);
    const targetOther = Math.min(maxOther, dynamicLowTarget);
    const preferredEntryCap = Math.min(
      maxOther,
      Number.isFinite(this.secondLegLowestPrice)
        ? this.secondLegLowestPrice + SECOND_LEG_DYNAMIC_ENTRY_PAD
        : targetOther + secondLegPlan.entryPad,
    );
    this.secondLegTargetPrice = targetOther;
    const nearHoldLow = Number.isFinite(this.secondLegLowestPrice) &&
      oppositeQuote.avgPrice <= this.secondLegLowestPrice + SECOND_LEG_NEAR_LOW_TOLERANCE;
    const reboundedFromLow = Number.isFinite(this.secondLegLowestPrice) &&
      oppositeQuote.avgPrice <= maxOther &&
      oppositeQuote.avgPrice >= this.secondLegLowestPrice + SECOND_LEG_REBOUND_FROM_LOW;
    const hitTarget = oppositeQuote.avgPrice <= targetOther;
    const lowFlat = flat.flat &&
      Number.isFinite(this.secondLegLowestPrice) &&
      oppositeQuote.avgPrice <= this.secondLegLowestPrice + SECOND_LEG_FLAT_NEAR_LOW &&
      oppositeQuote.avgPrice <= maxOther;
    const canLock = oppositeQuote.avgPrice <= maxOther && projectedEdge >= MIN_LOCKED_EDGE;
    const withinPreferredEntry = oppositeQuote.avgPrice <= preferredEntryCap;
    const lowLockSwing = Math.max(0, recentHigh - this.secondLegLowestPrice);
    const lockAfterFreshLow = canLock &&
      withinPreferredEntry &&
      projectedEdge >= SECOND_LEG_LOW_LOCK_MIN_EDGE &&
      Number.isFinite(this.secondLegLowestPrice) &&
      lowLockSwing >= SECOND_LEG_LOW_LOCK_MIN_SWING &&
      oppositeQuote.avgPrice <= this.secondLegLowestPrice + SECOND_LEG_LOW_LOCK_PAD &&
      lowAgeMs <= SECOND_LEG_LOW_LOCK_WINDOW_MS &&
      (lowFlat || reboundedFromLow);
    this.signalCost = projectedCost;
    const trendLabel = lockAfterFreshLow ? " low-lock" : lowFlat ? " flat-low" : reboundedFromLow ? " rebound" : nearHoldLow ? " near-low" : "";
    this.status = `single ${side.toUpperCase()} wait ${oppositeSide.toUpperCase()}: ask ${oppositeQuote.avgPrice.toFixed(3)} target ${targetOther.toFixed(3)} max ${maxOther.toFixed(3)}${trendLabel}`;
    this.roundDecision = `second-leg low ${Number.isFinite(this.secondLegLowestPrice) ? this.secondLegLowestPrice.toFixed(3) : "--"} / pair ${projectedCost.toFixed(3)} edge ${(projectedEdge * 100).toFixed(2)}% / ${secondLegPlan.quality}/${Math.floor(activeHoldMs / 1000)}s`;

    this.roundDecision = `???????${Number.isFinite(this.secondLegLowestPrice) ? this.secondLegLowestPrice.toFixed(3) : "--"} / pair ${projectedCost.toFixed(3)} edge ${(projectedEdge * 100).toFixed(2)}% / ${secondLegPlan.quality}/${Math.floor(activeHoldMs / 1000)}s`;
    if (!canLock) {
      if (cutoffExpired || (timeExpired && secondLegPlan.quality === "normal")) {
        await this.abortStagedSingle(trader, "hedge never reached lockable range");
      }
      return;
    }
    if (!withinPreferredEntry) {
      if (cutoffExpired || (timeExpired && secondLegPlan.quality === "normal")) {
        await this.abortStagedSingle(trader, "second leg price never improved enough");
      }
      return;
    }
    if (!lowFlat && !reboundedFromLow && !lockAfterFreshLow && !(expired && nearHoldLow) ) {
      return;
    }

    this.pairEntryInFlight = true;
    this.hedgeState = "pair_pending";
    this.roundDecision = `hedging single position ${projectedCost.toFixed(3)}`;
    try {
      const secondToken = this.getSideToken(rnd, oppositeSide);
      const secondFill = await this.executeBuyLeg(trader, secondToken, heldShares, oppositeQuote.rawCost, preferredEntryCap, rnd.negRisk);
      if (!secondFill) {
        this.hedgeState = "single_open";
        this.roundDecision = "second leg not filled, keep waiting or abort";
        if (expired) await this.abortStagedSingle(trader, "second leg not filled");
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
        this.roundDecision = cleared ? "hedged but no valid edge, rolled back" : "hedged but no valid edge, residual managed";
        if (cleared) {
          this.hedgeState = "watching";
          this.status = "single hedge failed, rolled back";
        }
        return;
      }

      this.singleSide = null;
      this.singleOpenedAt = 0;
      this.hedgeState = "pair_open";
      this.activeStrategyMode = "staged-single-hedged";
      this.entryReason = `STAGED cost=${this.observedCost.toFixed(3)} edge=${(this.lockedEdge * 100).toFixed(2)}%`;
      this.status = `single hedged ${this.matchedShares.toFixed(0)} pairs @${this.observedCost.toFixed(3)}`;
      this.roundDecision = `single low-price hedge complete edge ${(this.lockedEdge * 100).toFixed(2)}%`;
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
      logger.info(`SINGLE HEDGED: ${this.matchedShares.toFixed(0)} pairs cost=${this.observedCost.toFixed(3)} edge=${(this.lockedEdge * 100).toFixed(2)}%`);
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
        ? `settlement winner: ${winningLeg.toUpperCase()} | pair ${this.matchedShares.toFixed(0)} pairs`
        : `settlement winner: ${winningLeg.toUpperCase()} | single ${primarySide?.toUpperCase() || "-"} ${primaryShares.toFixed(0)} shares`,
      leg1Shares: primaryShares,
      leg1FillPrice: round2(primaryFillPrice),
      orderId: [this.upOrderId, this.downOrderId].filter(Boolean).join("/"),
      estimated: false,
      profitBreakdown: `return $${returnVal.toFixed(2)} - cost $${this.totalCost.toFixed(2)} = ${profit >= 0 ? "+" : ""}$${profit.toFixed(2)}` ,
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
    this.status = `settled: ${result} ${profit >= 0 ? "+" : ""}$${profit.toFixed(2)}`;
    this.roundDecision = `settlement complete ${winningLeg.toUpperCase()} payout $${returnVal.toFixed(2)}`;
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
          this.status = "no active 15m market, waiting";
          this.roundDecision = "waiting for next market";
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
            this.setRoundSkipped(`浣欓$${this.balance.toFixed(2)} < $${MIN_BALANCE_TO_TRADE}`);
          } else if (round.secondsLeft <= MIN_ENTRY_SECS) {
            this.setRoundSkipped(`鍓╀綑${Math.floor(round.secondsLeft)}s < ${MIN_ENTRY_SECS}s`);
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
          this.status = `pair opened ${this.matchedShares.toFixed(0)} pairs @${this.observedCost.toFixed(3)} edge ${(this.lockedEdge * 100).toFixed(2)}%`;
          if (round.secondsLeft <= 2) {
            this.status = "settling soon";
            await this.settlePair();
          }
        } else if (this.hedgeState === "watching" && this.upAsk > 0 && this.downAsk > 0) {
          const pairQuote = upBook && downBook ? this.buildExecutablePairQuote(upBook, downBook) : null;
          const signalCost = pairQuote?.signalCost ?? this.calcSignalPairCost(this.upAsk, this.downAsk);
          this.signalCost = signalCost;
          if (pairQuote) this.pushPairCost(signalCost);
          if (pairQuote) {
            this.pushSideCost("up", pairQuote.upEffectiveCost);
            this.pushSideCost("down", pairQuote.downEffectiveCost);
            this.pushRoundCostStats(pairQuote);
          }
          const lockedEdge = 1 - signalCost;
          const observedSecs = this.roundStatsStartedAt > 0 ? Math.floor((Date.now() - this.roundStatsStartedAt) / 1000) : 0;
          this.status = pairQuote
            ? `watch first-leg low: pair ${signalCost.toFixed(3)} edge ${(lockedEdge * 100).toFixed(2)}%`
            : `watching pair spread: insufficient executable depth cost ${signalCost.toFixed(3)}`;
          this.roundDecision = `round low ${Number.isFinite(this.roundLowestPairCost) ? this.roundLowestPairCost.toFixed(3) : "--"} / current ${signalCost.toFixed(3)} / observed ${observedSecs}s`;

          this.status = pairQuote
            ? `waiting first-leg low: pair ${signalCost.toFixed(3)} edge ${(lockedEdge * 100).toFixed(2)}%`
            : `watching first-leg setup: insufficient depth cost ${signalCost.toFixed(3)}`;
          if (upBook && downBook && this.isStagedSingleEnabled()) {
            const { quotes: singleQuotes, reasons: singleBuildReasons } = this.buildStagedSingleQuotes(upBook, downBook);
            for (const quote of singleQuotes) this.pushSingleCost(quote.side, quote.effectiveCost);
            const singleEvaluations = singleQuotes.map((quote) => ({
              quote,
              check: this.evaluateStagedSingleEntry(quote, round.secondsLeft),
            }));
            const singleCandidate = singleEvaluations.find((item) => item.check.ok);
            if (singleCandidate) {
              await this.openStagedSingle(trader, round, singleCandidate.quote);
            } else if (singleEvaluations.length > 0) {
              const bestRejected = singleEvaluations[0];
              this.roundDecision = `no trade: ${bestRejected.check.reason}`;
              this.maybeAuditNoTrade(bestRejected.check.reason, {
                side: bestRejected.quote.side,
                effectiveCost: round2(bestRejected.quote.effectiveCost),
                projectedPairCost: round2(bestRejected.quote.projectedPairCost),
                oppositeAsk: round2(bestRejected.quote.opposite.avgPrice),
              });
            } else {
              const buildReason = singleBuildReasons[0] || "insufficient depth or first leg too expensive";
              this.roundDecision = `no trade: ${buildReason}`;
              this.maybeAuditNoTrade(buildReason, {
                upAsk: this.upAsk,
                downAsk: this.downAsk,
              });
            }
          }
        } else if (this.hedgeState === "watching") {
          const missingSide = this.upAsk <= 0 && this.downAsk <= 0
            ? "UP/DN"
            : this.upAsk <= 0
              ? "UP"
              : "DN";
          this.status = `waiting valid book: ${missingSide} ask missing`;
          this.roundDecision = `no trade: ${missingSide} ask missing`;
          this.maybeAuditNoTrade(`${missingSide} ask missing`, {
            upAsk: this.upAsk,
            downAsk: this.downAsk,
          });
        } else if (this.hedgeState === "done" && round.secondsLeft > MIN_ENTRY_SECS) {
          this.status = "round already completed";
        }

        this.diagnostics = trader.getDiagnostics();
        this.persistRuntimeState();
        await trader.waitForOrderbookUpdate(trader.getOrderbookVersion(), LOOP_SLEEP_MS);
      } catch (error: any) {
        logger.error(`mainLoop error: ${error.message}`);
        this.status = `閿欒: ${error.message}`;
        this.roundDecision = "main loop error";
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
    this.status = this.tradingMode === "paper" ? "paper ready" : "live ready";
    this.roundDecision = "waiting for market";

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
    this.status = "stopped";
    this.roundDecision = "stopped by user";
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
    const singleEntryEffective = this.singleSide ? this.singleEntryEffectiveCost || this.observedCost : 0;
    const secondLegPlan = singleEntryEffective > 0 ? this.buildSecondLegPlan(singleEntryEffective) : null;
    const secondLegWaitSecs = this.singleSide && this.singleOpenedAt > 0
      ? Math.max(0, Math.floor((Date.now() - this.singleOpenedAt) / 1000))
      : 0;
    const secondLegWaitMaxSecs = secondLegPlan ? Math.floor(this.getSecondLegActiveHoldMs(secondLegPlan) / 1000) : 0;

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
      singleSide: this.singleSide || "",
      singleHeldShares: this.singleSide ? this.getHeldShares(this.singleSide) : 0,
      singleEntryPrice: this.singleSide ? this.observedCost : 0,
      secondLegQuality: secondLegPlan?.quality || "",
      secondLegWaitSecs,
      secondLegWaitMaxSecs,
      secondLegTargetPrice: this.secondLegTargetPrice,
      secondLegMaxPrice: this.secondLegMaxPrice,
      secondLegLowestPrice: Number.isFinite(this.secondLegLowestPrice) ? this.secondLegLowestPrice : 0,
    };
  }
}

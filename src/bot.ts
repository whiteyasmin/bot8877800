import * as fs from "fs";
import * as path from "path";
import { writeDecisionAudit } from "./decisionAudit";
import { logger } from "./logger";
import { startLatencyMonitor, stopLatencyMonitor, recordLatency, getDynamicParams, getLatencySnapshot } from "./latency";
import { getExecutionTelemetry, recordExecutionLatency, resetExecutionTelemetry } from "./telemetry";
import { getCurrentRound15m, prefetchNextRound, Round15m } from "./market";
import {
  startPriceFeed, getBtcPrice,
  getBtcMovePct, getBtcDirection,
  getTakerFlowRatio, getTakerFlowTrend,
  getVolumeSpikeInfo, getLargeOrderInfo,
  getDepthImbalance, getLiquidationInfo, getFundingRateInfo,
  setRoundSecsLeft, setRoundStartPrice, stopPriceFeed,
  getRecentMomentum, getRecentVolatility,
} from "./btcPrice";
import { HISTORY_FILE, PAPER_HISTORY_FILE } from "./audit";
import { clearPaperRuntimeState, loadPaperRuntimeState, savePaperRuntimeState } from "./paperRuntimeState";
import { RoundMarketState } from "./marketState";
import { estimateFilledShares, evaluateEntryOrderbook } from "./executionManager";
import { planHedgeEntry } from "./executionPlanner";
import {
  evaluateMispricingOpportunity,
  getDirectionalBias as getDirectionalBiasSignal,
} from "./strategyEngine";
import { Trader, type TraderDiagnostics } from "./trader";

// ── 15分钟对冲机器人参数 (延迟相关参数由 getDynamicParams() 提供) ──
const MIN_SHARES      = 3;        // 最少3份, 低于此不开仓 (从5降低, 避免小余额死循环)
const MAX_SHARES      = 150;      // 单腿上限150份 (低价入场EV+大, 允许更大仓位)
const DUMP_THRESHOLD  = 0.08;     // ask 跌幅 ≥8% 触发Leg1 (基准值, 低价位会动态降低)
const DUMP_THRESHOLD_LOW_PRICE = 0.06;  // ask≤$0.22时降到6% (低价位EV已高, 不需等大跌)
const DUMP_LOW_PRICE_CUTOFF = 0.22;     // 低价位分界线
const ENTRY_WINDOW_S  = 660;      // 开局11分钟内监控砸盘, 窗口关闭=ROUND-660=240s=MIN_ENTRY_SECS
const ROUND_DURATION  = 900;      // 15分钟
const TAKER_FEE       = 0.02;     // Polymarket taker fee ~2%
const MIN_ENTRY_SECS  = 120;      // 剩余 <4分钟不开新仓 (放宽: 低价入场EV+即使时间短, 4min足够结算)
const MAX_ENTRY_ASK   = 0.30;     // Leg1 入场价上限: 降至$0.30, 砍掉$0.31-0.35亏损桶 (paper证明>$0.25净亏)
const MIN_ENTRY_ASK   = 0.10;     // Leg1 入场价下限, 深度砸盘时低价=高EV (dumpThreshold已过滤噪声)
const DIRECTIONAL_MOVE_PCT = 0.0012;       // 回合内价格移动超过 0.12% 才形成方向偏置
const MOMENTUM_WINDOW_SEC = 60;            // 短期动量窗口 60秒
const MOMENTUM_CONTRA_PCT = 0.0010;        // BTC 60s内反方向移动超过 0.10% 才拒绝dump
const TREND_WINDOW_SEC = 180;              // 中期趋势窗口 180秒
const TREND_CONTRA_PCT = 0.0024;           // BTC 180s内单边超过 0.24% 才视为强真实趋势

const BASE_BUDGET_PCT = 0.18;             // 默认轻仓基准 (Kelly分层会自动覆盖)
const KELLY_WIN_RATE = 0.54;              // Kelly估计胜率 (实盘4W/3L≈57%, 54%保守估计)
const KELLY_FRACTION = 0.5;               // Half-Kelly (避免过度下注)
const LIMIT_RACE_ENABLED = true;           // 启用 Limit+FAK 赛跑
const LIMIT_RACE_OFFSET = 0.01;            // limit 挂单价 = ask - offset
const LIMIT_RACE_FAST_OFFSET = 0.03;       // dump 快速时更激进 (多省1c/份)
const LIMIT_RACE_TIMEOUT_MS = 900;         // limit 等待上限 ms (900ms: maker 0%fee vs taker 2%fee, 多等300ms值得)
const LIMIT_RACE_POLL_MS = 50;             // 每 50ms 检查一次
const LIMIT_RACE_FAST_DUMP_THRESHOLD = 0.15; // dump>=15% 视为快速dump
const DUAL_SIDE_ENABLED = true;            // 启用双侧预挂单做市
const DUAL_SIDE_SUM_CEILING = 0.96;        // 预挂单目标: 略收紧至0.96, 提高成交侧+对手ask隐含套利质量 (0.97时边际单偏多)
/** 本轮 BTC 从开盘价位移 ≥ 此比例时: 撤销逆势预挂单 / 禁止挂逆势单 (原0.25%过宽, flat轮次易接到逆势边) */
const DUAL_SIDE_BTC_MOVE_BLOCK = 0.0018;
/** 预挂 maker 成交后若 BSM 拒绝: 仅当成交价 ≤ 此值才持有到期; 高于则 taker 平仓, 避免薄 edge 赌方向 */
const DUAL_SIDE_KEEP_ON_BSM_REJECT = 0.27;
const DUAL_SIDE_OFFSET = 0.02;             // 挂单价 = currentAsk - offset (最少, 实际用动态offset)
const DUAL_SIDE_REFRESH_MS = 2000;         // 每2秒刷新挂单价格 (3s在快行情中偏移过大)
const DUAL_SIDE_BUDGET_PCT = 0.25;         // 预挂单仓位 (单侧) - 方向性策略EV+加大仓位
const DUAL_SIDE_MIN_SECS = 300;            // 剩余≥5min才预挂 (原540太保守, 低价maker成交即使剩5min仍EV+)
const DUAL_SIDE_MIN_ASK = 0.18;            // 挂单价下限 (与反应入场MIN_ENTRY_ASK对齐)
const DUAL_SIDE_MAX_ASK = 0.30;            // 预挂上限同步降至$0.30, 与MAX_ENTRY_ASK一致

const DUAL_SIDE_MIN_DRIFT = 0.04;          // 价格偏移>此值才重挂 (降低更新频率)
const DUAL_SIDE_MIN_VOL = 0.0012;          // 5分钟BTC波动率下限 (0.12%), 低于此视为微行情不挂单
const REACTIVE_MIN_VOL = 0.0008;           // reactive波动率门槛: 0.08% (原0.10%拒了大量log中7-9%edge的入场)
const DUMP_LOG_THROTTLE_MS = 2000;         // 重复dump日志节流: 同key至少间隔2s

const LIQUIDITY_FILTER_SUM = 1.10;          // UP+DOWN best ask之和>此值 说明spread太大无edge, 不挂预挂单
const SUM_DIVERGENCE_MAX = 1.03;            // 入场时 upAsk+downAsk > 此值 → 拒绝入场 (sum≥1.03=市场公平定价, 无dump错定价edge)
const SUM_DIVERGENCE_RELAXED = 1.05;        // 大dump(≥12%)时放宽sum上限: 深度砸盘说明定价效率低, sum略高仍有edge
const SUM_DIVERGENCE_MIN = 0.85;            // 入场时 upAsk+downAsk < 此值 → 方向性强、砸盘更可信
const DUMP_CONFIRM_CYCLES = 1;              // 连续 N 个循环看到 dump 才触发入场 (1: dumpThreshold已过滤噪声, 无需多次确认)
const MIN_ENTRY_ELAPSED = 30;               // 回合开始至少30s后才允许反应式入场 (30s数据已足够稳定)
const TREND_BUDGET_BOOST = 0.05;            // 趋势一致在Kelly基础上再加5%
const TREND_BUDGET_CUT = 0.03;              // 方向中性时在Kelly基础上减3%
const CONTRA_TREND_SCALE = 0.70;            // 逆势缩仓30%
const CONTRA_TREND_EXTRA_EDGE = 0.05;       // 逆势需额外5% net edge才允许入场
const MIN_NET_EDGE = 0.05;                  // BSM net edge 基准门槛: <5% 不做 (secsLeft动态±3%)
const NON_FLAT_MIN_NET_EDGE = 0.08;         // 非flat行情 regime 门槛: 8%
const FLAT_MIN_NET_EDGE = 0.09;             // flat行情 regime 门槛: 9%
const REACTIVE_MIN_ALIGNMENT_SCORE = 1.5;   // 加权信号质量门槛: aligned-contra >= 1.5 (原等权=1)
const REACTIVE_ALIGNMENT_EDGE_OVERRIDE = 0.20; // edge≥20%时允许越过信号门槛
const MID_NET_EDGE = 0.15;                  // 8%~15% 小仓
const HIGH_NET_EDGE = 0.25;                 // 15%~25% 正常仓, >25% 强信号仓
const BALANCE_ESTIMATE_MIN_PCT = 0.70;
const BALANCE_ESTIMATE_MAX_PCT = 1.15;

// ── 资金安全守护 ──
const MIN_BALANCE_TO_TRADE = 5;             // 余额<$5停止交易 (不够开最小仓)
const MAX_SESSION_LOSS_PCT = 0.35;          // 单次会话亏损超过初始资金35%→暂停交易 (更早止损保留本金)
const CONSECUTIVE_LOSS_PAUSE = 3;           // 连续亏损≥3次 → 日志提示 + Kelly自动缩仓(0.90^n)

export type PaperSessionMode = "session" | "persistent";

export interface Hedge15mState {
  botRunning: boolean;
  tradingMode: "live" | "paper";
  paperSessionMode: PaperSessionMode;
  status: string;
  roundPhase: string;
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
  hedgeLeg1Dir: string;
  hedgeLeg1Price: number;
  hedgeTotalCost: number;
  dumpDetected: string;
  maxEntryAsk: number;
  activeStrategyMode: string;
  trendBias: string;
  sessionROI: number;
  rolling4hPnL: number;
  effectiveMaxAsk: number;
  askSum: number;
  dumpConfirmCount: number;
  dirAlignedScore: number;
  dirContraScore: number;
  roundMomentumRejects: number;
  roundEntryAskRejects: number;
  preOrderUpPrice: number;
  preOrderDownPrice: number;
  leg1Maker: boolean;
  leg1WinRate: number;
  leg1BsFair: number;
  leg1EffectiveCost: number;
  leg1EffectiveEdge: number;
  leg1EdgeTier: string;
  upBsFair: number;
  downBsFair: number;
  upEffectiveCost: number;
  downEffectiveCost: number;
  upNetEdge: number;
  downNetEdge: number;
  upEdgeTier: string;
  downEdgeTier: string;
  upEdgeMultiplier: number;
  downEdgeMultiplier: number;
  leg1EntrySource: string;
  lastBsmRejectReason: string;
  // L: Taker Flow
  takerFlowRatio: number;
  takerFlowDirection: string;
  takerFlowConfidence: string;
  takerFlowTrend: string;
  takerFlowTrades: number;
  // M: Volume Spike
  volSpikeRatio: number;
  volSpikeIsSpike: boolean;
  volSpikeDirection: string;
  // N: Large Order
  largeBuyCount: number;
  largeSellCount: number;
  largeBuyVol: number;
  largeSellVol: number;
  largeDirection: string;
  largeRecent60s: number;
  // O: Depth Imbalance
  depthRatio: number;
  depthDirection: string;
  depthFresh: boolean;
  // P: Liquidation
  liqBuyVol: number;
  liqSellVol: number;
  liqDirection: string;
  liqIntensity: string;
  // Q: Funding Rate
  fundingRate: number;
  fundingDirection: string;
  fundingExtreme: boolean;
  rtDumpConfirmCycles: number;
  rtEntryWindowS: number;
  rtMinEntrySecs: number;
  rtMaxEntryAsk: number;
  rtDualSideMaxAsk: number;
  rtKellyFraction: number;
  latencyP50: number;
  latencyP90: number;
  latencyNetworkSource: string;
  latencyPingP50: number;
  latencyPingP90: number;
  latencyPingCount: number;
  latencyPingLastMs: number;
  latencyPingLastAt: number;
  latencyHttpP50: number;
  latencyHttpP90: number;
  latencyHttpCount: number;
  latencyHttpLastMs: number;
  latencyHttpLastAt: number;
  latencyCacheP50: number;
  latencyCacheP90: number;
  latencyCacheCount: number;
  latencyCacheLastMs: number;
  latencyCacheLastAt: number;
  btcVolatility5m: number;
  diagnostics: {
    marketWsConnected: boolean;
    userWsConnected: boolean;
    marketWsAgeMs: number;
    userWsAgeMs: number;
    orderbookSource: string;
    localBookReady: boolean;
    trackedTokenCount: number;
    localBookTokenCount: number;
    fallbackActive: boolean;
    marketWsDisconnects: number;
    userWsDisconnects: number;
    marketWsReconnects: number;
    userWsReconnects: number;
    fallbackTransitions: number;
    lastFallbackAt: number;
    localBookMaxDepth: number;
    localBookStaleCount: number;
    localBookCrossedCount: number;
    execSignalToSubmitP50: number;
    execSubmitToAckP50: number;
    execAckToFillP50: number;
    execSignalToFillP50: number;
    execSignalToFillP90: number;
  };
}

export interface Hedge15mStartOptions {
  mode?: "live" | "paper";
  paperBalance?: number;
  paperSessionMode?: PaperSessionMode;
  // ── 运行时可调参数 ──
  dumpConfirmCycles?: number;       // 砸盘确认周期: 1/2/3
  entryWindowPreset?: "short" | "medium" | "long";  // 入场窗口: 短4min/中6min/长8min
  maxEntryAsk?: number;             // 反应入场上限: 0.35
  dualSideMaxAsk?: number;          // 预挂上限: 0.30/0.35
  kellyFraction?: number;           // 仓位计算: 0.25/0.50/0.75
}

export interface HedgeHistoryEntry {
  time: string;
  result: string;
  leg1Dir: string;
  leg1Price: number;        // Leg1 入场 ask (报价)
  totalCost: number;
  profit: number;
  cumProfit: number;
  // ── 真实成交数据 ──
  exitType?: string;        // "settlement"
  exitReason?: string;      // 人类可读退出理由
  leg1Shares?: number;      // Leg1 实际成交份数
  leg1FillPrice?: number;   // Leg1 真实平均成交价
  orderId?: string;         // 关联订单ID (截取前12位)
  estimated?: boolean;      // 是否含估算数据
  profitBreakdown?: string; // 盈亏计算明细
  entrySource?: string;     // dual-side-preorder | reactive-mispricing
  entryTrendBias?: string;  // up | down | flat
  entrySecondsLeft?: number; // 入场时回合剩余秒数
  entryWinRate?: number;    // 入场时动态胜率
  entryBsFair?: number;     // 入场时BSM公平胜率(raw)
  entryEffectiveCost?: number; // 入场综合成本(含费率/滑点)
  entryEffectiveEdge?: number; // 入场净edge = bsFair - effectiveCost
  entryEdgeTier?: string;   // net-edge档位: small/normal/strong
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function timeStr(): string {
  return new Date().toTimeString().slice(0, 8);
}

/** 给 Promise 加超时保护，超时返回 null 而不 reject */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

async function getHotBestPrices(trader: Trader, tokenId: string): Promise<{ bid: number | null; ask: number | null; spread: number; askDepth: number; bidDepth: number } | null> {
  const startedAt = Date.now();
  const cached = trader.peekBestPrices(tokenId);
  if (cached) {
    recordLatency(Math.max(1, Date.now() - startedAt), "cache");
    return cached;
  }
  const result = await withTimeout(trader.getBestPrices(tokenId), getDynamicParams().orderbookTimeoutMs);
  if (result) {
    recordLatency(Math.max(1, Date.now() - startedAt), "http");
  }
  return result;
}

function getDefaultTraderDiagnostics(): TraderDiagnostics {
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

export class Hedge15mEngine {
  running = false;
  private servicesStarted = false;
  private trader: Trader | null = null;
  private tradingMode: "live" | "paper" = "live";
  private paperSessionMode: PaperSessionMode = "session";
  private historyFile = HISTORY_FILE;

  private status = "空闲";
  private balance = 0;
  private initialBankroll = 0;
  private totalProfit = 0;
  private wins = 0;
  private losses = 0;
  private skips = 0;
  private totalRounds = 0;
  private history: HedgeHistoryEntry[] = [];

  private secondsLeft = 0;
  private currentMarket = "";
  private currentConditionId = "";
  private upAsk = 0;
  private downAsk = 0;

  // Hedge state
  private hedgeState: "off" | "watching" | "leg1_pending" | "leg1_filled" | "done" = "off";
  private leg1Dir = "";
  private leg1Price = 0;
  private leg1Shares = 0;
  private leg1Token = "";
  private totalCost = 0;
  private dumpDetected = "";
  private roundStartBtcPrice = 0; // 用于结算方向回退
  private negRisk = false;        // 当前市场的 negRisk 标志
  private sessionProfit = 0;      // 本次会话累计盈亏
  private leg1FillPrice = 0;         // Leg1 真实平均成交价
  private leg1OrderId = "";          // Leg1 订单ID
  private leg1FilledAt = 0;
  private leg1Estimated = false;       // Leg1 成交是否为估算值
  private leg1EntryInFlight = false;
  private leg1AttemptedThisRound = false;
  private roundMomentumRejects = 0;
  private roundEntryAskRejects = 0;
  private loopRunId = 0;
  private activeStrategyMode: "none" | "mispricing" | "trend" = "none";
  private currentTrendBias: "up" | "down" | "flat" = "flat";
  private currentDumpDrop = 0;               // 当前dump跌幅(用于limit race offset)
  private currentDumpVelocity: "fast" | "normal" | "slow" = "normal"; // dump速度
  private leg1MakerFill = false;             // Leg1是否maker成交
  private leg1WinRate = 0.50;                // Leg1入场时动态胜率
  private leg1BsFair = 0.50;
  private leg1EffectiveCost = 0;
  private leg1EffectiveEdge = 0;
  private leg1EdgeTier = "--";
  private preOrderUpId = "";                 // 双侧预挂单: UP token GTC orderId
  private preOrderDownId = "";               // 双侧预挂单: DOWN token GTC orderId
  private preOrderUpPrice = 0;
  private preOrderDownPrice = 0;
  private preOrderUpShares = 0;
  private preOrderDownShares = 0;
  private preOrderUpToken = "";
  private preOrderDownToken = "";
  private preOrderLastRefresh = 0;
  private leg1EntrySource = "";
  private leg1EntryTrendBias: "up" | "down" | "flat" = "flat";
  private leg1EntrySecondsLeft = 0;
  private roundRejectReasonCounts = new Map<string, number>();
  private rollingPnL: Array<{ ts: number; profit: number }> = []; // 滚动P/L记录
  private dumpConfirmCount = 0;             // 连续砸盘确认计数
  private lastDumpCandidateDir = "";        // 上个cycle的dump方向
  private lastEntrySkipKey = "";            // 去重: 上次入场跳过的key (dir:price)
  private lastDumpLogKey = "";              // 去重: 上次SUM过高跳过日志的key
  private lastDumpInfoKey = "";             // 去重: 上次DUMP信息日志key
  private lastDumpInfoTs = 0;               // 节流: 上次DUMP信息日志时间戳
  private lastSignalSkipKey = "";           // 去重: 上次信号门控跳过的key
  private lastRepricingRejectKey = "";      // 去重: 上次重定价拒绝的key
  private bsmRejectThrottle = new Map<string, number>(); // 去重: BSM拒绝日志按key节流(30s/key)
  private lastBsmRejectReason = "";
  private _volGateLoggedThisRound = false;  // 去重: 波动率门控日志每轮只打一次
  private _earlyEntryLoggedThisRound = false; // 去重: EARLY日志每轮只打一次
  private _holdReversalLogged = false;       // 去重: 持仓反转警告每轮只打一次
  private dirAlignedScore = 0;              // 入场时方向一致信号加权分 (8源)
  private dirContraScore = 0;               // 入场时方向反向信号加权分 (8源)
  private consecutiveLosses = 0;            // 连续亏损计数 (资金安全守护)
  private leg1FailedAttempts = 0;           // 本回合FAK失败次数 (限制重试)
  private emaVolAnnual = 0;                 // EMA平滑的年化波动率 (BSM用)
  private emaVolWarmup = 0;                  // EMA warm-up计数: 前3次用均值种子, 之后切EMA

  // ── 运行时可调参数 (覆盖 const) ──
  private rtDumpConfirmCycles = DUMP_CONFIRM_CYCLES;
  private rtEntryWindowS = ENTRY_WINDOW_S;
  private rtMinEntrySecs = MIN_ENTRY_SECS;
  private rtMaxEntryAsk = MAX_ENTRY_ASK;
  private rtDualSideMaxAsk = DUAL_SIDE_MAX_ASK;
  private rtKellyFraction = KELLY_FRACTION;

  // Market state layer
  private marketState = new RoundMarketState();

  private resetRoundRejectStats(): void {
    this.roundMomentumRejects = 0;
    this.roundEntryAskRejects = 0;
    this.roundRejectReasonCounts.clear();
  }

  private trackRoundRejectReason(reason: string): void {
    const normalized = reason.trim();
    if (!normalized) return;
    this.roundRejectReasonCounts.set(normalized, (this.roundRejectReasonCounts.get(normalized) || 0) + 1);
  }

  private getTopRoundRejectReasons(limit = 5): Array<{ detail: string; count: number }> {
    return Array.from(this.roundRejectReasonCounts.entries())
      .sort((left, right) => right[1] - left[1])
      .slice(0, limit)
      .map(([detail, count]) => ({ detail, count }));
  }

  private writeRoundAudit(event: string, details: Record<string, unknown> = {}): void {
    writeDecisionAudit(event, {
      tradingMode: this.tradingMode,
      paperSessionMode: this.paperSessionMode,
      market: this.currentMarket,
      conditionId: this.currentConditionId,
      secondsLeft: this.secondsLeft,
      status: this.status,
      hedgeState: this.hedgeState,
      activeStrategyMode: this.activeStrategyMode,
      trendBias: this.currentTrendBias,
      leg1Dir: this.leg1Dir,
      leg1Price: this.leg1Price,
      leg1FillPrice: this.leg1FillPrice,
      leg1Shares: this.leg1Shares,
      totalCost: this.totalCost,
      balance: this.balance,
      totalProfit: this.totalProfit,
      dumpDetected: this.dumpDetected,
      rejectCounts: {
        momentum: this.roundMomentumRejects,
        entryAsk: this.roundEntryAskRejects,
      },
      topRejectReasons: this.getTopRoundRejectReasons(),
      ...details,
    });
  }

  private logRoundRejectSummary(reason: string): void {
    const parts: string[] = [];
    if (this.roundMomentumRejects > 0) parts.push(`momentum=${this.roundMomentumRejects}`);
    if (this.roundEntryAskRejects > 0) parts.push(`entryAsk=${this.roundEntryAskRejects}`);
    const topReasons = Array.from(this.roundRejectReasonCounts.entries())
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5);
    if (parts.length > 0) {
      logger.info(`HEDGE15M ROUND SUMMARY: ${reason}, rejects(${parts.join(", ")})`);
      for (const [detail, count] of topReasons) {
        logger.info(`HEDGE15M REJECT DETAIL: ${count}x ${detail}`);
      }
    } else {
      logger.info(`HEDGE15M ROUND SUMMARY: ${reason}, no dump detected`);
    }
    this.writeRoundAudit("round-no-entry", {
      reason,
      summary: parts.length > 0 ? parts.join(", ") : "no_dump_detected",
      topRejectReasons: topReasons.map(([detail, count]) => ({ detail, count })),
    });
  }

  private onLeg1Opened(): void {
    this.leg1AttemptedThisRound = true;
  }

  private isActiveRun(runId: number): boolean {
    return this.running && this.loopRunId === runId;
  }

  private getRoundDirectionalBias(): "up" | "down" | "flat" {
    const score = this.dirAlignedScore - this.dirContraScore;
    return getDirectionalBiasSignal({
      roundStartPrice: this.roundStartBtcPrice,
      btcNow: getBtcPrice(),
      shortMomentum: getRecentMomentum(MOMENTUM_WINDOW_SEC),
      trendMomentum: getRecentMomentum(TREND_WINDOW_SEC),
      directionalMovePct: DIRECTIONAL_MOVE_PCT,
      momentumContraPct: MOMENTUM_CONTRA_PCT,
      trendContraPct: TREND_CONTRA_PCT,
      secsLeft: this.secondsLeft,
      signalScore: score,
    });
  }

  private getEffectiveMaxAsk(): number {
    return this.rtDualSideMaxAsk;
  }

  /**
   * 加权 8 源信号对齐度评分.
   * 权重按信号对 15 分钟短周期的预测价值分配:
   *   Taker Flow 1.5 | Depth 1.5 | Large Orders 1.2 | Vol Spike 1.0
   *   Liquidation 1.0 | BTC 180s Mom 1.0 | Funding Rate 0.8 | Flow Trend 0.5
   * Funding Rate extreme(>=0.01) 权重 ×2; 方向取反转逻辑(long_pay→看跌).
   */
  private computeSignalAlignment(dir: string): void {
    const targetDir = dir === "up" ? "buy" : "sell";
    const contraDir = dir === "up" ? "sell" : "buy";
    let aligned = 0;
    let contra = 0;

    // 1. Taker Flow (w=1.5)
    const flow = getTakerFlowRatio();
    if (flow.direction === targetDir) aligned += 1.5;
    else if (flow.direction === contraDir) contra += 1.5;

    // 2. Volume Spike (w=1.0)
    const vol = getVolumeSpikeInfo();
    if (vol.isSpike) {
      if (vol.direction === targetDir) aligned += 1.0;
      else if (vol.direction === contraDir) contra += 1.0;
    }

    // 3. Large Orders (w=1.2)
    const large = getLargeOrderInfo();
    if (large.direction === targetDir) aligned += 1.2;
    else if (large.direction === contraDir) contra += 1.2;

    // 4. Depth Imbalance (w=1.5)
    const depth = getDepthImbalance();
    if (depth.fresh) {
      if (depth.direction === targetDir) aligned += 1.5;
      else if (depth.direction === contraDir) contra += 1.5;
    }

    // 5. Liquidation (w=1.0)
    const liq = getLiquidationInfo();
    if (liq.intensity !== "low") {
      if (liq.direction === targetDir) aligned += 1.0;
      else if (liq.direction === contraDir) contra += 1.0;
    }

    // 6. Taker Flow Trend (w=0.5, 与 #1 高度相关故降权)
    const flowTrend = getTakerFlowTrend();
    if (flowTrend === "strengthening" && flow.direction === targetDir) aligned += 0.5;
    else if (flowTrend === "strengthening" && flow.direction === contraDir) contra += 0.5;

    // 7. BTC 180s Momentum (w=1.0)
    const mom180 = getRecentMomentum(180);
    if ((dir === "up" && mom180 > 0.001) || (dir === "down" && mom180 < -0.001)) aligned += 1.0;
    else if ((dir === "up" && mom180 < -0.001) || (dir === "down" && mom180 > 0.001)) contra += 1.0;

    // 8. Funding Rate (w=0.8, extreme ×2; 反转逻辑: long_pay=看涨过热→利空, short_pay→利多)
    const funding = getFundingRateInfo();
    const fundingW = funding.extreme ? 1.6 : 0.8;
    if (funding.direction === "long_pay") {
      if (dir === "down") aligned += fundingW; else if (dir === "up") contra += fundingW;
    } else if (funding.direction === "short_pay") {
      if (dir === "up") aligned += fundingW; else if (dir === "down") contra += fundingW;
    }

    this.dirAlignedScore = aligned;
    this.dirContraScore = contra;
  }

  private getRolling4hPnL(): number {
    const cutoff = Date.now() - 4 * 3600_000;
    return this.rollingPnL.reduce((sum, item) => item.ts >= cutoff ? sum + item.profit : sum, 0);
  }

  private recordRollingPnL(profit: number): void {
    this.rollingPnL.push({ ts: Date.now(), profit });
    // 只在添加时清理过期条目
    const cutoff = Date.now() - 4 * 3600_000;
    this.rollingPnL = this.rollingPnL.filter((item) => item.ts >= cutoff);
  }

  // ── Black-Scholes 数字期权公式 ──
  // Abramowitz & Stegun 26.2.17 近似, 误差 < 7.5e-8
  private normalCdf(x: number): number {
    if (x < -6) return 0;
    if (x > 6) return 1;
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const pd = 0.3989422803 * Math.exp(-0.5 * x * x);
    const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    const cdf = 1 - pd * poly;
    return x >= 0 ? cdf : 1 - cdf;
  }

  /**
   * BSM数字期权: P(BTC结算时 > 开盘价) = N(d), d = ln(S/K) / (σ√T)
   * - S = 当前BTC, K = 本回合开盘BTC, T = 剩余时间(年), σ = 年化波动率
   * - σ由 getRecentVolatility(300) 的Parkinson估计量换算
   * - fairRaw 用于入场过滤; fairKelly 限幅到 [0.30, 0.70] 仅用于Kelly sizing
   */
  private getBsSnapshot(dir: string, secsLeft: number, readonly_ = false): { fairRaw: number; fairKelly: number; dAbs: number; lnMoneyness: number } {
    const K = this.roundStartBtcPrice;
    const S = getBtcPrice();
    if (K <= 0 || S <= 0 || secsLeft < 30) {
      return { fairRaw: KELLY_WIN_RATE, fairKelly: KELLY_WIN_RATE, dAbs: 0, lnMoneyness: 0 };
    }
    // Parkinson estimator: σ_5min = range / (2*sqrt(2*ln2)) ≈ range / 2.355
    // σ_annual = σ_5min * sqrt(31557600/300) = σ_5min * 324.5
    // EMA平滑(α=0.3): 减少短窗口噪声导致BSM公允概率剧烈波动
    const vol5m = getRecentVolatility(300);
    const rawSigAnnual = Math.max(0.25, Math.min(1.50, vol5m * 324.5 / 2.355));
    // readonly模式(面板轮询): 只读EMA, 不更新 — 防止250ms面板轮询污染EMA采样率
    let sigAnnual: number;
    if (readonly_) {
      sigAnnual = this.emaVolAnnual > 0 ? this.emaVolAnnual : rawSigAnnual;
    } else {
      // Warm-up: 前3次采样用累积均值做种子, 避免首笔尖刺直接成为EMA基准
      this.emaVolWarmup++;
      if (this.emaVolWarmup <= 3) {
        this.emaVolAnnual = this.emaVolAnnual <= 0
          ? rawSigAnnual
          : (this.emaVolAnnual * (this.emaVolWarmup - 1) + rawSigAnnual) / this.emaVolWarmup;
      } else {
        this.emaVolAnnual = 0.3 * rawSigAnnual + 0.7 * this.emaVolAnnual;
      }
      sigAnnual = this.emaVolAnnual;
    }
    const tYears = secsLeft / (365.25 * 24 * 3600);
    const sigSqrtT = sigAnnual * Math.sqrt(tYears);
    if (sigSqrtT <= 0) {
      return { fairRaw: KELLY_WIN_RATE, fairKelly: KELLY_WIN_RATE, dAbs: 0, lnMoneyness: 0 };
    }
    const lnSK = Math.log(S / K);            // ln(S/K): BTC偏离幅度 (绝对)
    const d = lnSK / sigSqrtT;               // ln(S/K) / σ√T
    const pUp = this.normalCdf(d);            // P(S_T > K): S>K时d>0→N(d)>0.5, UP更可能
    const fairRaw = dir === "up" ? pUp : (1 - pUp);
    return {
      fairRaw,
      fairKelly: Math.max(0.30, Math.min(0.70, fairRaw)),
      dAbs: Math.abs(d),
      lnMoneyness: Math.abs(lnSK),           // |ln(S/K)|: 波动率无关的BTC偏离度
    };
  }

  private evaluateBsEntry(
    dir: string,
    quotedPrice: number,
    secsLeft: number,
    mode: "reactive" | "dual-side",
    readonly_ = false,
  ): {
    allowed: boolean;
    fairRaw: number;
    fairKelly: number;
    dAbs: number;
    effectiveCost: number;
    effectiveEdge: number;
    reason: string;
  } {
    const { fairRaw, fairKelly, dAbs, lnMoneyness } = this.getBsSnapshot(dir, secsLeft, readonly_);
    const takerFeeBuffer = mode === "reactive" ? quotedPrice * TAKER_FEE : 0;
    const slippageBuffer = mode === "reactive" ? 0.005 : 0;
    const effectiveCost = quotedPrice + takerFeeBuffer + slippageBuffer;
    const effectiveEdge = fairRaw - effectiveCost;

    let dynamicMinEdge = MIN_NET_EDGE;
    if (secsLeft < 300) {
      dynamicMinEdge = Math.max(0.01, MIN_NET_EDGE - 0.03); 
    } else if (secsLeft > 600) {
      dynamicMinEdge = MIN_NET_EDGE + 0.02; 
    }
    if (effectiveEdge < dynamicMinEdge) {
      return { allowed: false, fairRaw, fairKelly, dAbs, effectiveCost, effectiveEdge, reason: `net-edge<${(dynamicMinEdge*100).toFixed(0)}%` };
    }
    // Doji检测: 用 |ln(S/K)| (BTC偏离幅度) 而非 |d| (σ√T归一化后的值)
    // 15分钟期权σ√T≈0.003, BTC偏$15→|d|=0.06但|ln(S/K)|=0.00015
    // 旧阈值|d|<0.05误杀: BTC偏$10就触发doji (砸盘场景BTC可能确实没大动)
    // 新阈值: |ln(S/K)|<0.0001 (BTC偏<0.01%≈$10) 才是真doji
    if (lnMoneyness < 0.0001 && effectiveEdge < 0.18) {
      return { allowed: false, fairRaw, fairKelly, dAbs, effectiveCost, effectiveEdge, reason: "doji-net-edge<18%" };
    }
    // near-doji: BTC偏<0.03% (≈$30) — 方向不明确, 要求更高edge
    if (lnMoneyness < 0.0003 && effectiveEdge < 0.12) {
      return { allowed: false, fairRaw, fairKelly, dAbs, effectiveCost, effectiveEdge, reason: "near-doji-net-edge<12%" };
    }

    return { allowed: true, fairRaw, fairKelly, dAbs, effectiveCost, effectiveEdge, reason: "ok" };
  }

  private getNetEdgeTier(edge: number): { label: "small" | "normal" | "strong"; multiplier: number } {
    let multiplier: number;
    let label: "small" | "normal" | "strong";
    if (edge < MID_NET_EDGE) {
      label = "small";
      const t = Math.max(0, (edge - MIN_NET_EDGE)) / (MID_NET_EDGE - MIN_NET_EDGE);
      multiplier = 0.55 + t * 0.45;
    } else if (edge < HIGH_NET_EDGE) {
      label = "normal";
      const t = (edge - MID_NET_EDGE) / (HIGH_NET_EDGE - MID_NET_EDGE);
      multiplier = 1.00 + t * 0.22;
    } else {
      label = "strong";
      const t = Math.min(1, (edge - HIGH_NET_EDGE) / 0.15);
      multiplier = 1.22 + t * 0.18;
    }
    return { label, multiplier };
  }

  private logBsReject(
    source: string,
    dir: string,
    quotedPrice: number,
    result: {
      fairRaw: number;
      dAbs: number;
      effectiveCost: number;
      effectiveEdge: number;
      reason: string;
    },
  ): void {
    const rejectKey = `${source}:${dir}:${quotedPrice.toFixed(2)}:${result.reason}`;
    const now = Date.now();
    const lastLogged = this.bsmRejectThrottle.get(rejectKey) ?? 0;
    this.lastBsmRejectReason = `${source}:${dir} ${result.reason} edge=${(result.effectiveEdge * 100).toFixed(1)}%`;
    if (now - lastLogged < 30_000) return; // 同一key每30s只打一条
    this.bsmRejectThrottle.set(rejectKey, now);
    logger.warn(
      `Leg1 BSM REJECT: ${dir} fair=${result.fairRaw.toFixed(3)} price=${quotedPrice.toFixed(2)} effCost=${result.effectiveCost.toFixed(3)} edge=${(result.effectiveEdge * 100).toFixed(1)}% |d|=${result.dAbs.toFixed(3)} reason=${result.reason}`,
    );
  }

  private getMaxEntryAsk(): number {
    return this.getEffectiveMaxAsk();
  }

  /** 方向信号不提升入场上限: 低价才是真正的edge */
  private getDynamicMaxEntryAsk(_entryDir?: string): number {
    return this.getMaxEntryAsk();
  }

  private getRoundPhase(): string {
    if (!this.running) return "idle";
    if (this.hedgeState === "off") return "booting";
    if (this.hedgeState === "leg1_pending") return "leg1_pending";
    if (this.hedgeState === "leg1_filled") return "leg1_filled";
    if (this.hedgeState === "watching") {
      if (this.secondsLeft < this.rtMinEntrySecs) return "waiting_next_round";
      return "watching";
    }
    if (this.hedgeState === "done") {
      if (this.totalCost > 0) return "settling";
      return "waiting_next_round";
    }
    return this.hedgeState;
  }

  private getRoundDecision(): string {
    if (!this.running) return "已停止";
    if (this.hedgeState === "off") return this.status || "等待首轮市场数据";
    if (this.status.startsWith("跳过:")) return this.status;
    if (this.status === "窗口到期,无砸盘") return this.status;
    if (this.hedgeState === "leg1_pending") return "Leg1 下单中";
    if (this.hedgeState === "leg1_filled") return "已成交Leg1, 持有到结算";
    if (this.hedgeState === "watching") return this.secondsLeft >= this.rtMinEntrySecs ? "本轮仍在观察窗口" : "本轮入场窗已关闭";
    return this.status || "等待中";
  }

  getState(): Hedge15mState {
    const dp = getDynamicParams();
    const latency = getLatencySnapshot();
    const exec = getExecutionTelemetry();
    const traderDiag = this.trader ? this.trader.getDiagnostics() : getDefaultTraderDiagnostics();
    const secondsLeft = Math.max(0, Math.min(ROUND_DURATION, this.secondsLeft));
    const hasRoundClock = secondsLeft > 0;
    const roundElapsed = hasRoundClock ? Math.max(0, Math.min(ROUND_DURATION, ROUND_DURATION - secondsLeft)) : 0;
    const roundProgressPct = hasRoundClock && ROUND_DURATION > 0 ? (roundElapsed / ROUND_DURATION) * 100 : 0;
    const entryWindowLeft = Math.max(0, secondsLeft - this.rtMinEntrySecs);
    const upBs = this.upAsk > 0 ? this.evaluateBsEntry("up", this.upAsk, secondsLeft, "reactive", true) : null;
    const downBs = this.downAsk > 0 ? this.evaluateBsEntry("down", this.downAsk, secondsLeft, "reactive", true) : null;
    const upTierObj = upBs ? this.getNetEdgeTier(upBs.effectiveEdge) : null;
    const downTierObj = downBs ? this.getNetEdgeTier(downBs.effectiveEdge) : null;
    return {
      botRunning: this.running,
      tradingMode: this.tradingMode,
      paperSessionMode: this.paperSessionMode,
      status: this.status,
      roundPhase: this.getRoundPhase(),
      roundDecision: this.getRoundDecision(),
      btcPrice: this.servicesStarted ? getBtcPrice() : 0,
      secondsLeft,
      roundElapsed,
      roundProgressPct,
      entryWindowLeft,
      canOpenNewPosition: this.running && this.hedgeState === "watching" && secondsLeft >= this.rtMinEntrySecs,
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
      history: this.history.slice(-100),
      hedgeState: this.hedgeState,
      hedgeLeg1Dir: this.leg1Dir,
      hedgeLeg1Price: this.leg1Price,
      hedgeTotalCost: this.totalCost,
      dumpDetected: this.dumpDetected,
      maxEntryAsk: this.getMaxEntryAsk(),
      activeStrategyMode: this.activeStrategyMode,
      trendBias: this.currentTrendBias,
      sessionROI: this.initialBankroll > 0 ? (this.totalProfit / this.initialBankroll) * 100 : 0,
      rolling4hPnL: this.getRolling4hPnL(),
      effectiveMaxAsk: this.getEffectiveMaxAsk(),
      askSum: this.upAsk > 0 && this.downAsk > 0 ? this.upAsk + this.downAsk : 0,
      btcVolatility5m: getRecentVolatility(300),
      dumpConfirmCount: this.dumpConfirmCount,
      dirAlignedScore: this.dirAlignedScore,
      dirContraScore: this.dirContraScore,
      roundMomentumRejects: this.roundMomentumRejects,
      roundEntryAskRejects: this.roundEntryAskRejects,
      preOrderUpPrice: this.preOrderUpPrice,
      preOrderDownPrice: this.preOrderDownPrice,
      leg1Maker: this.leg1MakerFill,
      leg1WinRate: this.leg1WinRate,
      leg1BsFair: this.leg1BsFair,
      leg1EffectiveCost: this.leg1EffectiveCost,
      leg1EffectiveEdge: this.leg1EffectiveEdge,
      leg1EdgeTier: this.leg1EdgeTier,
      upBsFair: upBs?.fairRaw ?? 0,
      downBsFair: downBs?.fairRaw ?? 0,
      upEffectiveCost: upBs?.effectiveCost ?? 0,
      downEffectiveCost: downBs?.effectiveCost ?? 0,
      upNetEdge: upBs?.effectiveEdge ?? 0,
      downNetEdge: downBs?.effectiveEdge ?? 0,
      upEdgeTier: upTierObj?.label ?? "--",
      downEdgeTier: downTierObj?.label ?? "--",
      upEdgeMultiplier: upTierObj?.multiplier ?? 0,
      downEdgeMultiplier: downTierObj?.multiplier ?? 0,
      leg1EntrySource: this.leg1EntrySource,
      lastBsmRejectReason: this.lastBsmRejectReason,
      // L: Taker Flow
      ...(() => { const tf = getTakerFlowRatio(); return {
        takerFlowRatio: tf.ratio,
        takerFlowDirection: tf.direction,
        takerFlowConfidence: tf.confidence,
        takerFlowTrend: getTakerFlowTrend(),
        takerFlowTrades: tf.trades,
      }; })(),
      // M: Volume Spike
      ...(() => { const vs = getVolumeSpikeInfo(); return {
        volSpikeRatio: vs.spikeRatio,
        volSpikeIsSpike: vs.isSpike,
        volSpikeDirection: vs.direction,
      }; })(),
      // N: Large Order
      ...(() => { const lo = getLargeOrderInfo(); return {
        largeBuyCount: lo.buyCount,
        largeSellCount: lo.sellCount,
        largeBuyVol: lo.buyVol,
        largeSellVol: lo.sellVol,
        largeDirection: lo.direction,
        largeRecent60s: lo.recentCount60s,
      }; })(),
      // O: Depth Imbalance
      ...(() => { const di = getDepthImbalance(); return {
        depthRatio: di.ratio,
        depthDirection: di.direction,
        depthFresh: di.fresh,
      }; })(),
      // P: Liquidation
      ...(() => { const li = getLiquidationInfo(); return {
        liqBuyVol: li.buyVol,
        liqSellVol: li.sellVol,
        liqDirection: li.direction,
        liqIntensity: li.intensity,
      }; })(),
      // Q: Funding Rate
      ...(() => { const fr = getFundingRateInfo(); return {
        fundingRate: fr.rate,
        fundingDirection: fr.direction,
        fundingExtreme: fr.extreme,
      }; })(),
      // 运行时参数 (UI显示)
      rtDumpConfirmCycles: this.rtDumpConfirmCycles,
      rtEntryWindowS: this.rtEntryWindowS,
      rtMinEntrySecs: this.rtMinEntrySecs,
      rtMaxEntryAsk: this.rtMaxEntryAsk,
      rtDualSideMaxAsk: this.rtDualSideMaxAsk,
      rtKellyFraction: this.rtKellyFraction,
      latencyP50: dp.p50,
      latencyP90: dp.p90,
      latencyNetworkSource: latency.networkSource,
      latencyPingP50: latency.pingP50,
      latencyPingP90: latency.pingP90,
      latencyPingCount: latency.pingCount,
      latencyPingLastMs: latency.pingLastMs,
      latencyPingLastAt: latency.pingLastAt,
      latencyHttpP50: latency.httpP50,
      latencyHttpP90: latency.httpP90,
      latencyHttpCount: latency.httpCount,
      latencyHttpLastMs: latency.httpLastMs,
      latencyHttpLastAt: latency.httpLastAt,
      latencyCacheP50: latency.cacheP50,
      latencyCacheP90: latency.cacheP90,
      latencyCacheCount: latency.cacheCount,
      latencyCacheLastMs: latency.cacheLastMs,
      latencyCacheLastAt: latency.cacheLastAt,
      diagnostics: {
        ...traderDiag,
        execSignalToSubmitP50: exec.signalToSubmit.p50,
        execSubmitToAckP50: exec.submitToAck.p50,
        execAckToFillP50: exec.ackToFill.p50,
        execSignalToFillP50: exec.signalToFill.p50,
        execSignalToFillP90: exec.signalToFill.p90,
      },
    };
  }

  // ── Persistence ──
  private saveHistory(): void {
    try {
      const dir = path.dirname(this.historyFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const payload = JSON.stringify({
        history: this.history,
        wins: this.wins,
        losses: this.losses,
        skips: this.skips,
        totalProfit: this.totalProfit,
        totalRounds: this.totalRounds,
      }, null, 2);
      const tmp = this.historyFile + ".tmp";
      fs.writeFileSync(tmp, payload, "utf8");
      fs.renameSync(tmp, this.historyFile);
      this.savePaperRuntimeSnapshot();
    } catch (e: any) {
      logger.warn(`Hedge15m history save failed: ${e.message}`);
    }
  }

  private savePaperRuntimeSnapshot(): void {
    if (this.tradingMode !== "paper" || this.paperSessionMode !== "persistent") return;
    try {
      // 持久化前清理过期的滚动P/L条目
      const cutoff = Date.now() - 4 * 3600_000;
      this.rollingPnL = this.rollingPnL.filter((item) => item.ts >= cutoff);
      savePaperRuntimeState({
        balance: this.balance,
        initialBankroll: this.initialBankroll,
        sessionProfit: this.sessionProfit,
        rollingPnL: this.rollingPnL,
        updatedAt: new Date().toISOString(),
        openPosition: this.hedgeState === "leg1_filled" && this.leg1Shares > 0 ? {
          conditionId: this.currentConditionId,
          leg1Dir: this.leg1Dir,
          leg1Token: this.leg1Token,
          leg1Shares: this.leg1Shares,
          leg1FillPrice: this.leg1FillPrice,
          leg1OrderId: this.leg1OrderId,
          totalCost: this.totalCost,
          roundStartBtcPrice: this.roundStartBtcPrice,
          entrySource: this.leg1EntrySource,
          filledAt: this.leg1FilledAt,
        } : null,
      });
    } catch (e: any) {
      logger.warn(`Paper runtime save failed: ${e.message}`);
    }
  }

  private loadHistory(): void {
    try {
      if (!fs.existsSync(this.historyFile)) return;
      const d = JSON.parse(fs.readFileSync(this.historyFile, "utf8"));
      if (Array.isArray(d.history)) this.history = d.history.slice(-200);
      if (typeof d.wins === "number") this.wins = d.wins;
      if (typeof d.losses === "number") this.losses = d.losses;
      if (typeof d.skips === "number") this.skips = d.skips;
      if (typeof d.totalProfit === "number") this.totalProfit = d.totalProfit;
      if (typeof d.totalRounds === "number") this.totalRounds = d.totalRounds;
      logger.info(`Hedge15m history loaded: ${this.history.length} entries, P/L $${this.totalProfit.toFixed(2)}`);
    } catch (e: any) {
      logger.warn(`Hedge15m history load failed: ${e.message}`);
    }
  }

  // ── Lifecycle ──

  getHistoryFilePath(): string {
    return this.historyFile;
  }

  async start(options: Hedge15mStartOptions = {}): Promise<void> {
    if (this.running) throw new Error("Hedge15m already running");
    this.tradingMode = options.mode || "live";
    this.paperSessionMode = options.paperSessionMode === "persistent" ? "persistent" : "session";
    this.historyFile = this.tradingMode === "paper" ? PAPER_HISTORY_FILE : HISTORY_FILE;

    // ── 应用运行时参数 ──
    this.rtDumpConfirmCycles = options.dumpConfirmCycles ?? DUMP_CONFIRM_CYCLES;
    const ewPreset = options.entryWindowPreset ?? "medium";
    if (ewPreset === "short") { this.rtEntryWindowS = 360; this.rtMinEntrySecs = 360; }
    else if (ewPreset === "long") { this.rtEntryWindowS = 660; this.rtMinEntrySecs = 180; }
    else { this.rtEntryWindowS = ENTRY_WINDOW_S; this.rtMinEntrySecs = MIN_ENTRY_SECS; }
    this.rtMaxEntryAsk = options.maxEntryAsk ?? MAX_ENTRY_ASK;
    this.rtDualSideMaxAsk = options.dualSideMaxAsk ?? DUAL_SIDE_MAX_ASK;
    this.rtKellyFraction = options.kellyFraction ?? KELLY_FRACTION;
    logger.info(`RT params: dumpConfirm=${this.rtDumpConfirmCycles} window=${ewPreset}(${this.rtEntryWindowS}s) maxAsk=$${this.rtMaxEntryAsk} dualAsk=$${this.rtDualSideMaxAsk} kelly=${this.rtKellyFraction}`);

    resetExecutionTelemetry();
    this.loopRunId += 1;
    const runId = this.loopRunId;
    this.running = true;
    this.status = this.tradingMode === "paper" ? "仿真盘连接中..." : "连接中...";
    const persistedPaperState = this.tradingMode === "paper" && this.paperSessionMode === "persistent"
      ? loadPaperRuntimeState()
      : null;
    if (this.tradingMode === "paper" && this.paperSessionMode === "session") {
      clearPaperRuntimeState();
    }
    try {
      this.trader = new Trader();
      const restoredPaperBalance = persistedPaperState && persistedPaperState.balance > 0
        ? persistedPaperState.balance
        : options.paperBalance;
      await this.trader.init({ mode: this.tradingMode, paperBalance: restoredPaperBalance });
    } catch (e: any) {
      this.running = false;
      this.status = "空闲";
      throw e;
    }

    // Fetch balance with retry
    try {
      let bal = 0;
      for (let attempt = 1; attempt <= 3; attempt++) {
        bal = await this.trader.getBalance();
        if (bal > 0) break;
        if (attempt < 3) await sleep(2000);
      }
      if (bal > 0) {
        this.balance = bal;
        this.initialBankroll = persistedPaperState && persistedPaperState.initialBankroll > 0
          ? persistedPaperState.initialBankroll
          : bal;
      } else {
        this.balance = 50;
        this.initialBankroll = persistedPaperState && persistedPaperState.initialBankroll > 0
          ? persistedPaperState.initialBankroll
          : 50;
        logger.warn("Balance query returned 0, using conservative $50 estimate to limit risk");
      }
    } catch (e: any) {
      this.balance = 50;
      this.initialBankroll = persistedPaperState && persistedPaperState.initialBankroll > 0
        ? persistedPaperState.initialBankroll
        : 50;
      logger.warn(`Balance error: ${e.message}, using conservative $50 estimate`);
    }

    if (!this.servicesStarted) {
      startLatencyMonitor(); // 优先启动, 在连接建立期间积累延迟样本
      await startPriceFeed();
      this.servicesStarted = true;
    }

    this.status = "就绪";
    this.totalRounds = 0;
    this.wins = 0;
    this.losses = 0;
    this.skips = 0;
    this.totalProfit = 0;
    this.sessionProfit = persistedPaperState && this.tradingMode === "paper" && this.paperSessionMode === "persistent"
      ? persistedPaperState.sessionProfit
      : 0;
    this.rollingPnL = persistedPaperState && this.tradingMode === "paper" && this.paperSessionMode === "persistent"
      ? persistedPaperState.rollingPnL.filter((item) => item.ts >= Date.now() - 4 * 3600_000)
      : [];
    this.history = [];
    this.loadHistory();

    // ── 崩溃恢复: 检查上次是否有未结算的持仓 ──
    if (persistedPaperState?.openPosition && persistedPaperState.openPosition.leg1Shares > 0) {
      const pos = persistedPaperState.openPosition;
      // 检查持仓是否过期 (超过15分钟已结算)
      const ageMs = Date.now() - pos.filledAt;
      if (ageMs < 20 * 60_000) { // 20min内的持仓可能还在结算中
        logger.warn(`CRASH RECOVERY: found open position ${pos.leg1Dir.toUpperCase()} ${pos.leg1Shares}份 @${pos.leg1FillPrice.toFixed(2)} from ${Math.floor(ageMs/1000)}s ago`);
        this.hedgeState = "leg1_filled";
        this.leg1Dir = pos.leg1Dir;
        this.leg1Token = pos.leg1Token;
        this.leg1Shares = pos.leg1Shares;
        this.leg1FillPrice = pos.leg1FillPrice;
        this.leg1Price = pos.leg1FillPrice;
        this.leg1OrderId = pos.leg1OrderId;
        this.totalCost = pos.totalCost;
        this.roundStartBtcPrice = pos.roundStartBtcPrice;
        this.leg1EntrySource = pos.entrySource;
        this.leg1FilledAt = pos.filledAt;
        this.currentConditionId = pos.conditionId;
        this.leg1AttemptedThisRound = true;
        this.activeStrategyMode = "mispricing";
        this.status = `恢复持仓: ${pos.leg1Dir.toUpperCase()} @${pos.leg1FillPrice.toFixed(2)} x${pos.leg1Shares}`;
        this.writeRoundAudit("crash-recovery", { position: pos, ageMs });
      } else {
        logger.info(`CRASH RECOVERY: stale position (${Math.floor(ageMs/60000)}min old), discarding`);
      }
    }

    this.savePaperRuntimeSnapshot();

    logger.info(`Hedge15m started (${this.tradingMode}), balance=$${this.balance.toFixed(2)}`);

    this.mainLoop(runId).catch((e) => {
      if (runId !== this.loopRunId) return;
      logger.error(`Hedge15m loop fatal: ${e.message}`);
      this.status = `致命错误: ${e.message}`;
      this.running = false;
      if (this.trader) this.trader.cancelAll().catch(() => {});
    });
  }

  stop(): void {
    this.loopRunId += 1;
    this.running = false;
    this.status = "已停止";
    this.savePaperRuntimeSnapshot();
    if (this.trader) {
      this.trader.stopOrderbookLoop();
      this.trader.cancelAll().catch(() => {});
    }
    stopLatencyMonitor();
    stopPriceFeed();
    this.servicesStarted = false;
    logger.info(`Hedge15m stopped. P/L: $${this.totalProfit.toFixed(2)}`);  
  }

  private async refreshBalance(expectedMin?: number): Promise<void> {
    if (!this.trader) return;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const fresh = await this.trader.getBalance();
        if (fresh > 0) {
          // 如果提供了预期底线 (比如刚结算完但链上延迟没到账), 则取这两者的大值
          if (expectedMin && fresh < expectedMin - 0.5) {
            logger.info(`Chain balance $${fresh.toFixed(2)} lags expected $${expectedMin.toFixed(2)}, keeping optimistic balance`);
            this.balance = expectedMin;
          } else {
            this.balance = fresh;
          }
          this.savePaperRuntimeSnapshot();
          return;
        }
      } catch {}
      if (attempt < 3) await sleep(1500);
    }
    logger.warn(`refreshBalance: 3次尝试均返回0, 保留本地余额 $${this.balance.toFixed(2)}`);
  }

  private resetRoundState(): void {
    this.hedgeState = "watching";
    this.leg1Dir = "";
    this.leg1Price = 0;
    this.leg1Shares = 0;
    this.leg1Token = "";
    this.totalCost = 0;
    this.dumpDetected = "";
    this.activeStrategyMode = "none";
    this.currentTrendBias = "flat";
    this.marketState.reset();
    this.roundStartBtcPrice = 0;
    this.negRisk = false;
    this.leg1FillPrice = 0;
    this.leg1OrderId = "";
    this.leg1FilledAt = 0;
    this.leg1Estimated = false;
    this.currentDumpDrop = 0;
    this.currentDumpVelocity = "normal";
    this.leg1MakerFill = false;
    this.leg1WinRate = 0.50;
    this.leg1BsFair = 0.50;
    this.leg1EffectiveCost = 0;
    this.leg1EffectiveEdge = 0;
    this.leg1EdgeTier = "--";
    this.leg1EntrySource = "";
    this.leg1EntryTrendBias = "flat";
    this.leg1EntrySecondsLeft = 0;
    this.dumpConfirmCount = 0;
    this.lastDumpCandidateDir = "";
    this.lastEntrySkipKey = "";
    this.lastSignalSkipKey = "";
    this.lastRepricingRejectKey = "";
    this.bsmRejectThrottle.clear();
    this.lastBsmRejectReason = "";
    this.lastDumpLogKey = "";
    this.lastDumpInfoKey = "";
    this.lastDumpInfoTs = 0;
    this._volGateLoggedThisRound = false;
    this._earlyEntryLoggedThisRound = false;
    this._holdReversalLogged = false;
    this.dirAlignedScore = 0;
    this.dirContraScore = 0;
    this.preOrderUpId = "";
    this.preOrderDownId = "";
    this.preOrderUpPrice = 0;
    this.preOrderDownPrice = 0;
    this.preOrderUpShares = 0;
    this.preOrderDownShares = 0;
    this.preOrderUpToken = "";
    this.preOrderDownToken = "";
    this.preOrderLastRefresh = 0;
    this.leg1EntryInFlight = false;
    this.leg1AttemptedThisRound = false;
    this.leg1FailedAttempts = 0;
    this.trader?.pruneStaleOrderCaches();
    // 跨轮次 EMA 衰减继承: 保留上轮 30% 作为种子, 减少新轮前 3 次采样的噪声尖刺
    // 极端波动率(>1.2 或 <0.25)时完全重置, 防止异常值跨轮传播
    if (this.emaVolAnnual > 0.25 && this.emaVolAnnual < 1.20) {
      this.emaVolAnnual = this.emaVolAnnual * 0.30;
      this.emaVolWarmup = 1;
    } else {
      this.emaVolAnnual = 0;
      this.emaVolWarmup = 0;
    }
    this.resetRoundRejectStats();
  }

  // ── Main Loop ──

  private async mainLoop(runId: number): Promise<void> {
    const trader = this.trader!;
    let curCid = "";

    while (this.isActiveRun(runId)) {
      try {


        const rnd = await getCurrentRound15m();
        if (!this.isActiveRun(runId)) break;
        if (!rnd) {
          this.status = "无15分钟市场,等待中...";
          this.secondsLeft = 0;
          setRoundSecsLeft(999);
          trader.setTrackedTokens([]);
          trader.setTrackedMarkets([]);
          await sleep(8000);
          continue;
        }

        const cid = rnd.conditionId;
        const secs = rnd.secondsLeft;
        this.currentConditionId = cid;
        this.currentMarket = rnd.question;
        this.secondsLeft = secs;
        setRoundSecsLeft(secs);
        trader.setTrackedTokens([rnd.upToken, rnd.downToken]);
        trader.setTrackedMarkets([rnd.conditionId]);

        // New round
        if (cid !== curCid) {
          if (curCid && this.totalCost > 0) {
            await this.settleHedge();
          }
          curCid = cid;
          this.resetRoundState();
          this.status = "新回合开始";
          this.upAsk = 0;
          this.downAsk = 0;
          await trader.cancelAll();
          await this.refreshBalance();
          this.totalRounds++;
          this.roundStartBtcPrice = getBtcPrice();
          setRoundStartPrice(); // 同步设置 btcPrice 模块的回合基准
          this.negRisk = !!rnd.negRisk;

          // ── 资金安全守护 ──
          if (this.balance < MIN_BALANCE_TO_TRADE) {
            this.hedgeState = "done";
            this.status = `暂停: 余额$${this.balance.toFixed(2)} < $${MIN_BALANCE_TO_TRADE}`;
            this.skips++;
            logger.warn(`CAPITAL GUARD: balance $${this.balance.toFixed(2)} < $${MIN_BALANCE_TO_TRADE}, skipping round`);
            this.writeRoundAudit("round-skip-capital", { reason: "low-balance", balance: this.balance });
          } else if (this.initialBankroll > 0 && this.sessionProfit < -(this.initialBankroll * MAX_SESSION_LOSS_PCT)) {
            this.hedgeState = "done";
            this.status = `暂停: 会话亏损$${Math.abs(this.sessionProfit).toFixed(2)} > ${(MAX_SESSION_LOSS_PCT * 100).toFixed(0)}%本金`;
            this.skips++;
            logger.warn(`CAPITAL GUARD: session loss $${this.sessionProfit.toFixed(2)} exceeds ${(MAX_SESSION_LOSS_PCT * 100).toFixed(0)}% of bankroll $${this.initialBankroll.toFixed(2)}, skipping`);
            this.writeRoundAudit("round-skip-capital", { reason: "session-loss-limit", sessionProfit: this.sessionProfit, initialBankroll: this.initialBankroll });
          } else if (this.consecutiveLosses >= CONSECUTIVE_LOSS_PAUSE) {
            const cLossScale = Math.max(0.5, Math.pow(0.90, this.consecutiveLosses));
            logger.warn(`CAPITAL GUARD: ${this.consecutiveLosses} consecutive losses, Kelly ×${(cLossScale*100).toFixed(0)}% (0.90^n, floor 50%)`);
          }
          // 跳过剩余时间不足的回合 — 无法完成 dump检测 + 对冲
          else if (secs < this.rtMinEntrySecs) {
            this.hedgeState = "done";
            this.status = `跳过: 剩余${Math.floor(secs)}s < ${this.rtMinEntrySecs}s`;
            this.skips++;
            logger.info(`HEDGE15M SKIP LATE ROUND: ${Math.floor(secs)}s < ${this.rtMinEntrySecs}s minimum`);
            this.writeRoundAudit("round-skip-late", { secondsLeft: secs, minimumEntrySeconds: this.rtMinEntrySecs, negRisk: this.negRisk });
          } else {
            logger.info(`HEDGE15M ROUND: ${rnd.question}, ${Math.floor(secs)}s left, BTC=$${this.roundStartBtcPrice.toFixed(0)}`);
            this.writeRoundAudit("round-start", { question: rnd.question, secondsLeft: secs, roundStartBtcPrice: this.roundStartBtcPrice, negRisk: this.negRisk });
          }
        }

        // Sample ask prices from live orderbook (skip when round is done or settled)
        if (this.hedgeState !== "done") {
          try {
            const t0 = Date.now();
            const [upRes, dnRes] = await Promise.all([
              getHotBestPrices(trader, rnd.upToken),
              getHotBestPrices(trader, rnd.downToken),
            ]);
            if (!this.isActiveRun(runId)) break;
            const callMs = Date.now() - t0;
            void callMs;
            this.upAsk = upRes?.ask ?? 0;
            this.downAsk = dnRes?.ask ?? 0;
          } catch (e: any) {
            logger.warn(`Price sample error: ${e.message}`);
            await sleep(200);
            continue;
          }
        }

        const elapsed = ROUND_DURATION - secs;

        // ═══ State Machine ═══

        if (this.hedgeState === "watching") {
          this.status = `监控砸盘 (${Math.floor(elapsed)}/${this.rtEntryWindowS}s)`;

          if (this.upAsk > 0 && this.downAsk > 0) {
            const { dumpWindowMs, dumpBaselineMs } = getDynamicParams();
            this.marketState.push(this.upAsk, this.downAsk, dumpWindowMs + 500);

            // ── 双侧预挂单做市: 检查成交 + 刷新挂单 ──
            await this.manageDualSideOrders(trader, rnd, secs);
            if (this.hedgeState !== "watching") {
              // 预挂单成交转入 leg1_filled, 跳过dump检测
            } else {

            const dumpBaseline = this.marketState.getDumpBaseline(dumpBaselineMs);
            if (dumpBaseline) {
              const shortMomentum = getRecentMomentum(MOMENTUM_WINDOW_SEC);
              const shortMomentum30s = getRecentMomentum(30);
              const trendMomentum = getRecentMomentum(TREND_WINDOW_SEC);
              const directionalBias = this.getRoundDirectionalBias();
              this.currentTrendBias = directionalBias;

              // 低价位动态降低dump阈值: ask已经便宜时不需等大跌幅
              const lowestAsk = Math.min(this.upAsk, this.downAsk);
              const effectiveDumpThreshold = lowestAsk <= DUMP_LOW_PRICE_CUTOFF ? DUMP_THRESHOLD_LOW_PRICE : DUMP_THRESHOLD;

              // Binance 信号交叉验证: 分别计算两侧的加权信号分
              this.computeSignalAlignment("up");
              const dumpUpSigScore = this.dirAlignedScore - this.dirContraScore;
              this.computeSignalAlignment("down");
              const dumpDnSigScore = this.dirAlignedScore - this.dirContraScore;

              const mispricing = evaluateMispricingOpportunity({
                upAsk: this.upAsk,
                downAsk: this.downAsk,
                oldestUpAsk: dumpBaseline.oldest.upAsk,
                oldestDownAsk: dumpBaseline.oldest.downAsk,
                upDrop: dumpBaseline.upDrop,
                downDrop: dumpBaseline.downDrop,
                upDropMs: dumpBaseline.upDropMs,
                downDropMs: dumpBaseline.downDropMs,
                dumpThreshold: effectiveDumpThreshold,
                nearThresholdRatio: 0.75,
                shortMomentum,
                trendMomentum,
                momentumContraPct: MOMENTUM_CONTRA_PCT,
                trendContraPct: TREND_CONTRA_PCT,
                momentumWindowSec: MOMENTUM_WINDOW_SEC,
                trendWindowSec: TREND_WINDOW_SEC,
                shortMomentum30s,
                downAskAtUpPeak: dumpBaseline.downAskAtUpPeak,
                upAskAtDownPeak: dumpBaseline.upAskAtDownPeak,
                upSignalScore: dumpUpSigScore,
                downSignalScore: dumpDnSigScore,
              });

              if (mispricing.bothSidesDumping) {
                // 双侧都在dump: 融合 BSM edge 选最优方向
                const btcDir = getBtcDirection();
                const btcAlignedDir: "up" | "down" = btcDir === "up" ? "up" : "down";
                const candidatesWithEdge = mispricing.candidates.map(c => {
                  const bs = this.evaluateBsEntry(c.dir, c.askPrice, rnd.secondsLeft, "reactive", true);
                  return { ...c, bsAllowed: bs.allowed, bsEdge: bs.effectiveEdge };
                });
                const bsmPassed = candidatesWithEdge.filter(c => c.bsAllowed);
                let bestCandidate: typeof candidatesWithEdge[0] | undefined;
                if (bsmPassed.length >= 2) {
                  // 两侧都通过: edge 差距 < 2% 时用 btcDir 做 tiebreaker，否则选高 edge
                  const sorted = [...bsmPassed].sort((a, b) => b.bsEdge - a.bsEdge);
                  const edgeGap = sorted[0].bsEdge - sorted[1].bsEdge;
                  if (edgeGap < 0.02) {
                    bestCandidate = sorted.find(c => c.dir === btcAlignedDir) || sorted[0];
                  } else {
                    bestCandidate = sorted[0];
                  }
                } else if (bsmPassed.length === 1) {
                  bestCandidate = bsmPassed[0];
                } else {
                  // 都不通过 BSM: 回退到 btcDir 对齐 + 跌幅排序
                  const aligned = candidatesWithEdge.find(c => c.dir === btcAlignedDir);
                  bestCandidate = aligned || candidatesWithEdge[0];
                }
                if (bestCandidate) {
                  const maxAsk = this.getMaxEntryAsk();
                  if (bestCandidate.askPrice > 0 && bestCandidate.askPrice <= maxAsk && bestCandidate.askPrice >= MIN_ENTRY_ASK) {
                    const pickReason = bsmPassed.length >= 2 ? `edge=${(bestCandidate.bsEdge * 100).toFixed(1)}%` : bsmPassed.length === 1 ? "bsm-only" : `BTC=${btcDir} fallback`;
                    logger.info(`HEDGE15M BOTH DUMP → picking ${bestCandidate.dir.toUpperCase()} @${bestCandidate.askPrice.toFixed(2)} (${pickReason}) (UP -${(dumpBaseline.upDrop*100).toFixed(1)}%, DN -${(dumpBaseline.downDrop*100).toFixed(1)}%)`);
                    this.dumpDetected = `BOTH-DUMP → ${bestCandidate.dir.toUpperCase()} @${bestCandidate.askPrice.toFixed(2)}`;
                    this.currentDumpDrop = bestCandidate.dir === "up" ? dumpBaseline.upDrop : dumpBaseline.downDrop;
                    this.currentDumpVelocity = bestCandidate.dumpVelocity;
                    this.activeStrategyMode = "mispricing";
                    const buyToken = rnd[bestCandidate.buyTokenKey];
                    await this.buyLeg1(trader, rnd, bestCandidate.dir, bestCandidate.askPrice, buyToken);
                  } else {
                    logger.warn(`HEDGE15M SKIP: both dump candidate ${bestCandidate.dir.toUpperCase()} @${bestCandidate.askPrice.toFixed(2)} outside ask range`);
                  }
                } else {
                  // 所有候选都被过滤掉了 (momentum/repricing reject)
                  if (mispricing.momentumRejects.length > 0) {
                    const rejectDirKey = mispricing.momentumRejects.map(r => r.replace(/[\d.]+%/g, "").slice(0, 20)).join("||");
                    if (rejectDirKey !== this.lastRepricingRejectKey) {
                      this.lastRepricingRejectKey = rejectDirKey;
                      this.roundMomentumRejects += mispricing.momentumRejects.length;
                      for (const rejectMessage of mispricing.momentumRejects) {
                        logger.warn(`HEDGE15M BOTH-DUMP REJECT: ${rejectMessage}`);
                      }
                    }
                  } else {
                    logger.warn(`HEDGE15M SKIP: both sides dumping but no valid candidates (UP -${(dumpBaseline.upDrop*100).toFixed(1)}%, DN -${(dumpBaseline.downDrop*100).toFixed(1)}%)`);
                  }
                }
              } else {
                if (mispricing.cautionMessage) {
                  logger.warn(`HEDGE15M CAUTION: ${mispricing.cautionMessage} — proceeding with low ask`);
                }
                if (mispricing.momentumRejects.length > 0) {
                  // 去重: 只用方向做 key (DN dump / UP dump), 不含数值
                  const rejectDirKey = mispricing.momentumRejects.map(r => r.replace(/[\d.]+%/g, "").slice(0, 20)).join("||");
                  if (rejectDirKey !== this.lastRepricingRejectKey) {
                    this.lastRepricingRejectKey = rejectDirKey;
                    this.roundMomentumRejects += mispricing.momentumRejects.length;
                    for (const rejectMessage of mispricing.momentumRejects) {
                      logger.warn(`HEDGE15M MOMENTUM REJECT: ${rejectMessage}`);
                    }
                  }
                }

                const candidate = mispricing.candidates[0];
                if (candidate) {
                  // ── 动态价格下限: 早期数据不稳用较高 floor，末期放宽抓 EV+ ──
                  const dynamicMinAsk = elapsed < 180 ? 0.18 : elapsed < 480 ? 0.12 : MIN_ENTRY_ASK;
                  if (candidate.askPrice < dynamicMinAsk) {
                    const skipKey = `minask:${candidate.dir}:${candidate.askPrice.toFixed(2)}`;
                    if (skipKey !== this.lastEntrySkipKey) {
                      this.lastEntrySkipKey = skipKey;
                      logger.warn(`Hedge15m Leg1 skipped (dynamic floor): ask=${candidate.askPrice.toFixed(2)} < floor=${dynamicMinAsk} (elapsed=${Math.floor(elapsed)}s)`);
                    }
                  }
                  // ── 早期价格过滤: ask高于MAX_ENTRY_ASK时不尝试 ──
                  else if (candidate.askPrice > this.getMaxEntryAsk()) {
                    const skipKey = `maxask:${candidate.dir}:${candidate.askPrice.toFixed(2)}`;
                    if (skipKey !== this.lastEntrySkipKey) {
                      this.lastEntrySkipKey = skipKey;
                      logger.warn(`Hedge15m Leg1 skipped: ask=${candidate.askPrice.toFixed(2)} > MAX_ENTRY_ASK=${this.getMaxEntryAsk()}`);
                    }
                    this.roundEntryAskRejects += 1;
                  }
                  // ── #5 早期入场保护: 回合开始<30s内不允许反应式入场 ──
                  else if (elapsed < MIN_ENTRY_ELAPSED) {
                    this.trackRoundRejectReason(`early_entry: elapsed=${Math.floor(elapsed)}s < ${MIN_ENTRY_ELAPSED}s`);
                    if (!this._earlyEntryLoggedThisRound) {
                      this._earlyEntryLoggedThisRound = true;
                      logger.info(`HEDGE15M EARLY: elapsed=${Math.floor(elapsed)}s < ${MIN_ENTRY_ELAPSED}s — waiting for stable data`);
                    }
                  } else {
                    // ── #4 连续砸盘确认: 需连续 N 个cycle看到dump才触发 ──
                    if (candidate.dir === this.lastDumpCandidateDir) {
                      this.dumpConfirmCount++;
                    } else {
                      this.dumpConfirmCount = 1;
                      this.lastDumpCandidateDir = candidate.dir;
                    }
                    // 信号强一致(≥4源aligned)时跳过确认等待 — dump更可信
                    this.computeSignalAlignment(candidate.dir);
                    const signalFastTrack = this.dirAlignedScore >= 5.0 && this.dirContraScore <= 1.5;
                    if (!signalFastTrack && this.dumpConfirmCount < this.rtDumpConfirmCycles) {
                      // 还未达到确认次数且信号不够强, 继续等
                    } else {
                      // ── #2 Sum分歧度过滤: 市场不确定时拒绝入场 ──
                      const currentSum = this.upAsk + this.downAsk;
                      const candDrop = candidate.dir === "up" ? dumpBaseline.upDrop : dumpBaseline.downDrop;
                      // 大dump(≥12%)时放宽sum上限: 深度砸盘说明定价效率低, sum略高仍有edge
                      const effectiveSumMax = candDrop >= 0.12 ? SUM_DIVERGENCE_RELAXED : SUM_DIVERGENCE_MAX;
                      if (currentSum > effectiveSumMax) {
                        this.trackRoundRejectReason(`sum_high: ${currentSum.toFixed(2)} > ${effectiveSumMax}`);
                        const sumKey = currentSum.toFixed(2);
                        if (sumKey !== this.lastDumpLogKey) {
                          this.lastDumpLogKey = sumKey;
                          logger.warn(`HEDGE15M SKIP: sum=${currentSum.toFixed(2)} > ${effectiveSumMax}${candDrop >= 0.12 ? " (relaxed)" : ""} — no mispricing edge`);
                        }
                      } else {
                        // ── 入场: 价格达标 ──
                        const btcDir = getBtcDirection();
                        this.dumpDetected = candidate.dumpDetected;
                        this.currentDumpDrop = candidate.dir === "up" ? dumpBaseline.upDrop : dumpBaseline.downDrop;
                        this.currentDumpVelocity = candidate.dumpVelocity;
                        this.activeStrategyMode = "mispricing";
                        const flow = getTakerFlowRatio();
                        const depth = getDepthImbalance();
                        const liq = getLiquidationInfo();
                        const dumpInfoKey = `${candidate.dir}:${candidate.askPrice.toFixed(2)}`;
                        const now = Date.now();
                        if (dumpInfoKey !== this.lastDumpInfoKey || now - this.lastDumpInfoTs >= DUMP_LOG_THROTTLE_MS) {
                          this.lastDumpInfoKey = dumpInfoKey;
                          this.lastDumpInfoTs = now;
                          logger.info(`HEDGE15M DUMP${mispricing.candidates.length > 1 ? ` (选${candidate.dir.toUpperCase()})` : ""}${currentSum <= SUM_DIVERGENCE_MIN ? " [强方向]" : ""}: ${this.dumpDetected} (sum=${currentSum.toFixed(2)} BTC=${btcDir} flow=${flow.ratio.toFixed(2)}/${flow.direction} depth=${depth.ratio.toFixed(2)}/${depth.direction} liq=${liq.direction}/${liq.intensity})`);
                        }
                        await this.buyLeg1(
                          trader,
                          rnd,
                          candidate.dir,
                          candidate.askPrice,
                          rnd[candidate.buyTokenKey],
                        );
                      }
                    }
                  }
                } else {
                  // 无候选 → 重置连续确认
                  this.dumpConfirmCount = 0;
                  this.lastDumpCandidateDir = "";
                }
              }
            }
            } // end dual-side pre-order guard
          }

          // Window expired
          if (elapsed >= this.rtEntryWindowS && this.hedgeState === "watching") {
            // 窗口到期, 取消预挂单 (检查是否在取消前被成交)
            if (this.preOrderUpId || this.preOrderDownId) {
              const ghostFilled = await this.cancelDualSideOrders(trader);
              if (ghostFilled) {
                logger.info(`HEDGE15M window expiry: pre-order ghost fill detected, holding to settlement`);
              }
            }
            if (this.hedgeState === "watching") {
              this.hedgeState = "done";
              this.status = "窗口到期,无砸盘";
              this.skips++;
              this.logRoundRejectSummary("window expired without entry");
            }
          }
        }

        if (this.hedgeState === "leg1_filled") {
          // ── 方向性策略: 纯持有到结算, 零中途干预 ──
          // 入场价≤$0.35, 即使50%随机胜率也EV+$0.15/share
          // 卖出要付2% taker fee, 持有到结算 0 fee — 任何中途卖出都是EV-
          const entryPrice = this.leg1FillPrice > 0 ? this.leg1FillPrice : this.leg1Price;
          const secsHeld = this.leg1FilledAt > 0 ? (Date.now() - this.leg1FilledAt) / 1000 : 0;
          const sourceTag = this.leg1EntrySource === "dual-side-preorder" ? "预挂" : "砸盘";
          this.status = `纯持仓[${sourceTag}]: ${this.leg1Dir.toUpperCase()}@$${entryPrice.toFixed(2)} ${this.leg1Shares}份 EV+$${(this.leg1Shares * (1 - entryPrice)).toFixed(2)} ${secs.toFixed(0)}s → 等结算`;

          // ── 极端反转预警: BTC 大幅逆向运动时记录日志供复盘 ──
          if (!this._holdReversalLogged && this.roundStartBtcPrice > 0) {
            const btcNow = getBtcPrice();
            if (btcNow > 0) {
              const btcMove = (btcNow - this.roundStartBtcPrice) / this.roundStartBtcPrice;
              const adverse = (this.leg1Dir === "up" && btcMove < -0.005) || (this.leg1Dir === "down" && btcMove > 0.005);
              if (adverse) {
                this._holdReversalLogged = true;
                logger.warn(`HOLD REVERSAL: ${this.leg1Dir.toUpperCase()} @${entryPrice.toFixed(2)} but BTC ${btcMove > 0 ? "+" : ""}${(btcMove * 100).toFixed(2)}% (held ${secsHeld.toFixed(0)}s, ${secs.toFixed(0)}s left)`);
                this.writeRoundAudit("hold-reversal", { dir: this.leg1Dir, entryPrice, btcMove, secsHeld, secsLeft: secs });
              }
            }
          }
        }

        // 回合最后30秒: 预加载下一轮市场
        // 回合最后30秒: 预加载下一轮市场，消除下轮切换时的冷启动延迟
        if (secs <= 30 && secs > 0) {
          prefetchNextRound().catch(() => {});
        }

        // Near settlement
        if (secs <= 5 && secs > 0 && this.totalCost > 0) {
          this.status = "即将结算...";
        }

        // Round ended
        if (secs <= 0) {
          if (this.totalCost > 0) {
            await this.settleHedge();
          }
          await trader.cancelAll();
          curCid = "";
          setRoundSecsLeft(999);
          await sleep(3000);
          continue;
        }

        const { watchPollMs, idlePollMs } = getDynamicParams();
        const loopVersion = trader.getOrderbookVersion();
        const aggressiveWatchMs = this.currentTrendBias === "flat" ? watchPollMs : Math.max(25, Math.floor(watchPollMs * 0.5));
        // 持仓期大部分时间用长 idle 轮询; 最后 15s 加速以精确捕获结算时刻
        const holdPollMs = this.hedgeState === "leg1_filled" && secs <= 15 ? Math.min(500, idlePollMs) : idlePollMs;
        await trader.waitForOrderbookUpdate(
          loopVersion,
          this.hedgeState === "watching" ? aggressiveWatchMs : holdPollMs,
        );

      } catch (e: any) {
        if (!this.isActiveRun(runId)) break;
        logger.error(`Hedge15m loop error: ${e.message}`);
        await sleep(5000);
      }
    }
  }

  // ── Trading Actions ──

  private async buyLeg1(
    trader: Trader,
    rnd: Round15m,
    dir: string,
    askPrice: number,
    buyToken: string,
  ): Promise<void> {
    if (this.hedgeState !== "watching" || this.leg1EntryInFlight) return;
    if (this.leg1AttemptedThisRound) {
      logger.warn("Hedge15m Leg1 skipped: order already filled this round, avoiding duplicate exposure");
      return;
    }
    if (this.leg1FailedAttempts >= 2) {
      logger.warn(`Hedge15m Leg1 skipped: ${this.leg1FailedAttempts} failed attempts this round, giving up`);
      return;
    }

    // ── Leg1价格上限: 只接受足够低价的EV+入场, 强信号时动态提升 ──
    const maxEntryAsk = this.getDynamicMaxEntryAsk(dir);
    const directionalBias = this.getRoundDirectionalBias();

    const plan = planHedgeEntry({
      dir: dir as "up" | "down",
      askPrice,
      maxEntryAsk,
      minEntryAsk: rnd.secondsLeft > 720 ? 0.18 : rnd.secondsLeft > 420 ? 0.12 : MIN_ENTRY_ASK,
      directionalBias,
    });
    if (!plan.allowed) {
      if (plan.reason?.includes("MAX_ENTRY_ASK")) this.roundEntryAskRejects += 1;
      this.trackRoundRejectReason(`plan: ${plan.reason}`);
      // 只在首次或价格变化时打日志, 避免同价格反复刷屏
      const skipKey = `${dir}:${askPrice.toFixed(2)}`;
      if (skipKey !== this.lastEntrySkipKey) {
        this.lastEntrySkipKey = skipKey;
        logger.warn(`Hedge15m Leg1 skipped: ${plan.reason}`);
      }
      return;
    }

    // ── 统计7源信号对齐度 ──
    this.computeSignalAlignment(dir);

    // ── 低波过滤: reactive在微行情中噪声极高, 直接跳过 ──
    const reactiveVol = getRecentVolatility(300);
    if (reactiveVol < REACTIVE_MIN_VOL) {
      this.trackRoundRejectReason(`reactive-low-vol: ${(reactiveVol * 100).toFixed(3)}% < ${(REACTIVE_MIN_VOL * 100).toFixed(2)}%`);
      const skipKey = `reactive-vol:${dir}:${Math.floor(reactiveVol * 100000)}`;
      if (skipKey !== this.lastSignalSkipKey) {
        this.lastSignalSkipKey = skipKey;
        logger.info(`HEDGE15M REACTIVE SKIP: vol=${(reactiveVol * 100).toFixed(3)}% < ${(REACTIVE_MIN_VOL * 100).toFixed(2)}%`);
      }
      return;
    }

    // ── BSM数字期权动态胜率 ──
    const bsEntry = this.evaluateBsEntry(dir, askPrice, rnd.secondsLeft, "reactive");
    if (!bsEntry.allowed) {
      this.trackRoundRejectReason(`bsm: ${bsEntry.reason}`);
      this.logBsReject("reactive", dir, askPrice, bsEntry);
      return;
    }
    const bsFairRaw = bsEntry.fairRaw;
    const bsWinRate = bsEntry.fairKelly;
    const bsEdgeNet = bsEntry.effectiveEdge;
    const alignmentScore = this.dirAlignedScore - this.dirContraScore;

    let minEdgeForRegime = directionalBias === "flat" ? FLAT_MIN_NET_EDGE : NON_FLAT_MIN_NET_EDGE;
    if (this.secondsLeft < 300) {
      minEdgeForRegime = Math.max(0.02, minEdgeForRegime - 0.03);
    } else if (this.secondsLeft > 600) {
      minEdgeForRegime += 0.02;
    }
    // 信号共识微调: 每 1 分 score 降/升 0.5% 门槛，夹紧到 [3%, 12%]
    minEdgeForRegime = Math.min(0.12, Math.max(0.03, minEdgeForRegime - alignmentScore * 0.005));
    if (bsEdgeNet < minEdgeForRegime) {
      this.trackRoundRejectReason(`regime-edge: ${(bsEdgeNet * 100).toFixed(1)}% < ${(minEdgeForRegime * 100).toFixed(1)}% sig=${alignmentScore.toFixed(1)}`);
      const skipKey = `regime-edge:${dir}:${directionalBias}:${askPrice.toFixed(2)}:${Math.floor(bsEdgeNet * 1000)}`;
      if (skipKey !== this.lastSignalSkipKey) {
        this.lastSignalSkipKey = skipKey;
        logger.info(`HEDGE15M REACTIVE SKIP: ${directionalBias} edge ${(bsEdgeNet * 100).toFixed(1)}% < ${(minEdgeForRegime * 100).toFixed(1)}% sig=${alignmentScore.toFixed(1)}`);
      }
      return;
    }
    const isContraTrend = directionalBias !== "flat" && directionalBias !== dir;
    if (isContraTrend && bsEdgeNet < NON_FLAT_MIN_NET_EDGE + CONTRA_TREND_EXTRA_EDGE) {
      this.trackRoundRejectReason(`contra-trend: bias=${directionalBias} dir=${dir} edge=${(bsEdgeNet * 100).toFixed(1)}%`);
      const skipKey = `contra:${dir}:${directionalBias}:${Math.floor(bsEdgeNet * 1000)}`;
      if (skipKey !== this.lastSignalSkipKey) {
        this.lastSignalSkipKey = skipKey;
        logger.info(`HEDGE15M REACTIVE SKIP: contra-trend bias=${directionalBias} edge ${(bsEdgeNet * 100).toFixed(1)}% < ${((NON_FLAT_MIN_NET_EDGE + CONTRA_TREND_EXTRA_EDGE) * 100).toFixed(0)}%`);
      }
      return;
    }
    if (alignmentScore < REACTIVE_MIN_ALIGNMENT_SCORE && bsEdgeNet < REACTIVE_ALIGNMENT_EDGE_OVERRIDE) {
      this.trackRoundRejectReason(`alignment: score=${alignmentScore} edge=${(bsEdgeNet * 100).toFixed(1)}%`);
      const skipKey = `align:${dir}:${alignmentScore}:${Math.floor(bsEdgeNet * 1000)}`;
      if (skipKey !== this.lastSignalSkipKey) {
        this.lastSignalSkipKey = skipKey;
        logger.info(`HEDGE15M REACTIVE SKIP: weak signals score=${alignmentScore} edge=${(bsEdgeNet * 100).toFixed(1)}%`);
      }
      return;
    }

    const netEdgeTier = this.getNetEdgeTier(bsEdgeNet);

    // ── 确定入场, 取消双侧预挂单释放资金 ──
    if (this.preOrderUpId || this.preOrderDownId) {
      const ghostFilled = await this.cancelDualSideOrders(trader);
      if (ghostFilled) {
        logger.info(`HEDGE15M buyLeg1 aborted: pre-order ghost fill detected, already transitioned to leg1`);
        return;
      }
    }

    // ── Half-Kelly分层仓位 ──
    const odds = (1 - askPrice) / askPrice;
    const kellyFull = (bsWinRate * odds - (1 - bsWinRate)) / odds;
    // ── EV+分层Kelly上限: 越便宜EV越高, 允许更大仓位 ──
    const kellyCapForPrice = askPrice <= 0.15 ? 0.45 : askPrice <= 0.20 ? 0.40 : askPrice <= 0.25 ? 0.35 : askPrice <= 0.30 ? 0.32 : askPrice <= 0.35 ? 0.30 : 0.27;
    const lossScale = this.consecutiveLosses > 0 ? Math.max(0.5, Math.pow(0.90, this.consecutiveLosses)) : 1.0;
    const kellyBase = Math.max(0.08, Math.min(kellyCapForPrice, kellyFull * this.rtKellyFraction * lossScale));
    let budgetPct = kellyBase * netEdgeTier.multiplier;
    // ── 强方向连续 boost: sum 越低于 SUM_DIVERGENCE_MIN，砸盘越可信 ──
    const liveSum = this.upAsk + this.downAsk;
    if (liveSum > 0 && liveSum < SUM_DIVERGENCE_MIN) {
      const sumBoost = 1.0 + Math.max(0, (SUM_DIVERGENCE_MIN - liveSum)) * 0.75;
      budgetPct = Math.min(kellyCapForPrice, budgetPct * sumBoost);
    }
    if (directionalBias === dir) {
      budgetPct += TREND_BUDGET_BOOST;
    } else if (directionalBias === "flat") {
      budgetPct -= TREND_BUDGET_CUT;
    } else {
      budgetPct *= CONTRA_TREND_SCALE;
    }
    // ── 加权 8 源信号 Kelly 调权: aligned 高→加仓 ──
    if (this.dirAlignedScore >= 3.5) {
      budgetPct *= 1.0 + (this.dirAlignedScore - 2.5) * 0.04; // 每多 1 分加 4%
      logger.info(`KELLY SIG BOOST: aligned=${this.dirAlignedScore.toFixed(1)} contra=${this.dirContraScore.toFixed(1)} score=${alignmentScore.toFixed(1)} pct=${(budgetPct*100).toFixed(1)}% bsFair=${bsFairRaw.toFixed(3)} edgeRaw=${(bsEdgeNet*100).toFixed(1)}% tier=${netEdgeTier.label}`);
    } else {
      logger.info(`KELLY SIG: aligned=${this.dirAlignedScore.toFixed(1)} contra=${this.dirContraScore.toFixed(1)} score=${alignmentScore.toFixed(1)} pct=${(budgetPct*100).toFixed(1)}% bsFair=${bsFairRaw.toFixed(3)} edgeRaw=${(bsEdgeNet*100).toFixed(1)}%`);
    }
    budgetPct = Math.max(0.08, Math.min(kellyCapForPrice, budgetPct)); // EV+分层硬限 (低价→高上限)

    await this.openLeg1Position(
      trader,
      dir,
      askPrice,
      buyToken,
      budgetPct,
      "mispricing",
      Date.now(),
      "reactive-mispricing",
      bsEntry,
    );
  }

  private async cancelDualSideOrders(trader: Trader): Promise<boolean> {
    let ghostFillHandled = false;

    // 取消前先检查是否已被成交 (防止幽灵成交导致双重曝险)
    if (this.preOrderUpId) {
      const upCheck = await trader.getOrderFillDetails(this.preOrderUpId);
      if (upCheck.filled > 0) {
        logger.warn(`CANCEL CHECK: UP pre-order ghost filled ${upCheck.filled.toFixed(0)}份 @${upCheck.avgPrice.toFixed(2)} BEFORE cancel!`);
        // 取消另一侧
        if (this.preOrderDownId) {
          await trader.cancelOrder(this.preOrderDownId).catch(() => {});
          const dnGhost = await trader.getOrderFillDetails(this.preOrderDownId);
          if (dnGhost.filled > 0) {
            logger.warn(`CANCEL CHECK: DOWN also ghost filled ${dnGhost.filled.toFixed(0)}份, selling immediately`);
            await trader.placeFakSell(this.preOrderDownToken, dnGhost.filled, this.negRisk).catch((e: any) => {
              logger.error(`CANCEL CHECK ghost sell failed: ${e.message}`);
            });
          }
          this.preOrderDownId = "";
          this.preOrderDownPrice = 0;
          this.preOrderDownShares = 0;
        }
        // 取消UP余量
        await trader.cancelOrder(this.preOrderUpId).catch(() => {});
        const finalUp = await trader.getOrderFillDetails(this.preOrderUpId);
        const realFilled = finalUp.filled > upCheck.filled ? finalUp.filled : upCheck.filled;
        const realAvg = finalUp.filled > upCheck.filled ? finalUp.avgPrice : upCheck.avgPrice;
        await this.transitionPreOrderToLeg1(
          trader,
          "up", this.preOrderUpToken,
          realFilled, realAvg > 0 ? realAvg : this.preOrderUpPrice,
          this.preOrderUpId,
          (realAvg > 0 ? realAvg : this.preOrderUpPrice) + this.downAsk,
        );
        this.preOrderUpId = "";
        this.preOrderUpPrice = 0;
        this.preOrderUpShares = 0;
        this.preOrderLastRefresh = 0;
        await this.refreshBalance();
        return true;
      }
      await trader.cancelOrder(this.preOrderUpId).catch(() => {});
      logger.info(`DUAL SIDE: cancelled UP pre-order ${this.preOrderUpId.slice(0, 12)}`);
      this.preOrderUpId = "";
    }
    if (this.preOrderDownId) {
      const dnCheck = await trader.getOrderFillDetails(this.preOrderDownId);
      if (dnCheck.filled > 0) {
        logger.warn(`CANCEL CHECK: DOWN pre-order ghost filled ${dnCheck.filled.toFixed(0)}份 @${dnCheck.avgPrice.toFixed(2)} BEFORE cancel!`);
        await trader.cancelOrder(this.preOrderDownId).catch(() => {});
        const finalDn = await trader.getOrderFillDetails(this.preOrderDownId);
        const realFilled = finalDn.filled > dnCheck.filled ? finalDn.filled : dnCheck.filled;
        const realAvg = finalDn.filled > dnCheck.filled ? finalDn.avgPrice : dnCheck.avgPrice;
        await this.transitionPreOrderToLeg1(
          trader,
          "down", this.preOrderDownToken,
          realFilled, realAvg > 0 ? realAvg : this.preOrderDownPrice,
          this.preOrderDownId,
          (realAvg > 0 ? realAvg : this.preOrderDownPrice) + this.upAsk,
        );
        this.preOrderDownId = "";
        this.preOrderDownPrice = 0;
        this.preOrderDownShares = 0;
        this.preOrderLastRefresh = 0;
        await this.refreshBalance();
        return true;
      }
      await trader.cancelOrder(this.preOrderDownId).catch(() => {});
      logger.info(`DUAL SIDE: cancelled DOWN pre-order ${this.preOrderDownId.slice(0, 12)}`);
      this.preOrderDownId = "";
    }
    this.preOrderUpPrice = 0;
    this.preOrderDownPrice = 0;
    this.preOrderUpShares = 0;
    this.preOrderDownShares = 0;
    this.preOrderLastRefresh = 0;
    // 同步余额: paper 模式下 cancelOrder 已退款到 paperBalance
    await this.refreshBalance();
    return false;
  }

  /**
   * 双侧预挂单做市:
   * 在 watching 阶段主动挂 GTC limit buy 在 UP 和 DOWN 两侧,
   * 当市场下砸到目标价时以 maker 费率(0%)成交, 实现:
   * 1. 比反应式下单更快 (单已在book中)
   * 2. 省 2% taker fee
   * 3. 如果一侧被吃到 → 等于拿到便宜的 Leg1, 持有到结算
   */
  private async manageDualSideOrders(trader: Trader, rnd: Round15m, secs: number): Promise<void> {
    if (!DUAL_SIDE_ENABLED) return;
    if (this.hedgeState !== "watching") return;
    if (this.leg1EntryInFlight || this.leg1AttemptedThisRound) return;
    // dump已确认时不挂新预挂单, 避免 挂单→dump取消→挂单 刷屏循环
    if (this.dumpConfirmCount >= this.rtDumpConfirmCycles) return;
    if (secs < this.rtMinEntrySecs) {
      // 时间不足, 取消预挂单
      if (this.preOrderUpId || this.preOrderDownId) {
        await this.cancelDualSideOrders(trader);
      }
      return;
    }
    // consecutiveLosses 冷却已移除: 方向性策略每轮独立, 连亏不影响下轮EV

    const upAsk = this.upAsk;
    const downAsk = this.downAsk;
    if (upAsk <= 0 || downAsk <= 0) return;

    // ── 微行情过滤: BTC近5分钟波动率过低时不挂预挂单 (避免横盘抛硬币) ──
    const recentVol = getRecentVolatility(300);
    if (recentVol < DUAL_SIDE_MIN_VOL) {
      // 波动率不足 → 取消已有预挂单, 不挂新单
      if (this.preOrderUpId || this.preOrderDownId) {
        await this.cancelDualSideOrders(trader);
      }
      // 每轮只打一次日志, 避免刷屏
      if (!this._volGateLoggedThisRound) {
        this._volGateLoggedThisRound = true;
        logger.info(`DUAL SIDE: vol=${(recentVol*100).toFixed(3)}% < ${(DUAL_SIDE_MIN_VOL*100).toFixed(2)}% — 微行情, 跳过预挂单`);
      }
      return;
    }

    // ── 低流动性过滤: 仅用LIQUIDITY_FILTER_SUM, SUM_DIVERGENCE_MAX是给dump入场的不影响预挂单 ──
    const askSum = upAsk + downAsk;
    const lowLiquidity = askSum >= LIQUIDITY_FILTER_SUM;

    // ── 检查已有预挂单是否被成交 ──
    if (this.preOrderUpId) {
      const upFill = await trader.getOrderFillDetails(this.preOrderUpId);
      if (upFill.filled > 0) {
        // UP 侧被成交 → 先取消 UP 余量 + 另一侧
        if (upFill.filled < this.preOrderUpShares) {
          await trader.cancelOrder(this.preOrderUpId).catch(() => {});
          const afterCancel = await trader.getOrderFillDetails(this.preOrderUpId);
          if (afterCancel.filled > upFill.filled) {
            upFill.filled = afterCancel.filled;
            upFill.avgPrice = afterCancel.avgPrice;
          }
        }
        logger.info(`DUAL SIDE FILLED: UP ${upFill.filled.toFixed(0)}份 @${upFill.avgPrice.toFixed(2)} (limit@${this.preOrderUpPrice.toFixed(2)}) maker=true`);
        // 取消另一侧 (先cancel再查fill, 避免竞态丢份额)
        if (this.preOrderDownId) {
          await trader.cancelOrder(this.preOrderDownId).catch(() => {});
          const dnCheck = await trader.getOrderFillDetails(this.preOrderDownId);
          if (dnCheck.filled > 0) {
            logger.warn(`DUAL SIDE GHOST: DOWN also filled ${dnCheck.filled.toFixed(0)}份, selling immediately`);
            await trader.placeFakSell(this.preOrderDownToken, dnCheck.filled, this.negRisk).catch((e: any) => {
              logger.error(`DUAL SIDE GHOST sell failed: ${e.message}`);
            });
          }
          this.preOrderDownId = "";
          this.preOrderDownPrice = 0;
          this.preOrderDownShares = 0;
        }
        await this.transitionPreOrderToLeg1(
          trader,
          "up", this.preOrderUpToken,
          upFill.filled, upFill.avgPrice > 0 ? upFill.avgPrice : this.preOrderUpPrice,
          this.preOrderUpId,
          (upFill.avgPrice > 0 ? upFill.avgPrice : this.preOrderUpPrice) + downAsk,
        );
        this.preOrderUpId = "";
        this.preOrderUpPrice = 0;
        this.preOrderUpShares = 0;
        await this.refreshBalance();
        return;
      }
    }

    if (this.preOrderDownId) {
      const dnFill = await trader.getOrderFillDetails(this.preOrderDownId);
      if (dnFill.filled > 0) {
        // DOWN 侧被成交 → 先取消 DOWN 余量 + 另一侧
        if (dnFill.filled < this.preOrderDownShares) {
          await trader.cancelOrder(this.preOrderDownId).catch(() => {});
          const afterCancel = await trader.getOrderFillDetails(this.preOrderDownId);
          if (afterCancel.filled > dnFill.filled) {
            dnFill.filled = afterCancel.filled;
            dnFill.avgPrice = afterCancel.avgPrice;
          }
        }
        logger.info(`DUAL SIDE FILLED: DOWN ${dnFill.filled.toFixed(0)}份 @${dnFill.avgPrice.toFixed(2)} (limit@${this.preOrderDownPrice.toFixed(2)}) maker=true`);
        if (this.preOrderUpId) {
          await trader.cancelOrder(this.preOrderUpId).catch(() => {});
          const upCheck = await trader.getOrderFillDetails(this.preOrderUpId);
          if (upCheck.filled > 0) {
            logger.warn(`DUAL SIDE GHOST: UP also filled ${upCheck.filled.toFixed(0)}份, selling immediately`);
            await trader.placeFakSell(this.preOrderUpToken, upCheck.filled, this.negRisk).catch((e: any) => {
              logger.error(`DUAL SIDE GHOST sell failed: ${e.message}`);
            });
          }
          this.preOrderUpId = "";
          this.preOrderUpPrice = 0;
          this.preOrderUpShares = 0;
        }
        await this.transitionPreOrderToLeg1(
          trader,
          "down", this.preOrderDownToken,
          dnFill.filled, dnFill.avgPrice > 0 ? dnFill.avgPrice : this.preOrderDownPrice,
          this.preOrderDownId,
          (dnFill.avgPrice > 0 ? dnFill.avgPrice : this.preOrderDownPrice) + upAsk,
        );
        this.preOrderDownId = "";
        this.preOrderDownPrice = 0;
        this.preOrderDownShares = 0;
        await this.refreshBalance();
        return;
      }
    }

    // ── 计算理想挂单价 ──
    // 目标: 如果一侧被吃到, sum = myFillPrice + oppositeAsk ≤ DUAL_SIDE_SUM_CEILING
    // → myLimit ≤ DUAL_SIDE_SUM_CEILING - oppositeCurrentAsk
    // 波动率自适应offset: 高波→大offset(更低价成交→更高EV); 低波→小offset(靠近市价→增加成交率)
    const volOffsetScale = recentVol < 0.002 ? 0.03 : recentVol < 0.004 ? 0.04 : 0.06;
    const dynamicUpOffset = Math.max(DUAL_SIDE_OFFSET, Math.round(upAsk * volOffsetScale * 100) / 100);
    const dynamicDnOffset = Math.max(DUAL_SIDE_OFFSET, Math.round(downAsk * volOffsetScale * 100) / 100);
    const idealUpLimit = Math.min(
      DUAL_SIDE_SUM_CEILING - downAsk,
      upAsk - dynamicUpOffset,
    );
    const idealDownLimit = Math.min(
      DUAL_SIDE_SUM_CEILING - upAsk,
      downAsk - dynamicDnOffset,
    );

    // 价格精度 0.01
    // ── 预检查: 将limit价钳制到effectiveMaxAsk, 避免边界震荡导致挂→取消循环 ──
    const effectiveMaxAsk = this.getEffectiveMaxAsk();
    let upLimit = Math.min(Math.round(idealUpLimit * 100) / 100, effectiveMaxAsk);
    let downLimit = Math.min(Math.round(idealDownLimit * 100) / 100, effectiveMaxAsk);

    const upInRange = upLimit >= DUAL_SIDE_MIN_ASK;
    const downInRange = downLimit >= DUAL_SIDE_MIN_ASK;

    // ── 趋势 + 信号方向过滤: bias 明确 或 加权信号共识足够时撤销逆势侧 ──
    const trend = this.currentTrendBias;
    this.computeSignalAlignment("up");
    const upSignalScore = this.dirAlignedScore - this.dirContraScore;
    this.computeSignalAlignment("down");
    const dnSignalScore = this.dirAlignedScore - this.dirContraScore;
    // 信号共识 >= 2.5 时也视为有方向，即使 bias 仍 flat
    const signalFavorsDown = trend === "down" || (trend === "flat" && dnSignalScore >= 2.5 && upSignalScore < 1.0);
    const signalFavorsUp = trend === "up" || (trend === "flat" && upSignalScore >= 2.5 && dnSignalScore < 1.0);
    // 强反向信号阻止新挂单: score <= -2.0 说明该方向信号严重矛盾，不值得挂单承担被错误成交风险
    const upSignalBlocked = upSignalScore <= -2.0;
    const dnSignalBlocked = dnSignalScore <= -2.0;
    if ((signalFavorsDown || upSignalBlocked) && this.preOrderUpId) {
      await trader.cancelOrder(this.preOrderUpId).catch(() => {});
      this.preOrderUpId = ""; this.preOrderUpPrice = 0; this.preOrderUpShares = 0;
      logger.info(`DUAL SIDE: UP cancelled (bias=${trend} upSig=${upSignalScore.toFixed(1)} dnSig=${dnSignalScore.toFixed(1)}${upSignalBlocked ? " BLOCKED" : ""})`);
    }
    if ((signalFavorsUp || dnSignalBlocked) && this.preOrderDownId) {
      await trader.cancelOrder(this.preOrderDownId).catch(() => {});
      this.preOrderDownId = ""; this.preOrderDownPrice = 0; this.preOrderDownShares = 0;
      logger.info(`DUAL SIDE: DOWN cancelled (bias=${trend} upSig=${upSignalScore.toFixed(1)} dnSig=${dnSignalScore.toFixed(1)}${dnSignalBlocked ? " BLOCKED" : ""})`);
    }

    // ── Binance 方向过滤: BTC方向明确时撤销逆向侧预挂单 ──
    const btcDirPre = getBtcDirection();
    const btcMovePre = getBtcMovePct();
    if (btcMovePre >= DUAL_SIDE_BTC_MOVE_BLOCK) {
      if (btcDirPre === "down" && this.preOrderUpId) {
        await trader.cancelOrder(this.preOrderUpId).catch(() => {});
        this.preOrderUpId = ""; this.preOrderUpPrice = 0; this.preOrderUpShares = 0;
        logger.info(`DUAL SIDE: UP cancelled (BTC=down move=${(btcMovePre * 100).toFixed(3)}%)`);
      }
      if (btcDirPre === "up" && this.preOrderDownId) {
        await trader.cancelOrder(this.preOrderDownId).catch(() => {});
        this.preOrderDownId = ""; this.preOrderDownPrice = 0; this.preOrderDownShares = 0;
        logger.info(`DUAL SIDE: DOWN cancelled (BTC=up move=${(btcMovePre * 100).toFixed(3)}%)`);
      }
    }

    // ── 低流动性过滤: spread过大时撤销所有预挂单 ──
    if (lowLiquidity && (this.preOrderUpId || this.preOrderDownId)) {
      if (this.preOrderUpId) {
        await trader.cancelOrder(this.preOrderUpId).catch(() => {});
        this.preOrderUpId = ""; this.preOrderUpPrice = 0; this.preOrderUpShares = 0;
      }
      if (this.preOrderDownId) {
        await trader.cancelOrder(this.preOrderDownId).catch(() => {});
        this.preOrderDownId = ""; this.preOrderDownPrice = 0; this.preOrderDownShares = 0;
      }
      logger.info(`DUAL SIDE: all cancelled (askSum=${askSum.toFixed(2)} >= ${LIQUIDITY_FILTER_SUM}, low liquidity)`);
      return;
    }

    let validUpLimit = upLimit;
    let upBsEntry = upInRange ? this.evaluateBsEntry("up", validUpLimit, this.secondsLeft, "dual-side") : null;
    while (upBsEntry && !upBsEntry.allowed && validUpLimit >= DUAL_SIDE_MIN_ASK) {
      validUpLimit = Math.round((validUpLimit - 0.01) * 100) / 100;
      upBsEntry = this.evaluateBsEntry("up", validUpLimit, this.secondsLeft, "dual-side");
    }
    if (upBsEntry && !upBsEntry.allowed) upBsEntry = null;
    upLimit = validUpLimit;

    let validDownLimit = downLimit;
    let downBsEntry = downInRange ? this.evaluateBsEntry("down", validDownLimit, this.secondsLeft, "dual-side") : null;
    while (downBsEntry && !downBsEntry.allowed && validDownLimit >= DUAL_SIDE_MIN_ASK) {
      validDownLimit = Math.round((validDownLimit - 0.01) * 100) / 100;
      downBsEntry = this.evaluateBsEntry("down", validDownLimit, this.secondsLeft, "dual-side");
    }
    if (downBsEntry && !downBsEntry.allowed) downBsEntry = null;
    downLimit = validDownLimit;

    if (upBsEntry && !upBsEntry.allowed) this.logBsReject("dual-side-pre", "up", upLimit, upBsEntry);
    if (downBsEntry && !downBsEntry.allowed) this.logBsReject("dual-side-pre", "down", downLimit, downBsEntry);

    const calcPreBudgetPct = (price: number, fairKelly: number): number => {
      const preOdds = price > 0 ? (1 - price) / price : 2.0;
      const preKelly = (fairKelly * preOdds - (1 - fairKelly)) / preOdds;
      const preKellyCap = price <= 0.15 ? 0.40 : price <= 0.20 ? 0.35 : price <= 0.25 ? 0.30 : 0.25;
      const preLossScale = this.consecutiveLosses > 0 ? Math.max(0.5, Math.pow(0.90, this.consecutiveLosses)) : 1.0;
      return Math.max(0.08, Math.min(preKellyCap, preKelly * this.rtKellyFraction * preLossScale));
    };

    const now = Date.now();
    const needRefresh = now - this.preOrderLastRefresh >= DUAL_SIDE_REFRESH_MS;

    // ── 时间权重: 剩余时间越多BSM越准、成交后持仓EV越高 → 早期挂单加仓 ──
    const timeBoost = secs >= 700 ? 1.12 : secs >= 500 ? 1.0 : 0.85;

    // ── BTC + 信号方向倾斜: 综合 BTC 走势与加权信号分配仓位比例 ──
    const btcBlocksUp = btcMovePre >= DUAL_SIDE_BTC_MOVE_BLOCK && btcDirPre === "down";
    const btcBlocksDn = btcMovePre >= DUAL_SIDE_BTC_MOVE_BLOCK && btcDirPre === "up";
    // 信号驱动 tilt: 每多 1 分加权共识 → 对齐侧 +6%，逆侧 -6%
    const sigTiltUp = 1.0 + Math.max(-0.30, Math.min(0.30, upSignalScore * 0.06));
    const sigTiltDn = 1.0 + Math.max(-0.30, Math.min(0.30, dnSignalScore * 0.06));
    // 叠加 BTC 价格方向的微调
    const btcTiltUp = btcMovePre >= 0.0008 && btcDirPre === "up" ? 1.10 : btcMovePre >= 0.0008 && btcDirPre === "down" ? 0.85 : 1.0;
    const btcTiltDn = btcMovePre >= 0.0008 && btcDirPre === "down" ? 1.10 : btcMovePre >= 0.0008 && btcDirPre === "up" ? 0.85 : 1.0;
    const tiltUp = sigTiltUp * btcTiltUp;
    const tiltDn = sigTiltDn * btcTiltDn;

    // ── UP 侧挂单管理 ──
    if (!lowLiquidity && !signalFavorsDown && !upSignalBlocked && !btcBlocksUp && upInRange && !!upBsEntry?.allowed) {
      const upPreKellyCap = upLimit <= 0.15 ? 0.40 : upLimit <= 0.20 ? 0.35 : upLimit <= 0.25 ? 0.30 : 0.25;
      const upBudgetPct = Math.min(upPreKellyCap, calcPreBudgetPct(upLimit, upBsEntry.fairKelly) * this.getNetEdgeTier(upBsEntry.effectiveEdge).multiplier);
      const upShares = Math.min(MAX_SHARES, Math.floor((this.balance * upBudgetPct * 0.7 * tiltUp * timeBoost) / upLimit));
      if (upShares >= MIN_SHARES) {
        const drift = Math.abs(upLimit - this.preOrderUpPrice);
        if (!this.preOrderUpId) {
          // 首次挂单
          const oid = await trader.placeGtcBuy(rnd.upToken, upShares, upLimit, !!rnd.negRisk);
          if (oid) {
            this.preOrderUpId = oid;
            this.preOrderUpPrice = upLimit;
            this.preOrderUpShares = upShares;
            this.preOrderUpToken = rnd.upToken;
            logger.info(`DUAL SIDE: UP pre-order ${upShares}份 @${upLimit.toFixed(2)} (sum target=${(upLimit + downAsk).toFixed(2)})`);
          }
        } else if (needRefresh && drift >= DUAL_SIDE_MIN_DRIFT) {
          // 价格偏移过大, 重挂 — cancel 后检查是否在窗口内成交
          await trader.cancelOrder(this.preOrderUpId).catch(() => {});
          const reFill = await trader.getOrderFillDetails(this.preOrderUpId);
          if (reFill.filled > 0) {
            // cancel 前成交了, 不重挂, 下次循环会走 fill 路径
            logger.info(`DUAL SIDE: UP filled ${reFill.filled.toFixed(0)} during re-place cancel, will handle next tick`);
          } else {
          const oid = await trader.placeGtcBuy(rnd.upToken, upShares, upLimit, !!rnd.negRisk);
          if (oid) {
            this.preOrderUpId = oid;
            this.preOrderUpPrice = upLimit;
            this.preOrderUpShares = upShares;
            logger.info(`DUAL SIDE: UP re-placed ${upShares}份 @${upLimit.toFixed(2)} (drift=${drift.toFixed(2)})`);
          } else {
            this.preOrderUpId = "";
            this.preOrderUpPrice = 0;
            this.preOrderUpShares = 0;
          }
          }
        }
      }
    } else if (this.preOrderUpId) {
      // 价格脱离区间, 取消
      await trader.cancelOrder(this.preOrderUpId).catch(() => {});
      this.preOrderUpId = "";
      this.preOrderUpPrice = 0;
      this.preOrderUpShares = 0;
      const cancelReason = !upInRange
        ? `limit=${upLimit.toFixed(2)} out of range`
        : upBsEntry && !upBsEntry.allowed
          ? `BSM ${upBsEntry.reason}`
          : "filtered";
      logger.info(`DUAL SIDE: UP cancelled (${cancelReason})`);
    }

    // ── DOWN 侧挂单管理 ──
    if (!lowLiquidity && !signalFavorsUp && !dnSignalBlocked && !btcBlocksDn && downInRange && !!downBsEntry?.allowed) {
      const dnPreKellyCap = downLimit <= 0.15 ? 0.40 : downLimit <= 0.20 ? 0.35 : downLimit <= 0.25 ? 0.30 : 0.25;
      const dnBudgetPct = Math.min(dnPreKellyCap, calcPreBudgetPct(downLimit, downBsEntry.fairKelly) * this.getNetEdgeTier(downBsEntry.effectiveEdge).multiplier);
      const dnShares = Math.min(MAX_SHARES, Math.floor((this.balance * dnBudgetPct * 0.7 * tiltDn * timeBoost) / downLimit));
      if (dnShares >= MIN_SHARES) {
        const drift = Math.abs(downLimit - this.preOrderDownPrice);
        if (!this.preOrderDownId) {
          const oid = await trader.placeGtcBuy(rnd.downToken, dnShares, downLimit, !!rnd.negRisk);
          if (oid) {
            this.preOrderDownId = oid;
            this.preOrderDownPrice = downLimit;
            this.preOrderDownShares = dnShares;
            this.preOrderDownToken = rnd.downToken;
            logger.info(`DUAL SIDE: DOWN pre-order ${dnShares}份 @${downLimit.toFixed(2)} (sum target=${(downLimit + upAsk).toFixed(2)})`);
          }
        } else if (needRefresh && drift >= DUAL_SIDE_MIN_DRIFT) {
          await trader.cancelOrder(this.preOrderDownId).catch(() => {});
          const reFill = await trader.getOrderFillDetails(this.preOrderDownId);
          if (reFill.filled > 0) {
            logger.info(`DUAL SIDE: DOWN filled ${reFill.filled.toFixed(0)} during re-place cancel, will handle next tick`);
          } else {
          const oid = await trader.placeGtcBuy(rnd.downToken, dnShares, downLimit, !!rnd.negRisk);
          if (oid) {
            this.preOrderDownId = oid;
            this.preOrderDownPrice = downLimit;
            this.preOrderDownShares = dnShares;
            logger.info(`DUAL SIDE: DOWN re-placed ${dnShares}份 @${downLimit.toFixed(2)} (drift=${drift.toFixed(2)})`);
          } else {
            this.preOrderDownId = "";
            this.preOrderDownPrice = 0;
            this.preOrderDownShares = 0;
          }
          }
        }
      }
    } else if (this.preOrderDownId) {
      await trader.cancelOrder(this.preOrderDownId).catch(() => {});
      this.preOrderDownId = "";
      this.preOrderDownPrice = 0;
      this.preOrderDownShares = 0;
      const cancelReason = !downInRange
        ? `limit=${downLimit.toFixed(2)} out of range`
        : downBsEntry && !downBsEntry.allowed
          ? `BSM ${downBsEntry.reason}`
          : "filtered";
      logger.info(`DUAL SIDE: DOWN cancelled (${cancelReason})`);
    }

    if (needRefresh) this.preOrderLastRefresh = now;
  }

  /** 预挂单成交 → 转为 Leg1 持仓 */
  private async transitionPreOrderToLeg1(
    trader: Trader,
    dir: string,
    leg1Token: string,
    filledShares: number,
    fillPrice: number,
    orderId: string,
    observedSum = 0,
  ): Promise<void> {
    const bsEntry = this.evaluateBsEntry(dir, fillPrice, this.secondsLeft, "dual-side");
    // 动态 KEEP 阈值: 只有成交价 < bsFair (edge>0) 才持有; 否则平仓止损
    const dynamicKeepThreshold = Math.min(DUAL_SIDE_KEEP_ON_BSM_REJECT, bsEntry.fairRaw);
    if (!bsEntry.allowed && fillPrice > dynamicKeepThreshold) {
      this.logBsReject("dual-side-fill", dir, fillPrice, bsEntry);
      const unwind = await trader.placeFakSell(leg1Token, filledShares, this.negRisk).catch(() => null);
      if (unwind) {
        this.leg1AttemptedThisRound = true;
        this.activeStrategyMode = "none";
        this.status = `预挂成交后立即平仓: ${dir.toUpperCase()} @${fillPrice.toFixed(2)} x${filledShares.toFixed(0)}`;
        logger.warn(`DUAL SIDE UNWIND: ${dir.toUpperCase()} ${filledShares.toFixed(0)}份 @${fillPrice.toFixed(2)} rejected by BSM (fair=${bsEntry.fairRaw.toFixed(3)} keepMax=${dynamicKeepThreshold.toFixed(2)}), sold immediately`);
        this.writeRoundAudit("preorder-unwind", {
          dir,
          fillPrice,
          filledShares,
          orderId: orderId.slice(0, 12),
          bsFair: bsEntry.fairRaw,
          effectiveCost: bsEntry.effectiveCost,
          effectiveEdge: bsEntry.effectiveEdge,
          dynamicKeepThreshold,
          reason: bsEntry.reason,
        });
        return;
      }
      logger.error(`DUAL SIDE UNWIND FAILED: ${dir.toUpperCase()} ${filledShares.toFixed(0)}份 @${fillPrice.toFixed(2)} — keeping position to settlement`);
    } else if (!bsEntry.allowed) {
      logger.info(
        `DUAL SIDE KEEP: ${dir.toUpperCase()} @${fillPrice.toFixed(2)} BSM rejected (${bsEntry.reason}) but fillPrice ≤ keepMax=$${dynamicKeepThreshold.toFixed(2)} (fair=${bsEntry.fairRaw.toFixed(3)}) — holding (edge>0)`,
      );
    }

    this.hedgeState = "leg1_filled";
    this.activeStrategyMode = "mispricing";
    this.leg1Dir = dir;
    this.leg1Price = fillPrice;
    this.leg1FillPrice = fillPrice;
    this.leg1OrderId = orderId.slice(0, 12);
    this.leg1FilledAt = Date.now();
    this.leg1Shares = filledShares;
    this.leg1Token = leg1Token;
    this.leg1MakerFill = true; // 预挂单永远是 maker
    this.leg1EntrySource = "dual-side-preorder";
    this.leg1WinRate = bsEntry.fairKelly;
    this.leg1BsFair = bsEntry.fairRaw;
    this.leg1EffectiveCost = bsEntry.effectiveCost;
    this.leg1EffectiveEdge = bsEntry.effectiveEdge;
    this.leg1EdgeTier = this.getNetEdgeTier(bsEntry.effectiveEdge).label;
    this.leg1EntryTrendBias = this.currentTrendBias;
    this.leg1EntrySecondsLeft = Math.floor(this.secondsLeft);
    this.leg1AttemptedThisRound = true;
    this.totalCost = filledShares * fillPrice; // maker fee = 0
    // paper 模式下 placeGtcBuy 已预扣 paperBalance, 不要重复扣; 直接同步
    // live 模式下 balance 是链上余额, 成交已扣款
    // 两种模式统一: 从 trader 读取真实余额
    // 注: refreshBalance 是 async 但 transition 是 sync → 保守处理
    // 在 manageDualSideOrders 调用 transition 前后会 refreshBalance
    // 这里仅设 totalCost 用于后续 P/L 计算, 不扣 balance
    this.onLeg1Opened();
    this.status = `Leg1预挂成交 ${dir.toUpperCase()} @${fillPrice.toFixed(2)} x${filledShares.toFixed(0)} maker, 等结算`;
    logger.info(`HEDGE15M DUAL SIDE → LEG1: ${dir.toUpperCase()} ${filledShares.toFixed(0)}份 @${fillPrice.toFixed(2)} maker orderId=${orderId.slice(0, 12)} bsFair=${bsEntry.fairRaw.toFixed(3)} netEdge=${(bsEntry.effectiveEdge * 100).toFixed(1)}%`);
    this.writeRoundAudit("leg1-filled", {
      strategyMode: "mispricing",
      dir,
      entryAsk: fillPrice,
      fillPrice,
      filledShares,
      orderId: orderId.slice(0, 12),
      maker: true,
      fee: 0,
      source: "dual-side-preorder",
      thinEdgeEntry: false,
      bsFair: bsEntry.fairRaw,
      effectiveCost: bsEntry.effectiveCost,
      effectiveEdge: bsEntry.effectiveEdge,
      observedEntrySum: observedSum,
      preferredSum: 0,
      hardMaxSum: 0,
    });
  }

  /**
   * Limit+FAK 赛跑: 先挂 limit 等待短暂时间, 未成交则 cancel + FAK fallback
   * 返回 { orderId, filled, avgPrice, maker } 或 null(两者都失败)
   */
  private async limitRaceBuy(
    trader: Trader,
    tokenId: string,
    shares: number,
    currentAsk: number,
    limitOffset: number,
    timeoutMs: number,
    negRisk: boolean,
  ): Promise<{ orderId: string; filled: number; avgPrice: number; maker: boolean } | null> {
    const limitPrice = Math.round((currentAsk - limitOffset) * 100) / 100; // 保持 0.01 精度
    if (limitPrice <= 0.01) {
      // limit 价格太低, 直接 FAK
      return this.fakBuyFallback(trader, tokenId, shares, currentAsk, negRisk);
    }

    // ── Phase 1: 挂 GTC limit buy ──
    const gtcOrderId = await trader.placeGtcBuy(tokenId, shares, limitPrice, negRisk);
    if (!gtcOrderId) {
      logger.warn(`LIMIT RACE: GTC buy failed, fallback to FAK`);
      return this.fakBuyFallback(trader, tokenId, shares, currentAsk, negRisk);
    }

    // ── Phase 2: 轮询等待成交 ──
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const details = await trader.getOrderFillDetails(gtcOrderId);
      if (details.filled >= shares * 0.5) {
        // 成交过半, 取消剩余后视为成功
        await trader.cancelOrder(gtcOrderId);
        const finalDetails = await trader.getOrderFillDetails(gtcOrderId);
        const realFilled = finalDetails.filled > details.filled ? finalDetails.filled : details.filled;
        const realAvg = finalDetails.filled > details.filled ? finalDetails.avgPrice : details.avgPrice;
        logger.info(`LIMIT RACE WIN: ${realFilled.toFixed(0)}/${shares} @${realAvg.toFixed(2)} (limit@${limitPrice.toFixed(2)}) maker=true`);
        return { orderId: gtcOrderId, filled: realFilled, avgPrice: realAvg, maker: true };
      }
      // 检查盘口: ask 是否反弹
      const book = trader.peekBestPrices(tokenId, 500);
      if (book && book.ask != null && book.ask > currentAsk * 1.03) {
        // ask 反弹超 3%, 立刻 cancel → FAK
        logger.info(`LIMIT RACE ABORT: ask rebounded ${book.ask.toFixed(2)} > ${currentAsk.toFixed(2)}*1.03, cancel+FAK`);
        break;
      }
      await new Promise(r => setTimeout(r, LIMIT_RACE_POLL_MS));
    }

    // ── Phase 3: 超时/反弹 → cancel → 检查是否在取消前成交 → FAK fallback ──
    let cancelSucceeded = true;
    try {
      await trader.cancelOrder(gtcOrderId);
    } catch {
      cancelSucceeded = false;
    }
    const finalCheck = await trader.getOrderFillDetails(gtcOrderId);
    if (finalCheck.filled > 0) {
      logger.info(`LIMIT RACE LATE: filled ${finalCheck.filled.toFixed(0)} during cancel @${finalCheck.avgPrice.toFixed(2)}, maker=true`);
      return { orderId: gtcOrderId, filled: finalCheck.filled, avgPrice: finalCheck.avgPrice, maker: true };
    }
    if (!cancelSucceeded) {
      // cancel 可能失败, GTC 可能仍挂着, 不安全发 FAK → 再试一次 cancel
      logger.warn(`LIMIT RACE: cancel may have failed, retry cancel before FAK`);
      await trader.cancelOrder(gtcOrderId).catch(() => {});
      const recheck = await trader.getOrderFillDetails(gtcOrderId);
      if (recheck.filled > 0) {
        return { orderId: gtcOrderId, filled: recheck.filled, avgPrice: recheck.avgPrice, maker: true };
      }
    }

    // 完全未成交或中止, FAK fallback — 使用原始入场信号时的 currentAsk 保证吃到这单
    // 之前错误地使用了 limitPrice 导致 FAK 完全无法过本（形同废单），导致看着方向对了却一直不进场。
    logger.info(`LIMIT RACE MISS/ABORT: no fill in ${timeoutMs}ms @limit=${limitPrice.toFixed(2)}, fallback taker FAK @${currentAsk.toFixed(2)}`);
    return this.fakBuyFallback(trader, tokenId, shares, currentAsk, negRisk);
  }

  private async fakBuyFallback(
    trader: Trader,
    tokenId: string,
    shares: number,
    askPrice: number,
    negRisk: boolean,
  ): Promise<{ orderId: string; filled: number; avgPrice: number; maker: boolean } | null> {
    const cost = shares * askPrice;
    const res = await trader.placeFakBuy(tokenId, cost, negRisk);
    if (!res) return null;
    const orderId = res?.orderID || res?.order_id || "";
    if (!orderId) return null;
    const details = await trader.waitForOrderFillDetails(orderId, getDynamicParams().fillCheckMs);
    if (details.filled > 0) {
      return { orderId, filled: details.filled, avgPrice: details.avgPrice > 0 ? details.avgPrice : askPrice, maker: false };
    }
    return null;
  }

  /** 下单入场 */
  private async openLeg1Position(
    trader: Trader,
    dir: string,
    askPrice: number,
    buyToken: string,
    budgetPct: number,
    strategyMode: "mispricing",
    signalDetectedAt = Date.now(),
    entrySource = "reactive-mispricing",
    bsEntry?: {
      fairRaw: number;
      fairKelly: number;
      effectiveCost: number;
      effectiveEdge: number;
    },
  ): Promise<void> {
    const budget = this.balance * budgetPct;
    const shares = Math.min(MAX_SHARES, Math.floor(budget / askPrice));
    if (shares < MIN_SHARES) {
      this.trackRoundRejectReason(`shares ${shares} < ${MIN_SHARES}`);
      logger.warn(`Hedge15m Leg1 skipped: ${shares}份 < ${MIN_SHARES} (balance=$${this.balance.toFixed(2)}, ask=$${askPrice.toFixed(2)})`);
      return;
    }

    const leg1Book = await getHotBestPrices(trader, buyToken);
    const orderbookPlan = evaluateEntryOrderbook({
      askPrice,
      shares,
      liveAsk: leg1Book?.ask ?? null,
      liveBid: leg1Book?.bid ?? null,
      askDepth: leg1Book?.askDepth ?? 0,
      spreadLimit: 0.20,
      reboundLimit: 1.15,
    });
    if (!orderbookPlan.allowed) {
      this.trackRoundRejectReason(`orderbook: ${orderbookPlan.reason}`);
      logger.warn(`Hedge15m Leg1 skipped: ${orderbookPlan.reason}`);
      return;
    }

    const entryAsk = orderbookPlan.entryAsk;
    const entryShares = Math.min(MAX_SHARES, Math.floor(budget / entryAsk));
    if (entryShares < MIN_SHARES) {
      this.trackRoundRejectReason(`fresh shares ${entryShares} < ${MIN_SHARES}`);
      logger.warn(`Hedge15m Leg1 skipped (fresh): ${entryShares}份 < ${MIN_SHARES} @${entryAsk.toFixed(2)}`);
      return;
    }
    const entryCost = entryShares * entryAsk;

    this.leg1EntryInFlight = true;
    // leg1AttemptedThisRound 延迟到真正成交后再设置, 允许FAK失败后重试
    this.hedgeState = "leg1_pending";
    this.status = `Leg1下单中: ${dir.toUpperCase()} @${entryAsk.toFixed(2)} x${entryShares.toFixed(0)}`;

    try {
      const adjustedShares = entryShares;

      // ── Limit race offset + timeout: 按dump速度动态化 ──
      // 慢dump(8-12%): 价格回弹慢→maker成交概率高→等久点+小offset
      // 快dump(>15%): 价格恢复快→缩短等待+大offset抢成交
      let limitOffset = LIMIT_RACE_OFFSET;
      let raceTimeout = LIMIT_RACE_TIMEOUT_MS;
      if (this.currentDumpDrop >= LIMIT_RACE_FAST_DUMP_THRESHOLD || this.currentDumpVelocity === "fast") {
        limitOffset = LIMIT_RACE_FAST_OFFSET;
        raceTimeout = 600;  // 快dump/快速度: 缩到600ms, 尽快成交
      } else if (this.currentDumpDrop < 0.12 && this.currentDumpVelocity === "slow") {
        raceTimeout = 1200; // 慢dump+慢速度: 等久点, maker成交概率更高
      }

      const adjustedCost = adjustedShares * entryAsk;
      logger.info(`HEDGE15M LEG1 ${strategyMode.toUpperCase()}: ${dir.toUpperCase()} ${adjustedShares}份 @${entryAsk.toFixed(2)} cost=$${adjustedCost.toFixed(2)}${entryAsk !== askPrice ? ` (signal@${askPrice.toFixed(2)})` : ""} negRisk=${this.negRisk} limitRace=${LIMIT_RACE_ENABLED}`);
      const orderSubmitStartedAt = Date.now();
      recordExecutionLatency("signalToSubmit", orderSubmitStartedAt - signalDetectedAt);

      let fillResult: { orderId: string; filled: number; avgPrice: number; maker: boolean } | null = null;
      if (LIMIT_RACE_ENABLED && raceTimeout > 0) {
        fillResult = await this.limitRaceBuy(trader, buyToken, adjustedShares, entryAsk, limitOffset, raceTimeout, this.negRisk);
      } else {
        fillResult = await this.fakBuyFallback(trader, buyToken, adjustedShares, entryAsk, this.negRisk);
      }

      const orderAckAt = Date.now();
      recordExecutionLatency("submitToAck", orderAckAt - orderSubmitStartedAt);

      if (!fillResult) {
        this.leg1FailedAttempts++;
        this.status = `Leg1下单失败 (${this.leg1FailedAttempts}/2), ${this.leg1FailedAttempts >= 2 ? "不重试" : "可重试"}`;
        logger.warn(`HEDGE15M Leg1 entry failed (limit race + FAK), attempt ${this.leg1FailedAttempts}/2`);
        return;
      }

      recordExecutionLatency("signalToFill", orderAckAt - signalDetectedAt);

      const orderId = fillResult.orderId;
      const filledShares = fillResult.filled;
      const realFillPrice = fillResult.avgPrice;
      const isMaker = fillResult.maker;
      const actualFee = isMaker ? 0 : TAKER_FEE;

      // NaN防护: 成交数据异常时拒绝入场, 防止P/L追踪损坏
      if (!Number.isFinite(filledShares) || filledShares <= 0 || !Number.isFinite(realFillPrice) || realFillPrice <= 0) {
        logger.error(`HEDGE15M LEG1 ABORT: invalid fill data shares=${filledShares} price=${realFillPrice} — refusing to track position`);
        this.status = "Leg1成交数据异常, 本轮跳过";
        return;
      }

      this.hedgeState = "leg1_filled";
      this.leg1AttemptedThisRound = true; // 真正成交后才锁定, FAK失败可重试
      this.activeStrategyMode = "mispricing";
      this.leg1Dir = dir;
      this.leg1Price = entryAsk;
      this.leg1FillPrice = realFillPrice;
      this.leg1OrderId = orderId ? orderId.slice(0, 12) : "";
      this.leg1FilledAt = Date.now();
      this.leg1Shares = filledShares;
      this.leg1Token = buyToken;
      this.leg1MakerFill = isMaker;
      this.leg1EntrySource = entrySource;
      const feeBuffer = isMaker ? 0 : realFillPrice * TAKER_FEE;
      const slippageBuffer = isMaker ? 0 : 0.005;
      const settledEffectiveCost = realFillPrice + feeBuffer + slippageBuffer;
      const settledBsFair = bsEntry?.fairRaw ?? KELLY_WIN_RATE;
      const settledKelly = bsEntry?.fairKelly ?? settledBsFair;
      const settledEdge = settledBsFair - settledEffectiveCost;
      this.leg1WinRate = Math.max(0.30, Math.min(0.70, settledKelly));
      this.leg1BsFair = settledBsFair;
      this.leg1EffectiveCost = settledEffectiveCost;
      this.leg1EffectiveEdge = settledEdge;
      this.leg1EdgeTier = this.getNetEdgeTier(settledEdge).label;
      this.leg1EntryTrendBias = this.currentTrendBias;
      this.leg1EntrySecondsLeft = Math.floor(this.secondsLeft);
      this.totalCost = filledShares * realFillPrice * (1 + actualFee);
      this.balance -= this.totalCost;
      this.onLeg1Opened();
      this.status = `Leg1 ${dir.toUpperCase()} @${realFillPrice.toFixed(2)} x${filledShares.toFixed(0)}${isMaker ? " maker" : ""}, 等结算`;
      logger.info(`HEDGE15M LEG1 FILLED: ${dir.toUpperCase()} ${filledShares.toFixed(0)}份 ask=${entryAsk.toFixed(2)} fill=${realFillPrice.toFixed(2)} orderId=${orderId.slice(0, 12)} maker=${isMaker} fee=${(actualFee * 100).toFixed(0)}%`);
      this.writeRoundAudit("leg1-filled", {
        strategyMode: "mispricing",
        dir,
        entryAsk,
        fillPrice: realFillPrice,
        filledShares,
        orderId: orderId.slice(0, 12),
        maker: isMaker,
        fee: actualFee,
        source: entrySource,
      });
    } finally {
      this.leg1EntryInFlight = false;
      if (this.hedgeState === "leg1_pending") {
        this.hedgeState = "watching";
      }
    }
  }

  private async settleHedge(): Promise<void> {
    const preSettleBalance = this.balance; // 记录结算前余额用于校验
    await sleep(2000); // 等待价格源更新

    // 结算方向判断: 3次采样取中位数, 减少BTC瞬时反转导致误判
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const p = getBtcPrice();
      if (p > 0) samples.push(p);
      if (i < 2) await sleep(500);
    }
    samples.sort((a, b) => a - b);
    const btcNow = samples.length > 0 ? samples[Math.floor(samples.length / 2)] : 0;
    let actualDir: "up" | "down";
    let dirSource = "BTC";
    if (this.roundStartBtcPrice > 0 && btcNow > 0) {
      // Polymarket "Up" = BTC strictly above open → equal = DOWN wins
      actualDir = btcNow > this.roundStartBtcPrice ? "up" : "down";
      logger.info(`HEDGE15M SETTLE: BTC start=$${this.roundStartBtcPrice.toFixed(0)} now=$${btcNow.toFixed(0)} (${samples.length} samples, median) → ${actualDir}${btcNow === this.roundStartBtcPrice ? " (flat=DOWN)" : ""}`);
    } else {
      dirSource = "BOOK";
      let leg1Score = 0;
      if (this.trader && this.leg1Token) {
        const leg1Book = await getHotBestPrices(this.trader, this.leg1Token).catch(() => null);
        if (leg1Book) {
          const leg1Bid = leg1Book.bid ?? 0;
          const leg1Ask = leg1Book.ask ?? 0;
          leg1Score = leg1Bid > 0 ? leg1Bid : leg1Ask;
        }
      }

      if (leg1Score > 0) {
        actualDir = leg1Score >= 0.50 ? (this.leg1Dir === "down" ? "down" : "up") : (this.leg1Dir === "up" ? "down" : "up");
        logger.error(`HEDGE15M SETTLE: BTC unavailable, using orderbook fallback (L1=${leg1Score.toFixed(2)} → ${actualDir})`);
      } else {
        actualDir = this.leg1Dir === "down" ? "down" : "up";
        dirSource = "LEG1_FALLBACK";
        logger.error(`HEDGE15M SETTLE: unable to determine direction, falling back to leg1Dir=${actualDir}`);
      }
    }

    let returnVal = 0;
    if (this.leg1Dir === actualDir && this.leg1Shares > 0) {
      returnVal = this.leg1Shares;
    }

    const profit = returnVal - this.totalCost;

    // NaN防护: totalCost或returnVal异常时中止, 防止P/L追踪损坏
    if (!Number.isFinite(profit) || !Number.isFinite(this.totalCost)) {
      logger.error(`SETTLE NaN GUARD: profit=${profit} totalCost=${this.totalCost} returnVal=${returnVal} — skipping P/L update`);
      this.writeRoundAudit("settle-nan-guard", { profit, totalCost: this.totalCost, returnVal, leg1Shares: this.leg1Shares });
      this.totalCost = 0;
      this.leg1Shares = 0;
      this.hedgeState = "done";
      await this.refreshBalance();
      return;
    }

    const result = profit >= 0 ? "WIN" : "LOSS";

    if (result === "WIN") { this.wins++; this.consecutiveLosses = 0; }
    else { this.losses++; this.consecutiveLosses++; }
    this.totalProfit += profit;
    this.sessionProfit += profit;
    this.recordRollingPnL(profit);
    this.balance += returnVal;
    this.trader?.creditSettlement(returnVal);

    const settlementReason = `结算: BTC ${actualDir.toUpperCase()}(${dirSource}), ${this.leg1Dir===actualDir?'方向正确→$1/份':'方向错误→$0'}`;

    this.history.push({
      time: timeStr(),
      result,
      leg1Dir: this.leg1Dir.toUpperCase(),
      leg1Price: this.leg1Price,
      totalCost: this.totalCost,
      profit,
      cumProfit: this.totalProfit,
      exitType: "settlement",
      exitReason: settlementReason,
      profitBreakdown: `结算回收$${returnVal.toFixed(2)}(${this.leg1Shares.toFixed(0)}份) - 成本$${this.totalCost.toFixed(2)} = ${profit>=0?'+':''}$${profit.toFixed(2)}`,
      leg1Shares: this.leg1Shares,
      leg1FillPrice: this.leg1FillPrice,
      orderId: this.leg1OrderId,
      estimated: this.leg1Estimated,
      entrySource: this.leg1EntrySource,
      entryTrendBias: this.leg1EntryTrendBias,
      entrySecondsLeft: this.leg1EntrySecondsLeft,
      entryWinRate: this.leg1WinRate,
      entryBsFair: this.leg1BsFair,
      entryEffectiveCost: this.leg1EffectiveCost,
      entryEffectiveEdge: this.leg1EffectiveEdge,
      entryEdgeTier: this.leg1EdgeTier,
    });
    if (this.history.length > 200) this.history.shift();
    this.saveHistory();

    this.status = `结算: ${result} ${profit >= 0 ? "+" : ""}$${profit.toFixed(2)} (返$${returnVal.toFixed(2)} dir=${actualDir}/${dirSource})`;
    logger.info(`HEDGE15M SETTLED: ${result} dir=${actualDir}(${dirSource}) return=$${returnVal.toFixed(2)} cost=$${this.totalCost.toFixed(2)} profit=$${profit.toFixed(2)} L1fill=${this.leg1FillPrice.toFixed(2)}`);
    this.writeRoundAudit("settlement", {
      result,
      actualDir,
      dirSource,
      returnVal,
      profit,
      settlementReason,
    });

    // ── 结算 P/L 校验: 链上余额 vs 本地预期 ──
    const expectedBalance = preSettleBalance + returnVal;
    
    // 等待链上结算生效后再同步余额
    await sleep(5000);
    await this.refreshBalance(expectedBalance);

    if (this.tradingMode === "live") {
      const drift = Math.abs(this.balance - expectedBalance);
      if (drift > 0.50) {
        logger.warn(`SETTLE P/L DRIFT: expected=$${expectedBalance.toFixed(2)} actual=$${this.balance.toFixed(2)} drift=$${drift.toFixed(2)} (cost=$${this.totalCost.toFixed(2)} return=$${returnVal.toFixed(2)})`);
        this.writeRoundAudit("settle-pl-drift", { preSettleBalance, expectedBalance, actualBalance: this.balance, drift, returnVal, totalCost: this.totalCost });
      }
    }

    this.totalCost = 0;
    this.leg1Shares = 0;
    this.hedgeState = "done";
  }
}

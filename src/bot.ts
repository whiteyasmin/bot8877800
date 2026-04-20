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
  getDepthImbalance, getLiquidationInfo, getFundingRateInfo, getOpenInterestInfo,
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
  type MispricingCandidate,
} from "./strategyEngine";
import { Trader, type TraderDiagnostics } from "./trader";

const DIRECTIONAL_REACTIVE_ENABLED = true;
const DISABLE_DUAL_SIDE_PREORDER = true;
const DIRECTIONAL_MIN_POSITIVE_EDGE = 0.01;
const DIRECTIONAL_SMALL_EDGE = 0.03;
const DIRECTIONAL_MEDIUM_EDGE = 0.05;
const DIRECTIONAL_SMALL_BUDGET_SCALE = 0.35;
const DIRECTIONAL_MEDIUM_BUDGET_SCALE = 0.60;
const DIRECTIONAL_CHASE_MOMENTUM = 0.0012;
const DIRECTIONAL_TREND_MIN_BTC_MOVE = 0.0008;
const DIRECTIONAL_TREND_MIN_EDGE = 0.02;
const DIRECTIONAL_TREND_MAX_ASK = 0.72;
const DIRECTIONAL_TREND_PULLBACK_MAX_ASK = 0.58;
const MISPRICING_MIN_EDGE = 0.03;
const MISPRICING_STRONG_DROP = 0.12;
const MISPRICING_LOW_PRICE = 0.22;
const MISPRICING_STRONG_CONTRA_SCORE = -3;
const MISPRICING_CONTRA_EDGE_OVERRIDE = 0.12;
const MISPRICING_NORMAL_EDGE = 0.08;
const MISPRICING_FAST_LANE_EDGE = 0.12;
const MISPRICING_LOW_TICKET_EDGE = 0.12;
const MISPRICING_ABSOLUTE_MIN_ASK = 0.06;
const MISPRICING_COUNTER_BTC_MOVE = 0.0005;
const MISPRICING_COUNTER_BTC_MIN_EDGE = MISPRICING_NORMAL_EDGE;
const MISPRICING_STRONG_COUNTER_MIN_EDGE = 0.18;
const MISPRICING_STRONG_COUNTER_MAX_ASK = 0.15;
const MISPRICING_UNFAVORED_FAIR = 0.30;
const MISPRICING_DEEP_UNFAVORED_FAIR = 0.25;
const MISPRICING_DEEP_UNFAVORED_MIN_EDGE = MISPRICING_FAST_LANE_EDGE;
const COUNTER_WIN_ENABLED = true;
const COUNTER_WIN_MIN_EDGE = 0.02;
const COUNTER_WIN_STRONG_EDGE = 0.05;
const COUNTER_WIN_MIN_ASK = 0.55;
const COUNTER_WIN_MAX_ASK = 0.86;
const COUNTER_WIN_MAX_BUDGET_PCT = 0.14;
const PANIC_HEDGE_ENABLED_DEFAULT = true;
const PANIC_HEDGE_MIN_DROP = 0.14;
const PANIC_HEDGE_MAX_ASK = 0.22;
const PANIC_HEDGE_MIN_EDGE = 0.06;
const PANIC_HEDGE_MAX_BUDGET_PCT = 0.10;
const DOJI_LN_MONEYNESS = 0.0001;
const NEAR_DOJI_LN_MONEYNESS = 0.0003;
const DOJI_MAX_BUDGET_PCT = 0.08;
const NEAR_DOJI_MAX_BUDGET_PCT = 0.12;
const DOJI_HIGH_ASK_CUTOFF = 0.20;
const DOJI_HIGH_ASK_MAX_BUDGET_PCT = 0.08;
const EARLY_DOJI_SECS_LEFT = 600;
const EARLY_DOJI_MIN_DROP = 0.15;
const EARLY_DOJI_MAX_BUDGET_PCT = 0.05;
const EARLY_SMALL_EDGE_SECS_LEFT = 780;
const EARLY_SMALL_EDGE_MIN_EDGE = MISPRICING_NORMAL_EDGE;
const EARLY_COUNTER_MOMENTUM_MIN_EDGE = MISPRICING_FAST_LANE_EDGE;

// 閳光偓閳光偓 15閸掑棝鎸撶€电懓鍟块張鍝勬珤娴滃搫寮弫?(瀵ゆ儼绻滈惄绋垮彠閸欏倹鏆熼悽?getDynamicParams() 閹绘劒绶? 閳光偓閳光偓
const MIN_SHARES      = 3;        // 閺堚偓鐏?娴? 娴ｅ簼绨銈勭瑝瀵偓娴?(娴?闂勫秳缍? 闁灝鍘ょ亸蹇庣稇妫版繃顒村顏嗗箚)
const MAX_SHARES      = 150;      // 閸楁洝鍚欐稉濠囨150娴?(娴ｅ簼鐜崗銉ユ簚EV+婢? 閸忎浇顔忛弴鏉戙亣娴犳挷缍?
const DUMP_THRESHOLD  = 0.08;     // ask 鐠哄苯绠?閳?% 鐟欙箑褰侺eg1 (閸╁搫鍣崐? 娴ｅ簼鐜担宥勭窗閸斻劍鈧線妾锋担?
const DUMP_THRESHOLD_LOW_PRICE = 0.06;  // ask閳?0.22閺冨爼妾烽崚?% (娴ｅ簼鐜担宀碫瀹告煡鐝? 娑撳秹娓剁粵澶娿亣鐠?
const DUMP_LOW_PRICE_CUTOFF = 0.22;     // 娴ｅ簼鐜担宥呭瀻閻ｅ瞼鍤?
const ENTRY_WINDOW_S  = 660;      // 瀵偓鐏炩偓11閸掑棝鎸撻崘鍛磧閹貉呯壋閻? 缁愭褰涢崗鎶芥４=ROUND-660=240s=MIN_ENTRY_SECS
const ROUND_DURATION  = 900;      // 15閸掑棝鎸?
const TAKER_FEE       = 0.02;     // Polymarket taker fee ~2%
const MIN_ENTRY_SECS  = 120;      // 閸撯晙缍?<4閸掑棝鎸撴稉宥呯磻閺傞绮?(閺€鎯ь啍: 娴ｅ簼鐜崗銉ユ簚EV+閸楀厖濞囬弮鍫曟？閻? 4min鐡掑啿顧勭紒鎾剁暬)
const MAX_ENTRY_ASK   = 0.35;     // Leg1 閸忋儱婧€娴犺渹绗傞梽?(鐎圭偟娲? 閳?0.35閺冪V閳?0.15/娴犵捶50%閼虫粎宸?
const MIN_ENTRY_ASK   = 0.10;     // Leg1 閸忋儱婧€娴犺渹绗呴梽? 濞ｅ崬瀹抽惍鍝ユ磸閺冩湹缍嗘禒?妤傛エV (dumpThreshold瀹歌尪绻冨銈呮珨婢?
const DIRECTIONAL_MOVE_PCT = 0.0012;       // 閸ョ偛鎮庨崘鍛幆閺嶈偐些閸斻劏绉存潻?0.12% 閹靛秴鑸伴幋鎰煙閸氭垵浜哥純?
const MOMENTUM_WINDOW_SEC = 60;            // 閻厽婀￠崝銊╁櫤缁愭褰?60缁?
const MOMENTUM_CONTRA_PCT = 0.0010;        // BTC 60s閸愬懎寮介弬鐟版倻缁夎濮╃搾鍛扮箖 0.10% 閹靛秵瀚嗙紒婕漸mp
const TREND_WINDOW_SEC = 180;              // 娑擃厽婀＄搾瀣◢缁愭褰?180缁?
const TREND_CONTRA_PCT = 0.0024;           // BTC 180s閸愬懎宕熸潏纭呯Т鏉?0.24% 閹靛秷顫嬫稉鍝勫繁閻喎鐤勭搾瀣◢

const BASE_BUDGET_PCT = 0.18;             // 姒涙顓绘潪璁崇波閸╁搫鍣?(Kelly閸掑棗鐪版导姘冲殰閸斻劏顩惄?
const KELLY_WIN_RATE = 0.54;              // Kelly娴兼媽顓搁懗婊呭芳 (鐎圭偟娲?W/3L閳?7%, 54%娣囨繂鐣ф导鎷岊吀)
const KELLY_FRACTION = 0.5;               // Half-Kelly (闁灝鍘ゆ潻鍥у娑撳鏁?
const LIMIT_RACE_ENABLED = true;           // 閸氼垳鏁?Limit+FAK 鐠ф稖绐?
const LIMIT_RACE_OFFSET = 0.01;            // limit 閹稿倸宕熸禒?= ask - offset
const LIMIT_RACE_FAST_OFFSET = 0.03;       // dump 韫囶偊鈧喐妞傞弴瀛樼负鏉?(婢舵氨娓?c/娴?
const LIMIT_RACE_TIMEOUT_MS = 900;         // limit 缁涘绶熸稉濠囨 ms (900ms: maker 0%fee vs taker 2%fee, 婢舵氨鐡?00ms閸婄厧绶?
const LIMIT_RACE_POLL_MS = 50;             // 濮?50ms 濡偓閺屻儰绔村▎?
const LIMIT_RACE_FAST_DUMP_THRESHOLD = 0.15; // dump>=15% 鐟欏棔璐熻箛顐︹偓鐒弖mp
const DUAL_SIDE_ENABLED = true;            // 閸氼垳鏁ら崣灞兼櫠妫板嫭瀵曢崡鏇炰粵鐢?
const DUAL_SIDE_SUM_CEILING = 0.97;        // 妫板嫭瀵曢崡鏇犳窗閺? 閸欏奔鏅秙um 閳?濮濄倕鈧?(0.97: fill@0.35+opp@0.62=0.97閳墮V+$0.15, 0.93婢额亞鎻ｇ€佃壈鍤ч幐鍌氬礋缁傝绔堕崷?0%閺冪姵纭堕幋鎰唉)
const DUAL_SIDE_OFFSET = 0.02;             // 閹稿倸宕熸禒?= currentAsk - offset (閺堚偓鐏? 鐎圭偤妾悽銊ュЗ閹狗ffset)
const DUAL_SIDE_REFRESH_MS = 2000;         // 濮?缁夋帒鍩涢弬鐗堝瘯閸楁洑鐜弽?(3s閸︺劌鎻╃悰灞惧剰娑擃厼浜哥粔鏄忕箖婢?
const DUAL_SIDE_BUDGET_PCT = 0.25;         // 妫板嫭瀵曢崡鏇氱波娴?(閸楁洑鏅? - 閺傜懓鎮滈幀褏鐡ラ悾顧媀+閸旂姴銇囨禒鎾茬秴
const DUAL_SIDE_MIN_SECS = 300;            // 閸撯晙缍戦埉?min閹靛秹顣╅幐?(閸?40婢额亙绻氱€? 娴ｅ簼鐜痬aker閹存劒姘﹂崡鍏呭▏閸?min娴犲泊V+)
const DUAL_SIDE_MIN_ASK = 0.18;            // 閹稿倸宕熸禒铚傜瑓闂?(娑撳骸寮芥惔鏂垮弳閸︾瘲IN_ENTRY_ASK鐎靛綊缍?
const DUAL_SIDE_MAX_ASK = 0.35;            // 閹稿倸宕熸禒铚傜瑐闂?(閳?.35娣囨繆鐦塃V+$0.15/share@50%閼虫粎宸?

const DUAL_SIDE_MIN_DRIFT = 0.04;          // 娴犻攱鐗搁崑蹇曅?濮濄倕鈧吋澧犻柌宥嗗瘯 (闂勫秳缍嗛弴瀛樻煀妫版垹宸?
const DUAL_SIDE_MIN_VOL = 0.0012;          // 5閸掑棝鎸揃TC濞夈垹濮╅悳鍥︾瑓闂?(0.12%), 娴ｅ簼绨銈堫潒娑撳搫浜曠悰灞惧剰娑撳秵瀵曢崡?
const REACTIVE_MIN_VOL = 0.0010;           // reactive鐠侯垰绶炲▔銏犲З閻滃洭妫Σ? 娴ｅ簼绨?.10%鐟欏棔璐熼崳顏勶紣, 娑撳秷鎷穌ump
const DUMP_LOG_THROTTLE_MS = 2000;         // 闁插秴顦瞕ump閺冦儱绻旈懞鍌涚ウ: 閸氬ey閼峰啿鐨梻鎾2s

const LIQUIDITY_FILTER_SUM = 1.10;          // UP+DOWN best ask娑斿鎷?濮濄倕鈧?鐠囧瓨妲憇pread婢额亜銇囬弮鐖€dge, 娑撳秵瀵曟０鍕瘯閸?
const SUM_DIVERGENCE_MAX = 1.03;            // 閸忋儱婧€閺?upAsk+downAsk > 濮濄倕鈧?閳?閹锋帞绮烽崗銉ユ簚 (sum閳?.03=鐢倸婧€閸忣剙閽╃€规矮鐜? 閺冪嚳ump闁挎瑥鐣炬禒绌峝ge)
const SUM_DIVERGENCE_RELAXED = 1.05;        // 婢额湭ump(閳?2%)閺冭埖鏂佺€圭氮um娑撳﹪妾? 濞ｅ崬瀹抽惍鍝ユ磸鐠囧瓨妲戠€规矮鐜弫鍫㈠芳娴? sum閻ｃ儵鐝禒宥嗘箒edge
const SUM_DIVERGENCE_MIN = 0.85;            // 閸忋儱婧€閺?upAsk+downAsk < 濮濄倕鈧?閳?閺傜懓鎮滈幀褍宸遍妴浣虹壋閻╂ɑ娲块崣顖欎繆
const DUMP_CONFIRM_CYCLES = 1;              // 鏉╃偟鐢?N 娑擃亜鎯婇悳顖滄箙閸?dump 閹靛秷袝閸欐垵鍙嗛崷?(1: dumpThreshold瀹歌尪绻冨銈呮珨婢? 閺冪娀娓舵径姘偧绾喛顓?
const MIN_ENTRY_ELAPSED = 30;               // 閸ョ偛鎮庡鈧慨瀣殾鐏?0s閸氬孩澧犻崗浣筋啅閸欏秴绨插蹇撳弳閸?(30s閺佺増宓佸鑼跺喕婢剁喓菙鐎?
const TREND_BUDGET_BOOST = 0.03;            // trend aligned budget boost
const BOOT_ROUND_MAX_ELAPSED = MIN_ENTRY_ELAPSED; // boot round guard
const TREND_BUDGET_CUT = 0.02;              // 閺傜懓鎮滄稉顓熲偓褎妞傞崷鈫榚lly閸╄櫣顢呮稉濠傚櫤2%
const MIN_NET_EDGE = 0.05;                  // net edge <8% 娑撳秴浠?
const NON_FLAT_MIN_NET_EDGE = 0.08;         // 闂堢€巐at娑旂喐褰佹妯哄煂10%, 鏉╁洦鎶ゆ潏褰掓閸ｎ亜锛愰崡?
const FLAT_MIN_NET_EDGE = 0.10;             // flat鐞涘本鍎忛幎顒勭彯閸?2%, 闂勫秳缍嗛崳顏勶紣閸忋儱婧€
const REACTIVE_MIN_ALIGNMENT_SCORE = 1;     // 閻╂ê褰涙穱鈥冲娇鐠愩劑鍣洪梻銊︻潬: aligned-contra >= 1
const REACTIVE_ALIGNMENT_EDGE_OVERRIDE = 0.20; // edge閳?0%閺冭泛鍘戠拋姝岀Ш鏉╁洣淇婇崣鐑芥，濡?
const MID_NET_EDGE = MISPRICING_NORMAL_EDGE;
const HIGH_NET_EDGE = MISPRICING_FAST_LANE_EDGE;
const BALANCE_ESTIMATE_MIN_PCT = 0.70;
const BALANCE_ESTIMATE_MAX_PCT = 1.15;

// 閳光偓閳光偓 鐠у嫰鍣剧€瑰鍙忕€瑰牊濮?閳光偓閳光偓
const MIN_BALANCE_TO_TRADE = 5;             // 娴ｆ瑩顤?$5閸嬫粍顒涙禍銈嗘 (娑撳秴顧勫鈧張鈧亸蹇庣波)
const MAX_SESSION_LOSS_PCT = 0.35;          // 閸楁洘顐兼导姘崇樈娴滃繑宕搾鍛扮箖閸掓繂顫愮挧鍕櫨35%閳帗娈忛崑婊€姘﹂弰?(閺囧瓨妫銏″疮娣囨繄鏆€閺堫剟鍣?
const CONSECUTIVE_LOSS_PAUSE = 3;           // 鏉╃偟鐢绘禍蹇斿疮5濞嗏檧鍟嬮弳鍌氫粻1鏉烆喖鍠庨棃娆愭埂 (閺囨潙鎻╅柅鍌氱安鐢倸婧€regime閸欐ê瀵?

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
  panicHedgeEnabled: boolean;
  trendBias: string;
  sessionROI: number;
  rolling4hPnL: number;
  effectiveMaxAsk: number;
  askSum: number;
  dumpConfirmCount: number;
  dirAlignedCount: number;
  dirContraCount: number;
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
  // R: Futures Open Interest
  openInterest: number;
  openInterestChangePct: number;
  openInterestDirection: string;
  openInterestFresh: boolean;
  openInterestRegime: string;
  derivativesBiasScore: number;
  derivativesBiasDirection: string;
  rtDumpConfirmCycles: number;
  rtEntryWindowS: number;
  rtMinEntrySecs: number;
  rtMaxEntryAsk: number;
  rtDualSideMaxAsk: number;
  rtKellyFraction: number;
  rtPanicHedgeMinDrop: number;
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
  // 閳光偓閳光偓 鏉╂劘顢戦弮璺哄讲鐠嬪啫寮弫?閳光偓閳光偓
  dumpConfirmCycles?: number;       // 閻摜娲忕涵顔款吇閸涖劍婀? 1/2/3
  entryWindowPreset?: "short" | "medium" | "long";  // 閸忋儱婧€缁愭褰? 閻?min/娑?min/闂€?min
  maxEntryAsk?: number;             // 閸欏秴绨查崗銉ユ簚娑撳﹪妾? 0.35
  dualSideMaxAsk?: number;          // 妫板嫭瀵曟稉濠囨: 0.30/0.35
  kellyFraction?: number;           // 娴犳挷缍呯拋锛勭暬: 0.25/0.50/0.75
  panicHedgeEnabled?: boolean;      // 閹劖鍘＄€电懓鍟垮Ο鈥崇础
}

export interface HedgeHistoryEntry {
  time: string;
  result: string;
  leg1Dir: string;
  leg1Price: number;        // Leg1 閸忋儱婧€ ask (閹躲儰鐜?
  totalCost: number;
  profit: number;
  cumProfit: number;
  // 閳光偓閳光偓 閻喎鐤勯幋鎰唉閺佺増宓?閳光偓閳光偓
  exitType?: string;        // "settlement"
  exitReason?: string;      // 娴滆櫣琚崣顖濐嚢闁偓閸戣櫣鎮婇悽?
  leg1Shares?: number;      // Leg1 鐎圭偤妾幋鎰唉娴犺姤鏆?
  leg1FillPrice?: number;   // Leg1 閻喎鐤勯獮鍐叉綆閹存劒姘︽禒?
  orderId?: string;         // 閸忓疇浠堢拋銏犲礋ID (閹搭亜褰囬崜?2娴?
  estimated?: boolean;      // 閺勵垰鎯侀崥顐″強缁犳鏆熼幑?
  profitBreakdown?: string; // 閻╁牅绨拋锛勭暬閺勫海绮?
  entrySource?: string;     // dual-side-preorder | reactive-mispricing
  entryTrendBias?: string;  // up | down | flat
  entrySecondsLeft?: number; // 閸忋儱婧€閺冭泛娲栭崥鍫濆⒖娴ｆ瑧顫楅弫?
  entryWinRate?: number;    // 閸忋儱婧€閺冭泛濮╅幀浣藉劏閻?
  entryBsFair?: number;     // 閸忋儱婧€閺冪SM閸忣剙閽╅懗婊呭芳(raw)
  entryEffectiveCost?: number; // 閸忋儱婧€缂佺厧鎮庨幋鎰拱(閸氼偉鍨傞悳?濠婃垹鍋?
  entryEffectiveEdge?: number; // 閸忋儱婧€閸戔偓edge = bsFair - effectiveCost
  entryEdgeTier?: string;   // net-edge濡楋絼缍? small/normal/strong
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function timeStr(): string {
  return new Date().toTimeString().slice(0, 8);
}

/** 缂?Promise 閸旂姾绉撮弮鏈电箽閹躲倧绱濈搾鍛鏉╂柨娲?null 閼板奔绗?reject */
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

  private status = "idle";
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
  private roundStartBtcPrice = 0; // 閻劋绨紒鎾剁暬閺傜懓鎮滈崶鐐衡偓鈧?
  private negRisk = false;        // 瑜版挸澧犵敮鍌氭簚閻?negRisk 閺嶅洤绻?
  private sessionProfit = 0;      // 閺堫剚顐兼导姘崇樈缁鳖垵顓搁惄鍫滅碍
  private leg1FillPrice = 0;         // Leg1 閻喎鐤勯獮鍐叉綆閹存劒姘︽禒?
  private leg1OrderId = "";          // Leg1 鐠併垹宕烮D
  private leg1FilledAt = 0;
  private leg1Estimated = false;       // Leg1 閹存劒姘﹂弰顖氭儊娑撹桨鍙婄粻妤€鈧?
  private leg1EntryInFlight = false;
  private leg1AttemptedThisRound = false;
  private roundMomentumRejects = 0;
  private roundEntryAskRejects = 0;
  private loopRunId = 0;
  private activeStrategyMode: "none" | "mispricing" | "trend" | "counter-win" | "panic-hedge" = "none";
  private currentTrendBias: "up" | "down" | "flat" = "flat";
  private currentDumpDrop = 0;               // 瑜版挸澧燿ump鐠哄苯绠?閻劋绨琹imit race offset)
  private currentDumpVelocity: "fast" | "normal" | "slow" = "normal"; // dump闁喎瀹?
  private leg1MakerFill = false;             // Leg1閺勵垰鎯乵aker閹存劒姘?
  private leg1WinRate = 0.50;                // Leg1閸忋儱婧€閺冭泛濮╅幀浣藉劏閻?
  private leg1BsFair = 0.50;
  private leg1EffectiveCost = 0;
  private leg1EffectiveEdge = 0;
  private leg1EdgeTier = "--";
  private preOrderUpId = "";                 // 閸欏奔鏅舵０鍕瘯閸? UP token GTC orderId
  private preOrderDownId = "";               // 閸欏奔鏅舵０鍕瘯閸? DOWN token GTC orderId
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
  private rollingPnL: Array<{ ts: number; profit: number }> = []; // 濠婃艾濮㏄/L鐠佹澘缍?
  private dumpConfirmCount = 0;             // 鏉╃偟鐢婚惍鍝ユ磸绾喛顓荤拋鈩冩殶
  private lastDumpCandidateDir = "";        // 娑撳﹣閲渃ycle閻ㄥ垼ump閺傜懓鎮?
  private lastEntrySkipKey = "";            // 閸樺鍣? 娑撳﹥顐奸崗銉ユ簚鐠哄疇绻冮惃鍒眅y (dir:price)
  private lastDumpLogKey = "";              // 閸樺鍣? 娑撳﹥顐糞UM鏉╁洭鐝捄瀹犵箖閺冦儱绻旈惃鍒眅y
  private lastDumpInfoKey = "";             // 閸樺鍣? 娑撳﹥顐糄UMP娣団剝浼呴弮銉ョ箶key
  private lastDumpInfoTs = 0;               // 閼哄倹绁? 娑撳﹥顐糄UMP娣団剝浼呴弮銉ョ箶閺冨爼妫块幋?
  private lastSignalSkipKey = "";           // 閸樺鍣? 娑撳﹥顐兼穱鈥冲娇闂傘劍甯剁捄瀹犵箖閻ㄥ埍ey
  private lastRepricingRejectKey = "";      // 閸樺鍣? 娑撳﹥顐奸柌宥呯暰娴犻攱瀚嗙紒婵堟畱key
  private bsmRejectThrottle = new Map<string, number>(); // 閸樺鍣? BSM閹锋帞绮烽弮銉ョ箶閹稿〕ey閼哄倹绁?30s/key)
  private lastBsmRejectReason = "";
  private _volGateLoggedThisRound = false;  // 閸樺鍣? 濞夈垹濮╅悳鍥，閹貉勬）韫囨鐦℃潪顔煎涧閹垫挷绔村▎?
  private _earlyEntryLoggedThisRound = false; // 閸樺鍣? EARLY閺冦儱绻斿В蹇氱枂閸欘亝澧︽稉鈧▎?
  private dirAlignedCount = 0;              // 閸忋儱婧€閺冭埖鏌熼崥鎴滅閼风繝淇婇崣閿嬫殶 (7濠?
  private dirContraCount = 0;               // 閸忋儱婧€閺冭埖鏌熼崥鎴濆冀閸氭垳淇婇崣閿嬫殶 (7濠?
  private consecutiveLosses = 0;            // 鏉╃偟鐢绘禍蹇斿疮鐠佲剝鏆?(鐠у嫰鍣剧€瑰鍙忕€瑰牊濮?
  private leg1FailedAttempts = 0;           // 閺堫剙娲栭崥鍦楢K婢惰精瑙﹀▎鈩冩殶 (闂勬劕鍩楅柌宥堢槸)
  private emaVolAnnual = 0;                 // EMA楠炶櫕绮﹂惃鍕嬀閸栨牗灏濋崝銊у芳 (BSM閻?
  private emaVolWarmup = 0;                  // EMA warm-up鐠佲剝鏆? 閸?濞嗭紕鏁ら崸鍥р偓鑲╊潚鐎? 娑斿鎮楅崚鍢怣A

  // 閳光偓閳光偓 鏉╂劘顢戦弮璺哄讲鐠嬪啫寮弫?(鐟曞棛娲?const) 閳光偓閳光偓
  private rtDumpConfirmCycles = DUMP_CONFIRM_CYCLES;
  private rtEntryWindowS = ENTRY_WINDOW_S;
  private rtMinEntrySecs = MIN_ENTRY_SECS;
  private rtMaxEntryAsk = MAX_ENTRY_ASK;
  private rtDualSideMaxAsk = DUAL_SIDE_MAX_ASK;
  private rtKellyFraction = KELLY_FRACTION;
  private panicHedgeEnabled = PANIC_HEDGE_ENABLED_DEFAULT;

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
    const baseBias = getDirectionalBiasSignal({
      roundStartPrice: this.roundStartBtcPrice,
      btcNow: getBtcPrice(),
      shortMomentum: getRecentMomentum(MOMENTUM_WINDOW_SEC),
      trendMomentum: getRecentMomentum(TREND_WINDOW_SEC),
      directionalMovePct: DIRECTIONAL_MOVE_PCT,
      momentumContraPct: MOMENTUM_CONTRA_PCT,
      trendContraPct: TREND_CONTRA_PCT,
    });
    if (baseBias === "flat") return "flat";

    const derivatives = this.getDerivativesBias(baseBias);
    if (derivatives.contra >= 2 && derivatives.aligned === 0) return "flat";
    return baseBias;
  }

  private getDerivativesBias(dir: "up" | "down"): {
    aligned: number;
    contra: number;
    score: number;
    direction: "up" | "down" | "flat";
  } {
    let aligned = 0;
    let contra = 0;

    const flow = getTakerFlowRatio();
    if (flow.confidence !== "low") {
      if ((dir === "up" && flow.direction === "buy") || (dir === "down" && flow.direction === "sell")) aligned++;
      else if ((dir === "up" && flow.direction === "sell") || (dir === "down" && flow.direction === "buy")) contra++;
    }

    const funding = getFundingRateInfo();
    if (!funding.extreme && funding.freshMs < 600_000) {
      if ((dir === "up" && funding.direction === "long_pay") || (dir === "down" && funding.direction === "short_pay")) aligned++;
      else if ((dir === "up" && funding.direction === "short_pay") || (dir === "down" && funding.direction === "long_pay")) contra++;
    }

    const oiRegime = this.getOpenInterestRegime();
    if (oiRegime.regime !== "neutral") {
      if ((dir === "up" && oiRegime.bullish) || (dir === "down" && oiRegime.bearish)) aligned++;
      else if ((dir === "up" && oiRegime.bearish) || (dir === "down" && oiRegime.bullish)) contra++;
    }

    const score = aligned - contra;
    return {
      aligned,
      contra,
      score,
      direction: score > 0 ? dir : score < 0 ? (dir === "up" ? "down" : "up") : "flat",
    };
  }

  private getOpenInterestRegime(): {
    regime: "long_build" | "short_build" | "short_cover" | "long_unwind" | "neutral";
    bullish: boolean;
    bearish: boolean;
  } {
    const oi = getOpenInterestInfo();
    if (!oi.fresh || Math.abs(oi.changePct) < 0.003) {
      return { regime: "neutral", bullish: false, bearish: false };
    }

    const priceMove = getRecentMomentum(TREND_WINDOW_SEC);
    if (priceMove >= 0.0008 && oi.changePct > 0) {
      return { regime: "long_build", bullish: true, bearish: false };
    }
    if (priceMove <= -0.0008 && oi.changePct > 0) {
      return { regime: "short_build", bullish: false, bearish: true };
    }
    if (priceMove >= 0.0008 && oi.changePct < 0) {
      return { regime: "short_cover", bullish: true, bearish: false };
    }
    if (priceMove <= -0.0008 && oi.changePct < 0) {
      return { regime: "long_unwind", bullish: false, bearish: true };
    }

    return { regime: "neutral", bullish: false, bearish: false };
  }

  private getEffectiveMaxAsk(): number {
    return this.rtDualSideMaxAsk;
  }

  /**
   * 缂佺喕顓?婢堆備繆閸欓攱绨稉搴″弳閸︾儤鏌熼崥鎴犳畱娑撯偓閼?閻稓娴橀弫?
   * 濮ｅ繋閲滄穱鈥冲娇閻?direction 鐎涙顔屾稉?"buy"/"sell"/"neutral".
   * buy 缁涘鎮?"up", sell 缁涘鎮?"down".
   */
  private computeSignalAlignment(dir: string): void {
    const targetDir = dir === "up" ? "buy" : "sell";
    const contraDir = dir === "up" ? "sell" : "buy";
    let aligned = 0;
    let contra = 0;

    // 1. Taker Flow
    const flow = getTakerFlowRatio();
    if (flow.direction === targetDir) aligned++;
    else if (flow.direction === contraDir) contra++;

    // 2. Volume Spike
    const vol = getVolumeSpikeInfo();
    if (vol.isSpike) {
      if (vol.direction === targetDir) aligned++;
      else if (vol.direction === contraDir) contra++;
    }

    // 3. Large Orders
    const large = getLargeOrderInfo();
    if (large.direction === targetDir) aligned++;
    else if (large.direction === contraDir) contra++;

    // 4. Depth Imbalance
    const depth = getDepthImbalance();
    if (depth.fresh) {
      if (depth.direction === targetDir) aligned++;
      else if (depth.direction === contraDir) contra++;
    }

    // 5. Liquidation
    const liq = getLiquidationInfo();
    if (liq.intensity !== "low") {
      if (liq.direction === targetDir) aligned++;
      else if (liq.direction === contraDir) contra++;
    }

    // 6. Taker Flow Trend (strengthening=娑撹顕遍弬鐟板瀵?
    const flowTrend = getTakerFlowTrend();
    if (flowTrend === "strengthening" && flow.direction === targetDir) aligned++;
    else if (flowTrend === "strengthening" && flow.direction === contraDir) contra++;

    // 7. BTC 180s Momentum
    const mom180 = getRecentMomentum(180);
    if ((dir === "up" && mom180 > 0.001) || (dir === "down" && mom180 < -0.001)) aligned++;
    else if ((dir === "up" && mom180 < -0.001) || (dir === "down" && mom180 > 0.001)) contra++;

    // 8. Funding
    const funding = getFundingRateInfo();
    if (!funding.extreme && funding.freshMs < 600_000) {
      if ((dir === "up" && funding.direction === "long_pay") || (dir === "down" && funding.direction === "short_pay")) aligned++;
      else if ((dir === "up" && funding.direction === "short_pay") || (dir === "down" && funding.direction === "long_pay")) contra++;
    }

    // 9. Open interest
    const oiRegime = this.getOpenInterestRegime();
    if (oiRegime.regime !== "neutral") {
      if ((dir === "up" && oiRegime.bullish) || (dir === "down" && oiRegime.bearish)) aligned++;
      else if ((dir === "up" && oiRegime.bearish) || (dir === "down" && oiRegime.bullish)) contra++;
    }

    this.dirAlignedCount = aligned;
    this.dirContraCount = contra;
  }

  private getRolling4hPnL(): number {
    const cutoff = Date.now() - 4 * 3600_000;
    return this.rollingPnL.reduce((sum, item) => item.ts >= cutoff ? sum + item.profit : sum, 0);
  }

  private recordRollingPnL(profit: number): void {
    this.rollingPnL.push({ ts: Date.now(), profit });
    // 閸欘亜婀ǎ璇插閺冭埖绔婚悶鍡氱箖閺堢喐娼惄?
    const cutoff = Date.now() - 4 * 3600_000;
    this.rollingPnL = this.rollingPnL.filter((item) => item.ts >= cutoff);
  }

  // 閳光偓閳光偓 Black-Scholes 閺佹澘鐡ч張鐔告綀閸忣剙绱?閳光偓閳光偓
  // Abramowitz & Stegun 26.2.17 鏉╂垳鎶€, 鐠囶垰妯?< 7.5e-8
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
   * BSM閺佹澘鐡ч張鐔告綀: P(BTC缂佹挾鐣婚弮?> 瀵偓閻╂ü鐜? = N(d), d = ln(S/K) / (锜介埈姝?
   * - S = 瑜版挸澧燘TC, K = 閺堫剙娲栭崥鍫濈磻閻╂イTC, T = 閸撯晙缍戦弮鍫曟？(楠?, 锜?= 楠炴潙瀵插▔銏犲З閻?
   * - 锜介悽?getRecentVolatility(300) 閻ㄥ嚤arkinson娴兼媽顓搁柌蹇斿床缁?
   * - fairRaw 閻劋绨崗銉ユ簚鏉╁洦鎶? fairKelly 闂勬劕绠欓崚?[0.30, 0.70] 娴犲懐鏁ゆ禍宥琫lly sizing
   */
  private getBsSnapshot(dir: string, secsLeft: number, readonly_ = false): { fairRaw: number; fairKelly: number; dAbs: number; lnMoneyness: number } {
    const K = this.roundStartBtcPrice;
    const S = getBtcPrice();
    if (K <= 0 || S <= 0 || secsLeft < 30) {
      return { fairRaw: KELLY_WIN_RATE, fairKelly: KELLY_WIN_RATE, dAbs: 0, lnMoneyness: 0 };
    }
    // Parkinson estimator: 锜絖5min = range / (2*sqrt(2*ln2)) 閳?range / 2.355
    // 锜絖annual = 锜絖5min * sqrt(31557600/300) = 锜絖5min * 324.5
    // EMA楠炶櫕绮?浼?0.3): 閸戝繐鐨惌顓犵崶閸欙絽娅旀竟鏉款嚤閼风SM閸忣剙鍘戝鍌滃芳閸撗呭創濞夈垹濮?
    const vol5m = getRecentVolatility(300);
    const rawSigAnnual = Math.max(0.25, Math.min(1.50, vol5m * 324.5 / 2.355));
    // readonly濡€崇础(闂堛垺婢樻潪顔款嚄): 閸欘亣顕癊MA, 娑撳秵娲块弬?閳?闂冨弶顒?50ms闂堛垺婢樻潪顔款嚄濮光剝鐓婨MA闁插洦鐗遍悳?
    let sigAnnual: number;
    if (readonly_) {
      sigAnnual = this.emaVolAnnual > 0 ? this.emaVolAnnual : rawSigAnnual;
    } else {
      // Warm-up: 閸?濞嗭繝鍣伴弽椋庢暏缁鳖垳袧閸у洤鈧厧浠涚粔宥呯摍, 闁灝鍘ゆ＃鏍應鐏忔牕鍩￠惄瀛樺复閹存劒璐烢MA閸╁搫鍣?
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
    const lnSK = Math.log(S / K);            // ln(S/K): BTC閸嬪繒顬囬獮鍛 (缂佹繂顕?
    const d = lnSK / sigSqrtT;               // ln(S/K) / 锜介埈姝?
    const pUp = this.normalCdf(d);            // P(S_T > K): S>K閺冪>0閳墹(d)>0.5, UP閺囨潙褰查懗?
    const fairRaw = dir === "up" ? pUp : (1 - pUp);
    return {
      fairRaw,
      fairKelly: Math.max(0.30, Math.min(0.70, fairRaw)),
      dAbs: Math.abs(d),
      lnMoneyness: Math.abs(lnSK),           // |ln(S/K)|: 濞夈垹濮╅悳鍥ㄦ￥閸忓磭娈態TC閸嬪繒顬囨惔?
    };
  }

  private evaluateBsEntry(
    dir: string,
    quotedPrice: number,
    secsLeft: number,
    mode: "reactive" | "dual-side" | "trend" | "mispricing" | "counter-win",
    readonly_ = false,
  ): {
    allowed: boolean;
    fairRaw: number;
    fairKelly: number;
    dAbs: number;
    lnMoneyness: number;
    effectiveCost: number;
    effectiveEdge: number;
    reason: string;
  } {
    const { fairRaw, fairKelly, dAbs, lnMoneyness } = this.getBsSnapshot(dir, secsLeft, readonly_);
    const takerFeeBuffer = mode !== "dual-side" ? quotedPrice * TAKER_FEE : 0;
    const slippageBuffer = mode !== "dual-side" ? 0.005 : 0;
    const effectiveCost = quotedPrice + takerFeeBuffer + slippageBuffer;
    const effectiveEdge = fairRaw - effectiveCost;

    let dynamicMinEdge = mode === "trend"
      ? DIRECTIONAL_MIN_POSITIVE_EDGE
      : mode === "mispricing"
        ? MISPRICING_MIN_EDGE
        : mode === "counter-win"
          ? COUNTER_WIN_MIN_EDGE
          : MIN_NET_EDGE;
    if (secsLeft < 300) {
      dynamicMinEdge = Math.max(0.01, dynamicMinEdge - 0.02); 
    } else if (secsLeft > 600) {
      dynamicMinEdge = dynamicMinEdge + (mode === "trend" ? 0.01 : mode === "mispricing" || mode === "counter-win" ? 0.01 : 0.02); 
    }
    if (effectiveEdge < dynamicMinEdge) {
      return { allowed: false, fairRaw, fairKelly, dAbs, lnMoneyness, effectiveCost, effectiveEdge, reason: `net-edge<${(dynamicMinEdge*100).toFixed(0)}%` };
    }
    // Doji濡偓濞? 閻?|ln(S/K)| (BTC閸嬪繒顬囬獮鍛) 閼板矂娼?|d| (锜介埈姝嶈ぐ鎺嶇閸栨牕鎮楅惃鍕偓?
    // 15閸掑棝鎸撻張鐔告綀锜介埈姝嶉埉?.003, BTC閸?15閳娋d|=0.06娴ｅ敗ln(S/K)|=0.00015
    // 閺冄囨閸婄磶d|<0.05鐠囶垱娼? BTC閸?10鐏忚精袝閸欐吀oji (閻摜娲忛崷鐑樻珯BTC閸欘垵鍏樼涵顔肩杽濞屸€炽亣閸?
    // 閺備即妲囬崐? |ln(S/K)|<0.0001 (BTC閸?0.01%閳?10) 閹靛秵妲搁惇鐒弌ji
    if (lnMoneyness < DOJI_LN_MONEYNESS && effectiveEdge < 0.18) {
      return { allowed: false, fairRaw, fairKelly, dAbs, lnMoneyness, effectiveCost, effectiveEdge, reason: "doji-net-edge<18%" };
    }
    // near-doji: BTC閸?0.03% (閳?30) 閳?閺傜懓鎮滄稉宥嗘绾? 鐟曚焦鐪伴弴鎾彯edge
    if (lnMoneyness < NEAR_DOJI_LN_MONEYNESS && effectiveEdge < 0.12) {
      return { allowed: false, fairRaw, fairKelly, dAbs, lnMoneyness, effectiveCost, effectiveEdge, reason: "near-doji-net-edge<12%" };
    }

    return { allowed: true, fairRaw, fairKelly, dAbs, lnMoneyness, effectiveCost, effectiveEdge, reason: "ok" };
  }

  private rankMispricingCandidates(candidates: MispricingCandidate[], secsLeft: number): MispricingCandidate[] {
    return candidates
      .map(candidate => {
        const bs = this.evaluateBsEntry(candidate.dir, candidate.askPrice, secsLeft, "mispricing", true);
        return { candidate, bs };
      })
      .sort((left, right) => {
        if (left.bs.allowed !== right.bs.allowed) return left.bs.allowed ? -1 : 1;
        return right.bs.effectiveEdge - left.bs.effectiveEdge;
      })
      .map(item => item.candidate);
  }

  private shouldTriggerPanicHedge(candidate: MispricingCandidate, candidateDrop: number, secsLeft: number): boolean {
    if (!this.panicHedgeEnabled) return false;
    if (candidate.askPrice <= 0 || candidate.askPrice > PANIC_HEDGE_MAX_ASK) return false;
    if (candidateDrop < PANIC_HEDGE_MIN_DROP && candidate.dumpVelocity !== "fast") return false;
    if (secsLeft < this.rtMinEntrySecs) return false;
    const bs = this.evaluateBsEntry(candidate.dir, candidate.askPrice, secsLeft, "mispricing", true);
    if (!bs.allowed) return false;
    return bs.effectiveEdge >= PANIC_HEDGE_MIN_EDGE;
  }

  private getNetEdgeTier(edge: number): { label: "small" | "normal" | "strong"; multiplier: number } {
    if (edge < MID_NET_EDGE) return { label: "small", multiplier: 0.70 };
    if (edge < HIGH_NET_EDGE) return { label: "normal", multiplier: 1.00 };
    return { label: "strong", multiplier: 1.15 };
  }

  private logBsReject(
    source: string,
    dir: string,
    quotedPrice: number,
    result: {
      fairRaw: number;
      dAbs: number;
      lnMoneyness?: number;
      effectiveCost: number;
      effectiveEdge: number;
      reason: string;
    },
  ): void {
    const rejectKey = `${source}:${dir}:${quotedPrice.toFixed(2)}:${result.reason}`;
    const now = Date.now();
    const lastLogged = this.bsmRejectThrottle.get(rejectKey) ?? 0;
    this.lastBsmRejectReason = `${source}:${dir} ${result.reason} edge=${(result.effectiveEdge * 100).toFixed(1)}%`;
    if (now - lastLogged < 30_000) return; // 閸氬奔绔磌ey濮?0s閸欘亝澧︽稉鈧弶?
    this.bsmRejectThrottle.set(rejectKey, now);
    logger.warn(
      `Leg1 BSM REJECT: ${dir} fair=${result.fairRaw.toFixed(3)} price=${quotedPrice.toFixed(2)} effCost=${result.effectiveCost.toFixed(3)} edge=${(result.effectiveEdge * 100).toFixed(1)}% |d|=${result.dAbs.toFixed(3)} reason=${result.reason}`,
    );
  }

  private getMaxEntryAsk(): number {
    return this.getEffectiveMaxAsk();
  }

  /** 閺傜懓鎮滄穱鈥冲娇娑撳秵褰侀崡鍥у弳閸﹁桨绗傞梽? 娴ｅ簼鐜幍宥嗘Ц閻喐顒滈惃鍒ge */
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
    if (!this.running) return "stopped";
    if (this.hedgeState === "off") return this.status || "waiting for first round data";
    if (this.status.startsWith("鐠哄疇绻?")) return this.status;
    if (this.status === "window expired, no entry") return this.status;
    if (this.hedgeState === "leg1_pending") return "Leg1 pending";
    if (this.hedgeState === "leg1_filled") return "Leg1 filled, waiting settlement";
    if (this.hedgeState === "watching") return this.secondsLeft >= this.rtMinEntrySecs ? "watching entry window" : "entry window closed";
    return this.status || "waiting";
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
    const upTier = upBs ? this.getNetEdgeTier(upBs.effectiveEdge).label : "--";
    const downTier = downBs ? this.getNetEdgeTier(downBs.effectiveEdge).label : "--";
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
      panicHedgeEnabled: this.panicHedgeEnabled,
      trendBias: this.currentTrendBias,
      sessionROI: this.initialBankroll > 0 ? (this.totalProfit / this.initialBankroll) * 100 : 0,
      rolling4hPnL: this.getRolling4hPnL(),
      effectiveMaxAsk: this.getEffectiveMaxAsk(),
      askSum: this.upAsk > 0 && this.downAsk > 0 ? this.upAsk + this.downAsk : 0,
      btcVolatility5m: getRecentVolatility(300),
      dumpConfirmCount: this.dumpConfirmCount,
      dirAlignedCount: this.dirAlignedCount,
      dirContraCount: this.dirContraCount,
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
      upEdgeTier: upTier,
      downEdgeTier: downTier,
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
      // 鏉╂劘顢戦弮璺哄棘閺?(UI閺勫墽銇?
      ...(() => {
        const oi = getOpenInterestInfo();
        const oiRegime = this.getOpenInterestRegime();
        const derivatives = this.currentTrendBias === "flat"
          ? { score: 0, direction: "flat" as const }
          : this.getDerivativesBias(this.currentTrendBias);
        return {
          openInterest: oi.value,
          openInterestChangePct: oi.changePct,
          openInterestDirection: oi.direction,
          openInterestFresh: oi.fresh,
          openInterestRegime: oiRegime.regime,
          derivativesBiasScore: derivatives.score,
          derivativesBiasDirection: derivatives.direction,
        };
      })(),
      rtDumpConfirmCycles: this.rtDumpConfirmCycles,
      rtEntryWindowS: this.rtEntryWindowS,
      rtMinEntrySecs: this.rtMinEntrySecs,
      rtMaxEntryAsk: this.rtMaxEntryAsk,
      rtDualSideMaxAsk: this.rtDualSideMaxAsk,
      rtKellyFraction: this.rtKellyFraction,
      rtPanicHedgeMinDrop: PANIC_HEDGE_MIN_DROP,
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

  // 閳光偓閳光偓 Persistence 閳光偓閳光偓
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
      // 閹镐椒绠欓崠鏍у濞撳懐鎮婃潻鍥ㄦ埂閻ㄥ嫭绮撮崝鈮?L閺夛紕娲?
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

  // 閳光偓閳光偓 Lifecycle 閳光偓閳光偓

  getHistoryFilePath(): string {
    return this.historyFile;
  }

  async start(options: Hedge15mStartOptions = {}): Promise<void> {
    if (this.running) throw new Error("Hedge15m already running");
    this.tradingMode = options.mode || "live";
    this.paperSessionMode = options.paperSessionMode === "persistent" ? "persistent" : "session";
    this.historyFile = this.tradingMode === "paper" ? PAPER_HISTORY_FILE : HISTORY_FILE;

    // 閳光偓閳光偓 鎼存梻鏁ゆ潻鎰攽閺冭泛寮弫?閳光偓閳光偓
    this.rtDumpConfirmCycles = options.dumpConfirmCycles ?? DUMP_CONFIRM_CYCLES;
    const ewPreset = options.entryWindowPreset ?? "medium";
    if (ewPreset === "short") { this.rtEntryWindowS = 360; this.rtMinEntrySecs = 360; }
    else if (ewPreset === "long") { this.rtEntryWindowS = 660; this.rtMinEntrySecs = 180; }
    else { this.rtEntryWindowS = ENTRY_WINDOW_S; this.rtMinEntrySecs = MIN_ENTRY_SECS; }
    this.rtMaxEntryAsk = options.maxEntryAsk ?? MAX_ENTRY_ASK;
    this.rtDualSideMaxAsk = options.dualSideMaxAsk ?? DUAL_SIDE_MAX_ASK;
    this.rtKellyFraction = options.kellyFraction ?? KELLY_FRACTION;
    this.panicHedgeEnabled = options.panicHedgeEnabled ?? PANIC_HEDGE_ENABLED_DEFAULT;
    logger.info(`RT params: dumpConfirm=${this.rtDumpConfirmCycles} window=${ewPreset}(${this.rtEntryWindowS}s) maxAsk=$${this.rtMaxEntryAsk} dualAsk=$${this.rtDualSideMaxAsk} kelly=${this.rtKellyFraction} panicHedge=${this.panicHedgeEnabled}`);

    resetExecutionTelemetry();
    this.loopRunId += 1;
    const runId = this.loopRunId;
    this.running = true;
    this.status = this.tradingMode === "paper" ? "娴犺法婀￠惄妯跨箾閹恒儰鑵?.." : "鏉╃偞甯存稉?..";
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
      this.status = "idle";
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
      startLatencyMonitor(); // 娴兼ê鍘涢崥顖氬З, 閸︺劏绻涢幒銉ョ紦缁斿婀￠梻瀵感濈槐顖氭鏉╃喐鐗遍張?
      await startPriceFeed();
      this.servicesStarted = true;
    }

    this.status = "ready";
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

    // 閳光偓閳光偓 瀹曗晜绨濋幁銏狀槻: 濡偓閺屻儰绗傚▎鈩冩Ц閸氾附婀侀張顏嗙波缁犳娈戦幐浣风波 閳光偓閳光偓
    if (persistedPaperState?.openPosition && persistedPaperState.openPosition.leg1Shares > 0) {
      const pos = persistedPaperState.openPosition;
      // 濡偓閺屻儲瀵旀禒鎾存Ц閸氾箒绻冮張?(鐡掑懓绻?5閸掑棝鎸撳鑼波缁?
      const ageMs = Date.now() - pos.filledAt;
      if (ageMs < 20 * 60_000) { // 20min閸愬懐娈戦幐浣风波閸欘垵鍏樻潻妯烘躬缂佹挾鐣绘稉?
        logger.warn(`CRASH RECOVERY: found open position ${pos.leg1Dir.toUpperCase()} ${pos.leg1Shares}娴?@${pos.leg1FillPrice.toFixed(2)} from ${Math.floor(ageMs/1000)}s ago`);
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
        this.status = `閹垹顦查幐浣风波: ${pos.leg1Dir.toUpperCase()} @${pos.leg1FillPrice.toFixed(2)} x${pos.leg1Shares}`;
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
      this.status = `閼锋潙鎳￠柨娆掝嚖: ${e.message}`;
      this.running = false;
      if (this.trader) this.trader.cancelAll().catch(() => {});
    });
  }

  stop(): void {
    this.loopRunId += 1;
    this.running = false;
    this.status = "stopped";
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
          // 婵″倹鐏夐幓鎰返娴滃棝顣╅張鐔风俺缁?(濮ｆ柨顩ч崚姘辩波缁犳鐣担鍡涙懠娑撳﹤娆㈡潻鐔哥梾閸掓媽澶?, 閸掓瑥褰囨潻娆庤⒈閼板懐娈戞径褍鈧?
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
    logger.warn(`refreshBalance: 3濞嗏€崇毦鐠囨洖娼庢潻鏂挎礀0, 娣囨繄鏆€閺堫剙婀存担娆擃杺 $${this.balance.toFixed(2)}`);
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
    this.dirAlignedCount = 0;
    this.dirContraCount = 0;
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
    this.emaVolAnnual = 0; // 濮ｅ繗鐤嗛柌宥囩枂, 闁灝鍘ゆ稉濠呯枂閺嬩胶顏▔銏犲З閻滃洦钖勯弻?
    this.emaVolWarmup = 0;
    this.resetRoundRejectStats();
  }

  // 閳光偓閳光偓 Main Loop 閳光偓閳光偓

  private async mainLoop(runId: number): Promise<void> {
    const trader = this.trader!;
    let curCid = "";
    let firstObservedRound = true;

    while (this.isActiveRun(runId)) {
      try {


        const rnd = await getCurrentRound15m();
        if (!this.isActiveRun(runId)) break;
        if (!rnd) {
          this.status = "閺?5閸掑棝鎸撶敮鍌氭簚,缁涘绶熸稉?..";
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
          const isBootRound = firstObservedRound;
          firstObservedRound = false;
          if (curCid && this.totalCost > 0) {
            await this.settleHedge();
          }
          curCid = cid;
          this.resetRoundState();
          this.status = "waiting for market data";
          this.upAsk = 0;
          this.downAsk = 0;
          await trader.cancelAll();
          await this.refreshBalance();
          this.totalRounds++;
          this.roundStartBtcPrice = getBtcPrice();
          setRoundStartPrice(); // 閸氬本顒炵拋鍓х枂 btcPrice 濡€虫健閻ㄥ嫬娲栭崥鍫濈唨閸?
          this.negRisk = !!rnd.negRisk;

          // 閳光偓閳光偓 鐠у嫰鍣剧€瑰鍙忕€瑰牊濮?閳光偓閳光偓
          if (this.balance < MIN_BALANCE_TO_TRADE) {
            this.hedgeState = "done";
            this.status = `閺嗗倸浠? 娴ｆ瑩顤?${this.balance.toFixed(2)} < $${MIN_BALANCE_TO_TRADE}`;
            this.skips++;
            logger.warn(`CAPITAL GUARD: balance $${this.balance.toFixed(2)} < $${MIN_BALANCE_TO_TRADE}, skipping round`);
            this.writeRoundAudit("round-skip-capital", { reason: "low-balance", balance: this.balance });
          } else if (this.initialBankroll > 0 && this.sessionProfit < -(this.initialBankroll * MAX_SESSION_LOSS_PCT)) {
            this.hedgeState = "done";
            this.status = `Skip: session loss ${Math.abs(this.sessionProfit).toFixed(2)} > ${(MAX_SESSION_LOSS_PCT * 100).toFixed(0)}%`;
            this.skips++;
            logger.warn(`CAPITAL GUARD: session loss $${this.sessionProfit.toFixed(2)} exceeds ${(MAX_SESSION_LOSS_PCT * 100).toFixed(0)}% of bankroll $${this.initialBankroll.toFixed(2)}, skipping`);
            this.writeRoundAudit("round-skip-capital", { reason: "session-loss-limit", sessionProfit: this.sessionProfit, initialBankroll: this.initialBankroll });
          } else if (isBootRound && (ROUND_DURATION - secs) > BOOT_ROUND_MAX_ELAPSED) {
            this.hedgeState = "done";
            this.status = `Skip: boot elapsed ${Math.floor(ROUND_DURATION - secs)}s > ${BOOT_ROUND_MAX_ELAPSED}s`;
            this.skips++;
            logger.info(`HEDGE15M SKIP BOOT MID-ROUND: elapsed ${Math.floor(ROUND_DURATION - secs)}s > ${BOOT_ROUND_MAX_ELAPSED}s, waiting next round`);
            this.writeRoundAudit("round-skip-boot-midround", { elapsed: ROUND_DURATION - secs, secondsLeft: secs, maxBootElapsed: BOOT_ROUND_MAX_ELAPSED, negRisk: this.negRisk });
          } else if (this.consecutiveLosses >= CONSECUTIVE_LOSS_PAUSE) {
            // 鏉╃偘绨埉?: 娑撳秴鍟€鐎瑰苯鍙忕捄瀹犵箖, 閼板本妲告禒銉︽付娴ｅ簼绮ㄦ担?鑴?.4)缂佈呯敾娴溿倖妲?閳?JSONL閺佺増宓佺拠浣规娴ｅ簼鐜崗銉ユ簚闂€鎸庢埂EV+
            const cLossScale = Math.max(0.4, Math.pow(0.85, this.consecutiveLosses));
            logger.warn(`CAPITAL GUARD: ${this.consecutiveLosses} consecutive losses, Kelly scaled to ${(cLossScale*100).toFixed(0)}% (continuing with reduced size)`);
          }
          // 鐠哄疇绻冮崜鈺€缍戦弮鍫曟？娑撳秷鍐婚惃鍕礀閸?閳?閺冪姵纭剁€瑰本鍨?dump濡偓濞?+ 鐎电懓鍟?
          else if (secs < this.rtMinEntrySecs) {
            this.hedgeState = "done";
            this.status = `Skip: ${Math.floor(secs)}s < ${this.rtMinEntrySecs}s`;
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

        // 閳烘劏鏅查埡?State Machine 閳烘劏鏅查埡?

        if (this.hedgeState === "watching") {
          this.status = `閻╂垶甯堕惍鍝ユ磸 (${Math.floor(elapsed)}/${this.rtEntryWindowS}s)`;

          if (this.upAsk > 0 && this.downAsk > 0) {
            const { dumpWindowMs, dumpBaselineMs } = getDynamicParams();
            this.marketState.push(this.upAsk, this.downAsk, dumpWindowMs + 500);
            this.currentTrendBias = this.getRoundDirectionalBias();

            // 閳光偓閳光偓 閸欏奔鏅舵０鍕瘯閸楁洖浠涚敮? 濡偓閺屻儲鍨氭禍?+ 閸掗攱鏌婇幐鍌氬礋 閳光偓閳光偓
            await this.manageDualSideOrders(trader, rnd, secs);
            if (this.hedgeState !== "watching") {
              // 妫板嫭瀵曢崡鏇熷灇娴溿倛娴嗛崗?leg1_filled, 鐠哄疇绻僤ump濡偓濞?
            } else {

            const dumpBaseline = this.marketState.getDumpBaseline(dumpBaselineMs);
            if (dumpBaseline) {
              const shortMomentum = getRecentMomentum(MOMENTUM_WINDOW_SEC);
              const trendMomentum = getRecentMomentum(TREND_WINDOW_SEC);
              const directionalBias = this.getRoundDirectionalBias();
              this.currentTrendBias = directionalBias;
              await this.maybeEnterDirectionalLeg1(trader, rnd);
              if (this.hedgeState !== "watching") {
                continue;
              }

              // 娴ｅ簼鐜担宥呭З閹線妾锋担宸噓mp闂冨牆鈧? ask瀹歌尙绮℃笟鍨杹閺冩湹绗夐棁鈧粵澶娿亣鐠哄苯绠?
              const lowestAsk = Math.min(this.upAsk, this.downAsk);
              const effectiveDumpThreshold = lowestAsk <= DUMP_LOW_PRICE_CUTOFF ? DUMP_THRESHOLD_LOW_PRICE : DUMP_THRESHOLD;

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
              });
              mispricing.candidates = this.rankMispricingCandidates(mispricing.candidates, secs);

              if (mispricing.bothSidesDumping) {
                // 閸欏奔鏅堕柈钘夋躬dump: 閻滄澘婀猚andidates瀹歌尙绮℃潻鍥箖濠?momentum/dumpRatio/鐎甸€涙櫠)
                // 娴犲氦绻冨銈呮倵閻ㄥ垻andidates娑擃參鈧TC閺傜懓鎮滄稉鈧懛瀵告畱; 閺冪姴鈧瑩鈧鍨捄瀹犵箖
                const btcDir = getBtcDirection();
                const btcAlignedDir: "up" | "down" = btcDir === "up" ? "up" : "down";
                // 娴兼ê鍘汢TC閺傜懓鎮滄稉鈧懛瀵告畱閸婃瑩鈧? 閸忚埖顐肩捄灞界畽閺堚偓婢堆呮畱(瀹稿弶瀵滅捄灞界畽閹烘帒绨?
                const bestCandidate = mispricing.candidates[0];
                const aligned = bestCandidate?.dir === btcAlignedDir;
                if (bestCandidate) {
                  const maxAsk = this.getMaxEntryAsk();
                  if (bestCandidate.askPrice > 0 && bestCandidate.askPrice <= maxAsk && bestCandidate.askPrice >= MISPRICING_ABSOLUTE_MIN_ASK) {
                    logger.info(`HEDGE15M BOTH DUMP 閳?picking ${bestCandidate.dir.toUpperCase()} @${bestCandidate.askPrice.toFixed(2)} (BTC=${btcDir}${aligned ? " aligned" : " best-ev"}) (UP -${(dumpBaseline.upDrop*100).toFixed(1)}%, DN -${(dumpBaseline.downDrop*100).toFixed(1)}%)`);
                    this.dumpDetected = `BOTH-DUMP 閳?${bestCandidate.dir.toUpperCase()} @${bestCandidate.askPrice.toFixed(2)}`;
                    this.currentDumpDrop = bestCandidate.dir === "up" ? dumpBaseline.upDrop : dumpBaseline.downDrop;
                    this.currentDumpVelocity = bestCandidate.dumpVelocity;
                    this.activeStrategyMode = "mispricing";
                    const buyToken = rnd[bestCandidate.buyTokenKey];
                    await this.buyLeg1(trader, rnd, bestCandidate.dir, bestCandidate.askPrice, buyToken);
                  } else {
                    logger.warn(`HEDGE15M SKIP: both dump candidate ${bestCandidate.dir.toUpperCase()} @${bestCandidate.askPrice.toFixed(2)} outside ask range`);
                  }
                } else {
                  // 閹碘偓閺堝鈧瑩鈧鍏樼悮顐ョ箖濠娿倖甯€娴?(momentum/repricing reject)
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
                  logger.warn(`HEDGE15M CAUTION: ${mispricing.cautionMessage} 閳?proceeding with low ask`);
                }
                if (mispricing.momentumRejects.length > 0) {
                  // 閸樺鍣? 閸欘亞鏁ら弬鐟版倻閸?key (DN dump / UP dump), 娑撳秴鎯堥弫鏉库偓?
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
                  const candidateDrop = candidate.dir === "up" ? dumpBaseline.upDrop : dumpBaseline.downDrop;
                  if (this.shouldTriggerPanicHedge(candidate, candidateDrop, secs)) {
                    this.dumpDetected = `PANIC HEDGE ${candidate.dir.toUpperCase()} ${candidate.askPrice.toFixed(2)} drop=${(candidateDrop * 100).toFixed(1)}%`;
                    this.currentDumpDrop = candidateDrop;
                    this.currentDumpVelocity = candidate.dumpVelocity;
                    this.activeStrategyMode = "panic-hedge";
                    logger.info(`HEDGE15M PANIC HEDGE: ${candidate.dir.toUpperCase()} @${candidate.askPrice.toFixed(2)} drop=${(candidateDrop * 100).toFixed(1)}% vel=${candidate.dumpVelocity}`);
                    await this.buyLeg1(trader, rnd, candidate.dir, candidate.askPrice, rnd[candidate.buyTokenKey], "panic-hedge", "panic-hedge");
                    if (this.hedgeState !== "watching") {
                      continue;
                    }
                  }

                  const dynamicMinAsk = MISPRICING_ABSOLUTE_MIN_ASK;
                  if (candidate.askPrice < dynamicMinAsk) {
                    const skipKey = `minask:${candidate.dir}:${candidate.askPrice.toFixed(2)}`;
                    if (skipKey !== this.lastEntrySkipKey) {
                      this.lastEntrySkipKey = skipKey;
                      logger.warn(`Hedge15m Leg1 skipped (dynamic floor): ask=${candidate.askPrice.toFixed(2)} < floor=${dynamicMinAsk} (elapsed=${Math.floor(elapsed)}s)`);
                    }
                  }
                  // ???? ?????????: ask???MAX_ENTRY_ASK?????? ????
                  else if (candidate.askPrice > this.getMaxEntryAsk()) {
                    const skipKey = `maxask:${candidate.dir}:${candidate.askPrice.toFixed(2)}`;
                    if (skipKey !== this.lastEntrySkipKey) {
                      this.lastEntrySkipKey = skipKey;
                      logger.warn(`Hedge15m Leg1 skipped: ask=${candidate.askPrice.toFixed(2)} > MAX_ENTRY_ASK=${this.getMaxEntryAsk()}`);
                    }
                    this.roundEntryAskRejects += 1;
                  }
                  // ???? #5 ?????????: ???????30s??????????????????
                  else if (elapsed < MIN_ENTRY_ELAPSED) {
                    this.trackRoundRejectReason(`early_entry: elapsed=${Math.floor(elapsed)}s < ${MIN_ENTRY_ELAPSED}s`);
                    if (!this._earlyEntryLoggedThisRound) {
                      this._earlyEntryLoggedThisRound = true;
                      logger.info(`HEDGE15M EARLY: elapsed=${Math.floor(elapsed)}s < ${MIN_ENTRY_ELAPSED}s ??waiting for stable data`);
                    }
                  } else {
                    // ???? #4 ?????????: ????? N ??ycle???dump?????????
                    if (candidate.dir === this.lastDumpCandidateDir) {
                      this.dumpConfirmCount++;
                    } else {
                      this.dumpConfirmCount = 1;
                      this.lastDumpCandidateDir = candidate.dir;
                    }
                    // ????????????ligned)?????????????dump?????
                    this.computeSignalAlignment(candidate.dir);
                    const strongMispricingCandidate = candidateDrop >= MISPRICING_STRONG_DROP || candidate.askPrice <= MISPRICING_LOW_PRICE;
                    const candidateBs = this.evaluateBsEntry(candidate.dir, candidate.askPrice, secs, "mispricing", true);
                    const edgeFastTrack = candidateBs.effectiveEdge >= MISPRICING_FAST_LANE_EDGE;
                    const signalFastTrack = strongMispricingCandidate || edgeFastTrack || (this.dirAlignedCount >= 3 && this.dirContraCount <= 2);
                    if (!signalFastTrack && this.dumpConfirmCount < this.rtDumpConfirmCycles) {
                      // ?????????????????????, ?????                    } else {
                      const counterEntered = await this.maybeEnterCounterWin(trader, rnd, candidate, candidateBs);
                      if (counterEntered) {
                        continue;
                      }
                      // ???? #2 Sum???????? ??????????????? ????
                      const currentSum = this.upAsk + this.downAsk;
                      const candDrop = candidateDrop;
                      // ??ump(??2%)?????um???: ????????????????? sum??????edge
                      const effectiveSumMax = candDrop >= 0.12 ? SUM_DIVERGENCE_RELAXED : SUM_DIVERGENCE_MAX;
                      if (currentSum > effectiveSumMax) {
                        this.trackRoundRejectReason(`sum_high: ${currentSum.toFixed(2)} > ${effectiveSumMax}`);
                        const sumKey = currentSum.toFixed(2);
                        if (sumKey !== this.lastDumpLogKey) {
                          this.lastDumpLogKey = sumKey;
                          logger.warn(`HEDGE15M SKIP: sum=${currentSum.toFixed(2)} > ${effectiveSumMax}${candDrop >= 0.12 ? " (relaxed)" : ""} ??no mispricing edge`);
                        }
                      } else {
                        // ???? ???: ?????? ????
                        const btcDir = getBtcDirection();
                        this.dumpDetected = candidate.dumpDetected;
                        this.currentDumpDrop = candidateDrop;
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
                          logger.info(`HEDGE15M DUMP${mispricing.candidates.length > 1 ? ` (??{candidate.dir.toUpperCase()})` : ""}${currentSum <= SUM_DIVERGENCE_MIN ? " [?????" : ""}: ${this.dumpDetected} (sum=${currentSum.toFixed(2)} BTC=${btcDir} flow=${flow.ratio.toFixed(2)}/${flow.direction} depth=${depth.ratio.toFixed(2)}/${depth.direction} liq=${liq.direction}/${liq.intensity})`);
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
                  // ?????????????????
                  this.dumpConfirmCount = 0;
                  this.lastDumpCandidateDir = "";
                }

              }
            }
            } // end dual-side pre-order guard
          }

          // Window expired
          if (elapsed >= this.rtEntryWindowS && this.hedgeState === "watching") {
            // 缁愭褰涢崚鐗堟埂, 閸欐牗绉锋０鍕瘯閸?(濡偓閺屻儲妲搁崥锕€婀崣鏍ㄧХ閸撳秷顫﹂幋鎰唉)
            if (this.preOrderUpId || this.preOrderDownId) {
              const ghostFilled = await this.cancelDualSideOrders(trader);
              if (ghostFilled) {
                logger.info(`HEDGE15M window expiry: pre-order ghost fill detected, holding to settlement`);
              }
            }
            if (this.hedgeState === "watching") {
              this.hedgeState = "done";
              this.status = "window expired, no entry";
              this.skips++;
              this.logRoundRejectSummary("window expired without entry");
            }
          }
        }

        if (this.hedgeState === "leg1_filled") {
          // 閳光偓閳光偓 閺傜懓鎮滈幀褏鐡ラ悾? 缁绢垱瀵旈張澶婂煂缂佹挾鐣? 闂嗘湹鑵戦柅鏂垮叡妫?閳光偓閳光偓
          // 閸忋儱婧€娴犲皝澧?0.35, 閸楀厖濞?0%闂呭繑婧€閼虫粎宸兼稊鐑+$0.15/share
          // 閸楁牕鍤憰浣风帛2% taker fee, 閹镐焦婀侀崚鎵波缁?0 fee 閳?娴犺缍嶆稉顓⑩偓鏂垮礌閸戞椽鍏橀弰鐤嶸-
          const entryPrice = this.leg1FillPrice > 0 ? this.leg1FillPrice : this.leg1Price;
          const secsHeld = this.leg1FilledAt > 0 ? (Date.now() - this.leg1FilledAt) / 1000 : 0;
          const sourceTag = this.leg1EntrySource === "dual-side-preorder" ? "pre" : "reactive";
          this.status = `Holding [${sourceTag}]: ${this.leg1Dir.toUpperCase()} @$${entryPrice.toFixed(2)} ${this.leg1Shares}sh EV+$${(this.leg1Shares * (1 - entryPrice)).toFixed(2)} ${secs.toFixed(0)}s -> wait settle`;
        }

        // 閸ョ偛鎮庨張鈧崥?0缁? 妫板嫬濮炴潪鎴掔瑓娑撯偓鏉烆喖绔堕崷?
        // 閸ョ偛鎮庨張鈧崥?0缁? 妫板嫬濮炴潪鎴掔瑓娑撯偓鏉烆喖绔堕崷鐚寸礉濞戝牓娅庢稉瀣枂閸掑洦宕查弮鍓佹畱閸愬嘲鎯庨崝銊ユ鏉?
        if (secs <= 30 && secs > 0) {
          prefetchNextRound().catch(() => {});
        }

        // Near settlement
        if (secs <= 5 && secs > 0 && this.totalCost > 0) {
          this.status = "閸楀啿鐨㈢紒鎾剁暬...";
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
        await trader.waitForOrderbookUpdate(
          loopVersion,
          this.hedgeState === "watching" ? aggressiveWatchMs : idlePollMs,
        );

      } catch (e: any) {
        if (!this.isActiveRun(runId)) break;
        logger.error(`Hedge15m loop error: ${e.message}`);
        await sleep(5000);
      }
    }
  }

  // 閳光偓閳光偓 Trading Actions 閳光偓閳光偓

  private async maybeEnterDirectionalLeg1(trader: Trader, rnd: Round15m): Promise<void> {
    if (!DIRECTIONAL_REACTIVE_ENABLED) return;
    if (this.hedgeState !== "watching" || this.leg1EntryInFlight || this.leg1AttemptedThisRound) return;

    const dir = this.currentTrendBias;
    if (dir === "flat") return;

    const askPrice = dir === "up" ? this.upAsk : this.downAsk;
    const buyToken = dir === "up" ? rnd.upToken : rnd.downToken;
    if (askPrice <= 0 || !buyToken) return;

    const btcMovePct = getBtcMovePct();
    const shortMomentum = getRecentMomentum(60);
    const trendMomentum = getRecentMomentum(TREND_WINDOW_SEC);
    const isChasingImpulse = (dir === "up" && shortMomentum >= DIRECTIONAL_CHASE_MOMENTUM)
      || (dir === "down" && shortMomentum <= -DIRECTIONAL_CHASE_MOMENTUM);
    const maxTrendAsk = isChasingImpulse ? DIRECTIONAL_TREND_PULLBACK_MAX_ASK : DIRECTIONAL_TREND_MAX_ASK;
    if (btcMovePct < DIRECTIONAL_TREND_MIN_BTC_MOVE) return;
    if (askPrice > maxTrendAsk) {
      const skipKey = `dir-ask:${dir}:${askPrice.toFixed(2)}:${isChasingImpulse ? "impulse" : "trend"}`;
      if (skipKey !== this.lastSignalSkipKey) {
        this.lastSignalSkipKey = skipKey;
        logger.info(`HEDGE15M DIRECTIONAL WAIT: ${dir.toUpperCase()} ask=${askPrice.toFixed(2)} > ${maxTrendAsk.toFixed(2)}${isChasingImpulse ? " (impulse pullback)" : ""}`);
      }
      return;
    }

    const bsEntry = this.evaluateBsEntry(dir, askPrice, rnd.secondsLeft, "trend", true);
    if (!bsEntry.allowed || bsEntry.effectiveEdge < DIRECTIONAL_TREND_MIN_EDGE) {
      this.trackRoundRejectReason(`trend-edge: ${(bsEntry.effectiveEdge * 100).toFixed(1)}% < ${(DIRECTIONAL_TREND_MIN_EDGE * 100).toFixed(0)}%`);
      const skipKey = `dir-edge:${dir}:${askPrice.toFixed(2)}:${Math.floor(bsEntry.effectiveEdge * 1000)}`;
      if (skipKey !== this.lastSignalSkipKey) {
        this.lastSignalSkipKey = skipKey;
        logger.info(`HEDGE15M DIRECTIONAL SKIP: ${dir.toUpperCase()} edge ${(bsEntry.effectiveEdge * 100).toFixed(1)}% < ${(DIRECTIONAL_TREND_MIN_EDGE * 100).toFixed(0)}% fair=${bsEntry.fairRaw.toFixed(3)} ask=${askPrice.toFixed(2)}`);
      }
      return;
    }

    logger.info(`HEDGE15M DIRECTIONAL ENTRY: ${dir.toUpperCase()} ask=${askPrice.toFixed(2)} edge=${(bsEntry.effectiveEdge * 100).toFixed(1)}% BTCmove=${(btcMovePct * 100).toFixed(3)}% m60=${(shortMomentum * 100).toFixed(3)}% m180=${(trendMomentum * 100).toFixed(3)}%`);

    await this.buyLeg1(trader, rnd, dir, askPrice, buyToken, "trend", "directional-reactive");
  }

  private async maybeEnterCounterWin(
    trader: Trader,
    rnd: Round15m,
    weakCandidate: MispricingCandidate,
    weakCandidateBs: { effectiveEdge: number },
  ): Promise<boolean> {
    if (!COUNTER_WIN_ENABLED) return false;
    if (this.hedgeState !== "watching" || this.leg1EntryInFlight || this.leg1AttemptedThisRound) return false;
    if (weakCandidateBs.effectiveEdge >= MISPRICING_NORMAL_EDGE) return false;

    const counterDir: "up" | "down" = weakCandidate.dir === "up" ? "down" : "up";
    const counterAsk = counterDir === "up" ? this.upAsk : this.downAsk;
    const counterToken = counterDir === "up" ? rnd.upToken : rnd.downToken;
    if (!counterToken || counterAsk < COUNTER_WIN_MIN_ASK || counterAsk > COUNTER_WIN_MAX_ASK) return false;

    const weakScore = this.dirAlignedCount - this.dirContraCount;
    const trendSupportsCounter = this.currentTrendBias === counterDir;
    const signalsRejectWeakSide = weakScore <= -1;
    if (!trendSupportsCounter && !signalsRejectWeakSide) return false;

    const counterBs = this.evaluateBsEntry(counterDir, counterAsk, rnd.secondsLeft, "counter-win", true);
    if (!counterBs.allowed) {
      this.logBsReject("counter-win", counterDir, counterAsk, counterBs);
      return false;
    }

    const deriv = this.getDerivativesBias(counterDir);
    if (deriv.contra >= 2 && deriv.aligned === 0 && counterBs.effectiveEdge < COUNTER_WIN_STRONG_EDGE) {
      this.trackRoundRejectReason(`counter-deriv-contra: edge=${(counterBs.effectiveEdge * 100).toFixed(1)}%`);
      return false;
    }

    logger.info(
      `HEDGE15M COUNTER-WIN: ${counterDir.toUpperCase()} @${counterAsk.toFixed(2)} edge=${(counterBs.effectiveEdge * 100).toFixed(1)}% vs weak ${weakCandidate.dir.toUpperCase()} edge=${(weakCandidateBs.effectiveEdge * 100).toFixed(1)}% trend=${this.currentTrendBias} score=${weakScore}`,
    );
    await this.buyLeg1(trader, rnd, counterDir, counterAsk, counterToken, "counter-win", "counter-win");
    return this.hedgeState !== "watching" || this.leg1EntryInFlight || this.leg1AttemptedThisRound;
  }

  private async buyLeg1(
    trader: Trader,
    rnd: Round15m,
    dir: string,
    askPrice: number,
    buyToken: string,
    strategyMode: "mispricing" | "trend" | "counter-win" | "panic-hedge" = "mispricing",
    entrySource = "reactive-mispricing",
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

    // 閳光偓閳光偓 Leg1娴犻攱鐗告稉濠囨: 閸欘亝甯撮崣妤勫喕婢剁喍缍嗘禒椋庢畱EV+閸忋儱婧€, 瀵桨淇婇崣閿嬫閸斻劍鈧焦褰侀崡?閳光偓閳光偓
    const isMispricingLike = strategyMode === "mispricing" || strategyMode === "panic-hedge";
    const maxEntryAsk = strategyMode === "counter-win"
      ? COUNTER_WIN_MAX_ASK
      : strategyMode === "panic-hedge"
        ? Math.min(this.getDynamicMaxEntryAsk(dir), PANIC_HEDGE_MAX_ASK)
        : this.getDynamicMaxEntryAsk(dir);
    const directionalBias = this.getRoundDirectionalBias();

    const plan = planHedgeEntry({
      dir: dir as "up" | "down",
      askPrice,
      maxEntryAsk,
      minEntryAsk: strategyMode === "counter-win" ? COUNTER_WIN_MIN_ASK : isMispricingLike ? MISPRICING_ABSOLUTE_MIN_ASK : rnd.secondsLeft > 660 ? 0.20 : rnd.secondsLeft > 480 ? 0.15 : MIN_ENTRY_ASK,
      directionalBias,
      allowDirectionalContra: strategyMode !== "trend",
    });
    if (!plan.allowed) {
      if (plan.reason?.includes("MAX_ENTRY_ASK")) this.roundEntryAskRejects += 1;
      this.trackRoundRejectReason(`plan: ${plan.reason}`);
      // 閸欘亜婀＃鏍偧閹存牔鐜弽鐓庡綁閸栨牗妞傞幍鎾存）韫? 闁灝鍘ら崥灞肩幆閺嶇厧寮芥径宥呭煕鐏?
      const skipKey = `${dir}:${askPrice.toFixed(2)}`;
      if (skipKey !== this.lastEntrySkipKey) {
        this.lastEntrySkipKey = skipKey;
        logger.warn(`Hedge15m Leg1 skipped: ${plan.reason}`);
      }
      return;
    }

    // 閳光偓閳光偓 缂佺喕顓?濠ф劒淇婇崣宄邦嚠姒绘劕瀹?閳光偓閳光偓
    this.computeSignalAlignment(dir);

    // 閳光偓閳光偓 娴ｅ孩灏濇潻鍥ㄦ姢: reactive閸︺劌浜曠悰灞惧剰娑擃厼娅旀竟鐗堢€? 閻╁瓨甯寸捄瀹犵箖 閳光偓閳光偓
    const reactiveVol = getRecentVolatility(300);
    const strongMispricing = isMispricingLike && (this.currentDumpDrop >= MISPRICING_STRONG_DROP || askPrice <= MISPRICING_LOW_PRICE);
    if (strategyMode !== "counter-win" && !strongMispricing && reactiveVol < REACTIVE_MIN_VOL) {
      this.trackRoundRejectReason(`reactive-low-vol: ${(reactiveVol * 100).toFixed(3)}% < ${(REACTIVE_MIN_VOL * 100).toFixed(2)}%`);
      const skipKey = `reactive-vol:${dir}:${Math.floor(reactiveVol * 100000)}`;
      if (skipKey !== this.lastSignalSkipKey) {
        this.lastSignalSkipKey = skipKey;
        logger.info(`HEDGE15M REACTIVE SKIP: vol=${(reactiveVol * 100).toFixed(3)}% < ${(REACTIVE_MIN_VOL * 100).toFixed(2)}%`);
      }
      return;
    }

    // 閳光偓閳光偓 BSM閺佹澘鐡ч張鐔告綀閸斻劍鈧浇鍎ㄩ悳?閳光偓閳光偓
    const bsEntry = this.evaluateBsEntry(
      dir,
      askPrice,
      rnd.secondsLeft,
      strategyMode === "trend" ? "trend" : strategyMode === "counter-win" ? "counter-win" : "mispricing",
    );
    if (!bsEntry.allowed) {
      this.trackRoundRejectReason(`bsm: ${bsEntry.reason}`);
      this.logBsReject("reactive", dir, askPrice, bsEntry);
      return;
    }
    const bsFairRaw = bsEntry.fairRaw;
    const bsWinRate = bsEntry.fairKelly;
    const bsEdgeNet = bsEntry.effectiveEdge;
    const dojiRegime = bsEntry.lnMoneyness < DOJI_LN_MONEYNESS ? "doji" : bsEntry.lnMoneyness < NEAR_DOJI_LN_MONEYNESS ? "near-doji" : "directional";
    if (
      isMispricingLike &&
      dojiRegime === "doji" &&
      rnd.secondsLeft > EARLY_DOJI_SECS_LEFT &&
      this.currentDumpDrop < EARLY_DOJI_MIN_DROP
    ) {
      this.trackRoundRejectReason(`early-doji-weak-dump: drop ${(this.currentDumpDrop * 100).toFixed(1)}% < ${(EARLY_DOJI_MIN_DROP * 100).toFixed(0)}%`);
      const skipKey = `early-doji:${dir}:${Math.floor(rnd.secondsLeft)}:${Math.floor(this.currentDumpDrop * 1000)}`;
      if (skipKey !== this.lastSignalSkipKey) {
        this.lastSignalSkipKey = skipKey;
        logger.info(`HEDGE15M MISPRICING SKIP: early doji ${Math.floor(rnd.secondsLeft)}s drop ${(this.currentDumpDrop * 100).toFixed(1)}% < ${(EARLY_DOJI_MIN_DROP * 100).toFixed(0)}% edge ${(bsEdgeNet * 100).toFixed(1)}%`);
      }
      return;
    }
    if (isMispricingLike && rnd.secondsLeft > EARLY_SMALL_EDGE_SECS_LEFT) {
      const shortMomentum = getRecentMomentum(MOMENTUM_WINDOW_SEC);
      const counterShortMomentum = (dir === "up" && shortMomentum < 0) || (dir === "down" && shortMomentum > 0);
      const earlyMinEdge = counterShortMomentum ? EARLY_COUNTER_MOMENTUM_MIN_EDGE : EARLY_SMALL_EDGE_MIN_EDGE;
      if (bsEdgeNet < earlyMinEdge) {
        this.trackRoundRejectReason(`early-small-edge: ${(bsEdgeNet * 100).toFixed(1)}% < ${(earlyMinEdge * 100).toFixed(0)}%`);
        const skipKey = `early-edge:${dir}:${Math.floor(rnd.secondsLeft)}:${Math.floor(bsEdgeNet * 1000)}`;
        if (skipKey !== this.lastSignalSkipKey) {
          this.lastSignalSkipKey = skipKey;
          logger.info(`HEDGE15M MISPRICING SKIP: early ${Math.floor(rnd.secondsLeft)}s edge ${(bsEdgeNet * 100).toFixed(1)}% < ${(earlyMinEdge * 100).toFixed(0)}%${counterShortMomentum ? " (counter-momentum)" : ""}`);
        }
        return;
      }
    }
    if (isMispricingLike) {
      const btcDir = getBtcDirection();
      const btcMovePct = getBtcMovePct();
      const counterBtc = btcMovePct >= MISPRICING_COUNTER_BTC_MOVE && btcDir !== dir;
      const alignmentScore = this.dirAlignedCount - this.dirContraCount;
      const strongCounterSignal = alignmentScore <= MISPRICING_STRONG_CONTRA_SCORE && counterBtc;
      const deepUnfavored = bsFairRaw < MISPRICING_DEEP_UNFAVORED_FAIR;
      const unfavored = bsFairRaw < MISPRICING_UNFAVORED_FAIR;
      const requiredCounterEdge = deepUnfavored
        ? MISPRICING_DEEP_UNFAVORED_MIN_EDGE
        : strongCounterSignal && askPrice > MISPRICING_STRONG_COUNTER_MAX_ASK
          ? MISPRICING_STRONG_COUNTER_MIN_EDGE
        : counterBtc || unfavored
          ? MISPRICING_COUNTER_BTC_MIN_EDGE
          : 0;
      if (requiredCounterEdge > 0 && bsEdgeNet < requiredCounterEdge) {
        this.trackRoundRejectReason(`counter-wind: fair=${bsFairRaw.toFixed(3)} edge ${(bsEdgeNet * 100).toFixed(1)}% < ${(requiredCounterEdge * 100).toFixed(0)}%`);
        const skipKey = `counter-wind:${dir}:${btcDir}:${Math.floor(btcMovePct * 100000)}:${Math.floor(bsEdgeNet * 1000)}`;
        if (skipKey !== this.lastSignalSkipKey) {
          this.lastSignalSkipKey = skipKey;
          logger.info(`HEDGE15M MISPRICING SKIP: counter-wind ${dir.toUpperCase()} vs BTC=${btcDir} move=${(btcMovePct * 100).toFixed(3)}% fair=${bsFairRaw.toFixed(3)} edge ${(bsEdgeNet * 100).toFixed(1)}% < ${(requiredCounterEdge * 100).toFixed(0)}%`);
        }
        return;
      }
    }
    if (isMispricingLike && askPrice < MIN_ENTRY_ASK && bsEdgeNet < MISPRICING_LOW_TICKET_EDGE) {
      this.trackRoundRejectReason(`low-ticket-edge: ${(bsEdgeNet * 100).toFixed(1)}% < ${(MISPRICING_LOW_TICKET_EDGE * 100).toFixed(0)}%`);
      const skipKey = `low-ticket:${dir}:${askPrice.toFixed(2)}:${Math.floor(bsEdgeNet * 1000)}`;
      if (skipKey !== this.lastSignalSkipKey) {
        this.lastSignalSkipKey = skipKey;
        logger.info(`HEDGE15M MISPRICING SKIP: low ticket ask=${askPrice.toFixed(2)} edge ${(bsEdgeNet * 100).toFixed(1)}% < ${(MISPRICING_LOW_TICKET_EDGE * 100).toFixed(0)}%`);
      }
      return;
    }
    let minEdgeForRegime = directionalBias === "flat" ? FLAT_MIN_NET_EDGE : NON_FLAT_MIN_NET_EDGE;
    if (strategyMode === "trend") {
      if (directionalBias === dir) minEdgeForRegime = DIRECTIONAL_MIN_POSITIVE_EDGE;
      else if (directionalBias === "flat") minEdgeForRegime = 0.03;
      else minEdgeForRegime = 0.05;
    } else if (strategyMode === "counter-win") {
      if (directionalBias === dir) minEdgeForRegime = COUNTER_WIN_MIN_EDGE;
      else if (directionalBias === "flat") minEdgeForRegime = 0.03;
      else minEdgeForRegime = COUNTER_WIN_STRONG_EDGE;
    } else if (isMispricingLike) {
      if (directionalBias === dir) minEdgeForRegime = 0.03;
      else if (directionalBias === "flat") minEdgeForRegime = 0.04;
      else minEdgeForRegime = 0.06;
      if (strongMispricing) {
        minEdgeForRegime = Math.max(MISPRICING_MIN_EDGE, minEdgeForRegime - 0.02);
      }
    } else if (directionalBias === dir) {
      minEdgeForRegime = Math.max(0.04, minEdgeForRegime - 0.01);
    } else if (directionalBias !== "flat" && directionalBias !== dir) {
      minEdgeForRegime += 0.02;
    }
    if (this.secondsLeft < 300) {
      minEdgeForRegime = Math.max(0.02, minEdgeForRegime - 0.03); // 閺堚偓閸?閸掑棝鎸撻弨鎯ь啍
    } else if (this.secondsLeft > 600) {
      minEdgeForRegime += 0.02; // 閸婃帟顓搁弮?0閸掑棝鎸撴禒銉ょ瑐鐟曚焦鐪伴幓鎰扮彯
    }
    if (bsEdgeNet < minEdgeForRegime) {
      this.trackRoundRejectReason(`regime-edge: ${(bsEdgeNet * 100).toFixed(1)}% < ${(minEdgeForRegime * 100).toFixed(0)}%`);
      const skipKey = `regime-edge:${dir}:${directionalBias}:${askPrice.toFixed(2)}:${Math.floor(bsEdgeNet * 1000)}`;
      if (skipKey !== this.lastSignalSkipKey) {
        this.lastSignalSkipKey = skipKey;
        logger.info(`HEDGE15M REACTIVE SKIP: ${directionalBias} edge ${(bsEdgeNet * 100).toFixed(1)}% < ${(minEdgeForRegime * 100).toFixed(0)}%`);
      }
      return;
    }

    const alignmentScore = this.dirAlignedCount - this.dirContraCount;
    if (isMispricingLike) {
      const strongContra = alignmentScore <= MISPRICING_STRONG_CONTRA_SCORE;
      if (strongContra && bsEdgeNet < MISPRICING_CONTRA_EDGE_OVERRIDE) {
        this.trackRoundRejectReason(`strong-contra: score=${alignmentScore} edge=${(bsEdgeNet * 100).toFixed(1)}%`);
        const skipKey = `contra:${dir}:${alignmentScore}:${Math.floor(bsEdgeNet * 1000)}`;
        if (skipKey !== this.lastSignalSkipKey) {
          this.lastSignalSkipKey = skipKey;
          logger.info(`HEDGE15M MISPRICING SKIP: strong contra score=${alignmentScore} edge=${(bsEdgeNet * 100).toFixed(1)}%`);
        }
        return;
      }
    } else {
      const alignmentFloor = directionalBias !== "flat" && directionalBias !== dir ? 0 : REACTIVE_MIN_ALIGNMENT_SCORE;
      const strongCounterTrendOverride = bsEdgeNet >= (REACTIVE_ALIGNMENT_EDGE_OVERRIDE + 0.05);
      if (alignmentScore < alignmentFloor && bsEdgeNet < REACTIVE_ALIGNMENT_EDGE_OVERRIDE && !strongCounterTrendOverride) {
        this.trackRoundRejectReason(`alignment: score=${alignmentScore} edge=${(bsEdgeNet * 100).toFixed(1)}%`);
        const skipKey = `align:${dir}:${alignmentScore}:${Math.floor(bsEdgeNet * 1000)}`;
        if (skipKey !== this.lastSignalSkipKey) {
          this.lastSignalSkipKey = skipKey;
          logger.info(`HEDGE15M REACTIVE SKIP: weak signals score=${alignmentScore} edge=${(bsEdgeNet * 100).toFixed(1)}%`);
        }
        return;
      }
    }

    const netEdgeTier = this.getNetEdgeTier(bsEdgeNet);

    // 閳光偓閳光偓 绾喖鐣鹃崗銉ユ簚, 閸欐牗绉烽崣灞兼櫠妫板嫭瀵曢崡鏇㈠櫞閺€鎹愮カ闁?閳光偓閳光偓
    if (this.preOrderUpId || this.preOrderDownId) {
      const ghostFilled = await this.cancelDualSideOrders(trader);
      if (ghostFilled) {
        logger.info(`HEDGE15M buyLeg1 aborted: pre-order ghost fill detected, already transitioned to leg1`);
        return;
      }
    }

    // 閳光偓閳光偓 Half-Kelly閸掑棗鐪版禒鎾茬秴 閳光偓閳光偓
    const odds = (1 - askPrice) / askPrice;
    const kellyFull = (bsWinRate * odds - (1 - bsWinRate)) / odds;
    // 閳光偓閳光偓 EV+閸掑棗鐪癒elly娑撳﹪妾? 鐡掑﹣绌剁€规窊V鐡掑﹪鐝? 閸忎浇顔忛弴鏉戙亣娴犳挷缍?閳光偓閳光偓
    const kellyCapForPrice = askPrice <= 0.15 ? 0.45 : askPrice <= 0.20 ? 0.40 : askPrice <= 0.25 ? 0.35 : askPrice <= 0.30 ? 0.32 : askPrice <= 0.35 ? 0.30 : 0.27;
    // 鏉╃偘绨紓鈺€绮? 濮ｅ繗绻涙禍?濞嗩搼elly鑴?.85, 閺堚偓娴ｅ篃?.4, 鐠?濞嗭繝鍣哥純?
    const lossScale = this.consecutiveLosses > 0 ? Math.max(0.6, Math.pow(0.95, this.consecutiveLosses)) : 1.0;
    const kellyBase = Math.max(0.08, Math.min(kellyCapForPrice, kellyFull * this.rtKellyFraction * lossScale));
    let budgetPct = kellyBase * netEdgeTier.multiplier;
    // 閳光偓閳光偓 瀵儤鏌熼崥鎴濆娴? sum閳椆UM_DIVERGENCE_MIN鐠囧瓨妲戠敮鍌氭簚瀹稿弶鐎惔锔跨鏉堢懓鈧? 閻摜娲忛懗婊呭芳閺囨挳鐝?閳光偓閳光偓
    const liveSum = this.upAsk + this.downAsk;
    if (liveSum > 0 && liveSum <= SUM_DIVERGENCE_MIN) {
      budgetPct = Math.min(kellyCapForPrice, budgetPct * 1.15); // 瀵儤鏌熼崥鎳?.15
    }
    if (strategyMode === "mispricing") {
      if (bsEdgeNet >= MISPRICING_FAST_LANE_EDGE) budgetPct *= 1.15;
      else if (bsEdgeNet >= MISPRICING_NORMAL_EDGE) budgetPct *= 1.05;
      if (alignmentScore <= MISPRICING_STRONG_CONTRA_SCORE && bsEdgeNet < MISPRICING_FAST_LANE_EDGE) {
        budgetPct *= 0.75;
      }
    } else if (strategyMode === "counter-win") {
      budgetPct *= bsEdgeNet >= COUNTER_WIN_STRONG_EDGE ? 0.70 : 0.50;
    } else if (strategyMode === "panic-hedge") {
      budgetPct *= 0.65;
    }
    if (directionalBias === dir) {
      budgetPct += TREND_BUDGET_BOOST; // 鐡掑濞嶆稉鈧懛纾嬫嫹閸?
    } else if (directionalBias === "flat") {
      budgetPct -= TREND_BUDGET_CUT;   // 娑擃厽鈧冨櫤娴?
    }
    // 閳光偓閳光偓 缂佺喍绔?濠ф劒淇婇崣绋玡lly鐠嬪啯娼? aligned婢舵埃鍟嬮崝鐘辩波; mispricing鐠侯垰绶炴稉宥囩級娴?閳光偓閳光偓
    // 濞? mispricing閻摜娲忛弮绂昑C閺傜懓鎮滄穱鈥冲娇婢垛晝鍔ч柅鍡楁倻(閻摜娲忓锝嗘Ц閻㈢泬TC閺傜懓鎮滈崣妯哄З瀵洝鎹?,
    // MOMENTUM REJECT瀹歌尪绻冨顦爀ro-sum闁插秴鐣炬禒? 閸撯晙缍慶ontra娣団€冲娇娑撳秴绨查幆鈺冪稈娴犳挷缍?
    if (this.dirAlignedCount >= 3) {
      budgetPct *= 1.0 + (this.dirAlignedCount - 2) * 0.05; // 3閳?5%, 4閳?10%, 5閳?15%...
      logger.info(`KELLY SIG BOOST: aligned=${this.dirAlignedCount} contra=${this.dirContraCount} score=${alignmentScore} pct=${(budgetPct*100).toFixed(1)}% bsFair=${bsFairRaw.toFixed(3)} edgeRaw=${(bsEdgeNet*100).toFixed(1)}% tier=${netEdgeTier.label}`);
    } else {
      logger.info(`KELLY SIG: aligned=${this.dirAlignedCount} contra=${this.dirContraCount} score=${alignmentScore} pct=${(budgetPct*100).toFixed(1)}% bsFair=${bsFairRaw.toFixed(3)} edgeRaw=${(bsEdgeNet*100).toFixed(1)}%`);
    }
    budgetPct = Math.max(0.08, Math.min(kellyCapForPrice, budgetPct)); // EV+閸掑棗鐪扮涵顒勬 (娴ｅ簼鐜埆鎺楃彯娑撳﹪妾?

    if (strategyMode === "trend") {
      if (bsEdgeNet < DIRECTIONAL_SMALL_EDGE) budgetPct *= DIRECTIONAL_SMALL_BUDGET_SCALE;
      else if (bsEdgeNet < DIRECTIONAL_MEDIUM_EDGE) budgetPct *= DIRECTIONAL_MEDIUM_BUDGET_SCALE;
      budgetPct = Math.min(0.16, budgetPct);
    }
    if (strategyMode === "counter-win") {
      budgetPct = Math.min(COUNTER_WIN_MAX_BUDGET_PCT, budgetPct);
    }
    if (isMispricingLike && dojiRegime !== "directional") {
      let dojiCap = dojiRegime === "doji" ? DOJI_MAX_BUDGET_PCT : NEAR_DOJI_MAX_BUDGET_PCT;
      if (dojiRegime === "doji" && rnd.secondsLeft > EARLY_DOJI_SECS_LEFT) {
        dojiCap = Math.min(dojiCap, EARLY_DOJI_MAX_BUDGET_PCT);
      }
      if (askPrice > DOJI_HIGH_ASK_CUTOFF) {
        dojiCap = Math.min(dojiCap, DOJI_HIGH_ASK_MAX_BUDGET_PCT);
      }
      if (budgetPct > dojiCap) {
        logger.info(`DOJI SIZE CAP: ${dojiRegime} ln=${bsEntry.lnMoneyness.toFixed(6)} ask=${askPrice.toFixed(2)} edge=${(bsEdgeNet * 100).toFixed(1)}% pct ${(budgetPct * 100).toFixed(1)}% -> ${(dojiCap * 100).toFixed(1)}%`);
        budgetPct = dojiCap;
      }
    }

    if (strategyMode === "panic-hedge") {
      budgetPct = Math.min(PANIC_HEDGE_MAX_BUDGET_PCT, budgetPct);
    }

    await this.openLeg1Position(
      trader,
      dir,
      askPrice,
      buyToken,
      budgetPct,
      strategyMode,
      Date.now(),
      entrySource,
      bsEntry,
    );
  }

  private async cancelDualSideOrders(trader: Trader): Promise<boolean> {
    let ghostFillHandled = false;

    // 閸欐牗绉烽崜宥呭帥濡偓閺屻儲妲搁崥锕€鍑＄悮顐ｅ灇娴?(闂冨弶顒涢獮鐣屼紥閹存劒姘︾€佃壈鍤ч崣宀勫櫢閺囨繈娅?
    if (this.preOrderUpId) {
      const upCheck = await trader.getOrderFillDetails(this.preOrderUpId);
      if (upCheck.filled > 0) {
        logger.warn(`CANCEL CHECK: UP pre-order ghost filled ${upCheck.filled.toFixed(0)}娴?@${upCheck.avgPrice.toFixed(2)} BEFORE cancel!`);
        // 閸欐牗绉烽崣锔跨娓?
        if (this.preOrderDownId) {
          await trader.cancelOrder(this.preOrderDownId).catch(() => {});
          const dnGhost = await trader.getOrderFillDetails(this.preOrderDownId);
          if (dnGhost.filled > 0) {
            logger.warn(`CANCEL CHECK: DOWN also ghost filled ${dnGhost.filled.toFixed(0)}娴? selling immediately`);
            await trader.placeFakSell(this.preOrderDownToken, dnGhost.filled, this.negRisk).catch((e: any) => {
              logger.error(`CANCEL CHECK ghost sell failed: ${e.message}`);
            });
          }
          this.preOrderDownId = "";
          this.preOrderDownPrice = 0;
          this.preOrderDownShares = 0;
        }
        // 閸欐牗绉稶P娴ｆ瑩鍣?
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
        logger.warn(`CANCEL CHECK: DOWN pre-order ghost filled ${dnCheck.filled.toFixed(0)}娴?@${dnCheck.avgPrice.toFixed(2)} BEFORE cancel!`);
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
    // 閸氬本顒炴担娆擃杺: paper 濡€崇础娑?cancelOrder 瀹告煡鈧偓濞嗘儳鍩?paperBalance
    await this.refreshBalance();
    return false;
  }

  /**
   * 閸欏奔鏅舵０鍕瘯閸楁洖浠涚敮?
   * 閸?watching 闂冭埖顔屾稉璇插З閹?GTC limit buy 閸?UP 閸?DOWN 娑撱倓鏅?
   * 瑜版挸绔堕崷杞扮瑓閻鍩岄惄顔界垼娴犻攱妞傛禒?maker 鐠愬湱宸?0%)閹存劒姘? 鐎圭偟骞?
   * 1. 濮ｆ柨寮芥惔鏂跨础娑撳宕熼弴鏉戞彥 (閸楁洖鍑￠崷鈺瀘ok娑?
   * 2. 閻?2% taker fee
   * 3. 婵″倹鐏夋稉鈧笟褑顫﹂崥鍐ㄥ煂 閳?缁涘绨幏鍨煂娓氬灝鐤侀惃?Leg1, 閹镐焦婀侀崚鎵波缁?
   */
  private async manageDualSideOrders(trader: Trader, rnd: Round15m, secs: number): Promise<void> {
    if (DISABLE_DUAL_SIDE_PREORDER) {
      if (this.preOrderUpId || this.preOrderDownId) {
        await this.cancelDualSideOrders(trader);
      }
      return;
    }
    if (!DUAL_SIDE_ENABLED) return;
    if (this.hedgeState !== "watching") return;
    if (this.leg1EntryInFlight || this.leg1AttemptedThisRound) return;
    // dump瀹歌尙鈥樼拋銈嗘娑撳秵瀵曢弬浼搭暕閹稿倸宕? 闁灝鍘?閹稿倸宕熼埆鎶巙mp閸欐牗绉烽埆鎺撳瘯閸?閸掑嘲鐫嗗顏嗗箚
    if (this.dumpConfirmCount >= this.rtDumpConfirmCycles) return;
    if (secs < this.rtMinEntrySecs) {
      // 閺冨爼妫挎稉宥堝喕, 閸欐牗绉锋０鍕瘯閸?
      if (this.preOrderUpId || this.preOrderDownId) {
        await this.cancelDualSideOrders(trader);
      }
      return;
    }
    // consecutiveLosses 閸愬嘲宓堝鑼╅梽? 閺傜懓鎮滈幀褏鐡ラ悾銉︾槨鏉烆喚瀚粩? 鏉╃偘绨稉宥呭閸濆秳绗呮潪鐡籚

    const upAsk = this.upAsk;
    const downAsk = this.downAsk;
    if (upAsk <= 0 || downAsk <= 0) return;

    // 閳光偓閳光偓 瀵邦喛顢戦幆鍛扮箖濠? BTC鏉?閸掑棝鎸撳▔銏犲З閻滃洩绻冩担搴㈡娑撳秵瀵曟０鍕瘯閸?(闁灝鍘ゅΟ顏嗘磸閹舵稓鈥栫敮? 閳光偓閳光偓
    const recentVol = getRecentVolatility(300);
    if (recentVol < DUAL_SIDE_MIN_VOL) {
      // 濞夈垹濮╅悳鍥︾瑝鐡?閳?閸欐牗绉峰鍙夋箒妫板嫭瀵曢崡? 娑撳秵瀵曢弬鏉垮礋
      if (this.preOrderUpId || this.preOrderDownId) {
        await this.cancelDualSideOrders(trader);
      }
      // 濮ｅ繗鐤嗛崣顏呭ⅵ娑撯偓濞嗏剝妫╄箛? 闁灝鍘ら崚宄扮潌
      if (!this._volGateLoggedThisRound) {
        this._volGateLoggedThisRound = true;
        logger.info(`DUAL SIDE: vol=${(recentVol*100).toFixed(3)}% < ${(DUAL_SIDE_MIN_VOL*100).toFixed(2)}% - skip pre-orders`);
      }
      return;
    }

    // 閳光偓閳光偓 娴ｅ孩绁﹂崝銊︹偓褑绻冨? 娴犲懐鏁IQUIDITY_FILTER_SUM, SUM_DIVERGENCE_MAX閺勵垳绮癲ump閸忋儱婧€閻ㄥ嫪绗夎ぐ鍗炴惙妫板嫭瀵曢崡?閳光偓閳光偓
    const askSum = upAsk + downAsk;
    const lowLiquidity = askSum >= LIQUIDITY_FILTER_SUM;

    // 閳光偓閳光偓 濡偓閺屻儱鍑￠張澶愵暕閹稿倸宕熼弰顖氭儊鐞氼偅鍨氭禍?閳光偓閳光偓
    if (this.preOrderUpId) {
      const upFill = await trader.getOrderFillDetails(this.preOrderUpId);
      if (upFill.filled > 0) {
        // UP 娓氀嗩潶閹存劒姘?閳?閸忓牆褰囧☉?UP 娴ｆ瑩鍣?+ 閸欙缚绔存笟?
        if (upFill.filled < this.preOrderUpShares) {
          await trader.cancelOrder(this.preOrderUpId).catch(() => {});
          const afterCancel = await trader.getOrderFillDetails(this.preOrderUpId);
          if (afterCancel.filled > upFill.filled) {
            upFill.filled = afterCancel.filled;
            upFill.avgPrice = afterCancel.avgPrice;
          }
        }
        logger.info(`DUAL SIDE FILLED: UP ${upFill.filled.toFixed(0)}娴?@${upFill.avgPrice.toFixed(2)} (limit@${this.preOrderUpPrice.toFixed(2)}) maker=true`);
        // 閸欐牗绉烽崣锔跨娓?(閸忓潏ancel閸愬秵鐓ill, 闁灝鍘ょ粩鐐粹偓浣锋丢娴犱粙顤?
        if (this.preOrderDownId) {
          await trader.cancelOrder(this.preOrderDownId).catch(() => {});
          const dnCheck = await trader.getOrderFillDetails(this.preOrderDownId);
          if (dnCheck.filled > 0) {
            logger.warn(`DUAL SIDE GHOST: DOWN also filled ${dnCheck.filled.toFixed(0)}娴? selling immediately`);
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
        // DOWN 娓氀嗩潶閹存劒姘?閳?閸忓牆褰囧☉?DOWN 娴ｆ瑩鍣?+ 閸欙缚绔存笟?
        if (dnFill.filled < this.preOrderDownShares) {
          await trader.cancelOrder(this.preOrderDownId).catch(() => {});
          const afterCancel = await trader.getOrderFillDetails(this.preOrderDownId);
          if (afterCancel.filled > dnFill.filled) {
            dnFill.filled = afterCancel.filled;
            dnFill.avgPrice = afterCancel.avgPrice;
          }
        }
        logger.info(`DUAL SIDE FILLED: DOWN ${dnFill.filled.toFixed(0)}娴?@${dnFill.avgPrice.toFixed(2)} (limit@${this.preOrderDownPrice.toFixed(2)}) maker=true`);
        if (this.preOrderUpId) {
          await trader.cancelOrder(this.preOrderUpId).catch(() => {});
          const upCheck = await trader.getOrderFillDetails(this.preOrderUpId);
          if (upCheck.filled > 0) {
            logger.warn(`DUAL SIDE GHOST: UP also filled ${upCheck.filled.toFixed(0)}娴? selling immediately`);
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

    // 閳光偓閳光偓 鐠侊紕鐣婚悶鍡樺厒閹稿倸宕熸禒?閳光偓閳光偓
    // 閻╊喗鐖? 婵″倹鐏夋稉鈧笟褑顫﹂崥鍐ㄥ煂, sum = myFillPrice + oppositeAsk 閳?DUAL_SIDE_SUM_CEILING
    // 閳?myLimit 閳?DUAL_SIDE_SUM_CEILING - oppositeCurrentAsk
    // 濞夈垹濮╅悳鍥殰闁倸绨瞣ffset: 妤傛ɑ灏濋埆鎺戙亣offset(閺囩繝缍嗘禒閿嬪灇娴溿倐鍟嬮弴鎾彯EV); 娴ｅ孩灏濋埆鎺戠毈offset(闂堢姾绻庣敮鍌欑幆閳帒顤冮崝鐘冲灇娴溿倗宸?
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

    // 娴犻攱鐗哥划鎯у 0.01
    // 閳光偓閳光偓 妫板嫭顥呴弻? 鐏忓攱imit娴犵兘鎸搁崚璺哄煂effectiveMaxAsk, 闁灝鍘ゆ潏鍦櫕闂囧洩宕辩€佃壈鍤ч幐鍌楀晪閸欐牗绉峰顏嗗箚 閳光偓閳光偓
    const effectiveMaxAsk = this.getEffectiveMaxAsk();
    let upLimit = Math.min(Math.round(idealUpLimit * 100) / 100, effectiveMaxAsk);
    let downLimit = Math.min(Math.round(idealDownLimit * 100) / 100, effectiveMaxAsk);

    const upInRange = upLimit >= DUAL_SIDE_MIN_ASK;
    const downInRange = downLimit >= DUAL_SIDE_MIN_ASK;

    // 閳光偓閳光偓 鐡掑濞嶉弬鐟版倻鏉╁洦鎶? 閺堝妲戠涵顔跨Ъ閸旀寧妞傞幘銈夋敘闁棗濞嶆笟褔顣╅幐鍌氬礋 閳光偓閳光偓
    const trend = this.currentTrendBias;
    if (trend === "down" && this.preOrderUpId) {
      await trader.cancelOrder(this.preOrderUpId).catch(() => {});
      this.preOrderUpId = ""; this.preOrderUpPrice = 0; this.preOrderUpShares = 0;
      logger.info(`DUAL SIDE: UP cancelled (trendBias=down, avoid counter-trend fill)`);
    }
    if (trend === "up" && this.preOrderDownId) {
      await trader.cancelOrder(this.preOrderDownId).catch(() => {});
      this.preOrderDownId = ""; this.preOrderDownPrice = 0; this.preOrderDownShares = 0;
      logger.info(`DUAL SIDE: DOWN cancelled (trendBias=up, avoid counter-trend fill)`);
    }

    // 閳光偓閳光偓 Binance 閺傜懓鎮滄潻鍥ㄦ姢: BTC閺傜懓鎮滈弰搴ｂ€橀弮鑸垫寵闁库偓闁棗鎮滄笟褔顣╅幐鍌氬礋 閳光偓閳光偓
    const btcDirPre = getBtcDirection();
    const btcMovePre = getBtcMovePct();
    if (btcMovePre >= 0.0025) { // BTC 閸欐ê濮╅埉?.25%閹靛秴褰囧☉鍫モ偓鍡楁倻妫板嫭瀵曢崡?(0.1%婢额亝鏅遍幇鐔奉嚤閼锋挳顣剁换浣稿絿濞戝牃鍟嬮弮鐘崇《閹存劒姘?
    if (btcDirPre === "down" && this.preOrderUpId) {
      await trader.cancelOrder(this.preOrderUpId).catch(() => {});
      this.preOrderUpId = ""; this.preOrderUpPrice = 0; this.preOrderUpShares = 0;
      logger.info(`DUAL SIDE: UP cancelled (BTC=down move=${(btcMovePre*100).toFixed(3)}%)`);
    }
    if (btcDirPre === "up" && this.preOrderDownId) {
      await trader.cancelOrder(this.preOrderDownId).catch(() => {});
      this.preOrderDownId = ""; this.preOrderDownPrice = 0; this.preOrderDownShares = 0;
      logger.info(`DUAL SIDE: DOWN cancelled (BTC=up move=${(btcMovePre*100).toFixed(3)}%)`);
    }
    }

    // 閳光偓閳光偓 娴ｅ孩绁﹂崝銊︹偓褑绻冨? spread鏉╁洤銇囬弮鑸垫寵闁库偓閹碘偓閺堝顣╅幐鍌氬礋 閳光偓閳光偓
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
      const preLossScale = this.consecutiveLosses > 0 ? Math.max(0.6, Math.pow(0.95, this.consecutiveLosses)) : 1.0;
      return Math.max(0.08, Math.min(preKellyCap, preKelly * this.rtKellyFraction * preLossScale));
    };

    const now = Date.now();
    const needRefresh = now - this.preOrderLastRefresh >= DUAL_SIDE_REFRESH_MS;

    // 閳光偓閳光偓 BTC閺傜懓鎮滈弰顖氭儊鐡掑厖浜掗梼缁橆剾閸楁洑鏅堕幐鍌氬礋: 韫囧懘銆忛崣妯哄З閳?.25%閹靛秷顫嬫稉鐑樻箒閺傜懓鎮?閳光偓閳光偓
    const btcBlocksUp = btcMovePre >= 0.0025 && btcDirPre === "down";
    const btcBlocksDn = btcMovePre >= 0.0025 && btcDirPre === "up";

    // 閳光偓閳光偓 UP 娓氀勫瘯閸楁洜顓搁悶?(鐡掑濞峝own/BTC瀵桨绗呴弮鎯扮儲鏉? 娴ｅ孩绁﹂崝銊︹偓褎妞傜捄瀹犵箖) 閳光偓閳光偓
    if (!lowLiquidity && trend !== "down" && !btcBlocksUp && upInRange && !!upBsEntry?.allowed) {
      const upPreKellyCap = upLimit <= 0.15 ? 0.40 : upLimit <= 0.20 ? 0.35 : upLimit <= 0.25 ? 0.30 : 0.25;
      const upBudgetPct = Math.min(upPreKellyCap, calcPreBudgetPct(upLimit, upBsEntry.fairKelly) * this.getNetEdgeTier(upBsEntry.effectiveEdge).multiplier);
      const upShares = Math.min(MAX_SHARES, Math.floor((this.balance * upBudgetPct * 0.7) / upLimit));
      if (upShares >= MIN_SHARES) {
        const drift = Math.abs(upLimit - this.preOrderUpPrice);
        if (!this.preOrderUpId) {
          // 妫ｆ牗顐奸幐鍌氬礋
          const oid = await trader.placeGtcBuy(rnd.upToken, upShares, upLimit, !!rnd.negRisk);
          if (oid) {
            this.preOrderUpId = oid;
            this.preOrderUpPrice = upLimit;
            this.preOrderUpShares = upShares;
            this.preOrderUpToken = rnd.upToken;
            logger.info(`DUAL SIDE: UP pre-order ${upShares}娴?@${upLimit.toFixed(2)} (sum target=${(upLimit + downAsk).toFixed(2)})`);
          }
        } else if (needRefresh && drift >= DUAL_SIDE_MIN_DRIFT) {
          // 娴犻攱鐗搁崑蹇曅╂潻鍥с亣, 闁插秵瀵?閳?cancel 閸氬孩顥呴弻銉︽Ц閸氾箑婀粣妤€褰涢崘鍛灇娴?
          await trader.cancelOrder(this.preOrderUpId).catch(() => {});
          const reFill = await trader.getOrderFillDetails(this.preOrderUpId);
          if (reFill.filled > 0) {
            // cancel 閸撳秵鍨氭禍銈勭啊, 娑撳秹鍣搁幐? 娑撳顐煎顏嗗箚娴兼俺铔?fill 鐠侯垰绶?
            logger.info(`DUAL SIDE: UP filled ${reFill.filled.toFixed(0)} during re-place cancel, will handle next tick`);
          } else {
          const oid = await trader.placeGtcBuy(rnd.upToken, upShares, upLimit, !!rnd.negRisk);
          if (oid) {
            this.preOrderUpId = oid;
            this.preOrderUpPrice = upLimit;
            this.preOrderUpShares = upShares;
            logger.info(`DUAL SIDE: UP re-placed ${upShares}娴?@${upLimit.toFixed(2)} (drift=${drift.toFixed(2)})`);
          } else {
            this.preOrderUpId = "";
            this.preOrderUpPrice = 0;
            this.preOrderUpShares = 0;
          }
          }
        }
      }
    } else if (this.preOrderUpId) {
      // 娴犻攱鐗搁懘杈╊瀲閸栨椽妫? 閸欐牗绉?
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

    // 閳光偓閳光偓 DOWN 娓氀勫瘯閸楁洜顓搁悶?(鐡掑濞島p/BTC瀵桨绗傞弮鎯扮儲鏉? 娴ｅ孩绁﹂崝銊︹偓褎妞傜捄瀹犵箖) 閳光偓閳光偓
    if (!lowLiquidity && trend !== "up" && !btcBlocksDn && downInRange && !!downBsEntry?.allowed) {
      const dnPreKellyCap = downLimit <= 0.15 ? 0.40 : downLimit <= 0.20 ? 0.35 : downLimit <= 0.25 ? 0.30 : 0.25;
      const dnBudgetPct = Math.min(dnPreKellyCap, calcPreBudgetPct(downLimit, downBsEntry.fairKelly) * this.getNetEdgeTier(downBsEntry.effectiveEdge).multiplier);
      const dnShares = Math.min(MAX_SHARES, Math.floor((this.balance * dnBudgetPct * 0.7) / downLimit));
      if (dnShares >= MIN_SHARES) {
        const drift = Math.abs(downLimit - this.preOrderDownPrice);
        if (!this.preOrderDownId) {
          const oid = await trader.placeGtcBuy(rnd.downToken, dnShares, downLimit, !!rnd.negRisk);
          if (oid) {
            this.preOrderDownId = oid;
            this.preOrderDownPrice = downLimit;
            this.preOrderDownShares = dnShares;
            this.preOrderDownToken = rnd.downToken;
            logger.info(`DUAL SIDE: DOWN pre-order ${dnShares}娴?@${downLimit.toFixed(2)} (sum target=${(downLimit + upAsk).toFixed(2)})`);
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
            logger.info(`DUAL SIDE: DOWN re-placed ${dnShares}娴?@${downLimit.toFixed(2)} (drift=${drift.toFixed(2)})`);
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

  /** 妫板嫭瀵曢崡鏇熷灇娴?閳?鏉烆兛璐?Leg1 閹镐椒绮?*/
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
    // 娴ｅ簼鐜痬aker閹存劒姘︽稉宥呬粵post-fill BSM unwind:
    // fillPrice 閳?$0.30 閺?EV+ 閳?$0.20/share @50%閼虫粎宸? unwind闂団偓娴?% taker fee = 绾喖鐣鹃幑鐔枫亼
    // BSM閸︺劍鍨氭禍銈呮倵閺佹壆娅╩s閸愬懎褰查懗钘夋礈BTC瀵邦喖绠欓崣宥堟祮閼板瞼鐐曟潪顒€鍨介弬? 濮濄倖妞倁nwind閺勭枎V-
    // 娴犲懎婀妯圭幆閹存劒姘?>$0.30)閺冭埖澧犻崗浣筋啅unwind 閳?妤傛ü鐜惃鍑烿 margin鐏? 閺傜懓鎮滈柨娆掝嚖娴狅絼鐜径?
    if (!bsEntry.allowed && fillPrice > 0.30) {
      this.logBsReject("dual-side-fill", dir, fillPrice, bsEntry);
      const unwind = await trader.placeFakSell(leg1Token, filledShares, this.negRisk).catch(() => null);
      if (unwind) {
        this.leg1AttemptedThisRound = true;
        this.activeStrategyMode = "none";
        this.status = `妫板嫭瀵曢幋鎰唉閸氬海鐝涢崡鍐查挬娴? ${dir.toUpperCase()} @${fillPrice.toFixed(2)} x${filledShares.toFixed(0)}`;
        logger.warn(`DUAL SIDE UNWIND: ${dir.toUpperCase()} ${filledShares.toFixed(0)}娴?@${fillPrice.toFixed(2)} rejected by BSM, sold immediately`);
        this.writeRoundAudit("preorder-unwind", {
          dir,
          fillPrice,
          filledShares,
          orderId: orderId.slice(0, 12),
          bsFair: bsEntry.fairRaw,
          effectiveCost: bsEntry.effectiveCost,
          effectiveEdge: bsEntry.effectiveEdge,
          reason: bsEntry.reason,
        });
        return;
      }
      logger.error(`DUAL SIDE UNWIND FAILED: ${dir.toUpperCase()} ${filledShares.toFixed(0)}娴?@${fillPrice.toFixed(2)} 閳?keeping position to settlement`);
    } else if (!bsEntry.allowed) {
      // 娴ｅ簼鐜幋鎰唉: BSM reject娴ｅ棔绗塽nwind, 閹镐焦婀侀崚鎵波缁犳ぞ绮汦V+
      logger.info(`DUAL SIDE KEEP: ${dir.toUpperCase()} @${fillPrice.toFixed(2)} BSM rejected (${bsEntry.reason}) but fillPrice 閳?$0.30 閳?holding to settlement (EV+ at low price)`);
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
    this.leg1MakerFill = true; // 妫板嫭瀵曢崡鏇熸鏉╂粍妲?maker
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
    // paper 濡€崇础娑?placeGtcBuy 瀹告煡顣╅幍?paperBalance, 娑撳秷顩﹂柌宥咁槻閹? 閻╁瓨甯撮崥灞绢劄
    // live 濡€崇础娑?balance 閺勵垶鎽兼稉濠佺稇妫? 閹存劒姘﹀鍙夊⒏濞?
    // 娑撱倗顫掑Ο鈥崇础缂佺喍绔? 娴?trader 鐠囪褰囬惇鐔风杽娴ｆ瑩顤?
    // 濞? refreshBalance 閺?async 娴?transition 閺?sync 閳?娣囨繂鐣ф径鍕倞
    // 閸?manageDualSideOrders 鐠嬪啰鏁?transition 閸撳秴鎮楁导?refreshBalance
    // 鏉╂瑩鍣锋禒鍛邦啎 totalCost 閻劋绨崥搴ｇ敾 P/L 鐠侊紕鐣? 娑撳秵澧?balance
    this.onLeg1Opened();
    this.status = `Leg1 pre-order filled ${dir.toUpperCase()} @${fillPrice.toFixed(2)} x${filledShares.toFixed(0)} maker, waiting settle`;
    logger.info(`HEDGE15M DUAL SIDE 閳?LEG1: ${dir.toUpperCase()} ${filledShares.toFixed(0)}娴?@${fillPrice.toFixed(2)} maker orderId=${orderId.slice(0, 12)} bsFair=${bsEntry.fairRaw.toFixed(3)} netEdge=${(bsEntry.effectiveEdge * 100).toFixed(1)}%`);
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
   * Limit+FAK 鐠ф稖绐? 閸忓牊瀵?limit 缁涘绶熼惌顓熸畯閺冨爼妫? 閺堫亝鍨氭禍銈呭灟 cancel + FAK fallback
   * 鏉╂柨娲?{ orderId, filled, avgPrice, maker } 閹?null(娑撱倛鈧懘鍏樻径杈Е)
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
    const limitPrice = Math.round((currentAsk - limitOffset) * 100) / 100; // 娣囨繃瀵?0.01 缁儳瀹?
    if (limitPrice <= 0.01) {
      // limit 娴犻攱鐗告径顏冪秵, 閻╁瓨甯?FAK
      return this.fakBuyFallback(trader, tokenId, shares, currentAsk, negRisk);
    }

    // 閳光偓閳光偓 Phase 1: 閹?GTC limit buy 閳光偓閳光偓
    const gtcOrderId = await trader.placeGtcBuy(tokenId, shares, limitPrice, negRisk);
    if (!gtcOrderId) {
      logger.warn(`LIMIT RACE: GTC buy failed, fallback to FAK`);
      return this.fakBuyFallback(trader, tokenId, shares, currentAsk, negRisk);
    }

    // 閳光偓閳光偓 Phase 2: 鏉烆喛顕楃粵澶婄窡閹存劒姘?閳光偓閳光偓
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const details = await trader.getOrderFillDetails(gtcOrderId);
      if (details.filled >= shares * 0.5) {
        // 閹存劒姘︽潻鍥у磹, 閸欐牗绉烽崜鈺€缍戦崥搴ゎ潒娑撶儤鍨氶崝?
        await trader.cancelOrder(gtcOrderId);
        const finalDetails = await trader.getOrderFillDetails(gtcOrderId);
        const realFilled = finalDetails.filled > details.filled ? finalDetails.filled : details.filled;
        const realAvg = finalDetails.filled > details.filled ? finalDetails.avgPrice : details.avgPrice;
        logger.info(`LIMIT RACE WIN: ${realFilled.toFixed(0)}/${shares} @${realAvg.toFixed(2)} (limit@${limitPrice.toFixed(2)}) maker=true`);
        return { orderId: gtcOrderId, filled: realFilled, avgPrice: realAvg, maker: true };
      }
      // 濡偓閺屻儳娲忛崣? ask 閺勵垰鎯侀崣宥呰剨
      const book = trader.peekBestPrices(tokenId, 500);
      if (book && book.ask != null && book.ask > currentAsk * 1.03) {
        // ask 閸欏秴鑴婄搾?3%, 缁斿鍩?cancel 閳?FAK
        logger.info(`LIMIT RACE ABORT: ask rebounded ${book.ask.toFixed(2)} > ${currentAsk.toFixed(2)}*1.03, cancel+FAK`);
        break;
      }
      await new Promise(r => setTimeout(r, LIMIT_RACE_POLL_MS));
    }

    // 閳光偓閳光偓 Phase 3: 鐡掑懏妞?閸欏秴鑴?閳?cancel 閳?濡偓閺屻儲妲搁崥锕€婀崣鏍ㄧХ閸撳秵鍨氭禍?閳?FAK fallback 閳光偓閳光偓
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
      // cancel 閸欘垵鍏樻径杈Е, GTC 閸欘垵鍏樻禒宥嗗瘯閻偓, 娑撳秴鐣ㄩ崗銊ュ絺 FAK 閳?閸愬秷鐦稉鈧▎?cancel
      logger.warn(`LIMIT RACE: cancel may have failed, retry cancel before FAK`);
      await trader.cancelOrder(gtcOrderId).catch(() => {});
      const recheck = await trader.getOrderFillDetails(gtcOrderId);
      if (recheck.filled > 0) {
        return { orderId: gtcOrderId, filled: recheck.filled, avgPrice: recheck.avgPrice, maker: true };
      }
    }

    // 鐎瑰苯鍙忛張顏呭灇娴溿倖鍨ㄦ稉顓燁剾, FAK fallback 閳?娴ｈ法鏁ら崢鐔奉潗閸忋儱婧€娣団€冲娇閺冨墎娈?currentAsk 娣囨繆鐦夐崥鍐ㄥ煂鏉╂瑥宕?
    // 娑斿澧犻柨娆掝嚖閸﹂濞囬悽銊ょ啊 limitPrice 鐎佃壈鍤?FAK 鐎瑰苯鍙忛弮鐘崇《鏉╁洦婀伴敍鍫濊埌閸氬苯绨鹃崡鏇礆閿涘苯顕遍懛瀵告箙閻偓閺傜懓鎮滅€甸€涚啊閸楃繝绔撮惄缈犵瑝鏉╂稑婧€閵?
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

  /** 娑撳宕熼崗銉ユ簚 */
  private async openLeg1Position(
    trader: Trader,
    dir: string,
    askPrice: number,
    buyToken: string,
    budgetPct: number,
    strategyMode: "mispricing" | "trend" | "counter-win" | "panic-hedge",
    signalDetectedAt = Date.now(),
    entrySource = "reactive-mispricing",
    bsEntry?: {
      fairRaw: number;
      fairKelly: number;
      lnMoneyness?: number;
      effectiveCost: number;
      effectiveEdge: number;
    },
  ): Promise<void> {
    const budget = this.balance * budgetPct;
    const shares = Math.min(MAX_SHARES, Math.floor(budget / askPrice));
    if (shares < MIN_SHARES) {
      this.trackRoundRejectReason(`shares ${shares} < ${MIN_SHARES}`);
      logger.warn(`Hedge15m Leg1 skipped: ${shares}娴?< ${MIN_SHARES} (balance=$${this.balance.toFixed(2)}, ask=$${askPrice.toFixed(2)})`);
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
      logger.warn(`Hedge15m Leg1 skipped (fresh): ${entryShares}娴?< ${MIN_SHARES} @${entryAsk.toFixed(2)}`);
      return;
    }
    const entryCost = entryShares * entryAsk;

    this.leg1EntryInFlight = true;
    // leg1AttemptedThisRound 瀵ゆ儼绻滈崚鎵埂濮濓絾鍨氭禍銈呮倵閸愬秷顔曠純? 閸忎浇顔廎AK婢惰精瑙﹂崥搴ㄥ櫢鐠?
    this.hedgeState = "leg1_pending";
    this.status = `Leg1娑撳宕熸稉? ${dir.toUpperCase()} @${entryAsk.toFixed(2)} x${entryShares.toFixed(0)}`;

    try {
      const adjustedShares = entryShares;

      // 閳光偓閳光偓 Limit race offset + timeout: 閹稿—ump闁喎瀹抽崝銊︹偓浣稿 閳光偓閳光偓
      // 閹鳖晩ump(8-12%): 娴犻攱鐗搁崶鐐茶剨閹扁懇鍟媘aker閹存劒姘﹀鍌滃芳妤傛ǚ鍟嬬粵澶夌畽閻?鐏忓紝ffset
      // 韫囩帬ump(>15%): 娴犻攱鐗搁幁銏狀槻韫囶偀鍟嬬紓鈺冪叚缁涘绶?婢额湹ffset閹躲垺鍨氭禍?
      let limitOffset = LIMIT_RACE_OFFSET;
      let raceTimeout = LIMIT_RACE_TIMEOUT_MS;
      if (this.currentDumpDrop >= LIMIT_RACE_FAST_DUMP_THRESHOLD || this.currentDumpVelocity === "fast") {
        limitOffset = LIMIT_RACE_FAST_OFFSET;
        raceTimeout = 600;  // 韫囩帬ump/韫囶偊鈧喎瀹? 缂傗晛鍩?00ms, 鐏忚棄鎻╅幋鎰唉
      } else if (this.currentDumpDrop < 0.12 && this.currentDumpVelocity === "slow") {
        raceTimeout = 1200; // 閹鳖晩ump+閹便垽鈧喎瀹? 缁涘绠欓悙? maker閹存劒姘﹀鍌滃芳閺囨挳鐝?
      }

      const adjustedCost = adjustedShares * entryAsk;
      logger.info(`HEDGE15M LEG1 ${strategyMode.toUpperCase()}: ${dir.toUpperCase()} ${adjustedShares}娴?@${entryAsk.toFixed(2)} cost=$${adjustedCost.toFixed(2)}${entryAsk !== askPrice ? ` (signal@${askPrice.toFixed(2)})` : ""} negRisk=${this.negRisk} limitRace=${LIMIT_RACE_ENABLED}`);
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
        this.status = `Leg1 entry failed (${this.leg1FailedAttempts}/2), ${this.leg1FailedAttempts >= 2 ? "stop retry" : "can retry"}`;
        logger.warn(`HEDGE15M Leg1 entry failed (limit race + FAK), attempt ${this.leg1FailedAttempts}/2`);
        return;
      }

      recordExecutionLatency("signalToFill", orderAckAt - signalDetectedAt);

      const orderId = fillResult.orderId;
      const filledShares = fillResult.filled;
      const realFillPrice = fillResult.avgPrice;
      const isMaker = fillResult.maker;
      const actualFee = isMaker ? 0 : TAKER_FEE;

      // NaN闂冨弶濮? 閹存劒姘﹂弫鐗堝祦瀵倸鐖堕弮鑸靛珕缂佹繂鍙嗛崷? 闂冨弶顒汸/L鏉╁€熼嚋閹圭喎娼?
      if (!Number.isFinite(filledShares) || filledShares <= 0 || !Number.isFinite(realFillPrice) || realFillPrice <= 0) {
        logger.error(`HEDGE15M LEG1 ABORT: invalid fill data shares=${filledShares} price=${realFillPrice} 閳?refusing to track position`);
        this.status = "Leg1閹存劒姘﹂弫鐗堝祦瀵倸鐖? 閺堫剝鐤嗙捄瀹犵箖";
        return;
      }

      this.hedgeState = "leg1_filled";
      this.leg1AttemptedThisRound = true; // 閻喐顒滈幋鎰唉閸氬孩澧犻柨浣哥暰, FAK婢惰精瑙﹂崣顖炲櫢鐠?
      this.activeStrategyMode = "mispricing";
      this.leg1Dir = dir;
      this.leg1Price = entryAsk;
      this.leg1FillPrice = realFillPrice;
      this.leg1OrderId = orderId ? orderId.slice(0, 12) : "";
      this.leg1FilledAt = Date.now();
      this.leg1Shares = filledShares;
      this.leg1Token = buyToken;
      this.leg1MakerFill = isMaker;
      this.activeStrategyMode = strategyMode;
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
      this.status = `Leg1 ${dir.toUpperCase()} @${realFillPrice.toFixed(2)} x${filledShares.toFixed(0)}${isMaker ? " maker" : ""}, waiting settle`;
      logger.info(`HEDGE15M LEG1 FILLED: ${dir.toUpperCase()} ${filledShares.toFixed(0)}娴?ask=${entryAsk.toFixed(2)} fill=${realFillPrice.toFixed(2)} orderId=${orderId.slice(0, 12)} maker=${isMaker} fee=${(actualFee * 100).toFixed(0)}%`);
      this.writeRoundAudit("leg1-filled", {
        strategyMode,
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
    const preSettleBalance = this.balance; // 鐠佹澘缍嶇紒鎾剁暬閸撳秳缍戞０婵堟暏娴滃孩鐗庢?
    await sleep(2000); // 缁涘绶熸禒閿嬬壐濠ф劖娲块弬?

    // 缂佹挾鐣婚弬鐟版倻閸掋倖鏌? 3濞嗭繝鍣伴弽宄板絿娑擃厺缍呴弫? 閸戝繐鐨疊TC閻剚妞傞崣宥堟祮鐎佃壈鍤х拠顖氬灲
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
      // Polymarket "Up" = BTC strictly above open 閳?equal = DOWN wins
      actualDir = btcNow > this.roundStartBtcPrice ? "up" : "down";
      logger.info(`HEDGE15M SETTLE: BTC start=$${this.roundStartBtcPrice.toFixed(0)} now=$${btcNow.toFixed(0)} (${samples.length} samples, median) 閳?${actualDir}${btcNow === this.roundStartBtcPrice ? " (flat=DOWN)" : ""}`);
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
        logger.error(`HEDGE15M SETTLE: BTC unavailable, using orderbook fallback (L1=${leg1Score.toFixed(2)} 閳?${actualDir})`);
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

    // NaN闂冨弶濮? totalCost閹存潧eturnVal瀵倸鐖堕弮鏈佃厬濮? 闂冨弶顒汸/L鏉╁€熼嚋閹圭喎娼?
    if (!Number.isFinite(profit) || !Number.isFinite(this.totalCost)) {
      logger.error(`SETTLE NaN GUARD: profit=${profit} totalCost=${this.totalCost} returnVal=${returnVal} 閳?skipping P/L update`);
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

    const settlementReason = `Settlement: BTC ${actualDir.toUpperCase()}(${dirSource}), ${this.leg1Dir === actualDir ? "direction correct => 1/share" : "direction wrong => 0"}`;

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
      profitBreakdown: `缂佹挾鐣婚崶鐐存暪$${returnVal.toFixed(2)}(${this.leg1Shares.toFixed(0)}娴? - 閹存劖婀?${this.totalCost.toFixed(2)} = ${profit>=0?'+':''}$${profit.toFixed(2)}`,
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

    this.status = `缂佹挾鐣? ${result} ${profit >= 0 ? "+" : ""}$${profit.toFixed(2)} (鏉?${returnVal.toFixed(2)} dir=${actualDir}/${dirSource})`;
    logger.info(`HEDGE15M SETTLED: ${result} dir=${actualDir}(${dirSource}) return=$${returnVal.toFixed(2)} cost=$${this.totalCost.toFixed(2)} profit=$${profit.toFixed(2)} L1fill=${this.leg1FillPrice.toFixed(2)}`);
    this.writeRoundAudit("settlement", {
      result,
      actualDir,
      dirSource,
      returnVal,
      profit,
      settlementReason,
    });

    // 閳光偓閳光偓 缂佹挾鐣?P/L 閺嶏繝鐛? 闁惧彞绗傛担娆擃杺 vs 閺堫剙婀存０鍕埂 閳光偓閳光偓
    const expectedBalance = preSettleBalance + returnVal;
    
    // 缁涘绶熼柧鍙ョ瑐缂佹挾鐣婚悽鐔告櫏閸氬骸鍟€閸氬本顒炴担娆擃杺
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

export type TradeDirection = "up" | "down";
export type DirectionalBias = TradeDirection | "flat";

export interface DirectionalBiasParams {
  roundStartPrice: number;
  btcNow: number;
  shortMomentum: number;
  trendMomentum: number;
  directionalMovePct: number;
  momentumContraPct: number;
  trendContraPct: number;
  secsLeft?: number;
  signalScore?: number;
}

export interface MispricingEvaluationParams {
  upAsk: number;
  downAsk: number;
  oldestUpAsk: number;
  oldestDownAsk: number;
  upDrop: number;
  downDrop: number;
  upDropMs: number;
  downDropMs: number;
  dumpThreshold: number;
  nearThresholdRatio: number;
  shortMomentum: number;
  trendMomentum: number;
  momentumContraPct: number;
  trendContraPct: number;
  momentumWindowSec: number;
  trendWindowSec: number;
  shortMomentum30s?: number;        // 30s 窗口动量 (多窗口 dumpRatio 校验)
  downAskAtUpPeak?: number;         // UP peak 时刻的 DOWN ask
  upAskAtDownPeak?: number;         // DOWN peak 时刻的 UP ask
  upSignalScore?: number;           // UP 方向加权信号净分 (Binance 交叉验证)
  downSignalScore?: number;         // DOWN 方向加权信号净分
}

export interface MispricingCandidate {
  dir: TradeDirection;
  askPrice: number;
  buyTokenKey: "upToken" | "downToken";
  oppTokenKey: "upToken" | "downToken";
  dumpDetected: string;
  dumpVelocity: "fast" | "normal" | "slow"; // 砸盘速度: fast=<800ms, slow=>3000ms
  trendFollow?: boolean; // 趋势跟随入场(zero-sum repricing 时买上涨侧), 由 bot.ts 放宽 maxAsk
}

export interface MispricingEvaluation {
  cautionMessage?: string;
  bothSidesDumping: boolean;
  candidates: MispricingCandidate[];
  momentumRejects: string[];
}

export function getDirectionalBias(params: DirectionalBiasParams): DirectionalBias {
  const {
    roundStartPrice,
    btcNow,
    shortMomentum,
    trendMomentum,
    directionalMovePct,
    momentumContraPct,
    trendContraPct,
    secsLeft = 900,
    signalScore = 0,
  } = params;

  if (roundStartPrice <= 0 || btcNow <= 0) return "flat";
  const roundDeltaPct = (btcNow - roundStartPrice) / roundStartPrice;

  // 回合后半段动态降低阈值：时间越短 BTC 小幅波动对结果影响越大
  const timeFactor = secsLeft < 450 ? 0.70 : 1.0;
  const effMovePct = directionalMovePct * timeFactor;
  const effTrendContra = trendContraPct * timeFactor;
  const effMomContra = momentumContraPct * timeFactor;

  // 标准 BTC momentum 判断（使用动态阈值）
  if (
    trendMomentum <= -effTrendContra ||
    (roundDeltaPct <= -effMovePct && shortMomentum <= -(effMomContra * 0.5))
  ) {
    return "down";
  }
  if (
    trendMomentum >= effTrendContra ||
    (roundDeltaPct >= effMovePct && shortMomentum >= (effMomContra * 0.5))
  ) {
    return "up";
  }

  // 信号共识补充：BTC momentum 不够阈值但多源信号强一致时仍可出方向
  if (signalScore >= 3.0) {
    if (roundDeltaPct < 0 && shortMomentum < 0) return "down";
    if (roundDeltaPct > 0 && shortMomentum > 0) return "up";
  }

  return "flat";
}

// ask跌幅 / BTC变动 的最低比�?�?低于此值说明BTC变动可以解释ask下跌, 是正确定价而非砸盘
// 动态化: 高波动时BTC变动�? ratio天然�? 需降低阈值避免误杀真砸�?
const MIN_DUMP_RATIO_BASE = 20;
const MIN_DUMP_RATIO_LOW_VOL = 25;  // BTC变动<0.05%时收�?微行情中小跌幅更可能是噪�?
const MIN_DUMP_RATIO_HIGH_VOL = 12; // BTC变动>0.15%时放�?高波下真砸盘ratio天然�?
// 对侧ask上涨阈�?�?一侧跌N%, 对侧�?�?N*此比�?说明市场在重定价而非恐慌
// 分档: 大dump(�?5%)时对侧不太可能等比大�? 放松�?.75; 小dump保持0.85
const OPPOSITE_RISE_RATIO_NORMAL = 0.85;
const OPPOSITE_RISE_RATIO_DEEP = 0.75;   // dump�?5%�?
const DEEP_DUMP_THRESHOLD = 0.15;

function getDynamicMinDumpRatio(btcMovePct: number): number {
  if (btcMovePct < 0.0005) return MIN_DUMP_RATIO_LOW_VOL;  // <0.05%
  if (btcMovePct > 0.0015) return MIN_DUMP_RATIO_HIGH_VOL; // >0.15%
  return MIN_DUMP_RATIO_BASE;
}

function classifyDumpVelocity(dropMs: number): "fast" | "normal" | "slow" {
  if (dropMs <= 800) return "fast";
  if (dropMs >= 3000) return "slow";
  return "normal";
}

export function evaluateMispricingOpportunity(params: MispricingEvaluationParams): MispricingEvaluation {
  const {
    upAsk,
    downAsk,
    oldestUpAsk,
    oldestDownAsk,
    upDrop,
    downDrop,
    upDropMs,
    downDropMs,
    dumpThreshold,
    nearThresholdRatio,
    shortMomentum,
    trendMomentum,
    momentumContraPct,
    trendContraPct,
    momentumWindowSec,
    trendWindowSec,
    shortMomentum30s = 0,
    downAskAtUpPeak = 0,
    upAskAtDownPeak = 0,
    upSignalScore = 0,
    downSignalScore = 0,
  } = params;

  const result: MispricingEvaluation = {
    bothSidesDumping: false,
    candidates: [],
    momentumRejects: [],
  };

  const nearThreshold = dumpThreshold * nearThresholdRatio;

  // slow dump 收紧: 渐进跌价大概率是理性调价
  const upVelocity = classifyDumpVelocity(upDropMs);
  const dnVelocity = classifyDumpVelocity(downDropMs);
  const upEffThreshold = upVelocity === "slow" ? dumpThreshold + 0.02 : dumpThreshold;
  const dnEffThreshold = dnVelocity === "slow" ? dumpThreshold + 0.02 : dumpThreshold;

  if (upDrop >= upEffThreshold && downDrop >= dnEffThreshold) {
    result.bothSidesDumping = true;
  }

  if ((upDrop >= upEffThreshold && downDrop >= nearThreshold) || (downDrop >= dnEffThreshold && upDrop >= nearThreshold)) {
    result.cautionMessage = "near-dual-dump (UP -" + (upDrop * 100).toFixed(1) + "%, DN -" + (downDrop * 100).toFixed(1) + "%)";
  }

  const upValid = oldestUpAsk > 0.10 && upDrop >= upEffThreshold;
  const downValid = oldestDownAsk > 0.10 && downDrop >= dnEffThreshold;
  const upExtremeDump = upDrop >= upEffThreshold * 1.35;
  const downExtremeDump = downDrop >= dnEffThreshold * 1.35;
  const strongDownTrend = trendMomentum <= -trendContraPct && shortMomentum <= -(momentumContraPct * 0.5);
  const strongUpTrend = trendMomentum >= trendContraPct && shortMomentum >= (momentumContraPct * 0.5);
  const alignedDownMove = shortMomentum <= -(momentumContraPct * 1.25) && trendMomentum <= -(trendContraPct * 0.5);
  const alignedUpMove = shortMomentum >= (momentumContraPct * 1.25) && trendMomentum >= (trendContraPct * 0.5);

  const softDownAlign = shortMomentum <= -(momentumContraPct * 0.5);
  const softUpAlign = shortMomentum >= (momentumContraPct * 0.5);

  const upRejected = upValid && (upExtremeDump ? (strongDownTrend && alignedDownMove) : (strongDownTrend && softDownAlign));
  if (upRejected) {
    result.momentumRejects.push(
      "UP dump but BTC dropping short=" + (shortMomentum * 100).toFixed(3) + "%/" + momentumWindowSec + "s trend=" + (trendMomentum * 100).toFixed(3) + "%/" + trendWindowSec + "s"
    );
  }
  const downRejected = downValid && (downExtremeDump ? (strongUpTrend && alignedUpMove) : (strongUpTrend && softUpAlign));
  if (downRejected) {
    result.momentumRejects.push(
      "DN dump but BTC rising short=+" + (shortMomentum * 100).toFixed(3) + "%/" + momentumWindowSec + "s trend=+" + (trendMomentum * 100).toFixed(3) + "%/" + trendWindowSec + "s"
    );
  }

  const upRise = oldestUpAsk > 0.10 ? (upAsk - oldestUpAsk) / oldestUpAsk : 0;
  const downRise = oldestDownAsk > 0.10 ? (downAsk - oldestDownAsk) / oldestDownAsk : 0;

  if (upValid && !upRejected) {
    // 多窗口 BTC 动量: 取 60s 和 30s 中更大的跌幅作分母 (防 V-型反转误判)
    const btcDrop60 = shortMomentum < 0 ? Math.abs(shortMomentum) : 0;
    const btcDrop30 = shortMomentum30s < 0 ? Math.abs(shortMomentum30s) : 0;
    const btcDrop = Math.max(btcDrop60, btcDrop30);
    const dynamicMinDumpRatio = getDynamicMinDumpRatio(btcDrop);
    const dumpRatio = btcDrop > 0.0001 ? upDrop / btcDrop : Infinity;
    let effectiveDumpRatio = upVelocity === "fast" ? dynamicMinDumpRatio * 0.7
      : upVelocity === "slow" ? dynamicMinDumpRatio * 1.3
      : dynamicMinDumpRatio;
    // Binance 信号交叉验证
    if (upSignalScore >= 2.0) effectiveDumpRatio *= 0.80;
    else if (upSignalScore <= -1.0) effectiveDumpRatio *= 1.25;

    const upOppRatio = upDrop >= DEEP_DUMP_THRESHOLD ? OPPOSITE_RISE_RATIO_DEEP : OPPOSITE_RISE_RATIO_NORMAL;
    const oppositeRose = downRise >= upDrop * upOppRatio;
    // peak 时段内对侧涨幅检测: 更精准捕捉 repricing
    const oppRiseSincePeak = downAskAtUpPeak > 0.10
      ? (downAsk - downAskAtUpPeak) / downAskAtUpPeak : 0;
    const oppositeRoseSincePeak = oppRiseSincePeak >= upDrop * upOppRatio;

    if (dumpRatio < effectiveDumpRatio) {
      result.momentumRejects.push(
        "UP dump ratio=" + dumpRatio.toFixed(1) + " < " + effectiveDumpRatio.toFixed(0) + " (ask-" + (upDrop*100).toFixed(1) + "% vs BTC drop " + (btcDrop*100).toFixed(3) + "% vel=" + upVelocity + " sig=" + upSignalScore.toFixed(1) + ") - likely correct repricing"
      );
    } else if (oppositeRose || oppositeRoseSincePeak) {
      const which = oppositeRoseSincePeak && !oppositeRose ? "since-peak" : "oldest";
      result.momentumRejects.push(
        "UP dump but DN ask rose +" + (downRise*100).toFixed(1) + "% (peak+" + (oppRiseSincePeak*100).toFixed(1) + "%) [" + which + "] - zero-sum repricing"
      );
      // 趋势跟随: UP 砸盘 + DN 上涨 + BTC 下跌 → DOWN 是赢家, 但 ask 已在上涨, 仍可能有 BSM edge
      // 条件: BTC 60s 明确下跌(<-0.03%) 且 DN 信号共识支持 + DN ask 在 0.30-0.85 合理区间
      const btcConfirmsDown = shortMomentum <= -0.0003;
      if (btcConfirmsDown && downSignalScore >= 1.5 && downAsk >= 0.30 && downAsk <= 0.85) {
        result.candidates.push({
          dir: "down",
          askPrice: downAsk,
          buyTokenKey: "downToken",
          oppTokenKey: "upToken",
          dumpDetected: "TREND-FOLLOW: UP dump -" + (upDrop*100).toFixed(1) + "% + DN rise +" + (downRise*100).toFixed(1) + "% (BTC60=" + (shortMomentum*100).toFixed(3) + "% sig=" + downSignalScore.toFixed(1) + ") → buy DN @" + downAsk.toFixed(2),
          dumpVelocity: upVelocity,
          trendFollow: true,
        });
      }
    } else {
      result.candidates.push({
        dir: "up",
        askPrice: upAsk,
        buyTokenKey: "upToken",
        oppTokenKey: "downToken",
        dumpDetected: "UP ask " + oldestUpAsk.toFixed(2) + "->" + upAsk.toFixed(2) + " (-" + (upDrop * 100).toFixed(1) + "%) [BTC" + momentumWindowSec + " " + (shortMomentum * 100).toFixed(3) + "% BTC30 " + (shortMomentum30s * 100).toFixed(3) + "% ratio=" + dumpRatio.toFixed(0) + " dnRise=" + (downRise*100).toFixed(1) + "% vel=" + upVelocity + " sig=" + upSignalScore.toFixed(1) + "]",
        dumpVelocity: upVelocity,
      });
    }
  }

  if (downValid && !downRejected) {
    // 多窗口 BTC 动量
    const btcRise60 = shortMomentum > 0 ? shortMomentum : 0;
    const btcRise30 = shortMomentum30s > 0 ? shortMomentum30s : 0;
    const btcRise = Math.max(btcRise60, btcRise30);
    const dynamicMinDumpRatio = getDynamicMinDumpRatio(btcRise);
    const dumpRatio = btcRise > 0.0001 ? downDrop / btcRise : Infinity;
    let effectiveDumpRatio = dnVelocity === "fast" ? dynamicMinDumpRatio * 0.7
      : dnVelocity === "slow" ? dynamicMinDumpRatio * 1.3
      : dynamicMinDumpRatio;
    // Binance 信号交叉验证
    if (downSignalScore >= 2.0) effectiveDumpRatio *= 0.80;
    else if (downSignalScore <= -1.0) effectiveDumpRatio *= 1.25;

    const dnOppRatio = downDrop >= DEEP_DUMP_THRESHOLD ? OPPOSITE_RISE_RATIO_DEEP : OPPOSITE_RISE_RATIO_NORMAL;
    const oppositeRose = upRise >= downDrop * dnOppRatio;
    const oppRiseSincePeak = upAskAtDownPeak > 0.10
      ? (upAsk - upAskAtDownPeak) / upAskAtDownPeak : 0;
    const oppositeRoseSincePeak = oppRiseSincePeak >= downDrop * dnOppRatio;

    if (dumpRatio < effectiveDumpRatio) {
      result.momentumRejects.push(
        "DN dump ratio=" + dumpRatio.toFixed(1) + " < " + effectiveDumpRatio.toFixed(0) + " (ask-" + (downDrop*100).toFixed(1) + "% vs BTC rise " + (btcRise*100).toFixed(3) + "% vel=" + dnVelocity + " sig=" + downSignalScore.toFixed(1) + ") - likely correct repricing"
      );
    } else if (oppositeRose || oppositeRoseSincePeak) {
      const which = oppositeRoseSincePeak && !oppositeRose ? "since-peak" : "oldest";
      result.momentumRejects.push(
        "DN dump but UP ask rose +" + (upRise*100).toFixed(1) + "% (peak+" + (oppRiseSincePeak*100).toFixed(1) + "%) [" + which + "] - zero-sum repricing"
      );
      // 趋势跟随: DN 砸盘 + UP 上涨 + BTC 上涨 → UP 是赢家, 仍可能有 BSM edge
      const btcConfirmsUp = shortMomentum >= 0.0003;
      if (btcConfirmsUp && upSignalScore >= 1.5 && upAsk >= 0.30 && upAsk <= 0.85) {
        result.candidates.push({
          dir: "up",
          askPrice: upAsk,
          buyTokenKey: "upToken",
          oppTokenKey: "downToken",
          dumpDetected: "TREND-FOLLOW: DN dump -" + (downDrop*100).toFixed(1) + "% + UP rise +" + (upRise*100).toFixed(1) + "% (BTC60=+" + (shortMomentum*100).toFixed(3) + "% sig=" + upSignalScore.toFixed(1) + ") → buy UP @" + upAsk.toFixed(2),
          dumpVelocity: dnVelocity,
          trendFollow: true,
        });
      }
    } else {
      result.candidates.push({
        dir: "down",
        askPrice: downAsk,
        buyTokenKey: "downToken",
        oppTokenKey: "upToken",
        dumpDetected: "DOWN ask " + oldestDownAsk.toFixed(2) + "->" + downAsk.toFixed(2) + " (-" + (downDrop * 100).toFixed(1) + "%) [BTC" + momentumWindowSec + " " + (shortMomentum * 100).toFixed(3) + "% BTC30 " + (shortMomentum30s * 100).toFixed(3) + "% ratio=" + dumpRatio.toFixed(0) + " upRise=" + (upRise*100).toFixed(1) + "% vel=" + dnVelocity + " sig=" + downSignalScore.toFixed(1) + "]",
        dumpVelocity: dnVelocity,
      });
    }
  }

  result.candidates.sort((left, right) => {
    const leftDrop = left.dir === "up" ? upDrop : downDrop;
    const rightDrop = right.dir === "up" ? upDrop : downDrop;
    return rightDrop - leftDrop;
  });

  return result;
}







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
}

export interface MispricingCandidate {
  dir: TradeDirection;
  askPrice: number;
  buyTokenKey: "upToken" | "downToken";
  oppTokenKey: "upToken" | "downToken";
  dumpDetected: string;
  dumpVelocity: "fast" | "normal" | "slow"; // 砸盘速度: fast=<800ms, slow=>3000ms
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
  } = params;

  if (roundStartPrice <= 0 || btcNow <= 0) return "flat";
  const roundDeltaPct = (btcNow - roundStartPrice) / roundStartPrice;

  if (
    trendMomentum <= -trendContraPct ||
    (roundDeltaPct <= -directionalMovePct && shortMomentum <= -(momentumContraPct * 0.5))
  ) {
    return "down";
  }
  if (
    trendMomentum >= trendContraPct ||
    (roundDeltaPct >= directionalMovePct && shortMomentum >= (momentumContraPct * 0.5))
  ) {
    return "up";
  }

  return "flat";
}

// ask跌幅 / BTC变动 的最低比�?�?低于此值说明BTC变动可以解释ask下跌, 是正确定价而非砸盘
// 动态化: 高波动时BTC变动�? ratio天然�? 需降低阈值避免误杀真砸�?
const MIN_DUMP_RATIO_BASE = 10;
const MIN_DUMP_RATIO_LOW_VOL = 12;  // BTC变动<0.05%时收�?微行情中小跌幅更可能是噪�?
const MIN_DUMP_RATIO_HIGH_VOL = 6; // BTC变动>0.15%时放�?高波下真砸盘ratio天然�?
// 对侧ask上涨阈�?�?一侧跌N%, 对侧�?�?N*此比�?说明市场在重定价而非恐慌
// 分档: 大dump(�?5%)时对侧不太可能等比大�? 放松�?.75; 小dump保持0.85
const OPPOSITE_RISE_RATIO_NORMAL = 0.95;
const OPPOSITE_RISE_RATIO_DEEP = 0.90;   // dump�?5%�?
const DEEP_DUMP_THRESHOLD = 0.10;

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
  } = params;

  const result: MispricingEvaluation = {
    bothSidesDumping: false,
    candidates: [],
    momentumRejects: [],
  };

  const nearThreshold = dumpThreshold * nearThresholdRatio;
  if (upDrop >= dumpThreshold && downDrop >= dumpThreshold) {
    result.bothSidesDumping = true;
  }

  if ((upDrop >= dumpThreshold && downDrop >= nearThreshold) || (downDrop >= dumpThreshold && upDrop >= nearThreshold)) {
    result.cautionMessage = "near-dual-dump (UP -" + (upDrop * 100).toFixed(1) + "%, DN -" + (downDrop * 100).toFixed(1) + "%)";
  }

  const upValid = oldestUpAsk > 0.10 && upDrop >= dumpThreshold;
  const downValid = oldestDownAsk > 0.10 && downDrop >= dumpThreshold;
  const upExtremeDump = upDrop >= dumpThreshold * 1.35;
  const downExtremeDump = downDrop >= dumpThreshold * 1.35;
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
      const upVelocity = classifyDumpVelocity(upDropMs);
      const btcDrop = shortMomentum < 0 ? Math.abs(shortMomentum) : 0;
      const dynamicMinDumpRatio = getDynamicMinDumpRatio(btcDrop);
      const dumpRatio = btcDrop > 0.0001 ? upDrop / btcDrop : Infinity;
      const effectiveDumpRatio = upVelocity === "fast" ? dynamicMinDumpRatio * 0.7 : dynamicMinDumpRatio;

      const upOppRatio = upDrop >= DEEP_DUMP_THRESHOLD ? OPPOSITE_RISE_RATIO_DEEP : OPPOSITE_RISE_RATIO_NORMAL;
      const oppositeRose = downRise >= upDrop * upOppRatio;
      if (dumpRatio < effectiveDumpRatio) {
        result.momentumRejects.push(
          "UP dump ratio=" + dumpRatio.toFixed(1) + " < " + effectiveDumpRatio.toFixed(0) + " (ask-" + (upDrop*100).toFixed(1) + "% vs BTC drop " + (btcDrop*100).toFixed(3) + "% vel=" + upVelocity + ") - likely correct repricing"
        );
      } else if (oppositeRose) {
        result.momentumRejects.push(
          "UP dump but DN ask rose +" + (downRise*100).toFixed(1) + "% (>=" + (upDrop*upOppRatio*100).toFixed(1) + "%) - zero-sum repricing"
        );
      } else {
        result.candidates.push({
          dir: "up",
          askPrice: upAsk,
          buyTokenKey: "upToken",
          oppTokenKey: "downToken",
          dumpDetected: "UP ask " + oldestUpAsk.toFixed(2) + "->" + upAsk.toFixed(2) + " (-" + (upDrop * 100).toFixed(1) + "%) [BTC" + momentumWindowSec + " " + (shortMomentum * 100).toFixed(3) + "% BTC" + trendWindowSec + " " + (trendMomentum * 100).toFixed(3) + "% ratio=" + dumpRatio.toFixed(0) + " dnRise=" + (downRise*100).toFixed(1) + "% vel=" + upVelocity + "]",
          dumpVelocity: upVelocity,
        });
      }
    }

    if (downValid && !downRejected) {
      const dnVelocity = classifyDumpVelocity(downDropMs);
      const btcRise = shortMomentum > 0 ? shortMomentum : 0;
      const dynamicMinDumpRatio = getDynamicMinDumpRatio(btcRise);
      const dumpRatio = btcRise > 0.0001 ? downDrop / btcRise : Infinity;
      const effectiveDumpRatio = dnVelocity === "fast" ? dynamicMinDumpRatio * 0.7 : dynamicMinDumpRatio;

      const dnOppRatio = downDrop >= DEEP_DUMP_THRESHOLD ? OPPOSITE_RISE_RATIO_DEEP : OPPOSITE_RISE_RATIO_NORMAL;
      const oppositeRose = upRise >= downDrop * dnOppRatio;
      if (dumpRatio < effectiveDumpRatio) {
        result.momentumRejects.push(
          "DN dump ratio=" + dumpRatio.toFixed(1) + " < " + effectiveDumpRatio.toFixed(0) + " (ask-" + (downDrop*100).toFixed(1) + "% vs BTC rise " + (btcRise*100).toFixed(3) + "% vel=" + dnVelocity + ") - likely correct repricing"
        );
      } else if (oppositeRose) {
        result.momentumRejects.push(
          "DN dump but UP ask rose +" + (upRise*100).toFixed(1) + "% (>=" + (downDrop*dnOppRatio*100).toFixed(1) + "%) - zero-sum repricing"
        );
      } else {
        result.candidates.push({
          dir: "down",
          askPrice: downAsk,
          buyTokenKey: "downToken",
          oppTokenKey: "upToken",
          dumpDetected: "DOWN ask " + oldestDownAsk.toFixed(2) + "->" + downAsk.toFixed(2) + " (-" + (downDrop * 100).toFixed(1) + "%) [BTC" + momentumWindowSec + " " + (shortMomentum * 100).toFixed(3) + "% BTC" + trendWindowSec + " " + (trendMomentum * 100).toFixed(3) + "% ratio=" + dumpRatio.toFixed(0) + " upRise=" + (upRise*100).toFixed(1) + "% vel=" + dnVelocity + "]",
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







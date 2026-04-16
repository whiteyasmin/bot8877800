import { DirectionalBias, TradeDirection } from "./strategyEngine";

export interface HedgeEntryPlanInput {
  dir: TradeDirection;
  askPrice: number;
  maxEntryAsk: number;
  minEntryAsk: number;
  directionalBias: DirectionalBias;
}

export interface EntryPlanResult {
  allowed: boolean;
  reason?: string;
}

export function planHedgeEntry(input: HedgeEntryPlanInput): EntryPlanResult {
  const {
    dir,
    askPrice,
    maxEntryAsk,
    minEntryAsk,
    directionalBias,
  } = input;

  if (askPrice > maxEntryAsk) {
    return { allowed: false, reason: `ask=${askPrice.toFixed(2)} > MAX_ENTRY_ASK=${maxEntryAsk}` };
  }
  if (askPrice < minEntryAsk) {
    return { allowed: false, reason: `ask=${askPrice.toFixed(2)} < MIN_ENTRY_ASK=${minEntryAsk}` };
  }
  // 逆势判断统一由 buyLeg1 的 isContraTrend gate 处理 (CONTRA_TREND_EXTRA_EDGE + CONTRA_TREND_SCALE)
  // 高 edge 的逆势入场仍有 EV+，不在此处硬拒
  return { allowed: true };
}
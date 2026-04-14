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
  // BTC方向逆向过滤: 狙击手+推土机融合
  // 顺势可以不管，但如果是逆向(BTC跌时买UP=接飞刀)，只允许在价格极便宜(<=0.22)时接盘
  if (directionalBias === "down" && dir === "up") {
    if (askPrice > 0.22) {
      return { allowed: false, reason: `逆势(BTC向下买UP)且价格${askPrice.toFixed(2)}>0.22, 拒绝推土机高频损耗` };
    }
  }
  if (directionalBias === "up" && dir === "down") {
    if (askPrice > 0.22) {
      return { allowed: false, reason: `逆势(BTC向上买DOWN)且价格${askPrice.toFixed(2)}>0.22, 拒绝推土机高频损耗` };
    }
  }
  return { allowed: true };
}
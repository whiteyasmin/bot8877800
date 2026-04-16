export interface AskSnapshot {
  ts: number;
  upAsk: number;
  downAsk: number;
}

export interface DumpBaseline {
  oldest: { upAsk: number; downAsk: number };
  peak: { upAsk: number; downAsk: number };
  upDrop: number;
  downDrop: number;
  upDropMs: number;   // 从峰值到当前经过的毫秒数 (用于计算dump velocity)
  downDropMs: number;
  downAskAtUpPeak: number;   // UP 侧 peak 时刻的 DOWN ask
  upAskAtDownPeak: number;   // DOWN 侧 peak 时刻的 UP ask
}

export class RoundMarketState {
  private askSnapshots: AskSnapshot[] = [];

  reset(): void {
    this.askSnapshots = [];
  }

  push(upAsk: number, downAsk: number, retainMs: number, now = Date.now()): void {
    this.askSnapshots.push({ ts: now, upAsk, downAsk });
    const cutoff = now - retainMs;
    this.askSnapshots = this.askSnapshots.filter((snapshot) => snapshot.ts >= cutoff);
  }

  getDumpBaseline(minAgeMs: number, now = Date.now()): DumpBaseline | null {
    const oldSnapshots = this.askSnapshots.filter((snapshot) => now - snapshot.ts >= minAgeMs);
    if (oldSnapshots.length === 0) return null;

    // oldest基准: 最早3个快照均值 (原有逻辑)
    const baseSnapshots = oldSnapshots.slice(0, Math.min(3, oldSnapshots.length));
    const oldest = {
      upAsk: baseSnapshots.reduce((sum, snapshot) => sum + snapshot.upAsk, 0) / baseSnapshots.length,
      downAsk: baseSnapshots.reduce((sum, snapshot) => sum + snapshot.downAsk, 0) / baseSnapshots.length,
    };

    // peak基准: P90 分位数 (消除单点尖刺噪声，样本<5 时回退到绝对最大)
    const snaps = this.askSnapshots;
    const sortedUp = snaps.map(s => s.upAsk).sort((a, b) => a - b);
    const sortedDn = snaps.map(s => s.downAsk).sort((a, b) => a - b);
    const peakUpAsk = sortedUp.length >= 5
      ? sortedUp[Math.floor(sortedUp.length * 0.9)]
      : sortedUp[sortedUp.length - 1];
    const peakDownAsk = sortedDn.length >= 5
      ? sortedDn[Math.floor(sortedDn.length * 0.9)]
      : sortedDn[sortedDn.length - 1];

    // peak 时间戳取该 P90 价位首次出现的时刻；同时记录 peak 时刻对侧价格
    let peakUpTs = now;
    let downAskAtUpPeak = 0;
    for (const snap of snaps) {
      if (snap.upAsk >= peakUpAsk) { peakUpTs = snap.ts; downAskAtUpPeak = snap.downAsk; break; }
    }
    let peakDownTs = now;
    let upAskAtDownPeak = 0;
    for (const snap of snaps) {
      if (snap.downAsk >= peakDownAsk) { peakDownTs = snap.ts; upAskAtDownPeak = snap.upAsk; break; }
    }
    const peak = { upAsk: peakUpAsk, downAsk: peakDownAsk };

    const latest = snaps[snaps.length - 1];

    // 跌幅取 oldest基准 和 peak基准 中更大者
    const upDropOldest = oldest.upAsk > 0.10 ? (oldest.upAsk - latest.upAsk) / oldest.upAsk : 0;
    const upDropPeak = peakUpAsk > 0.10 ? (peakUpAsk - latest.upAsk) / peakUpAsk : 0;
    const downDropOldest = oldest.downAsk > 0.10 ? (oldest.downAsk - latest.downAsk) / oldest.downAsk : 0;
    const downDropPeak = peakDownAsk > 0.10 ? (peakDownAsk - latest.downAsk) / peakDownAsk : 0;

    const upDrop = Math.max(upDropOldest, upDropPeak);
    const downDrop = Math.max(downDropOldest, downDropPeak);

    // 从峰值到当前的时间跨度 (ms), 用于计算dump velocity
    const upDropMs = Math.max(1, now - peakUpTs);
    const downDropMs = Math.max(1, now - peakDownTs);

    return { oldest, peak, upDrop, downDrop, upDropMs, downDropMs, downAskAtUpPeak, upAskAtDownPeak };
  }
}

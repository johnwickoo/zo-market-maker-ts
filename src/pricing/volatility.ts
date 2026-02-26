// Volatility Tracker — rolling realized volatility from price returns
//
// Theory: Realized volatility = stddev of log-returns over a window.
// Used to dynamically adjust spread: wider when volatile, tighter when calm.
//
// We sample mid-price once per second and compute rolling stddev
// of percentage returns over a configurable window.

export interface VolatilityState {
  readonly realizedVolBps: number;    // Annualized vol in bps (for display)
  readonly recentVolBps: number;      // Raw rolling stddev of returns in bps
  readonly sampleCount: number;
  readonly isReady: boolean;
}

export interface VolatilityConfig {
  readonly windowSeconds: number;     // Rolling window size (default 60)
  readonly minSamples: number;        // Min samples before producing vol (default 10)
}

const MAX_SAMPLES = 300; // 5 minutes of per-second samples

export class VolatilityTracker {
  private prices: number[] = [];
  private head = 0;
  private count = 0;
  private timestamps: number[] = [];
  private lastSecond = 0;

  constructor(private readonly config: VolatilityConfig) {}

  // Record a price sample (deduped to once per second)
  addPrice(mid: number): void {
    const currentSecond = Math.floor(Date.now() / 1000);
    if (currentSecond <= this.lastSecond) return;
    this.lastSecond = currentSecond;

    this.prices[this.head] = mid;
    this.timestamps[this.head] = currentSecond;
    this.head = (this.head + 1) % MAX_SAMPLES;
    if (this.count < MAX_SAMPLES) this.count++;
  }

  // Get percentage returns within the window
  private getReturns(): number[] {
    const cutoff = Math.floor(Date.now() / 1000) - this.config.windowSeconds;
    const validPrices: number[] = [];

    for (let i = 0; i < this.count; i++) {
      if (this.timestamps[i] > cutoff) {
        validPrices.push(this.prices[i]);
      }
    }

    if (validPrices.length < 2) return [];

    const returns: number[] = [];
    for (let i = 1; i < validPrices.length; i++) {
      if (validPrices[i - 1] > 0) {
        // Percentage return in bps
        returns.push(((validPrices[i] - validPrices[i - 1]) / validPrices[i - 1]) * 10000);
      }
    }
    return returns;
  }

  // Rolling standard deviation of returns (in bps)
  getVolatilityBps(): number | null {
    const returns = this.getReturns();
    if (returns.length < this.config.minSamples) return null;

    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
    return Math.sqrt(variance);
  }

  getState(): VolatilityState {
    const volBps = this.getVolatilityBps();
    const returns = this.getReturns();
    return {
      realizedVolBps: volBps !== null ? volBps * Math.sqrt(86400) : 0, // Annualize (seconds in a day)
      recentVolBps: volBps ?? 0,
      sampleCount: returns.length,
      isReady: volBps !== null,
    };
  }
}

// Momentum Detector — exponential moving average of signed returns
//
// Detects short-term directional flow. When momentum is strong,
// the quoter should pull or widen the side that's getting adversely selected.
//
// Output: momentum in bps (positive = price rising, negative = falling)

export interface MomentumState {
  readonly momentumBps: number;       // EMA of recent returns in bps
  readonly isStrong: boolean;         // |momentum| > threshold
  readonly direction: "up" | "down" | "neutral";
}

export interface MomentumConfig {
  readonly emaPeriodSeconds: number;  // EMA half-life (default 8)
  readonly strongThresholdBps: number; // Threshold for "strong" momentum (default 3)
}

export class MomentumDetector {
  private ema = 0;
  private lastPrice = 0;
  private lastSecond = 0;
  private alpha: number;
  private initialized = false;

  constructor(private readonly config: MomentumConfig) {
    // EMA alpha: 2 / (period + 1)
    this.alpha = 2 / (config.emaPeriodSeconds + 1);
  }

  addPrice(mid: number): void {
    const currentSecond = Math.floor(Date.now() / 1000);
    if (currentSecond <= this.lastSecond) return;
    this.lastSecond = currentSecond;

    if (!this.initialized) {
      this.lastPrice = mid;
      this.initialized = true;
      return;
    }

    if (this.lastPrice > 0) {
      const returnBps = ((mid - this.lastPrice) / this.lastPrice) * 10000;
      this.ema = this.alpha * returnBps + (1 - this.alpha) * this.ema;
    }
    this.lastPrice = mid;
  }

  getMomentumBps(): number {
    return this.ema;
  }

  getState(): MomentumState {
    const m = this.ema;
    const abs = Math.abs(m);
    return {
      momentumBps: m,
      isStrong: abs > this.config.strongThresholdBps,
      direction: abs <= this.config.strongThresholdBps ? "neutral" : m > 0 ? "up" : "down",
    };
  }
}

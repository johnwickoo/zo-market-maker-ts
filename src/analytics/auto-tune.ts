// Auto-Tuner — takes a performance report and current config, produces an optimized config
//
// This is the "learning from past trades" system. It adjusts parameters
// based on statistical evidence from actual trading performance.
//
// Rules (inspired by Kelly criterion and market microstructure theory):
//   1. Spread: f(win_rate, fill_rate, volatility proxy)
//   2. Order size: f(drawdown_ratio, win_rate, account_utilization)
//   3. Close threshold: f(max_position_ratio, drawdown)
//   4. Fair price window: f(side_imbalance, fill_rate)

import type { MarketMakerConfig } from "../bots/mm/config.js";
import type { RiskConfig } from "../bots/mm/configs.js";
import type { PerformanceReport } from "./analyzer.js";

export interface TuneResult {
  config: Omit<MarketMakerConfig, "symbol">;
  risk: RiskConfig;
  changes: ConfigChange[];
}

export interface ConfigChange {
  parameter: string;
  oldValue: number;
  newValue: number;
  reason: string;
}

export function autoTune(
  report: PerformanceReport,
  currentConfig: Omit<MarketMakerConfig, "symbol">,
  currentRisk: RiskConfig,
): TuneResult {
  const changes: ConfigChange[] = [];
  const config = { ...currentConfig };
  const risk = { ...currentRisk };

  // Need minimum sample size to make adjustments
  if (report.totalTrades < 20) {
    return { config, risk, changes };
  }

  // ─── 1. Spread Adjustment ──────────────────────────────────────────
  // Goal: maximize PnL = fill_rate × profit_per_fill
  // Wider spread → more profit per fill, fewer fills
  // Tighter spread → more fills, less profit per fill
  const newSpread = tuneSpread(report, config.spreadBps);
  if (newSpread !== config.spreadBps) {
    changes.push({
      parameter: "spreadBps",
      oldValue: config.spreadBps,
      newValue: newSpread,
      reason: `Win rate ${(report.winRate * 100).toFixed(0)}%, fills/hr ${report.tradesPerHour.toFixed(1)}, capture ${(report.spreadCaptureRate * 100).toFixed(0)}%`,
    });
    config.spreadBps = newSpread;
  }

  // ─── 2. Take Profit Spread ─────────────────────────────────────────
  // Close mode spread: should be tight enough to close quickly
  // but not so tight that we get adversely selected
  const newTakeProfit = tuneTakeProfit(report, config.takeProfitBps);
  if (newTakeProfit !== config.takeProfitBps) {
    changes.push({
      parameter: "takeProfitBps",
      oldValue: config.takeProfitBps,
      newValue: newTakeProfit,
      reason: `Adjusted based on close mode performance`,
    });
    config.takeProfitBps = newTakeProfit;
  }

  // ─── 3. Order Size ─────────────────────────────────────────────────
  // Scale with account profitability and risk utilization
  const newSize = tuneOrderSize(report, config.orderSizeUsd, risk.accountSizeUsd);
  if (newSize !== config.orderSizeUsd) {
    changes.push({
      parameter: "orderSizeUsd",
      oldValue: config.orderSizeUsd,
      newValue: newSize,
      reason: `Position util ${((report.maxPositionUsd / risk.accountSizeUsd) * 100).toFixed(0)}%, dd ${report.maxDrawdownPct.toFixed(1)}%`,
    });
    config.orderSizeUsd = newSize;
  }

  // ─── 4. Close Threshold ────────────────────────────────────────────
  const newThreshold = tuneCloseThreshold(report, config.closeThresholdUsd, risk.accountSizeUsd);
  if (newThreshold !== config.closeThresholdUsd) {
    changes.push({
      parameter: "closeThresholdUsd",
      oldValue: config.closeThresholdUsd,
      newValue: newThreshold,
      reason: `Max position $${report.maxPositionUsd.toFixed(2)}, dd ${report.maxDrawdownPct.toFixed(1)}%`,
    });
    config.closeThresholdUsd = newThreshold;
  }

  // ─── 5. Fair Price Window ──────────────────────────────────────────
  const newWindow = tuneFairPriceWindow(report, config.fairPriceWindowMs);
  if (newWindow !== config.fairPriceWindowMs) {
    changes.push({
      parameter: "fairPriceWindowMs",
      oldValue: config.fairPriceWindowMs,
      newValue: newWindow,
      reason: `Side imbalance: buy=${report.buyStats.count} sell=${report.sellStats.count}`,
    });
    config.fairPriceWindowMs = newWindow;
  }

  return { config, risk, changes };
}

function tuneSpread(report: PerformanceReport, current: number): number {
  let target = current;

  // If win rate is low, widen spread
  if (report.winRate < 0.4) {
    target = Math.round(current * 1.3);
  } else if (report.winRate > 0.65 && report.tradesPerHour < 3) {
    // High win rate but low activity → tighten to get more fills
    target = Math.round(current * 0.8);
  }

  // If spread capture is poor, widen
  if (report.spreadCaptureRate < 0.25) {
    target = Math.max(target, Math.round(current * 1.2));
  }

  // If profitable and active, can try slightly tighter
  if (report.totalRealizedPnl > 0 && report.tradesPerHour > 10 && report.winRate > 0.5) {
    target = Math.max(target - 1, Math.round(current * 0.9));
  }

  // Clamp: never below 3 bps (fee floor) or above 30 bps (too wide)
  return clamp(target, 3, 30);
}

function tuneTakeProfit(report: PerformanceReport, current: number): number {
  // Keep take profit between 0.5 and 5 bps
  // If strategy is profitable, we can be tighter on close
  if (report.totalRealizedPnl > 0 && report.winRate > 0.5) {
    return clamp(Math.round(current * 0.8 * 10) / 10, 0.5, 5);
  }
  // If losing, give more room for close orders to fill profitably
  if (report.totalRealizedPnl < 0) {
    return clamp(Math.round(current * 1.5 * 10) / 10, 0.5, 5);
  }
  return current;
}

function tuneOrderSize(
  report: PerformanceReport,
  current: number,
  accountSize: number,
): number {
  const posRatio = report.maxPositionUsd / accountSize;
  const ddRatio = report.maxDrawdownPct / 100;

  let target = current;

  // If position got too large relative to account, shrink
  if (posRatio > 0.25) {
    target = Math.round(current * 0.8);
  }

  // If drawdown was high, shrink
  if (ddRatio > 0.08) {
    target = Math.round(current * 0.7);
  }

  // If things are going well and we're under-utilizing, grow slowly
  if (posRatio < 0.1 && ddRatio < 0.03 && report.totalRealizedPnl > 0 && report.totalTrades > 50) {
    target = Math.round(current * 1.15);
  }

  // Clamp: $1 min, 10% of account max
  return clamp(target, 1, Math.round(accountSize * 0.1));
}

function tuneCloseThreshold(
  report: PerformanceReport,
  current: number,
  accountSize: number,
): number {
  const ddRatio = report.maxDrawdownPct / 100;

  // If drawdown was significant, lower the threshold
  if (ddRatio > 0.08) {
    return clamp(Math.round(current * 0.8), 3, Math.round(accountSize * 0.3));
  }

  // If very safe, can raise slightly
  if (ddRatio < 0.02 && report.totalRealizedPnl > 0) {
    return clamp(Math.round(current * 1.1), 3, Math.round(accountSize * 0.3));
  }

  return current;
}

function tuneFairPriceWindow(report: PerformanceReport, current: number): number {
  const total = report.buyStats.count + report.sellStats.count;
  if (total < 20) return current;

  const buyRatio = report.buyStats.count / total;
  const imbalance = Math.abs(buyRatio - 0.5);

  // If fills are heavily skewed to one side, the fair price may be off
  // Longer window = more smoothing = less bias
  if (imbalance > 0.15) {
    return clamp(Math.round(current * 1.3), 60_000, 600_000);
  }

  // If balanced, can use shorter window for responsiveness
  if (imbalance < 0.05) {
    return clamp(Math.round(current * 0.85), 60_000, 600_000);
  }

  return current;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// Format tune results for display
export function formatTuneResult(result: TuneResult): string {
  const lines: string[] = [];

  lines.push("");
  lines.push("╔══════════════════════════════════════════════════════════════╗");
  lines.push("║              AUTO-TUNED CONFIGURATION                      ║");
  lines.push("╚══════════════════════════════════════════════════════════════╝");
  lines.push("");

  if (result.changes.length === 0) {
    lines.push("  No changes recommended (insufficient data or already optimal).");
    lines.push("");
    return lines.join("\n");
  }

  lines.push("  CHANGES:");
  for (const c of result.changes) {
    lines.push(`    ${c.parameter}: ${c.oldValue} → ${c.newValue}`);
    lines.push(`      ${c.reason}`);
    lines.push("");
  }

  lines.push("  SUGGESTED CONFIG:");
  lines.push(`    spreadBps:          ${result.config.spreadBps}`);
  lines.push(`    takeProfitBps:      ${result.config.takeProfitBps}`);
  lines.push(`    orderSizeUsd:       ${result.config.orderSizeUsd}`);
  lines.push(`    closeThresholdUsd:  ${result.config.closeThresholdUsd}`);
  lines.push(`    fairPriceWindowMs:  ${result.config.fairPriceWindowMs}`);
  lines.push(`    warmupSeconds:      ${result.config.warmupSeconds}`);
  lines.push(`    updateThrottleMs:   ${result.config.updateThrottleMs}`);
  lines.push("");

  return lines.join("\n");
}

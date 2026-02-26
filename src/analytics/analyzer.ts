// Trade Analyzer — processes trade logs and produces performance metrics
//
// Computes:
//   - Total PnL, realized PnL, win rate
//   - Sharpe-like ratio (PnL per trade / stddev)
//   - Max drawdown, time in drawdown
//   - Volume, trade frequency, fill rate
//   - Per-hour and per-side breakdowns
//   - Actionable parameter recommendations

import type { LogRecord, TradeRecord, SnapshotRecord } from "./trade-logger.js";

export interface PerformanceReport {
  // Summary
  symbol: string;
  periodStart: string;
  periodEnd: string;
  durationHours: number;

  // PnL
  totalRealizedPnl: number;
  avgPnlPerTrade: number;
  medianPnlPerTrade: number;
  bestTrade: number;
  worstTrade: number;

  // Risk
  maxDrawdown: number;
  maxDrawdownPct: number;     // As % of account size
  maxPositionUsd: number;
  avgPositionUsd: number;

  // Win/Loss
  totalTrades: number;
  winCount: number;
  lossCount: number;
  winRate: number;            // 0-1
  profitFactor: number;       // gross profit / gross loss
  avgWin: number;
  avgLoss: number;

  // Volume
  totalVolumeUsd: number;
  avgTradeSize: number;
  tradesPerHour: number;

  // Efficiency
  sharpeRatio: number;        // PnL per trade / stddev(PnL per trade)
  spreadCaptureRate: number;  // % of theoretical spread actually captured
  avgSpreadBps: number;

  // By side
  buyStats: SideStats;
  sellStats: SideStats;

  // Hourly breakdown
  hourlyPnl: Map<number, number>;

  // Recommendations
  recommendations: Recommendation[];
}

export interface SideStats {
  count: number;
  volumeUsd: number;
  realizedPnl: number;
  avgPrice: number;
}

export interface Recommendation {
  parameter: string;
  currentValue: string;
  suggestedValue: string;
  reason: string;
  confidence: "high" | "medium" | "low";
}

export function analyzeTradeLog(
  records: LogRecord[],
  accountSizeUsd: number,
  currentSpreadBps?: number,
  currentOrderSizeUsd?: number,
): PerformanceReport {
  const fills = records.filter((r): r is TradeRecord => r.type === "fill");
  const snapshots = records.filter((r): r is SnapshotRecord => r.type === "snapshot");

  if (fills.length === 0) {
    return emptyReport(accountSizeUsd);
  }

  const symbol = fills[0].symbol;
  const periodStart = fills[0].timestamp;
  const periodEnd = fills[fills.length - 1].timestamp;
  const durationMs = fills[fills.length - 1].epoch - fills[0].epoch;
  const durationHours = Math.max(durationMs / 3_600_000, 0.001);

  // PnL per trade (only for trades that realized PnL)
  const pnlPerTrade = fills.map((f) => f.realizedPnl);
  const closingTrades = pnlPerTrade.filter((p) => Math.abs(p) > 1e-8);
  const wins = closingTrades.filter((p) => p > 0);
  const losses = closingTrades.filter((p) => p < 0);

  const totalRealizedPnl = closingTrades.reduce((sum, p) => sum + p, 0);
  const grossProfit = wins.reduce((sum, p) => sum + p, 0);
  const grossLoss = Math.abs(losses.reduce((sum, p) => sum + p, 0));

  // Drawdown from snapshots or fills
  let maxDrawdown = 0;
  let maxPositionUsd = 0;
  let sumPositionUsd = 0;
  let positionSamples = 0;

  if (snapshots.length > 0) {
    for (const s of snapshots) {
      if (s.drawdown > maxDrawdown) maxDrawdown = s.drawdown;
      const posUsd = Math.abs(s.positionUsd);
      if (posUsd > maxPositionUsd) maxPositionUsd = posUsd;
      sumPositionUsd += posUsd;
      positionSamples++;
    }
  }

  // Also check fills for position info
  for (const f of fills) {
    const posUsd = Math.abs(f.positionUsdAfter);
    if (posUsd > maxPositionUsd) maxPositionUsd = posUsd;
    sumPositionUsd += posUsd;
    positionSamples++;
  }

  // Compute running drawdown from fills if no snapshots
  if (snapshots.length === 0) {
    let cumPnl = 0;
    let peak = 0;
    for (const f of fills) {
      cumPnl += f.realizedPnl;
      const unrealized = f.unrealizedPnl;
      const total = cumPnl + unrealized;
      if (total > peak) peak = total;
      const dd = peak - total;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
  }

  const avgPositionUsd = positionSamples > 0 ? sumPositionUsd / positionSamples : 0;

  // Volume
  const totalVolumeUsd = fills.reduce((sum, f) => sum + f.sizeUsd, 0);
  const avgTradeSize = totalVolumeUsd / fills.length;

  // Sharpe-like ratio
  const avgPnl = closingTrades.length > 0 ? totalRealizedPnl / closingTrades.length : 0;
  const variance = closingTrades.length > 1
    ? closingTrades.reduce((sum, p) => sum + (p - avgPnl) ** 2, 0) / (closingTrades.length - 1)
    : 0;
  const stddev = Math.sqrt(variance);
  const sharpeRatio = stddev > 0 ? avgPnl / stddev : 0;

  // Spread capture: what % of the spread is captured as PnL
  const avgSpreadBps = fills.reduce((sum, f) => sum + f.spreadBps, 0) / fills.length;
  const theoreticalPnlPerTrade = avgTradeSize * (avgSpreadBps / 10000);
  const spreadCaptureRate = theoreticalPnlPerTrade > 0
    ? (avgPnl / theoreticalPnlPerTrade)
    : 0;

  // By side
  const buys = fills.filter((f) => f.side === "buy");
  const sells = fills.filter((f) => f.side === "sell");

  const buyStats: SideStats = {
    count: buys.length,
    volumeUsd: buys.reduce((s, f) => s + f.sizeUsd, 0),
    realizedPnl: buys.reduce((s, f) => s + f.realizedPnl, 0),
    avgPrice: buys.length > 0 ? buys.reduce((s, f) => s + f.price, 0) / buys.length : 0,
  };
  const sellStats: SideStats = {
    count: sells.length,
    volumeUsd: sells.reduce((s, f) => s + f.sizeUsd, 0),
    realizedPnl: sells.reduce((s, f) => s + f.realizedPnl, 0),
    avgPrice: sells.length > 0 ? sells.reduce((s, f) => s + f.price, 0) / sells.length : 0,
  };

  // Hourly PnL
  const hourlyPnl = new Map<number, number>();
  for (const f of fills) {
    const hour = new Date(f.epoch).getUTCHours();
    hourlyPnl.set(hour, (hourlyPnl.get(hour) ?? 0) + f.realizedPnl);
  }

  // Median PnL
  const sorted = [...closingTrades].sort((a, b) => a - b);
  const medianPnl = sorted.length > 0
    ? sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)]
    : 0;

  const report: PerformanceReport = {
    symbol,
    periodStart,
    periodEnd,
    durationHours,
    totalRealizedPnl,
    avgPnlPerTrade: avgPnl,
    medianPnlPerTrade: medianPnl,
    bestTrade: closingTrades.length > 0 ? Math.max(...closingTrades) : 0,
    worstTrade: closingTrades.length > 0 ? Math.min(...closingTrades) : 0,
    maxDrawdown,
    maxDrawdownPct: accountSizeUsd > 0 ? (maxDrawdown / accountSizeUsd) * 100 : 0,
    maxPositionUsd,
    avgPositionUsd,
    totalTrades: fills.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRate: closingTrades.length > 0 ? wins.length / closingTrades.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLoss: losses.length > 0 ? -grossLoss / losses.length : 0,
    totalVolumeUsd,
    avgTradeSize,
    tradesPerHour: fills.length / durationHours,
    sharpeRatio,
    spreadCaptureRate,
    avgSpreadBps,
    buyStats,
    sellStats,
    hourlyPnl,
    recommendations: [],
  };

  // Generate recommendations
  report.recommendations = generateRecommendations(
    report,
    accountSizeUsd,
    currentSpreadBps,
    currentOrderSizeUsd,
  );

  return report;
}

function generateRecommendations(
  report: PerformanceReport,
  accountSize: number,
  currentSpreadBps?: number,
  currentOrderSizeUsd?: number,
): Recommendation[] {
  const recs: Recommendation[] = [];

  // 1. Spread tuning based on win rate and capture rate
  if (currentSpreadBps !== undefined) {
    if (report.winRate < 0.4 && report.totalTrades > 20) {
      recs.push({
        parameter: "spreadBps",
        currentValue: `${currentSpreadBps}`,
        suggestedValue: `${Math.round(currentSpreadBps * 1.5)}`,
        reason: `Low win rate (${(report.winRate * 100).toFixed(1)}%). Wider spread gives more room for profit per trade at the cost of fill frequency.`,
        confidence: "high",
      });
    } else if (report.winRate > 0.7 && report.tradesPerHour < 5 && report.totalTrades > 20) {
      recs.push({
        parameter: "spreadBps",
        currentValue: `${currentSpreadBps}`,
        suggestedValue: `${Math.max(3, Math.round(currentSpreadBps * 0.7))}`,
        reason: `High win rate (${(report.winRate * 100).toFixed(1)}%) but low fill rate (${report.tradesPerHour.toFixed(1)}/hr). Tighter spread increases volume.`,
        confidence: "medium",
      });
    }

    if (report.spreadCaptureRate < 0.3 && report.totalTrades > 10) {
      recs.push({
        parameter: "spreadBps",
        currentValue: `${currentSpreadBps}`,
        suggestedValue: `${Math.round(currentSpreadBps * 1.3)}`,
        reason: `Low spread capture (${(report.spreadCaptureRate * 100).toFixed(1)}%). Market is eating into your spread — widen to compensate.`,
        confidence: "medium",
      });
    }
  }

  // 2. Order size tuning
  if (currentOrderSizeUsd !== undefined) {
    const posRatio = report.maxPositionUsd / accountSize;
    if (posRatio > 0.3) {
      recs.push({
        parameter: "orderSizeUsd",
        currentValue: `$${currentOrderSizeUsd}`,
        suggestedValue: `$${Math.max(1, Math.round(currentOrderSizeUsd * 0.7))}`,
        reason: `Position reached ${(posRatio * 100).toFixed(0)}% of account. Reduce order size to limit directional risk.`,
        confidence: "high",
      });
    } else if (posRatio < 0.1 && report.totalRealizedPnl > 0 && report.totalTrades > 50) {
      recs.push({
        parameter: "orderSizeUsd",
        currentValue: `$${currentOrderSizeUsd}`,
        suggestedValue: `$${Math.round(currentOrderSizeUsd * 1.3)}`,
        reason: `Low position utilization (${(posRatio * 100).toFixed(0)}% max). Profitable strategy can handle larger size for more PnL.`,
        confidence: "low",
      });
    }
  }

  // 3. Drawdown warnings
  const ddPct = report.maxDrawdownPct;
  if (ddPct > 8) {
    recs.push({
      parameter: "closeThresholdUsd",
      currentValue: "current",
      suggestedValue: "reduce by 20%",
      reason: `Max drawdown hit ${ddPct.toFixed(1)}% of account. Lower the close threshold to reduce tail risk.`,
      confidence: "high",
    });
  }

  // 4. Side imbalance detection
  const totalFills = report.buyStats.count + report.sellStats.count;
  if (totalFills > 20) {
    const buyRatio = report.buyStats.count / totalFills;
    if (buyRatio > 0.65 || buyRatio < 0.35) {
      const heavy = buyRatio > 0.5 ? "buy" : "sell";
      recs.push({
        parameter: "fairPriceWindowMs",
        currentValue: "current",
        suggestedValue: "increase by 50%",
        reason: `${heavy} side is ${(Math.max(buyRatio, 1 - buyRatio) * 100).toFixed(0)}% of fills. Fair price may be biased — longer window smooths out noise.`,
        confidence: "medium",
      });
    }
  }

  // 5. Low activity warning
  if (report.tradesPerHour < 1 && report.durationHours > 1) {
    recs.push({
      parameter: "spreadBps",
      currentValue: currentSpreadBps?.toString() ?? "unknown",
      suggestedValue: "reduce by 30%",
      reason: `Only ${report.tradesPerHour.toFixed(1)} trades/hr. Spread may be too wide for current market conditions.`,
      confidence: "medium",
    });
  }

  // 6. Sharpe analysis
  if (report.sharpeRatio < 0 && report.totalTrades > 30) {
    recs.push({
      parameter: "strategy",
      currentValue: "current",
      suggestedValue: "pause and review",
      reason: `Negative Sharpe ratio (${report.sharpeRatio.toFixed(2)}). Strategy is losing money per unit of risk. Consider pausing until market conditions improve.`,
      confidence: "high",
    });
  }

  return recs;
}

function emptyReport(accountSize: number): PerformanceReport {
  return {
    symbol: "N/A",
    periodStart: "",
    periodEnd: "",
    durationHours: 0,
    totalRealizedPnl: 0,
    avgPnlPerTrade: 0,
    medianPnlPerTrade: 0,
    bestTrade: 0,
    worstTrade: 0,
    maxDrawdown: 0,
    maxDrawdownPct: 0,
    maxPositionUsd: 0,
    avgPositionUsd: 0,
    totalTrades: 0,
    winCount: 0,
    lossCount: 0,
    winRate: 0,
    profitFactor: 0,
    avgWin: 0,
    avgLoss: 0,
    totalVolumeUsd: 0,
    avgTradeSize: 0,
    tradesPerHour: 0,
    sharpeRatio: 0,
    spreadCaptureRate: 0,
    avgSpreadBps: 0,
    buyStats: { count: 0, volumeUsd: 0, realizedPnl: 0, avgPrice: 0 },
    sellStats: { count: 0, volumeUsd: 0, realizedPnl: 0, avgPrice: 0 },
    hourlyPnl: new Map(),
    recommendations: [],
  };
}

// Format report as human-readable text
export function formatReport(report: PerformanceReport): string {
  const lines: string[] = [];
  const hr = "─".repeat(60);

  lines.push("");
  lines.push("╔══════════════════════════════════════════════════════════════╗");
  lines.push("║              MARKET MAKER PERFORMANCE REPORT               ║");
  lines.push("╚══════════════════════════════════════════════════════════════╝");
  lines.push("");

  if (report.totalTrades === 0) {
    lines.push("  No trades found in the specified period.");
    return lines.join("\n");
  }

  // Period
  lines.push(`  Symbol:     ${report.symbol}`);
  lines.push(`  Period:     ${report.periodStart.slice(0, 19)} → ${report.periodEnd.slice(0, 19)}`);
  lines.push(`  Duration:   ${report.durationHours.toFixed(1)} hours`);
  lines.push("");

  // PnL Section
  lines.push(`  ${hr}`);
  lines.push("  PROFIT & LOSS");
  lines.push(`  ${hr}`);
  const pnlColor = report.totalRealizedPnl >= 0 ? "+" : "";
  lines.push(`  Total PnL:       ${pnlColor}$${report.totalRealizedPnl.toFixed(4)}`);
  lines.push(`  Avg PnL/trade:   $${report.avgPnlPerTrade.toFixed(6)}`);
  lines.push(`  Median PnL:      $${report.medianPnlPerTrade.toFixed(6)}`);
  lines.push(`  Best trade:      +$${report.bestTrade.toFixed(6)}`);
  lines.push(`  Worst trade:     $${report.worstTrade.toFixed(6)}`);
  lines.push("");

  // Risk Section
  lines.push(`  ${hr}`);
  lines.push("  RISK");
  lines.push(`  ${hr}`);
  lines.push(`  Max drawdown:    $${report.maxDrawdown.toFixed(4)} (${report.maxDrawdownPct.toFixed(1)}% of account)`);
  lines.push(`  Max position:    $${report.maxPositionUsd.toFixed(2)}`);
  lines.push(`  Avg position:    $${report.avgPositionUsd.toFixed(2)}`);
  lines.push(`  Sharpe ratio:    ${report.sharpeRatio.toFixed(3)}`);
  lines.push("");

  // Win/Loss Section
  lines.push(`  ${hr}`);
  lines.push("  WIN / LOSS");
  lines.push(`  ${hr}`);
  lines.push(`  Total trades:    ${report.totalTrades}`);
  lines.push(`  Wins / Losses:   ${report.winCount} / ${report.lossCount}`);
  lines.push(`  Win rate:        ${(report.winRate * 100).toFixed(1)}%`);
  lines.push(`  Profit factor:   ${report.profitFactor === Infinity ? "∞" : report.profitFactor.toFixed(2)}`);
  lines.push(`  Avg win:         +$${report.avgWin.toFixed(6)}`);
  lines.push(`  Avg loss:        $${report.avgLoss.toFixed(6)}`);
  lines.push("");

  // Volume Section
  lines.push(`  ${hr}`);
  lines.push("  VOLUME & ACTIVITY");
  lines.push(`  ${hr}`);
  lines.push(`  Total volume:    $${report.totalVolumeUsd.toFixed(2)}`);
  lines.push(`  Avg trade size:  $${report.avgTradeSize.toFixed(2)}`);
  lines.push(`  Trades/hour:     ${report.tradesPerHour.toFixed(1)}`);
  lines.push(`  Spread capture:  ${(report.spreadCaptureRate * 100).toFixed(1)}%`);
  lines.push(`  Avg spread:      ${report.avgSpreadBps.toFixed(1)} bps`);
  lines.push("");

  // Side breakdown
  lines.push(`  ${hr}`);
  lines.push("  BY SIDE");
  lines.push(`  ${hr}`);
  lines.push(`  Buy:  ${report.buyStats.count} fills | $${report.buyStats.volumeUsd.toFixed(2)} vol | PnL $${report.buyStats.realizedPnl.toFixed(4)}`);
  lines.push(`  Sell: ${report.sellStats.count} fills | $${report.sellStats.volumeUsd.toFixed(2)} vol | PnL $${report.sellStats.realizedPnl.toFixed(4)}`);
  lines.push("");

  // Hourly PnL
  if (report.hourlyPnl.size > 0) {
    lines.push(`  ${hr}`);
    lines.push("  HOURLY PnL (UTC)");
    lines.push(`  ${hr}`);
    const sorted = [...report.hourlyPnl.entries()].sort((a, b) => a[0] - b[0]);
    for (const [hour, pnl] of sorted) {
      const bar = pnl >= 0 ? "█".repeat(Math.min(20, Math.round(pnl * 1000))) : "░".repeat(Math.min(20, Math.round(Math.abs(pnl) * 1000)));
      lines.push(`  ${String(hour).padStart(2, "0")}:00  ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)} ${bar}`);
    }
    lines.push("");
  }

  // Recommendations
  if (report.recommendations.length > 0) {
    lines.push(`  ${hr}`);
    lines.push("  RECOMMENDATIONS");
    lines.push(`  ${hr}`);
    for (const rec of report.recommendations) {
      const conf = rec.confidence === "high" ? "!!!" : rec.confidence === "medium" ? " !!" : "  !";
      lines.push(`  [${conf}] ${rec.parameter}: ${rec.currentValue} → ${rec.suggestedValue}`);
      lines.push(`       ${rec.reason}`);
      lines.push("");
    }
  }

  lines.push(`  ${hr}`);
  return lines.join("\n");
}

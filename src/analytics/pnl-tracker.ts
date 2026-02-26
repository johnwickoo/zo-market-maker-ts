// PnL Tracker — real-time profit/loss tracking with risk management
//
// Tracks:
//   - Realized PnL (from closed trades, using FIFO cost basis)
//   - Unrealized PnL (mark-to-market on open position)
//   - Peak PnL and max drawdown
//   - Daily PnL with reset at midnight UTC
//   - Trade count and volume
//
// Risk signals:
//   - shouldHalt: true when any risk limit is breached
//   - haltReason: human-readable reason

import type { RiskConfig } from "../bots/mm/configs.js";
import { log } from "../utils/logger.js";

export interface PnlState {
  // Position
  positionBase: number;
  avgEntryPrice: number;
  costBasis: number;          // Total cost of current position

  // PnL
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;

  // Drawdown
  peakPnl: number;
  drawdown: number;           // Always >= 0 (how far below peak)

  // Daily
  dailyPnl: number;
  dailyStartDate: string;     // YYYY-MM-DD

  // Activity
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  volumeUsd: number;
  winCount: number;           // Fills that realized positive PnL
  lossCount: number;          // Fills that realized negative PnL

  // Risk
  shouldHalt: boolean;
  haltReason: string | null;
}

export class PnlTracker {
  private positionBase = 0;
  private costBasis = 0;      // Total cost = sum(size * price) for current position
  private realizedPnl = 0;
  private peakPnl = 0;
  private dailyPnl = 0;
  private dailyStartDate: string;
  private tradeCount = 0;
  private buyCount = 0;
  private sellCount = 0;
  private volumeUsd = 0;
  private winCount = 0;
  private lossCount = 0;
  private shouldHalt = false;
  private haltReason: string | null = null;

  constructor(private readonly risk: RiskConfig) {
    this.dailyStartDate = this.todayUtc();
  }

  // Seed with a pre-existing position from the exchange.
  // Cost basis is set to |position| * entryPrice so unrealized PnL starts at ~0.
  // This prevents phantom PnL from positions that existed before this session.
  initPosition(positionBase: number, entryPrice: number): void {
    this.positionBase = positionBase;
    this.costBasis = Math.abs(positionBase) * entryPrice;
    log.info(
      `PnL tracker initialized: pos=${positionBase.toFixed(6)} entry=$${entryPrice.toFixed(2)} cost=$${this.costBasis.toFixed(4)}`,
    );
  }

  // Process a fill and return the realized PnL from this specific fill
  applyFill(side: "buy" | "sell", price: number, size: number): number {
    this.checkDayRollover();

    const sizeUsd = size * price;
    this.tradeCount++;
    this.volumeUsd += sizeUsd;

    if (side === "buy") {
      this.buyCount++;
    } else {
      this.sellCount++;
    }

    let fillRealizedPnl = 0;

    // Determine if this fill is opening or closing
    const isOpening =
      (side === "buy" && this.positionBase >= 0) ||
      (side === "sell" && this.positionBase <= 0);

    if (isOpening) {
      // Adding to position — update cost basis
      if (side === "buy") {
        this.costBasis += size * price;
        this.positionBase += size;
      } else {
        this.costBasis += size * price; // Cost basis is always positive magnitude
        this.positionBase -= size;
      }
    } else {
      // Reducing position — realize PnL
      const avgEntry = this.getAvgEntryPrice();
      const closingSize = Math.min(size, Math.abs(this.positionBase));
      const remainingSize = size - closingSize;

      if (this.positionBase > 0) {
        // Was long, selling to close
        fillRealizedPnl = closingSize * (price - avgEntry);
        this.positionBase -= closingSize;
        this.costBasis = Math.abs(this.positionBase) * avgEntry;
      } else {
        // Was short, buying to close
        fillRealizedPnl = closingSize * (avgEntry - price);
        this.positionBase += closingSize;
        this.costBasis = Math.abs(this.positionBase) * avgEntry;
      }

      // If fill was larger than position, the remainder opens a new position
      if (remainingSize > 0) {
        if (side === "buy") {
          this.positionBase += remainingSize;
        } else {
          this.positionBase -= remainingSize;
        }
        this.costBasis = Math.abs(this.positionBase) * price;
      }

      this.realizedPnl += fillRealizedPnl;
      this.dailyPnl += fillRealizedPnl;

      if (fillRealizedPnl > 0) {
        this.winCount++;
      } else if (fillRealizedPnl < 0) {
        this.lossCount++;
      }
    }

    // Check risk limits
    this.checkRiskLimits(price);

    return fillRealizedPnl;
  }

  // Get current state with unrealized PnL calculated at given fair price
  getState(fairPrice: number): PnlState {
    this.checkDayRollover();
    const unrealizedPnl = this.calcUnrealizedPnl(fairPrice);
    const totalPnl = this.realizedPnl + unrealizedPnl;

    // Update peak and drawdown
    if (totalPnl > this.peakPnl) {
      this.peakPnl = totalPnl;
    }
    const drawdown = Math.max(0, this.peakPnl - totalPnl);

    return {
      positionBase: this.positionBase,
      avgEntryPrice: this.getAvgEntryPrice(),
      costBasis: this.costBasis,
      realizedPnl: this.realizedPnl,
      unrealizedPnl,
      totalPnl,
      peakPnl: this.peakPnl,
      drawdown,
      dailyPnl: this.dailyPnl + unrealizedPnl,
      dailyStartDate: this.dailyStartDate,
      tradeCount: this.tradeCount,
      buyCount: this.buyCount,
      sellCount: this.sellCount,
      volumeUsd: this.volumeUsd,
      winCount: this.winCount,
      lossCount: this.lossCount,
      shouldHalt: this.shouldHalt,
      haltReason: this.haltReason,
    };
  }

  getPositionBase(): number {
    return this.positionBase;
  }

  // Sync position from server (corrects drift)
  syncPosition(serverPositionBase: number, fairPrice: number): void {
    if (Math.abs(this.positionBase - serverPositionBase) > 0.0001) {
      log.warn(
        `PnL tracker drift: local=${this.positionBase.toFixed(6)} server=${serverPositionBase.toFixed(6)}`,
      );
      this.positionBase = serverPositionBase;
      this.costBasis = Math.abs(serverPositionBase) * fairPrice;
    }
  }

  isHalted(): boolean {
    return this.shouldHalt;
  }

  resetHalt(): void {
    this.shouldHalt = false;
    this.haltReason = null;
    log.info("Risk halt cleared manually");
  }

  private getAvgEntryPrice(): number {
    const absPos = Math.abs(this.positionBase);
    if (absPos < 1e-10) return 0;
    return this.costBasis / absPos;
  }

  private calcUnrealizedPnl(fairPrice: number): number {
    if (Math.abs(this.positionBase) < 1e-10) return 0;
    const avgEntry = this.getAvgEntryPrice();
    if (this.positionBase > 0) {
      return this.positionBase * (fairPrice - avgEntry);
    }
    return Math.abs(this.positionBase) * (avgEntry - fairPrice);
  }

  private checkRiskLimits(currentPrice: number): void {
    const unrealized = this.calcUnrealizedPnl(currentPrice);
    const totalPnl = this.realizedPnl + unrealized;

    if (totalPnl > this.peakPnl) {
      this.peakPnl = totalPnl;
    }
    const drawdown = Math.max(0, this.peakPnl - totalPnl);

    // Max drawdown check
    if (drawdown >= this.risk.maxDrawdownUsd) {
      this.shouldHalt = true;
      this.haltReason = `Max drawdown breached: $${drawdown.toFixed(2)} >= $${this.risk.maxDrawdownUsd}`;
      log.error(`RISK HALT: ${this.haltReason}`);
      return;
    }

    // Max position check
    const posUsd = Math.abs(this.positionBase * currentPrice);
    if (posUsd >= this.risk.maxPositionUsd) {
      this.shouldHalt = true;
      this.haltReason = `Max position breached: $${posUsd.toFixed(2)} >= $${this.risk.maxPositionUsd}`;
      log.error(`RISK HALT: ${this.haltReason}`);
      return;
    }

    // Daily loss limit
    const dailyTotal = this.dailyPnl + unrealized;
    if (dailyTotal <= -this.risk.dailyLossLimitUsd) {
      this.shouldHalt = true;
      this.haltReason = `Daily loss limit: $${dailyTotal.toFixed(2)} <= -$${this.risk.dailyLossLimitUsd}`;
      log.error(`RISK HALT: ${this.haltReason}`);
      return;
    }
  }

  private checkDayRollover(): void {
    const today = this.todayUtc();
    if (today !== this.dailyStartDate) {
      log.info(
        `Day rollover: ${this.dailyStartDate} → ${today} | Daily PnL: $${this.dailyPnl.toFixed(4)}`,
      );
      this.dailyPnl = 0;
      this.dailyStartDate = today;
      // Reset daily halt if it was a daily loss limit
      if (this.haltReason?.includes("Daily loss limit")) {
        this.shouldHalt = false;
        this.haltReason = null;
      }
    }
  }

  private todayUtc(): string {
    return new Date().toISOString().slice(0, 10);
  }
}

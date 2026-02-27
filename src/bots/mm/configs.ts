// Preset configurations for different account sizes and strategies
//
// Account: $50 real × 10x leverage = $500 buying power
// Single bot per account (full margin available)
//
// Design philosophy:
//   - Survive first, profit second
//   - Inventory risk dominates spread income at this size
//   - Moderate order size for good fill rate without blowing up position
//   - Strong skew to actively mean-revert position
//   - Risk limits sized for full $50 account

import { DEFAULT_FEES, type MarketMakerConfig } from "./config.js";

// ─── Simple Strategy: $50 account, 1 bot ────────────────────────────────────
//
// Full $50 equity, $500 buying power available to one bot.
// Order size: $15 → needs $1.50 margin at 10x
// Close threshold: $60 → 4 fills to close mode
// Max position: $75 → 1.5x real equity
//
// Per-fill economics (8 bps spread):
//   Gross: $15 × 4 bps (half-spread) = $0.006
//   Fee:   $15 × 1 bps (maker)       = $0.0015
//   Net:   $0.0045 per fill
//   Need ~222 fills/day for $1/day

export const SMALL_ACCOUNT_CONFIG: Omit<MarketMakerConfig, "symbol"> = {
  spreadBps: 8,                // 0.08% — competitive but covers fees + profit
  takeProfitBps: 0.5,           // 0.005% — close near mid for fast unwind (matches dev's $100 challenge)
  orderSizeUsd: 15,            // $15 per side — good volume without excessive inventory
  closeThresholdUsd: 60,       // Enter close mode at $60 exposure
  warmupSeconds: 15,
  updateThrottleMs: 150,
  orderSyncIntervalMs: 3000,
  statusIntervalMs: 2000,
  fairPriceWindowMs: 3 * 60 * 1000,
  positionSyncIntervalMs: 4000,
  repriceThresholdBps: 2,
  fees: DEFAULT_FEES,
};

// Extended risk parameters for the PnL tracker
export interface RiskConfig {
  readonly maxDrawdownUsd: number;    // Kill switch: stop quoting if drawdown exceeds this
  readonly maxPositionUsd: number;    // Hard cap on position size in USD
  readonly dailyLossLimitUsd: number; // Stop trading for the day if daily PnL < -this
  readonly accountSizeUsd: number;    // Account size for percentage calculations
}

export const SMALL_ACCOUNT_RISK: RiskConfig = {
  maxDrawdownUsd: 5,           // 10% of REAL account — kill switch
  maxPositionUsd: 75,          // 1.5x real equity at 10x leverage ($7.50 margin)
  dailyLossLimitUsd: 3,        // 6% of real account — stop for the day
  accountSizeUsd: 50,
};

// ─── Aggressive Simple: $50 account, 1 bot ──────────────────────────────────
// Tighter spread for liquid markets (BTC, ETH). More fills, more risk.
export const SMALL_ACCOUNT_AGGRESSIVE: Omit<MarketMakerConfig, "symbol"> = {
  spreadBps: 6,                // 0.06% — tighter spread, more fills
  takeProfitBps: 0.5,           // 0.005% — close near mid for fast unwind
  orderSizeUsd: 20,            // $20 per side — aggressive for volume
  closeThresholdUsd: 75,       // Higher threshold
  warmupSeconds: 10,
  updateThrottleMs: 100,
  orderSyncIntervalMs: 3000,
  statusIntervalMs: 1000,
  fairPriceWindowMs: 2 * 60 * 1000,
  positionSyncIntervalMs: 3000,
  repriceThresholdBps: 2,
  fees: DEFAULT_FEES,
};

export const SMALL_ACCOUNT_AGGRESSIVE_RISK: RiskConfig = {
  maxDrawdownUsd: 7,           // 14% of real account
  maxPositionUsd: 100,         // 2x real equity
  dailyLossLimitUsd: 4,        // 8% of real account
  accountSizeUsd: 50,
};

// ─── Enhanced Strategy Configuration ─────────────────────────────────────────
// Avellaneda-Stoikov inspired market making with:
//   - Inventory skew (position-aware quote shifting)
//   - Volatility-adaptive spread (widens in chaos, tightens in calm)
//   - Multi-level orders (configurable levels per side for depth)
//   - Gradual position decay (replaces binary close mode)
//   - Momentum guard (avoids adverse selection in trending markets)

import type { EnhancedQuoterConfig } from "./enhanced-quoter.js";
import type { VolatilityConfig, MomentumConfig } from "../../pricing/volatility.js";

export interface EnhancedStrategyConfig {
  readonly base: Omit<MarketMakerConfig, "symbol">;
  readonly quoter: EnhancedQuoterConfig;
  readonly volatility: VolatilityConfig;
  readonly momentum: MomentumConfig;
  readonly risk: RiskConfig;
}

// ─── $50 @ 10x Enhanced Strategy (1 bot, full account) ──────────────────────
//
// Full $50 equity available. Balanced for volume + safety.
//
// Per-fill economics (8 bps base spread, $15 orders):
//   Gross: $15 × 4 bps = $0.006
//   Fee:   $15 × 1 bps = $0.0015
//   Net:   $0.0045/fill → ~222 fills/day for $1/day
//
// Key tuning:
//   - orderSizeUsd: $15 (decent volume per fill, 4 fills to close mode)
//   - skewFactor: 3.0 (strong mean-reversion even at low vol)
//   - volMultiplier: 0.8 (stay competitive, let skew handle inventory)
//   - maxSpreadBps: 15 (never widen so far nobody fills you)
//   - levels: 1 (full size per order, no margin waste on thin books)
//   - closeThresholdUsd: $60 (hard cap on directional exposure)
//   - maxPositionUsd: $75 (1.5x real equity)

export const ENHANCED_STRATEGY: EnhancedStrategyConfig = {
  base: {
    spreadBps: 8,              // Used as fallback; enhanced quoter overrides
    takeProfitBps: 0.5,         // Close near mid for fast unwind
    orderSizeUsd: 15,          // $15 per fill — good volume, 4 fills to close mode
    closeThresholdUsd: 60,     // Hard cap: stop adding side above $60 exposure
    warmupSeconds: 15,
    updateThrottleMs: 120,
    orderSyncIntervalMs: 3000,
    statusIntervalMs: 2000,
    fairPriceWindowMs: 3 * 60 * 1000,
    positionSyncIntervalMs: 4000,
    repriceThresholdBps: 1.5,
    fees: DEFAULT_FEES,
  },

  quoter: {
    // Spread
    baseSpreadBps: 8,          // Floor: never quote tighter than 8 bps
    maxSpreadBps: 15,          // Ceiling: stay competitive, never too wide
    volMultiplier: 0.8,        // Mild vol scaling — let skew handle inventory, not spread

    // Inventory — strong skew is the primary risk control
    skewFactor: 3.0,           // Aggressive skew: at 3bps effective vol, 25% inv → 2.25bps shift
    minSkewBps: 3.0,           // Floor: skew acts as if vol >= 3bps even in calm markets
    maxPositionUsd: 75,        // 1.5x real equity — skew hits max here
    sizeReductionStart: 0.3,   // Start reducing adding side at 30% ($22.50 position)
    closeThresholdUsd: 60,     // Hard cap: stop adding side entirely above $60

    // Single level for thin markets (HYPE, SOL). Change to 2 for BTC/ETH.
    levels: 1,                 // 1 order per side — full size, no margin waste
    levelSpacingBps: 5,        // Only used if levels > 1

    // Momentum
    momentumPenaltyBps: 4,     // Extra spread on adversely-selected side
  },

  volatility: {
    windowSeconds: 60,         // 1-minute rolling volatility
    minSamples: 10,
  },

  momentum: {
    emaPeriodSeconds: 8,       // 8-second EMA for quick momentum detection
    strongThresholdBps: 2.5,
  },

  risk: {
    maxDrawdownUsd: 5,         // 10% of real $50 — kill switch
    maxPositionUsd: 75,        // 1.5x real equity
    dailyLossLimitUsd: 3,      // 6% of real account — stop for the day
    accountSizeUsd: 50,
  },
};

// ─── $50 @ 10x Enhanced Aggressive (1 bot) ──────────────────────────────────
// For liquid markets (BTC, ETH) where tighter spreads are competitive.
// 2 levels per side to capture depth. Higher risk tolerance.
export const ENHANCED_AGGRESSIVE: EnhancedStrategyConfig = {
  base: {
    spreadBps: 6,
    takeProfitBps: 0.5,
    orderSizeUsd: 20,          // $20 per fill — aggressive for volume
    closeThresholdUsd: 75,
    warmupSeconds: 10,
    updateThrottleMs: 100,
    orderSyncIntervalMs: 3000,
    statusIntervalMs: 1000,
    fairPriceWindowMs: 2 * 60 * 1000,
    positionSyncIntervalMs: 3000,
    repriceThresholdBps: 1.5,
    fees: DEFAULT_FEES,
  },

  quoter: {
    baseSpreadBps: 6,
    maxSpreadBps: 15,
    volMultiplier: 0.8,

    skewFactor: 2.5,           // Strong skew
    minSkewBps: 3.0,           // Floor: skew effective even in calm markets
    maxPositionUsd: 100,       // 2x real equity
    sizeReductionStart: 0.3,
    closeThresholdUsd: 75,

    levels: 2,                 // 2 levels — viable on liquid BTC/ETH books
    levelSpacingBps: 4,

    momentumPenaltyBps: 3,
  },

  volatility: {
    windowSeconds: 45,
    minSamples: 8,
  },

  momentum: {
    emaPeriodSeconds: 6,
    strongThresholdBps: 2,
  },

  risk: {
    maxDrawdownUsd: 7,         // 14% of real account
    maxPositionUsd: 100,       // 2x real equity
    dailyLossLimitUsd: 4,      // 8% of real account
    accountSizeUsd: 50,
  },
};

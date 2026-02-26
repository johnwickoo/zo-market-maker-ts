// Preset configurations for different account sizes and strategies

import { DEFAULT_FEES, type MarketMakerConfig } from "./config.js";

// ─── $50 Account @ 10x Leverage Configuration ───────────────────────────────
// Philosophy: Survive first, profit second.
//
// Leverage context: $50 account × 10x = $500 buying power.
// Position limits scale with leverage; loss limits stay in real dollars.
//
// Risk budget: Max $75 position (15% of buying power, 1.5x effective leverage).
// Spread: Wide enough to cover fees + slippage + profit margin.
// Order size: $15 per side — meaningful fills relative to buying power.
// Close mode: Triggers at $60 to prevent runaway positions.
//
// Expected behavior:
//   - Quotes both sides with 10bps spread (~0.10%)
//   - Each fill nets ~$0.015 in spread capture on a $15 order
//   - At 50+ fills/day, targets ~$0.75-2.00/day net
//   - Position never exceeds $75 (1.5x effective leverage)
//   - Close mode uses 2bps spread for fast unwinding
//
// Risk controls (in REAL dollars, not leveraged):
//   - closeThresholdUsd: $60 (hard cap on directional exposure)
//   - maxDrawdownUsd: $5 (10% of real account — kill switch)
//   - maxPositionUsd: $75 (1.5x effective leverage)
//   - dailyLossLimitUsd: $3 (stop trading if losing day)

export const SMALL_ACCOUNT_CONFIG: Omit<MarketMakerConfig, "symbol"> = {
  spreadBps: 10,               // 0.10% — wide enough to cover fees + profit
  takeProfitBps: 2,            // 0.02% — tight close spread for quick unwind
  orderSizeUsd: 15,            // $15 per side — sized for $500 buying power
  closeThresholdUsd: 60,       // Enter close mode at $60 exposure
  warmupSeconds: 15,           // 15 samples for more stable fair price
  updateThrottleMs: 150,       // Slightly slower updates to avoid rate limits
  orderSyncIntervalMs: 3000,
  statusIntervalMs: 2000,
  fairPriceWindowMs: 3 * 60 * 1000, // 3 min window — more responsive to shifts
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
  maxDrawdownUsd: 5,           // 10% of REAL account ($50) — absolute kill switch
  maxPositionUsd: 75,          // 1.5x effective leverage — never exceed
  dailyLossLimitUsd: 3,        // 6% of real account — stop trading for the day
  accountSizeUsd: 50,
};

// ─── Aggressive $50 @ 10x Config (higher volume, higher risk) ────────────────
// For more active markets where tighter spreads are competitive.
// Uses more of the $500 buying power for volume generation.
export const SMALL_ACCOUNT_AGGRESSIVE: Omit<MarketMakerConfig, "symbol"> = {
  spreadBps: 6,                // 0.06% — tighter spread, more fills
  takeProfitBps: 1,            // 0.01% — very aggressive close
  orderSizeUsd: 25,            // $25 per side — aggressive sizing for $500 buying power
  closeThresholdUsd: 80,       // Higher threshold
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
  maxDrawdownUsd: 7,           // 14% of real account — aggressive but survivable
  maxPositionUsd: 100,         // 2x effective leverage
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

// ─── $50 @ 10x Enhanced Strategy ────────────────────────────────────────────
// Designed for maximum fill rate on a $50 account with 10x leverage ($500 buying power).
//
// Leverage-aware sizing:
//   - orderSizeUsd: $20 per fill (~4% of buying power)
//   - maxPositionUsd: $75 (1.5x effective leverage, 15% of buying power)
//   - Loss limits stay in REAL dollars ($5 drawdown = 10% of $50)
//
// Key differences from simple strategy:
//   - Spread adapts: 8-25 bps depending on volatility (simple uses fixed 10)
//   - Position naturally mean-reverts via skew instead of binary close mode
//   - 2 levels per side (4 total orders) — margin supports this at 10x
//   - Momentum guard prevents getting picked off in trending markets
//   - Size gradually reduces as position grows instead of abrupt close mode
//
// Expected edge:
//   - 30-50% more fills due to multi-level + tighter calm-market spread
//   - 40-60% less adverse selection from skew + momentum guard
//   - Smoother PnL curve from gradual position management
//   - ~$1-3/day target at 50+ fills/day

export const ENHANCED_STRATEGY: EnhancedStrategyConfig = {
  base: {
    spreadBps: 8,              // Used as fallback; enhanced quoter overrides
    takeProfitBps: 2,          // Used as fallback; enhanced quoter handles close
    orderSizeUsd: 20,          // $20 per level — sized for $500 buying power
    closeThresholdUsd: 60,     // Gradual decay starts well before this
    warmupSeconds: 15,
    updateThrottleMs: 120,     // Slightly faster to respond to vol/momentum
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
    maxSpreadBps: 25,          // Ceiling: never wider than 25 bps
    volMultiplier: 1.5,        // Spread = base + 1.5 * vol

    // Inventory
    skewFactor: 1.2,           // Moderate skew: shifts mid by 1.2 * posRatio * vol
    maxPositionUsd: 75,        // Position where skew hits maximum (1.5x effective leverage)
    sizeReductionStart: 0.4,   // Start reducing adding-side size at 40% of maxPosition ($30)
    closeThresholdUsd: 60,     // Hard cap: stop adding side entirely above $60 exposure

    // Multi-level (10x leverage provides enough margin for 4 orders)
    levels: 2,                 // 2 orders per side (4 total resting)
    levelSpacingBps: 5,        // 2nd level is 5 bps deeper

    // Momentum
    momentumPenaltyBps: 4,     // Extra spread on adversely-selected side
  },

  volatility: {
    windowSeconds: 60,         // 1-minute rolling volatility
    minSamples: 10,            // Need 10 seconds of data
  },

  momentum: {
    emaPeriodSeconds: 8,       // 8-second EMA for quick momentum detection
    strongThresholdBps: 2.5,   // >2.5 bps/sec momentum = "strong"
  },

  risk: {
    maxDrawdownUsd: 5,         // 10% of REAL $50 — kill switch (real dollars lost)
    maxPositionUsd: 75,        // 1.5x effective leverage
    dailyLossLimitUsd: 3,      // 6% of real account — stop for the day
    accountSizeUsd: 50,
  },
};

// ─── $50 @ 10x Enhanced Aggressive ──────────────────────────────────────────
// Tighter spread, 3 levels, max volume generation.
// For liquid markets where you can compete on spread.
// Uses up to 2x effective leverage ($100 max position on $50 account).
export const ENHANCED_AGGRESSIVE: EnhancedStrategyConfig = {
  base: {
    spreadBps: 6,
    takeProfitBps: 1,
    orderSizeUsd: 25,          // $25 per level — aggressive for $500 buying power
    closeThresholdUsd: 80,
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
    baseSpreadBps: 5,
    maxSpreadBps: 20,
    volMultiplier: 1.2,

    skewFactor: 1.0,
    maxPositionUsd: 100,       // 2x effective leverage — aggressive
    sizeReductionStart: 0.5,
    closeThresholdUsd: 80,     // Hard cap: stop adding side above $80

    levels: 3,                 // 3 levels = 6 resting orders — max depth
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
    maxDrawdownUsd: 7,         // 14% of real account — aggressive but survivable
    maxPositionUsd: 100,       // 2x effective leverage
    dailyLossLimitUsd: 4,      // 8% of real account
    accountSizeUsd: 50,
  },
};

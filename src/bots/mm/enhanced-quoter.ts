// Enhanced Quoter — Avellaneda-Stoikov inspired market making
//
// Improvements over simple quoter:
//   1. Inventory skew: shifts mid price based on position to naturally mean-revert
//   2. Volatility-adaptive spread: widens in volatile markets, tightens in calm
//   3. Multi-level orders: 2 levels per side at different depths
//   4. Gradual position decay: replaces binary close mode with smooth reduction
//   5. Momentum guard: widens aggressive side when strong directional flow
//
// The core formula (Avellaneda-Stoikov 2008, simplified):
//   reservation_price = fair_price - gamma * position * variance
//   optimal_spread = gamma * variance + (2/gamma) * ln(1 + gamma/kappa)
//
// We simplify for a DEX context (discrete ticks, low latency tolerance):
//   skewed_mid = fair_price - skewFactor * positionRatio * volatility
//   spread = baseSpread + volMultiplier * volatility + momentumPenalty

import Decimal from "decimal.js";
import type { FeeConfig } from "./config.js";
import type { BBO } from "../../sdk/orderbook.js";
import type { Quote } from "../../types.js";
import { log } from "../../utils/logger.js";

export interface EnhancedQuoterConfig {
  // Spread
  readonly baseSpreadBps: number;      // Minimum spread (floor)
  readonly maxSpreadBps: number;       // Maximum spread (ceiling)
  readonly volMultiplier: number;      // How much volatility widens spread (0.5-3.0)

  // Inventory management
  readonly skewFactor: number;         // How aggressively to skew quotes (0.5-3.0)
  readonly maxPositionUsd: number;     // Position where skew is at maximum
  readonly sizeReductionStart: number; // Position ratio (0-1) where size starts shrinking

  // Multi-level
  readonly levels: number;             // Number of order levels per side (1-3)
  readonly levelSpacingBps: number;    // Spread between levels in bps

  // Momentum
  readonly momentumPenaltyBps: number; // Extra spread on adversely-selected side
}

export interface EnhancedQuotingContext {
  readonly fairPrice: number;
  readonly positionUsd: number;        // Signed: positive = long
  readonly positionBase: number;       // Signed
  readonly volatilityBps: number | null; // null = not ready yet
  readonly momentumBps: number;        // Signed: positive = price going up
}

export class EnhancedQuoter {
  private readonly tickSize: Decimal;
  private readonly lotSize: Decimal;
  private readonly minSpreadBps: number;

  constructor(
    priceDecimals: number,
    sizeDecimals: number,
    private readonly config: EnhancedQuoterConfig,
    private readonly orderSizeUsd: number,
    fees: FeeConfig,
  ) {
    this.tickSize = new Decimal(10).pow(-priceDecimals);
    this.lotSize = new Decimal(10).pow(-sizeDecimals);
    // Both sides are post-only (maker), so minimum profitable spread = 2 * maker fee
    this.minSpreadBps = 2 * fees.makerFeeBps;
    if (config.baseSpreadBps < this.minSpreadBps) {
      log.warn(`baseSpreadBps (${config.baseSpreadBps}) < fee floor (${this.minSpreadBps}bps) — spread will be clamped`);
    }
  }

  getQuotes(ctx: EnhancedQuotingContext, bbo: BBO | null): Quote[] {
    const { fairPrice, positionUsd, volatilityBps, momentumBps } = ctx;
    const fair = new Decimal(fairPrice);

    // ─── 1. Inventory Skew ───────────────────────────────────────────
    // Shift the reservation price toward reducing our position.
    // Long → shift down (cheaper bids, cheaper asks → eager to sell)
    // Short → shift up (higher bids, higher asks → eager to buy)
    const positionRatio = this.clamp(positionUsd / this.config.maxPositionUsd, -1, 1);
    const vol = volatilityBps ?? this.config.baseSpreadBps; // Fallback to base spread if vol not ready
    const skewBps = this.config.skewFactor * positionRatio * vol;
    const skewAmount = fair.mul(skewBps).div(10000);
    const skewedMid = fair.sub(skewAmount); // Negative skew when long, positive when short

    // ─── 2. Volatility-Adaptive Spread ───────────────────────────────
    // Base spread + volatility component, clamped to [fee floor, max]
    let spreadBps = this.config.baseSpreadBps + this.config.volMultiplier * vol;
    const floorBps = Math.max(this.config.baseSpreadBps, this.minSpreadBps);
    spreadBps = this.clamp(spreadBps, floorBps, this.config.maxSpreadBps);

    // ─── 3. Momentum Guard ───────────────────────────────────────────
    // If price is moving up, widen the bid (we're more likely to get
    // adversely selected on our buy). Vice versa for down moves.
    const absMomentum = Math.abs(momentumBps);
    const momentumPenalty = absMomentum > 1.5
      ? this.config.momentumPenaltyBps * (absMomentum / 5)
      : 0;

    // If price is RISING (momentumBps > 0), our bids are getting picked off (adverse selection on buy side)
    // → widen BID spread (push bid lower) to avoid getting run over
    // If price is FALLING, asks get picked off → widen ASK spread
    const bidSpreadBps = spreadBps + (momentumBps > 1.5 ? momentumPenalty : 0);
    const askSpreadBps = spreadBps + (momentumBps < -1.5 ? momentumPenalty : 0);

    // ─── 4. Gradual Size Reduction ───────────────────────────────────
    // As position grows, reduce size on the adding side, keep size on reducing side.
    const absPositionRatio = Math.abs(positionRatio);
    const isLong = positionUsd > 0;

    // Base size in base units
    const baseSize = this.usdToSize(this.orderSizeUsd, fair);
    if (baseSize.lte(0)) return [];

    // Size multipliers per side (1.0 = full, 0.0 = don't quote)
    let bidSizeMult = 1.0;
    let askSizeMult = 1.0;

    if (absPositionRatio > this.config.sizeReductionStart) {
      // Linear reduction from sizeReductionStart to 1.0
      const reductionRange = 1.0 - this.config.sizeReductionStart;
      const reductionPct = Math.min(1, (absPositionRatio - this.config.sizeReductionStart) / reductionRange);

      if (isLong) {
        // Long: reduce bids (adding side), keep/boost asks (reducing side)
        bidSizeMult = Math.max(0, 1 - reductionPct * 0.8); // Never fully zero on adding side until 1.0
        askSizeMult = 1 + reductionPct * 0.3; // Slightly boost reducing side
      } else {
        // Short: reduce asks (adding side), keep/boost bids (reducing side)
        askSizeMult = Math.max(0, 1 - reductionPct * 0.8);
        bidSizeMult = 1 + reductionPct * 0.3;
      }
    }

    // At extreme position (>90%), only quote reducing side
    if (absPositionRatio > 0.9) {
      if (isLong) bidSizeMult = 0;
      else askSizeMult = 0;
    }

    // ─── 5. Generate Multi-Level Quotes ──────────────────────────────
    // CRITICAL: Split size budget across levels to stay within margin.
    // A $50 account can't afford 4 full-size orders. We distribute the
    // orderSizeUsd budget so total notional per side ≈ orderSizeUsd.
    //
    // Level weights: [0.6, 0.3, 0.1] for 3 levels, [0.65, 0.35] for 2 levels
    // This front-loads the inner level (higher fill probability).
    const levelWeights = this.getLevelWeights(this.config.levels);

    const quotes: Quote[] = [];

    for (let level = 0; level < this.config.levels; level++) {
      const levelOffset = level * this.config.levelSpacingBps;
      const levelWeight = levelWeights[level];

      // Bid orders
      if (bidSizeMult > 0) {
        const totalBidBps = bidSpreadBps + levelOffset;
        const bidSpread = skewedMid.mul(totalBidBps).div(10000);
        let bidPrice = this.alignPrice(skewedMid.sub(bidSpread), "floor");

        // Clamp to not cross BBO
        if (bbo && bidPrice.gte(bbo.bestAsk)) {
          bidPrice = this.alignPrice(
            new Decimal(bbo.bestAsk).sub(this.tickSize),
            "floor",
          );
        }

        if (bidPrice.gt(0)) {
          const bidSize = this.alignSize(baseSize.mul(bidSizeMult * levelWeight));
          if (bidSize.gt(0)) {
            quotes.push({ side: "bid", price: bidPrice, size: bidSize });
          }
        }
      }

      // Ask orders
      if (askSizeMult > 0) {
        const totalAskBps = askSpreadBps + levelOffset;
        const askSpread = skewedMid.mul(totalAskBps).div(10000);
        let askPrice = this.alignPrice(skewedMid.add(askSpread), "ceil");

        // Clamp to not cross BBO
        if (bbo && askPrice.lte(bbo.bestBid)) {
          askPrice = this.alignPrice(
            new Decimal(bbo.bestBid).add(this.tickSize),
            "ceil",
          );
        }

        if (askPrice.gt(0)) {
          const askSize = this.alignSize(baseSize.mul(askSizeMult * levelWeight));
          if (askSize.gt(0)) {
            quotes.push({ side: "ask", price: askPrice, size: askSize });
          }
        }
      }
    }

    return quotes;
  }

  // Get diagnostic info for logging
  diagnose(ctx: EnhancedQuotingContext): string {
    const posRatio = (ctx.positionUsd / this.config.maxPositionUsd * 100).toFixed(0);
    const vol = ctx.volatilityBps?.toFixed(1) ?? "--";
    const mom = ctx.momentumBps.toFixed(1);
    const skew = (this.config.skewFactor * this.clamp(ctx.positionUsd / this.config.maxPositionUsd, -1, 1) * (ctx.volatilityBps ?? this.config.baseSpreadBps)).toFixed(1);
    return `inv=${posRatio}% vol=${vol}bps mom=${mom}bps skew=${skew}bps`;
  }

  // Split budget across levels so total ≈ 1.0x base size per side.
  // Front-loads inner level for higher fill probability.
  private getLevelWeights(levels: number): number[] {
    if (levels === 1) return [1.0];
    if (levels === 2) return [0.65, 0.35];
    // 3 levels
    return [0.55, 0.30, 0.15];
  }

  private alignPrice(price: Decimal, round: "floor" | "ceil"): Decimal {
    const ticks = price.div(this.tickSize);
    const aligned = round === "floor" ? ticks.floor() : ticks.ceil();
    return aligned.mul(this.tickSize);
  }

  private usdToSize(usd: number, fairPrice: Decimal): Decimal {
    const rawSize = new Decimal(usd).div(fairPrice);
    return this.alignSize(rawSize);
  }

  private alignSize(size: Decimal): Decimal {
    const lots = size.div(this.lotSize).floor();
    return lots.mul(this.lotSize);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }
}

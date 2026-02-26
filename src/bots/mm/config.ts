// MarketMaker configuration

export interface FeeConfig {
  readonly makerFeeBps: number // Maker fee in bps (01 Exchange Tier 1: 1 bps)
  readonly takerFeeBps: number // Taker fee in bps (01 Exchange Tier 1: 3.5 bps)
}

export const DEFAULT_FEES: FeeConfig = {
  makerFeeBps: 1,
  takerFeeBps: 3.5,
};

export interface MarketMakerConfig {
  readonly symbol: string // e.g., "BTC" or "ETH"
  readonly spreadBps: number // Spread from fair price (bps)
  readonly takeProfitBps: number // Spread in close mode (bps)
  readonly orderSizeUsd: number // Order size in USD
  readonly closeThresholdUsd: number // Trigger close mode when position >= this
  readonly warmupSeconds: number // Seconds to warm up before quoting
  readonly updateThrottleMs: number // Min interval between quote updates
  readonly orderSyncIntervalMs: number // Interval for syncing orders from API
  readonly statusIntervalMs: number // Interval for status display
  readonly fairPriceWindowMs: number // Window for fair price calculation
  readonly positionSyncIntervalMs: number // Interval for position sync
  readonly repriceThresholdBps: number // Only reprice when quote drifts more than this (reduces churn)
  readonly fees: FeeConfig // Exchange fee rates
}

// Default configuration values (symbol must be provided)
export const DEFAULT_CONFIG: Omit<MarketMakerConfig, 'symbol'> = {
  spreadBps: 8,
  takeProfitBps: 0.1,
  orderSizeUsd: 3,
  closeThresholdUsd: 9,
  warmupSeconds: 10,
  updateThrottleMs: 100,
  orderSyncIntervalMs: 3000,
  statusIntervalMs: 1000,
  fairPriceWindowMs: 5 * 60 * 1000, // 5 minutes
  positionSyncIntervalMs: 5000,
  repriceThresholdBps: 2,
  fees: DEFAULT_FEES,
}

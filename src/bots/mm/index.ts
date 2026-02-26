// MarketMaker - main bot logic

import type { NordUser } from "@n1xyz/nord-ts";
import Decimal from "decimal.js";
import type { DebouncedFunc } from "lodash-es";
import { throttle } from "lodash-es";
import { PnlTracker } from "../../analytics/pnl-tracker.js";
import {
	TradeLogger,
	type TradeRecord,
	type SnapshotRecord,
} from "../../analytics/trade-logger.js";
import type { RiskConfig, EnhancedStrategyConfig } from "./configs.js";
import {
	EnhancedQuoter,
	type EnhancedQuotingContext,
} from "./enhanced-quoter.js";
import {
	VolatilityTracker,
	MomentumDetector,
} from "../../pricing/volatility.js";
import { BinancePriceFeed } from "../../pricing/binance.js";
import {
	FairPriceCalculator,
	type FairPriceConfig,
	type FairPriceProvider,
} from "../../pricing/fair-price.js";
import { AccountStream, type FillEvent } from "../../sdk/account.js";
import { createZoClient, type ZoClient } from "../../sdk/client.js";
import { ZoOrderbookStream } from "../../sdk/orderbook.js";
import {
	type CachedOrder,
	cancelOrders,
	updateQuotes,
} from "../../sdk/orders.js";
import type { MidPrice, Quote } from "../../types.js";
import { log } from "../../utils/logger.js";
import type { MarketMakerConfig } from "./config.js";
import { type PositionConfig, PositionTracker } from "./position.js";
import { Quoter } from "./quoter.js";

export type { MarketMakerConfig } from "./config.js";

// API order type from SDK
interface ApiOrder {
	orderId: bigint | number;
	marketId: number;
	side: "bid" | "ask";
	price: number | string;
	size: number | string;
}

// Convert API orders to cached orders
function mapApiOrdersToCached(orders: ApiOrder[]): CachedOrder[] {
	return orders.map((o) => ({
		orderId: o.orderId.toString(),
		side: o.side,
		price: new Decimal(o.price),
		size: new Decimal(o.size),
	}));
}

// Derive Binance symbol from market symbol (e.g., "BTC-PERP" → "btcusdt")
function deriveBinanceSymbol(marketSymbol: string): string {
	const baseSymbol = marketSymbol
		.replace(/-PERP$/i, "")
		.replace(/USD$/i, "")
		.toLowerCase();
	return `${baseSymbol}usdt`;
}

export class MarketMaker {
	private client: ZoClient | null = null;
	private marketId = 0;
	private marketSymbol = "";
	private accountStream: AccountStream | null = null;
	private orderbookStream: ZoOrderbookStream | null = null;
	private referenceFeed: BinancePriceFeed | null = null;
	private fairPriceCalc: FairPriceProvider | null = null;
	private positionTracker: PositionTracker | null = null;
	private quoter: Quoter | null = null;
	private enhancedQuoter: EnhancedQuoter | null = null;
	private volTracker: VolatilityTracker | null = null;
	private momentumDetector: MomentumDetector | null = null;
	private pnlTracker: PnlTracker | null = null;
	private tradeLogger: TradeLogger | null = null;
	private lastFairPrice = 0;
	private isRunning = false;
	private lastLoggedSampleCount = -1;
	private marginRejections = 0; // Track consecutive margin rejections for fallback
	private flatSideFallbackNext: "bid" | "ask" = "bid";
	private activeOrders: CachedOrder[] = [];
	private initialExchangePosition = 0;
	private pnlSeeded = false;
	private isUpdating = false;
	private throttledUpdate: DebouncedFunc<
		(fairPrice: number) => Promise<void>
	> | null = null;
	private statusInterval: ReturnType<typeof setInterval> | null = null;
	private orderSyncInterval: ReturnType<typeof setInterval> | null = null;
	private snapshotInterval: ReturnType<typeof setInterval> | null = null;

	// Dedup tracking for high-frequency diagnostic logs (POS, ENHANCED, QUOTE)
	// Only re-log when content changes or MIN_LOG_INTERVAL_MS has passed.
	private lastDiagLogs: Record<string, { content: string; time: number }> = {};

	constructor(
		private readonly config: MarketMakerConfig,
		private readonly privateKey: string,
		private readonly riskConfig?: RiskConfig,
		private readonly enhancedConfig?: EnhancedStrategyConfig,
	) {}

	private static readonly MIN_LOG_INTERVAL_MS = 1000;

	// Returns true if the log should be emitted (content changed or interval elapsed)
	private shouldLogDiag(key: string, content: string): boolean {
		const now = Date.now();
		const last = this.lastDiagLogs[key];
		if (last && last.content === content && now - last.time < MarketMaker.MIN_LOG_INTERVAL_MS) {
			return false;
		}
		this.lastDiagLogs[key] = { content, time: now };
		return true;
	}

	private requireClient(): ZoClient {
		if (!this.client) {
			throw new Error("Client not initialized");
		}
		return this.client;
	}

	async run(): Promise<void> {
		log.banner();

		await this.initialize();
		this.setupEventHandlers();
		await this.syncInitialOrders();
		this.startIntervals();
		this.registerShutdownHandlers();

		log.info("Warming up price feeds...");
		await this.waitForever();
	}

	private async initialize(): Promise<void> {
		this.throttledUpdate = throttle(
			(fairPrice: number) => this.executeUpdate(fairPrice),
			this.config.updateThrottleMs,
			{ leading: true, trailing: true },
		);

		this.client = await createZoClient(this.privateKey);
		const { nord, accountId } = this.client;

		// Find market by symbol (e.g., "BTC" matches "BTC-PERP")
		const market = nord.markets.find((m) =>
			m.symbol.toUpperCase().startsWith(this.config.symbol.toUpperCase()),
		);
		if (!market) {
			const available = nord.markets.map((m) => m.symbol).join(", ");
			throw new Error(
				`Market "${this.config.symbol}" not found. Available: ${available}`,
			);
		}
		this.marketId = market.marketId;
		this.marketSymbol = market.symbol;

		const binanceSymbol = deriveBinanceSymbol(market.symbol);
		this.logConfig(binanceSymbol);

		// Initialize strategy components
		const fairPriceConfig: FairPriceConfig = {
			windowMs: this.config.fairPriceWindowMs,
			minSamples: this.config.warmupSeconds,
		};
		const positionConfig: PositionConfig = {
			closeThresholdUsd: this.config.closeThresholdUsd,
			syncIntervalMs: this.config.positionSyncIntervalMs,
		};

		this.fairPriceCalc = new FairPriceCalculator(fairPriceConfig);
		this.positionTracker = new PositionTracker(positionConfig);
		this.quoter = new Quoter(
			market.priceDecimals,
			market.sizeDecimals,
			this.config.spreadBps,
			this.config.takeProfitBps,
			this.config.orderSizeUsd,
			this.config.fees,
		);

		// Enhanced strategy: volatility + momentum + inventory skew
		if (this.enhancedConfig) {
			this.enhancedQuoter = new EnhancedQuoter(
				market.priceDecimals,
				market.sizeDecimals,
				this.enhancedConfig.quoter,
				this.config.orderSizeUsd,
				this.config.fees,
			);
			this.volTracker = new VolatilityTracker(this.enhancedConfig.volatility);
			this.momentumDetector = new MomentumDetector(this.enhancedConfig.momentum);
			log.info("Enhanced strategy: inventory skew + vol-adaptive spread + multi-level");
		}

		// Analytics: PnL tracking + trade logging
		if (this.riskConfig) {
			this.pnlTracker = new PnlTracker(this.riskConfig);
			this.tradeLogger = new TradeLogger(this.config.symbol);
			log.info(`Trade log: ${this.tradeLogger.getFilePath()}`);
		}

		// Initialize streams
		this.accountStream = new AccountStream(nord, accountId);
		this.orderbookStream = new ZoOrderbookStream(nord, this.marketSymbol);
		this.referenceFeed = new BinancePriceFeed(binanceSymbol);

		this.isRunning = true;
	}

	private setupEventHandlers(): void {
		const { user, accountId } = this.requireClient();

		// Account stream - fill events
		this.accountStream?.syncOrders(user, accountId);
		this.accountStream?.setOnFill((fill: FillEvent) => {
			// Ignore fills from other markets on the same account
			if (fill.marketId !== this.marketId) {
				log.debug(`Ignoring fill from market ${fill.marketId} (watching ${this.marketId})`);
				return;
			}
			const side = fill.side === "bid" ? "buy" : "sell" as const;
			log.fill(side, fill.price, fill.size);
			this.positionTracker?.applyFill(fill.side, fill.size, fill.price);

			// Fill means an order was consumed — sync to remove stale IDs
			// and prevent ORDER_NOT_FOUND on next update cycle.
			this.forceOrderSync();

			// PnL tracking and trade logging
			if (this.pnlTracker) {
				const realizedPnl = this.pnlTracker.applyFill(side, fill.price, fill.size);
				const fairPrice = this.lastFairPrice || fill.price;
				const pnlState = this.pnlTracker.getState(fairPrice);

				if (Math.abs(realizedPnl) > 0.0001) {
					log.info(
						`PNL: realized=$${realizedPnl.toFixed(4)} | total=$${pnlState.totalPnl.toFixed(4)} | dd=$${pnlState.drawdown.toFixed(4)}`,
					);
				}

				// Log trade to disk
				if (this.tradeLogger) {
					const isClose = this.positionTracker?.isCloseMode(fill.price) ?? false;
					const record: TradeRecord = {
						timestamp: new Date().toISOString(),
						epoch: Date.now(),
						type: "fill",
						symbol: this.config.symbol,
						side,
						price: fill.price,
						size: fill.size,
						sizeUsd: fill.price * fill.size,
						positionAfter: pnlState.positionBase,
						positionUsdAfter: pnlState.positionBase * fairPrice,
						realizedPnl,
						cumulativeRealizedPnl: pnlState.realizedPnl,
						unrealizedPnl: pnlState.unrealizedPnl,
						fairPrice,
						mode: isClose ? "close" : "normal",
						spreadBps: isClose ? this.config.takeProfitBps : this.config.spreadBps,
					};
					this.tradeLogger.logTrade(record);
				}

				// Risk halt: cancel all orders and stop quoting
				if (pnlState.shouldHalt) {
					log.error(`RISK HALT: ${pnlState.haltReason} — cancelling all orders`);
					this.cancelOrdersAsync();
					return;
				}
			}

			// Cancel all orders when entering close mode
			if (this.positionTracker?.isCloseMode(fill.price)) {
				this.cancelOrdersAsync();
			}
		});

		// Price feeds
		if (this.referenceFeed) {
			this.referenceFeed.onPrice = (price) => this.handleRefPrice(price);
		}
		if (this.orderbookStream) {
			this.orderbookStream.onPrice = (price) => this.handleZoPrice(price);
		}

		// Start connections
		this.accountStream?.connect();
		this.orderbookStream?.connect();
		this.referenceFeed?.connect();
	}

	private handleRefPrice(refPrice: MidPrice): void {
		const zoPrice = this.orderbookStream?.getMidPrice();
		if (
			zoPrice &&
			Math.abs(refPrice.timestamp - zoPrice.timestamp) < 1000
		) {
			this.fairPriceCalc?.addSample(zoPrice.mid, refPrice.mid);
		}

		// Feed vol/momentum trackers
		this.volTracker?.addPrice(refPrice.mid);
		this.momentumDetector?.addPrice(refPrice.mid);

		if (!this.isRunning) return;

		const fairPrice = this.fairPriceCalc?.getFairPrice(refPrice.mid);
		if (!fairPrice) {
			this.logWarmupProgress(refPrice);
			return;
		}

		// Log ready on first valid fair price
		if (this.lastLoggedSampleCount < this.config.warmupSeconds) {
			this.lastLoggedSampleCount = this.config.warmupSeconds;
			log.info(`Ready! Fair price: $${fairPrice.toFixed(2)}`);
		}

		this.throttledUpdate?.(fairPrice);
	}

	private handleZoPrice(zoPrice: MidPrice): void {
		const refPrice = this.referenceFeed?.getMidPrice();
		if (
			refPrice &&
			Math.abs(zoPrice.timestamp - refPrice.timestamp) < 1000
		) {
			this.fairPriceCalc?.addSample(zoPrice.mid, refPrice.mid);
		}
	}

	private logWarmupProgress(refPrice: MidPrice): void {
		const state = this.fairPriceCalc?.getState();
		if (!state || state.samples === this.lastLoggedSampleCount) return;

		this.lastLoggedSampleCount = state.samples;
		const zoPrice = this.orderbookStream?.getMidPrice();
		const offsetBps =
			state.offset !== null && refPrice.mid > 0
				? ((state.offset / refPrice.mid) * 10000).toFixed(1)
				: "--";
		log.info(
			`Warming up: ${state.samples}/${this.config.warmupSeconds} samples | Binance $${refPrice.mid.toFixed(2)} | 01 $${zoPrice?.mid.toFixed(2) ?? "--"} | Offset ${offsetBps}bps`,
		);
	}

	private async syncInitialOrders(): Promise<void> {
		const { user, accountId } = this.requireClient();

		await user.fetchInfo();
		const existingOrders = (user.orders[accountId] ?? []) as ApiOrder[];
		const marketOrders = existingOrders.filter(
			(o) => o.marketId === this.marketId,
		);
		const staleOrders = mapApiOrdersToCached(marketOrders);

		// Cancel all existing orders on startup — stale orders from a previous
		// session may be at wildly different prices and get adversely filled
		// during the warmup period before the bot can reprice them.
		if (staleOrders.length > 0) {
			log.info(`Found ${staleOrders.length} existing orders — cancelling to prevent stale fills...`);
			try {
				await cancelOrders(user, staleOrders);
				log.info(`Cancelled ${staleOrders.length} stale orders`);
			} catch (err) {
				log.warn("Failed to cancel some stale orders (may already be filled):", err);
			}
		}
		this.activeOrders = [];

		// Start position sync and store initial position for PnL seeding
		this.initialExchangePosition = await this.positionTracker?.startSync(user, accountId, this.marketId) ?? 0;
	}

	private startIntervals(): void {
		const { user, accountId } = this.requireClient();

		// Status display
		this.statusInterval = setInterval(() => {
			this.logStatus();
		}, this.config.statusIntervalMs);

		// Order sync
		this.orderSyncInterval = setInterval(() => {
			this.syncOrders(user, accountId);
		}, this.config.orderSyncIntervalMs);

		// Periodic PnL snapshot (every 60s)
		if (this.pnlTracker && this.tradeLogger) {
			this.snapshotInterval = setInterval(() => {
				this.logSnapshot();
			}, 60_000);
		}
	}

	private registerShutdownHandlers(): void {
		const shutdown = () => this.shutdown();
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
	}

	private async shutdown(): Promise<void> {
		log.shutdown();
		this.isRunning = false;
		this.throttledUpdate?.cancel();
		this.positionTracker?.stopSync();

		if (this.statusInterval) {
			clearInterval(this.statusInterval);
			this.statusInterval = null;
		}
		if (this.orderSyncInterval) {
			clearInterval(this.orderSyncInterval);
			this.orderSyncInterval = null;
		}
		if (this.snapshotInterval) {
			clearInterval(this.snapshotInterval);
			this.snapshotInterval = null;
		}

		// Final snapshot before exit
		this.logSnapshot();

		this.referenceFeed?.close();
		this.orderbookStream?.close();
		this.accountStream?.close();

		try {
			if (this.activeOrders.length > 0 && this.client) {
				await cancelOrders(this.client.user, this.activeOrders);
				log.info(`Cancelled ${this.activeOrders.length} orders. Goodbye!`);
				this.activeOrders = [];
			} else {
				log.info("No active orders. Goodbye!");
			}
		} catch (err) {
			log.error("Shutdown error:", err);
		}

		process.exit(0);
	}

	private async waitForever(): Promise<void> {
		await new Promise(() => {});
	}

	private selectBestQuoteForSide(
		quotes: Quote[],
		side: "bid" | "ask",
	): Quote | null {
		const sideQuotes = quotes.filter((q) => q.side === side);
		if (sideQuotes.length === 0) return null;

		return sideQuotes.reduce((best, current) => {
			if (side === "bid") {
				return current.price.gt(best.price) ? current : best;
			}
			return current.price.lt(best.price) ? current : best;
		});
	}

	private applyMarginFallback(quotes: Quote[], positionBase: number): Quote[] {
		if (this.marginRejections === 0) {
			return quotes;
		}

		let reduced = quotes;

		// Step 1: reduce to one level per side.
		if (reduced.length > 2) {
			const bestBid = this.selectBestQuoteForSide(reduced, "bid");
			const bestAsk = this.selectBestQuoteForSide(reduced, "ask");
			const twoSided = [bestBid, bestAsk].filter((q): q is Quote => q !== null);

			if (twoSided.length > 0 && twoSided.length < reduced.length) {
				reduced = twoSided;
				log.warn(
					`Margin fallback: reduced to ${reduced.length} orders (${this.marginRejections} prior rejections)`,
				);
			}
		}

		// Step 2: repeated rejections → quote only one side to minimize margin.
		if (this.marginRejections >= 2 && reduced.length > 1) {
			const fallbackSide =
				positionBase > 0
					? "ask"
					: positionBase < 0
						? "bid"
						: this.flatSideFallbackNext;

			if (positionBase === 0) {
				this.flatSideFallbackNext =
					this.flatSideFallbackNext === "bid" ? "ask" : "bid";
			}

			const single = this.selectBestQuoteForSide(reduced, fallbackSide);
			if (single) {
				reduced = [single];
				const reason =
					positionBase === 0
						? "flat inventory (alternating sides)"
						: `position ${positionBase > 0 ? "long" : "short"} (reducing side only)`;
				log.warn(
					`Margin fallback: using single ${fallbackSide.toUpperCase()} quote (${reason})`,
				);
			}
		}

		return reduced;
	}

	private async executeUpdate(fairPrice: number): Promise<void> {
		if (this.isUpdating) return;
		this.isUpdating = true;
		this.lastFairPrice = fairPrice;

		try {
			if (!this.positionTracker || !this.client) {
				return;
			}

			// Seed PnL tracker with pre-existing exchange position on first fair price
			if (!this.pnlSeeded && this.pnlTracker) {
				this.pnlTracker.initPosition(this.initialExchangePosition, fairPrice);
				this.pnlSeeded = true;
			}

			// Risk halt: skip quoting entirely
			if (this.pnlTracker?.isHalted()) {
				return;
			}

			const bbo = this.orderbookStream?.getBBO() ?? null;
			let quotes: Quote[] = [];

			if (this.enhancedQuoter) {
				// ─── Enhanced Strategy Path ───────────────────────────
				const posBase = this.positionTracker.getBaseSize();
				const posUsd = posBase * fairPrice;
				const volBps = this.volTracker?.getVolatilityBps() ?? null;
				const momBps = this.momentumDetector?.getMomentumBps() ?? 0;

				const enhancedCtx: EnhancedQuotingContext = {
					fairPrice,
					positionUsd: posUsd,
					positionBase: posBase,
					volatilityBps: volBps,
					momentumBps: momBps,
				};

				quotes = this.enhancedQuoter.getQuotes(enhancedCtx, bbo);

				// Log enhanced diagnostics (throttled — only on change or once/sec)
				if (posBase !== 0) {
					const isLong = posBase > 0;
					const isCloseMode = Math.abs(posUsd) >= this.config.closeThresholdUsd;
					const posKey = `${posBase.toFixed(6)}|${isLong}|${isCloseMode}`;
					if (this.shouldLogDiag("pos", posKey)) {
						log.position(posBase, posUsd, isLong, isCloseMode);
					}
				}
				const enhDiag = this.enhancedQuoter.diagnose(enhancedCtx);
				if (this.shouldLogDiag("enhanced", enhDiag)) {
					log.info(`ENHANCED: ${enhDiag}`);
				}
			} else {
				// ─── Simple Strategy Path ─────────────────────────────
				if (!this.quoter) return;
				const quotingCtx = this.positionTracker.getQuotingContext(fairPrice);
				const { positionState } = quotingCtx;

				if (positionState.sizeBase !== 0) {
					const posKey = `${positionState.sizeBase.toFixed(6)}|${positionState.isLong}|${positionState.isCloseMode}`;
					if (this.shouldLogDiag("pos", posKey)) {
						log.position(
							positionState.sizeBase,
							positionState.sizeUsd,
							positionState.isLong,
							positionState.isCloseMode,
						);
					}
				}

				quotes = this.quoter.getQuotes(quotingCtx, bbo);
			}

			quotes = this.applyMarginFallback(
				quotes,
				this.positionTracker.getBaseSize(),
			);

			if (quotes.length === 0) {
				log.warn("No quotes generated (order size too small)");
				return;
			}

			const bid = quotes.find((q) => q.side === "bid");
			const ask = quotes.find((q) => q.side === "ask");
			const quoteKey = `${bid?.price.toFixed(2) ?? "-"}|${ask?.price.toFixed(2) ?? "-"}|${fairPrice.toFixed(2)}`;
			if (this.shouldLogDiag("quote", quoteKey)) {
				log.quote(
					bid?.price.toNumber() ?? null,
					ask?.price.toNumber() ?? null,
					fairPrice,
					this.config.spreadBps,
					this.enhancedQuoter ? "enhanced" : "normal",
				);
			}

			const result = await updateQuotes(
				this.client.user,
				this.marketId,
				this.activeOrders,
				quotes,
				this.config.repriceThresholdBps,
			);
			this.activeOrders = result.orders;

			// Chunk errors mean stale order IDs — sync so next cycle has fresh IDs.
			if (result.hadChunkErrors) {
				this.forceOrderSync();
			}

			// Success — reset margin rejection counter
			if (this.marginRejections > 0) {
				log.info("Margin OK — clearing rejection counter");
				this.marginRejections = 0;
			}
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			// Margin errors: don't nuke order tracking — orders from prior cycles may still be live.
			// Increment rejection counter so next cycle falls back to fewer levels.
			if (errMsg.includes("OMF") || errMsg.includes("RISK_TRADE") || errMsg.includes("margin")) {
				this.marginRejections++;
				log.warn(`Margin rejected (${this.marginRejections}x) — keeping ${this.activeOrders.length} existing orders. Will retry with fewer levels.`);
				if (this.marginRejections >= 5) {
					log.error("5+ consecutive margin rejections — check account balance on 01 Exchange. You may need to deposit more funds.");
				}
			} else if (errMsg.includes("POST_ONLY") || errMsg.includes("MUST_NOT_FILL")) {
				// PostOnly rejection: our bid crossed the ask (or vice versa) due to market movement.
				// This is transient — keep existing orders, next cycle will reprice.
				log.warn("PostOnly crossed — market moved between quote and submit. Keeping existing orders.");
			} else if (errMsg.includes("ORDER_NOT_FOUND")) {
				// Tried to cancel an order that was already filled or expired.
				// Our activeOrders cache is stale — force immediate sync.
				log.warn("Stale order ID — forcing immediate order sync.");
				this.forceOrderSync();
			} else {
				log.error("Update error:", err);
				// Don't blindly clear — orders may still be live on exchange.
				// Force sync to reconcile.
				log.warn("Unexpected error — forcing immediate order sync.");
				this.forceOrderSync();
			}
		} finally {
			this.isUpdating = false;
		}
	}

	private logConfig(binanceSymbol: string): void {
		log.config({
			Market: this.marketSymbol,
			Binance: binanceSymbol,
			Spread: `${this.config.spreadBps} bps`,
			"Take Profit": `${this.config.takeProfitBps} bps`,
			"Order Size": `$${this.config.orderSizeUsd}`,
			"Close Mode": `>=$${this.config.closeThresholdUsd}`,
			Fees: `maker ${this.config.fees.makerFeeBps}bps / taker ${this.config.fees.takerFeeBps}bps`,
			"Reprice Threshold": `${this.config.repriceThresholdBps} bps`,
		});
	}

	private cancelOrdersAsync(): void {
		if (this.activeOrders.length === 0 || !this.client) return;
		const orders = this.activeOrders;
		cancelOrders(this.client.user, orders)
			.then(() => {
				this.activeOrders = [];
			})
			.catch((err) => {
				log.error("Failed to cancel orders:", err);
				this.activeOrders = [];
			});
	}

	private syncOrders(user: NordUser, accountId: number): void {
		this.syncOrdersWithRetry(user, accountId, 3, 500);
	}

	private async syncOrdersWithRetry(
		user: NordUser,
		accountId: number,
		retries: number,
		delayMs: number,
	): Promise<void> {
		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				await user.fetchInfo();
				const apiOrders = (user.orders[accountId] ?? []) as ApiOrder[];
				const marketOrders = apiOrders.filter(
					(o) => o.marketId === this.marketId,
				);
				this.activeOrders = mapApiOrdersToCached(marketOrders);
				return;
			} catch (err) {
				if (attempt < retries) {
					const backoff = delayMs * 2 ** attempt;
					log.warn(`Order sync failed (attempt ${attempt + 1}/${retries + 1}) — retrying in ${backoff}ms`);
					await new Promise((r) => setTimeout(r, backoff));
				} else {
					log.error("Order sync failed after retries:", err);
				}
			}
		}
	}

	// Immediate sync — used after ORDER_NOT_FOUND or fills to clear stale IDs
	private forceOrderSync(): void {
		if (!this.client) return;
		const { user, accountId } = this.client;
		this.syncOrders(user, accountId);
	}

	private logSnapshot(): void {
		if (!this.pnlTracker || !this.tradeLogger || this.lastFairPrice === 0) return;

		const pnl = this.pnlTracker.getState(this.lastFairPrice);
		const snapshot: SnapshotRecord = {
			timestamp: new Date().toISOString(),
			epoch: Date.now(),
			type: "snapshot",
			symbol: this.config.symbol,
			positionBase: pnl.positionBase,
			positionUsd: pnl.positionBase * this.lastFairPrice,
			fairPrice: this.lastFairPrice,
			unrealizedPnl: pnl.unrealizedPnl,
			realizedPnl: pnl.realizedPnl,
			totalPnl: pnl.totalPnl,
			drawdown: pnl.drawdown,
			peakPnl: pnl.peakPnl,
			tradeCount: pnl.tradeCount,
			volume: pnl.volumeUsd,
		};
		this.tradeLogger.logSnapshot(snapshot);
	}

	private logStatus(): void {
		if (!this.isRunning) return;

		const pos = this.positionTracker?.getBaseSize() ?? 0;
		const bids = this.activeOrders.filter((o) => o.side === "bid");
		const asks = this.activeOrders.filter((o) => o.side === "ask");

		const formatOrder = (o: CachedOrder) =>
			`$${o.price.toFixed(2)}x${o.size.toString()}`;

		const bidStr = bids.map(formatOrder).join(",") || "-";
		const askStr = asks.map(formatOrder).join(",") || "-";

		// Include PnL in status if available
		const pnlStr = this.pnlTracker && this.lastFairPrice > 0
			? (() => {
				const s = this.pnlTracker!.getState(this.lastFairPrice);
				return ` | pnl=$${s.totalPnl.toFixed(4)} dd=$${s.drawdown.toFixed(4)} fills=${s.tradeCount} vol=$${s.volumeUsd.toFixed(2)}`;
			})()
			: "";

		log.info(
			`STATUS: pos=${pos.toFixed(5)} | bid=[${bidStr}] | ask=[${askStr}]${pnlStr}`,
		);
	}
}

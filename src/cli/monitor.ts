// Unified Market Monitor CLI
// Combines orderbook and pricing views using blessed TUI

import "../utils/polyfills.js";
import "dotenv/config";
import type { NordUser } from "@n1xyz/nord-ts";
import { Nord } from "@n1xyz/nord-ts";
import { Connection } from "@solana/web3.js";
import blessed from "blessed";
import { BinancePriceFeed } from "../pricing/binance.js";
import {
	FairPriceCalculator,
	type FairPriceConfig,
} from "../pricing/fair-price.js";
import { AccountStream, type FillEvent } from "../sdk/account.js";
import { createZoClient } from "../sdk/client.js";
import { ZoOrderbookStream } from "../sdk/orderbook.js";
import { log } from "../utils/logger.js";

const FAIR_PRICE_WINDOW_MS = 5 * 60 * 1000;
const FAIR_PRICE_MIN_SAMPLES = 10;
const STATS_WINDOW_MS = 60_000;
const ORDERBOOK_DEPTH = 10;
const MAX_TRADES = 100;
const MAX_FILLS = 20;
const RENDER_INTERVAL_MS = 100;
const POSITION_SYNC_INTERVAL_MS = 30_000;

interface PriceState {
	mid: number;
	bid: number;
	ask: number;
	timestamp: number;
}

interface OrderbookLevel {
	price: number;
	size: number;
}

interface Trade {
	time: number;
	side: "buy" | "sell";
	price: number;
	size: number;
}

class MarketMonitor {
	private nord!: Nord;
	private binanceFeed!: BinancePriceFeed;
	private zoOrderbook!: ZoOrderbookStream;
	private fairPriceCalc!: FairPriceCalculator;

	private binancePrice: PriceState | null = null;
	private zoPrice: PriceState | null = null;
	private fairPrice: { price: number; timestamp: number } | null = null;

	// Update frequency tracking
	private binanceUpdates: number[] = [];
	private zoUpdates: number[] = [];
	private fairPriceUpdates: number[] = [];

	// Orderbook state (from WebSocket deltas for display)
	private orderbookBids = new Map<number, number>();
	private orderbookAsks = new Map<number, number>();

	// Trades
	private recentTrades: Trade[] = [];

	// Render throttling
	private lastRenderTime = 0;
	private renderPending = false;

	// Blessed screen and widgets
	private screen!: blessed.Widgets.Screen;
	private pricingBox!: blessed.Widgets.BoxElement;
	private orderbookBox!: blessed.Widgets.BoxElement;
	private tradesBox!: blessed.Widgets.BoxElement;
	private logBox!: blessed.Widgets.Log;

	private priceDecimals = 2;
	private sizeDecimals = 4;
	private restoreConsole: (() => void) | null = null;

	// Account state (optional, only when PRIVATE_KEY is present)
	private user: NordUser | null = null;
	private accountId: number | null = null;
	private accountStream: AccountStream | null = null;
	private marketId = 0;
	private accountBox: blessed.Widgets.BoxElement | null = null;
	private positionSize = 0;
	private positionPrice = 0;
	private recentFills: FillEvent[] = [];
	private positionSyncInterval: ReturnType<typeof setInterval> | null = null;
	private readonly hasAccount: boolean;

	constructor(private readonly targetSymbol: string) {
		this.hasAccount = !!process.env.PRIVATE_KEY;
	}

	async run(): Promise<void> {
		this.initScreen();
		this.addLog("Connecting to 01 Exchange...");

		const privateKey = process.env.PRIVATE_KEY;

		if (privateKey) {
			this.addLog("PRIVATE_KEY detected, enabling account features...");
			const client = await createZoClient(privateKey);
			this.nord = client.nord;
			this.user = client.user;
			this.accountId = client.accountId;
		} else {
			const rpcUrl =
				process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
			const connection = new Connection(rpcUrl, "confirmed");
			this.nord = await Nord.new({
				webServerUrl: "https://zo-mainnet.n1.xyz",
				app: "zoau54n5U24GHNKqyoziVaVxgsiQYnPMx33fKmLLCT5",
				solanaConnection: connection,
			});
		}

		// Find market
		const market = this.nord.markets.find((m) =>
			m.symbol.toUpperCase().startsWith(this.targetSymbol.toUpperCase()),
		);
		if (!market) {
			const available = this.nord.markets.map((m) => m.symbol).join(", ");
			this.addLog(
				`Market "${this.targetSymbol}" not found. Available: ${available}`,
			);
			return;
		}

		this.priceDecimals = market.priceDecimals;
		this.sizeDecimals = market.sizeDecimals;
		this.marketId = market.marketId;

		// Derive Binance symbol
		const baseSymbol = market.symbol
			.replace(/-PERP$/i, "")
			.replace(/USD$/i, "")
			.toLowerCase();
		const binanceSymbol = `${baseSymbol}usdt`;

		this.addLog(`Market: ${market.symbol}, Binance: ${binanceSymbol}`);

		// Initialize fair price calculator
		const fairPriceConfig: FairPriceConfig = {
			windowMs: FAIR_PRICE_WINDOW_MS,
			minSamples: FAIR_PRICE_MIN_SAMPLES,
		};
		this.fairPriceCalc = new FairPriceCalculator(fairPriceConfig);

		// Setup Binance feed
		this.binanceFeed = new BinancePriceFeed(binanceSymbol);
		this.binanceFeed.onPrice = (price) => {
			this.binancePrice = price;
			this.recordUpdate(this.binanceUpdates);
			this.updateFairPrice();
			this.render();
		};

		// Setup Zo orderbook stream (handles both pricing and depth display)
		this.zoOrderbook = new ZoOrderbookStream(this.nord, market.symbol);
		this.zoOrderbook.onPrice = (price) => {
			this.zoPrice = price;
			this.recordUpdate(this.zoUpdates);
			this.updateFairPrice();
			this.render();
		};

		// Set up orderbook update handler for depth display
		this.zoOrderbook.onOrderbookUpdate = (bids, asks) => {
			this.handleOrderbookUpdate(bids, asks);
		};

		// Subscribe to trades
		const tradesSub = this.nord.subscribeTrades(market.symbol);
		tradesSub.on("message", (data: unknown) => {
			this.handleTradesUpdate(data);
		});

		// Setup account features if authenticated
		if (this.user && this.accountId !== null) {
			await this.initAccountFeatures();
		}

		// Start connections
		this.binanceFeed.connect();
		await this.zoOrderbook.connect();

		this.addLog("Connected! Press 'q' to quit.");

		// Keep alive
		await new Promise(() => {});
	}

	private async initAccountFeatures(): Promise<void> {
		if (!this.user || this.accountId === null) return;

		await this.user.fetchInfo();
		this.syncPositionFromServer();

		this.accountStream = new AccountStream(this.nord, this.accountId);
		this.accountStream.syncOrders(this.user, this.accountId);
		this.accountStream.setOnFill((fill: FillEvent) => {
			if (fill.marketId === this.marketId) {
				if (fill.side === "bid") {
					this.positionSize += fill.size;
				} else {
					this.positionSize -= fill.size;
				}
				this.recentFills.unshift(fill);
				if (this.recentFills.length > MAX_FILLS) {
					this.recentFills.length = MAX_FILLS;
				}
				this.addLog(
					`FILL: ${fill.side === "bid" ? "BUY" : "SELL"} ${fill.size.toFixed(this.sizeDecimals)} @ $${this.formatPrice(fill.price)}`,
				);
				this.scheduleRender();
			}
		});
		this.accountStream.connect();

		this.positionSyncInterval = setInterval(() => {
			this.syncPositionFromServer();
		}, POSITION_SYNC_INTERVAL_MS);

		this.addLog(
			`Account active. Position: ${this.positionSize === 0 ? "flat" : this.positionSize.toFixed(this.sizeDecimals)}`,
		);
	}

	private syncPositionFromServer(): void {
		if (!this.user || this.accountId === null) return;

		this.user
			.fetchInfo()
			.then(() => {
				const positions =
					(this.user as NordUser).positions[this.accountId as number] || [];
				const pos = positions.find(
					(p: { marketId: number }) => p.marketId === this.marketId,
				);
				if (
					pos?.perp &&
					typeof pos.perp === "object" &&
					"isLong" in pos.perp &&
					"baseSize" in pos.perp
				) {
					const perp = pos.perp as {
						isLong: boolean;
						baseSize: number;
						price: number;
					};
					this.positionSize = perp.isLong
						? perp.baseSize
						: -perp.baseSize;
					this.positionPrice = perp.price;
				} else {
					this.positionSize = 0;
					this.positionPrice = 0;
				}
				this.scheduleRender();
			})
			.catch((err: unknown) => {
				this.addLog(`Position sync error: ${err}`);
			});
	}

	private initScreen(): void {
		this.screen = blessed.screen({
			smartCSR: true,
			title: "Zo Market Monitor",
		});

		// Redirect all log output to the TUI log box
		log.setOutput((msg) => this.addLog(msg));

		// Also capture console.log/warn/error from SDK
		const originalConsoleLog = console.log;
		const originalConsoleWarn = console.warn;
		const originalConsoleError = console.error;
		console.log = (...args: unknown[]) => {
			this.addLog(args.map(String).join(" "));
		};
		console.warn = (...args: unknown[]) => {
			this.addLog(`[WARN] ${args.map(String).join(" ")}`);
		};
		console.error = (...args: unknown[]) => {
			this.addLog(`[ERROR] ${args.map(String).join(" ")}`);
		};

		// Restore on shutdown
		this.restoreConsole = () => {
			console.log = originalConsoleLog;
			console.warn = originalConsoleWarn;
			console.error = originalConsoleError;
		};

		// Header
		blessed.box({
			parent: this.screen,
			top: 0,
			left: 0,
			width: "100%",
			height: 3,
			content: `{center}{bold}ZO MARKET MONITOR{/bold} - ${this.targetSymbol.toUpperCase()} | ${1000 / RENDER_INTERVAL_MS} FPS{/center}`,
			tags: true,
			style: {
				fg: "white",
				bg: "blue",
			},
		});

		// Pricing panel (top left)
		this.pricingBox = blessed.box({
			parent: this.screen,
			top: 3,
			left: 0,
			width: "20%",
			height: this.hasAccount ? "30%-3" : "60%-3",
			label: " Pricing ",
			border: { type: "line" },
			tags: true,
			style: {
				border: { fg: "cyan" },
			},
		});

		// Account panel (below pricing, only when authenticated)
		if (this.hasAccount) {
			this.accountBox = blessed.box({
				parent: this.screen,
				top: "30%",
				left: 0,
				width: "20%",
				height: "30%",
				label: " Account ",
				border: { type: "line" },
				tags: true,
				scrollable: true,
				alwaysScroll: true,
				scrollbar: {
					ch: " ",
					style: { bg: "yellow" },
				},
				style: {
					border: { fg: "yellow" },
				},
			});
		}

		// Orderbook panel (top center)
		this.orderbookBox = blessed.box({
			parent: this.screen,
			top: 3,
			left: "20%",
			width: "30%",
			height: "60%-3",
			label: " Orderbook ",
			border: { type: "line" },
			tags: true,
			style: {
				border: { fg: "cyan" },
			},
		});

		// Trades panel (top right, 50% width)
		this.tradesBox = blessed.box({
			parent: this.screen,
			top: 3,
			left: "50%",
			width: "50%",
			height: "60%-3",
			label: " Trades ",
			border: { type: "line" },
			tags: true,
			scrollable: true,
			alwaysScroll: true,
			scrollbar: {
				ch: " ",
				style: { bg: "cyan" },
			},
			style: {
				border: { fg: "cyan" },
			},
		});

		// Log panel (bottom, full width)
		this.logBox = blessed.log({
			parent: this.screen,
			top: "60%",
			left: 0,
			width: "100%",
			height: "40%",
			label: " Log ",
			border: { type: "line" },
			tags: true,
			scrollable: true,
			alwaysScroll: true,
			scrollbar: {
				ch: " ",
				style: { bg: "cyan" },
			},
			style: {
				border: { fg: "cyan" },
			},
		});

		// Key bindings
		this.screen.key(["q", "C-c"], () => {
			this.shutdown();
		});

		this.screen.render();
	}

	private handleOrderbookUpdate(
		bids: Map<number, number>,
		asks: Map<number, number>,
	): void {
		this.orderbookBids = new Map(bids);
		this.orderbookAsks = new Map(asks);
		this.scheduleRender();
	}

	private handleTradesUpdate(rawData: unknown): void {
		const data = rawData as {
			trades?: Array<{ side: string; price: number; size: number }>;
		};

		if (!data.trades) return;

		for (const t of data.trades) {
			// side: "ask" = taker bought (hit the ask), "bid" = taker sold (hit the bid)
			const trade: Trade = {
				time: Date.now(),
				side: t.side === "ask" ? "buy" : "sell",
				price: t.price,
				size: t.size,
			};
			// Add to front (newest first)
			this.recentTrades.unshift(trade);
		}

		// Keep limited history
		if (this.recentTrades.length > MAX_TRADES) {
			this.recentTrades.length = MAX_TRADES;
		}

		this.scheduleRender();
	}

	private updateFairPrice(): void {
		if (this.binancePrice && this.zoPrice) {
			if (
				Math.abs(this.binancePrice.timestamp - this.zoPrice.timestamp) < 1000
			) {
				this.fairPriceCalc.addSample(this.zoPrice.mid, this.binancePrice.mid);
			}

			const fp = this.fairPriceCalc.getFairPrice(this.binancePrice.mid);
			if (fp !== null) {
				const now = Date.now();
				if (!this.fairPrice || this.fairPrice.price !== fp) {
					this.recordUpdate(this.fairPriceUpdates);
				}
				this.fairPrice = { price: fp, timestamp: now };
			}
		}
	}

	private recordUpdate(updates: number[]): void {
		const now = Date.now();
		updates.push(now);
		const cutoff = now - STATS_WINDOW_MS;
		while (updates.length > 0 && updates[0] < cutoff) {
			updates.shift();
		}
	}

	private getUpdatesPerSecond(updates: number[]): number {
		const now = Date.now();
		const cutoff = now - STATS_WINDOW_MS;
		const recentUpdates = updates.filter((t) => t > cutoff);
		const windowSeconds =
			Math.min(STATS_WINDOW_MS, now - (updates[0] ?? now)) / 1000;
		if (windowSeconds <= 0) return 0;
		return recentUpdates.length / windowSeconds;
	}

	private formatUsd(value: number): string {
		return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
	}

	private formatPrice(value: number): string {
		return value.toLocaleString("en-US", {
			minimumFractionDigits: this.priceDecimals,
			maximumFractionDigits: this.priceDecimals,
		});
	}

	private scheduleRender(): void {
		const now = Date.now();
		const elapsed = now - this.lastRenderTime;

		if (elapsed >= RENDER_INTERVAL_MS) {
			// Enough time passed, render immediately
			this.doRender();
		} else if (!this.renderPending) {
			// Schedule render for later
			this.renderPending = true;
			setTimeout(() => {
				this.renderPending = false;
				this.doRender();
			}, RENDER_INTERVAL_MS - elapsed);
		}
	}

	private doRender(): void {
		this.lastRenderTime = Date.now();
		this.renderPricing();
		this.renderOrderbook();
		this.renderTrades();
		this.renderAccount();
		this.screen.render();
	}

	// Legacy render for compatibility
	private render(): void {
		this.scheduleRender();
	}

	private renderPricing(): void {
		const lines: string[] = [];

		// Binance
		if (this.binancePrice) {
			const price = this.formatPrice(this.binancePrice.mid);
			const rate = `${this.getUpdatesPerSecond(this.binanceUpdates).toFixed(1)}/s`;
			lines.push(` Binance $${price} {gray-fg}${rate}{/gray-fg}`);
		} else {
			lines.push(` Binance {yellow-fg}--{/yellow-fg}`);
		}

		// 01 Exchange
		if (this.zoPrice) {
			const price = this.formatPrice(this.zoPrice.mid);
			const rate = `${this.getUpdatesPerSecond(this.zoUpdates).toFixed(1)}/s`;
			lines.push(` 01      $${price} {gray-fg}${rate}{/gray-fg}`);
		} else {
			lines.push(` 01      {yellow-fg}--{/yellow-fg}`);
		}

		// Current offset (01 - Binance)
		if (this.binancePrice && this.zoPrice) {
			const offset = this.zoPrice.mid - this.binancePrice.mid;
			const offsetBps = ((offset / this.binancePrice.mid) * 10000).toFixed(1);
			const sign = offset >= 0 ? "+" : "";
			lines.push(` Offset  ${sign}${offsetBps}bps`);
		}

		// Median offset (for fair price)
		const state = this.fairPriceCalc.getState();
		if (state.offset !== null && this.binancePrice) {
			const medianBps = (
				(state.offset / this.binancePrice.mid) *
				10000
			).toFixed(1);
			const sign = state.offset >= 0 ? "+" : "";
			lines.push(
				` Median  ${sign}${medianBps}bps {gray-fg}(${state.samples}s){/gray-fg}`,
			);
		}

		this.pricingBox.setContent(lines.join("\n"));
	}

	private renderAccount(): void {
		if (!this.accountBox) return;

		const lines: string[] = [];

		// Position
		if (this.positionSize === 0) {
			lines.push(" {gray-fg}No position{/gray-fg}");
		} else {
			const isLong = this.positionSize > 0;
			const dir = isLong
				? "{green-fg}LONG{/green-fg}"
				: "{red-fg}SHORT{/red-fg}";
			const size = Math.abs(this.positionSize).toFixed(this.sizeDecimals);
			const midPrice = this.zoPrice?.mid ?? this.positionPrice;
			const usdValue = Math.abs(this.positionSize * midPrice);
			lines.push(` ${dir} ${size}`);
			lines.push(` $${this.formatUsd(usdValue)} @ $${this.formatPrice(this.positionPrice)}`);
		}

		lines.push("");

		// Active orders
		const marketOrders =
			this.accountStream?.getOrdersForMarket(this.marketId) ?? [];
		const bids = marketOrders
			.filter((o) => o.side === "bid")
			.sort((a, b) => b.price - a.price);
		const asks = marketOrders
			.filter((o) => o.side === "ask")
			.sort((a, b) => a.price - b.price);

		if (bids.length === 0 && asks.length === 0) {
			lines.push(" {gray-fg}No orders{/gray-fg}");
		} else {
			lines.push(" {bold}Orders:{/bold}");
			for (const ask of asks) {
				lines.push(
					`  {red-fg}A $${this.formatPrice(ask.price)} x${ask.size.toFixed(this.sizeDecimals)}{/red-fg}`,
				);
			}
			for (const bid of bids) {
				lines.push(
					`  {green-fg}B $${this.formatPrice(bid.price)} x${bid.size.toFixed(this.sizeDecimals)}{/green-fg}`,
				);
			}
		}

		// Recent fills
		if (this.recentFills.length > 0) {
			lines.push("");
			lines.push(" {bold}Fills:{/bold}");
			const displayFills = this.recentFills.slice(0, 5);
			for (const f of displayFills) {
				const side =
					f.side === "bid"
						? "{green-fg}BUY{/green-fg}"
						: "{red-fg}SELL{/red-fg}";
				lines.push(
					`  ${side} ${f.size.toFixed(this.sizeDecimals)} @ $${this.formatPrice(f.price)}`,
				);
			}
			if (this.recentFills.length > 5) {
				lines.push(
					`  {gray-fg}+${this.recentFills.length - 5} more{/gray-fg}`,
				);
			}
		}

		this.accountBox.setContent(lines.join("\n"));
	}

	private renderOrderbook(): void {
		const sortedBids = this.getSortedLevels(this.orderbookBids, "desc").slice(
			0,
			ORDERBOOK_DEPTH,
		);
		const sortedAsks = this.getSortedLevels(this.orderbookAsks, "asc").slice(
			0,
			ORDERBOOK_DEPTH,
		);

		const lines: string[] = [];
		lines.push("");
		lines.push("  {bold}      Price       Size         USD{/bold}");
		lines.push("  ──────────────────────────────────────");

		// Asks (reversed so lowest is at bottom)
		const displayAsks = sortedAsks.slice().reverse();
		for (let i = 0; i < ORDERBOOK_DEPTH; i++) {
			const level = displayAsks[i];
			if (level) {
				const priceStr = this.formatPrice(level.price).padStart(11);
				const sizeStr = level.size.toFixed(this.sizeDecimals).padStart(10);
				const usdStr = this.formatUsd(level.price * level.size).padStart(12);
				lines.push(`  {red-fg}${priceStr} ${sizeStr}${usdStr}{/red-fg}`);
			} else {
				lines.push("");
			}
		}

		// Spread line
		const bestBid = sortedBids[0]?.price ?? 0;
		const bestAsk = sortedAsks[0]?.price ?? 0;
		const spread = bestAsk - bestBid;
		const spreadBps =
			bestBid > 0 ? ((spread / bestBid) * 10000).toFixed(1) : "0.0";
		lines.push(
			`  ─── spread: ${this.formatPrice(spread)} (${spreadBps} bps) ───`,
		);

		// Bids
		for (let i = 0; i < ORDERBOOK_DEPTH; i++) {
			const level = sortedBids[i];
			if (level) {
				const priceStr = this.formatPrice(level.price).padStart(11);
				const sizeStr = level.size.toFixed(this.sizeDecimals).padStart(10);
				const usdStr = this.formatUsd(level.price * level.size).padStart(12);
				lines.push(`  {green-fg}${priceStr} ${sizeStr}${usdStr}{/green-fg}`);
			} else {
				lines.push("");
			}
		}

		this.orderbookBox.setContent(lines.join("\n"));
	}

	private renderTrades(): void {
		const lines = this.recentTrades.map((t) => this.formatTrade(t));
		this.tradesBox.setContent(lines.join("\n"));
	}

	private formatTrade(trade: Trade): string {
		const d = new Date(trade.time);
		const timeStr = `${d.toLocaleTimeString("ja-JP", {
			hour12: false,
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		})}.${String(d.getMilliseconds()).padStart(3, "0")}`;
		const price = this.formatPrice(trade.price).padStart(10);
		const isBuy = trade.side === "buy";
		const sign = isBuy ? "" : "-";
		const color = isBuy ? "green" : "red";
		const size = `${sign}${trade.size.toFixed(this.sizeDecimals)}`.padStart(9);
		const usd = `${sign}${this.formatUsd(trade.price * trade.size)}`.padStart(
			11,
		);
		return `${timeStr}  ${price}  {${color}-fg}${size}  ${usd}{/${color}-fg}`;
	}

	private getSortedLevels(
		levels: Map<number, number>,
		order: "asc" | "desc",
	): OrderbookLevel[] {
		return Array.from(levels.entries())
			.map(([price, size]) => ({ price, size }))
			.sort((a, b) =>
				order === "asc" ? a.price - b.price : b.price - a.price,
			);
	}

	private addLog(message: string): void {
		// Message already has timestamp from logger, just display it
		this.logBox.log(message);
		this.screen.render();
	}

	private shutdown(): void {
		this.restoreConsole?.();
		this.binanceFeed?.close();
		this.zoOrderbook?.close();
		this.accountStream?.close();
		if (this.positionSyncInterval) {
			clearInterval(this.positionSyncInterval);
		}
		this.screen.destroy();
		process.exit(0);
	}
}

function main(): void {
	const symbol = process.argv[2]?.toUpperCase();

	if (!symbol) {
		console.error("Usage: npm run monitor -- <symbol>");
		console.error("Example: npm run monitor -- BTC");
		process.exit(1);
	}

	const monitor = new MarketMonitor(symbol);
	monitor.run().catch((err) => {
		console.error("Fatal error:", err);
		process.exit(1);
	});
}

main();

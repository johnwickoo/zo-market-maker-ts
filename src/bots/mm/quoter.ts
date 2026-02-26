// Quoter - calculates bid/ask prices with proper precision

import Decimal from "decimal.js";
import type { FeeConfig } from "./config.js";
import type { BBO } from "../../sdk/orderbook.js";
import type { Quote } from "../../types.js";
import type { QuotingContext } from "./position.js";
import { log } from "../../utils/logger.js";

export type { Quote } from "../../types.js";

export class Quoter {
	private readonly tickSize: Decimal;
	private readonly lotSize: Decimal;
	private readonly minSpreadBps: number;

	constructor(
		priceDecimals: number,
		sizeDecimals: number,
		private readonly spreadBps: number,
		private readonly takeProfitBps: number,
		private readonly orderSizeUsd: number,
		fees: FeeConfig,
	) {
		this.tickSize = new Decimal(10).pow(-priceDecimals);
		this.lotSize = new Decimal(10).pow(-sizeDecimals);
		this.minSpreadBps = 2 * fees.makerFeeBps;
		if (spreadBps < this.minSpreadBps) {
			log.warn(`spreadBps (${spreadBps}) < fee floor (${this.minSpreadBps}bps) — spread will be clamped`);
		}
	}

	// Calculate quotes from quoting context, clamped to BBO
	getQuotes(ctx: QuotingContext, bbo: BBO | null): Quote[] {
		const { fairPrice, positionState, allowedSides } = ctx;
		const fair = new Decimal(fairPrice);
		const rawBps = positionState.isCloseMode ? this.takeProfitBps : this.spreadBps;
		const bps = Math.max(rawBps, this.minSpreadBps);
		const spreadAmount = fair.mul(bps).div(10000);

		// In close mode: limit size to position size
		let size: Decimal;
		if (positionState.isCloseMode) {
			const posSize = new Decimal(positionState.sizeBase).abs();
			size = this.alignSize(posSize);
		} else {
			size = this.usdToSize(this.orderSizeUsd, fair);
		}

		// Skip if size is too small
		if (size.lte(0)) {
			return [];
		}

		const quotes: Quote[] = [];

		if (allowedSides.includes("bid")) {
			let bidPrice = this.alignPrice(fair.sub(spreadAmount), "floor");

			// Clamp bid to not exceed best ask (don't cross spread)
			if (bbo && bidPrice.gte(bbo.bestAsk)) {
				bidPrice = this.alignPrice(
					new Decimal(bbo.bestAsk).sub(this.tickSize),
					"floor",
				);
			}

			if (bidPrice.gt(0)) {
				quotes.push({
					side: "bid",
					price: bidPrice,
					size,
				});
			}
		}

		if (allowedSides.includes("ask")) {
			let askPrice = this.alignPrice(fair.add(spreadAmount), "ceil");

			// Clamp ask to not go below best bid (don't cross spread)
			if (bbo && askPrice.lte(bbo.bestBid)) {
				askPrice = this.alignPrice(
					new Decimal(bbo.bestBid).add(this.tickSize),
					"ceil",
				);
			}

			if (askPrice.gt(0)) {
				quotes.push({
					side: "ask",
					price: askPrice,
					size,
				});
			}
		}

		return quotes;
	}

	// Align price to tick size
	private alignPrice(price: Decimal, round: "floor" | "ceil"): Decimal {
		const ticks = price.div(this.tickSize);
		const aligned = round === "floor" ? ticks.floor() : ticks.ceil();
		return aligned.mul(this.tickSize);
	}

	// Convert USD to size aligned to lot size
	private usdToSize(usd: number, fairPrice: Decimal): Decimal {
		const rawSize = new Decimal(usd).div(fairPrice);
		return this.alignSize(rawSize);
	}

	// Align size to lot size
	private alignSize(size: Decimal): Decimal {
		const lots = size.div(this.lotSize).floor();
		return lots.mul(this.lotSize);
	}
}

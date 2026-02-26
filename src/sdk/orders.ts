// Atomic order operations with immediate order ID tracking

import {
	FillMode,
	type NordUser,
	Side,
	type UserAtomicSubaction,
} from "@n1xyz/nord-ts";
import Decimal from "decimal.js";
import type { Quote } from "../types.js";
import { log } from "../utils/logger.js";

const MAX_ATOMIC_ACTIONS = 4;

// Cached order info
export interface CachedOrder {
	orderId: string;
	side: "bid" | "ask";
	price: Decimal;
	size: Decimal;
}

// Result type for atomic operations
interface AtomicResult {
	results: Array<{
		inner: {
			case: string;
			value: {
				orderId?: string;
				posted?: {
					orderId: string;
				};
			};
		};
	}>;
}

function formatAction(action: UserAtomicSubaction): string {
	if (action.kind === "cancel") {
		return `X${action.orderId}`;
	}
	const side = action.side === Side.Bid ? "B" : "A";
	const ro = action.isReduceOnly ? "RO" : "";
	const fm =
		action.fillMode === FillMode.PostOnly
			? "PO"
			: action.fillMode === FillMode.Limit
				? "LIM"
				: action.fillMode === FillMode.ImmediateOrCancel
					? "IOC"
					: "FOK";
	return `${side}${ro}[${fm}]@${action.price}x${action.size}`;
}

// Extract placed orders from atomic result
function extractPlacedOrders(
	result: AtomicResult,
	actions: UserAtomicSubaction[],
): CachedOrder[] {
	const orders: CachedOrder[] = [];
	const placeActions = actions.filter((a) => a.kind === "place");
	let placeIdx = 0;

	for (const r of result.results) {
		if (r.inner.case === "placeOrderResult" && r.inner.value.posted?.orderId) {
			const action = placeActions[placeIdx];
			if (action && action.kind === "place") {
				orders.push({
					orderId: r.inner.value.posted.orderId,
					side: action.side === Side.Bid ? "bid" : "ask",
					price: new Decimal(action.price as Decimal.Value),
					size: new Decimal(action.size as Decimal.Value),
				});
			}
			placeIdx++;
		}
	}
	return orders;
}

// Result of executeAtomic — includes placed orders and whether any chunks failed.
export interface AtomicExecResult {
	orders: CachedOrder[];
	hadChunkErrors: boolean;
}

// Execute atomic operations in chunks of MAX_ATOMIC_ACTIONS.
// Errors per-chunk are caught and logged — remaining chunks still execute.
// This prevents a single POST_ONLY or ORDER_NOT_FOUND from aborting the
// entire cancel+place sequence, which would leave stale/orphaned orders.
async function executeAtomic(
	user: NordUser,
	actions: UserAtomicSubaction[],
): Promise<AtomicExecResult> {
	if (actions.length === 0) return { orders: [], hadChunkErrors: false };

	const allOrders: CachedOrder[] = [];
	const totalChunks = Math.ceil(actions.length / MAX_ATOMIC_ACTIONS);
	let hadChunkErrors = false;

	for (let i = 0; i < actions.length; i += MAX_ATOMIC_ACTIONS) {
		const chunkIdx = Math.floor(i / MAX_ATOMIC_ACTIONS) + 1;
		const chunk = actions.slice(i, i + MAX_ATOMIC_ACTIONS);

		log.info(
			`ATOMIC [${chunkIdx}/${totalChunks}]: ${chunk.map(formatAction).join(" ")}`,
		);

		try {
			const result = (await user.atomic(chunk)) as AtomicResult;
			const placed = extractPlacedOrders(result, chunk);
			allOrders.push(...placed);

			if (placed.length > 0) {
				log.debug(`ATOMIC: placed [${placed.map((o) => o.orderId).join(", ")}]`);
			}
		} catch (err) {
			hadChunkErrors = true;
			const errMsg = err instanceof Error ? err.message : String(err);
			if (errMsg.includes("POST_ONLY") || errMsg.includes("MUST_NOT_FILL")) {
				log.warn(`ATOMIC [${chunkIdx}/${totalChunks}]: PostOnly crossed — skipping chunk, continuing.`);
			} else if (errMsg.includes("ORDER_NOT_FOUND")) {
				log.warn(`ATOMIC [${chunkIdx}/${totalChunks}]: Stale order ID — skipping chunk, continuing.`);
			} else if (errMsg.includes("reason: undefined") || errMsg.includes("Atomic operation failed")) {
				// Exchange returned an error without a reason — treat as transient.
				// Common during high-frequency updates when exchange state is mid-transition.
				log.warn(`ATOMIC [${chunkIdx}/${totalChunks}]: Exchange error (${errMsg.slice(-60)}) — skipping chunk, continuing.`);
			} else {
				// Truly unknown error — rethrow so the caller can handle it
				throw err;
			}
		}
	}

	return { orders: allOrders, hadChunkErrors };
}

// Build place action from quote
function buildPlaceAction(marketId: number, quote: Quote): UserAtomicSubaction {
	const action = {
		kind: "place" as const,
		marketId,
		side: quote.side === "bid" ? Side.Bid : Side.Ask,
		fillMode: FillMode.PostOnly,
		isReduceOnly: false,
		price: quote.price,
		size: quote.size,
	};
	log.debug(`ORDER JSON: ${JSON.stringify(action)}`);
	return action;
}

// Build cancel action from order ID
function buildCancelAction(orderId: string): UserAtomicSubaction {
	return {
		kind: "cancel" as const,
		orderId,
	};
}

// Check if order matches quote (same side, price, size)
function orderMatchesQuote(order: CachedOrder, quote: Quote): boolean {
	return (
		order.side === quote.side &&
		order.price.eq(quote.price) &&
		order.size.eq(quote.size)
	);
}

// Result of updateQuotes — includes new active orders and whether any chunks failed.
export interface UpdateQuotesResult {
	orders: CachedOrder[];
	hadChunkErrors: boolean;
}

// Update quotes: only cancel/place if changed
export async function updateQuotes(
	user: NordUser,
	marketId: number,
	currentOrders: CachedOrder[],
	newQuotes: Quote[],
): Promise<UpdateQuotesResult> {
	const keptOrders: CachedOrder[] = [];
	const ordersToCancel: CachedOrder[] = [];
	const quotesToPlace: Quote[] = [];

	// For each new quote, check if matching order exists
	for (const quote of newQuotes) {
		const matchingOrder = currentOrders.find((o) =>
			orderMatchesQuote(o, quote),
		);
		if (matchingOrder) {
			keptOrders.push(matchingOrder);
		} else {
			quotesToPlace.push(quote);
		}
	}

	// Cancel orders that don't match any new quote
	for (const order of currentOrders) {
		if (!keptOrders.includes(order)) {
			ordersToCancel.push(order);
		}
	}

	// Skip if nothing to do
	if (ordersToCancel.length === 0 && quotesToPlace.length === 0) {
		return { orders: currentOrders, hadChunkErrors: false };
	}

	// Cancels first, then places. This isolates stale cancel IDs in early
	// chunks so they don't take down place actions in the same chunk.
	const cancelActions = ordersToCancel.map((o) => buildCancelAction(o.orderId));
	const placeActions = quotesToPlace.map((q) => buildPlaceAction(marketId, q));
	const actions: UserAtomicSubaction[] = [...cancelActions, ...placeActions];

	const result = await executeAtomic(user, actions);
	return { orders: [...keptOrders, ...result.orders], hadChunkErrors: result.hadChunkErrors };
}

// Cancel orders
export async function cancelOrders(
	user: NordUser,
	orders: CachedOrder[],
): Promise<void> {
	if (orders.length === 0) return;
	const actions = orders.map((o) => buildCancelAction(o.orderId));
	await executeAtomic(user, actions);
}

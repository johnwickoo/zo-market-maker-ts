// Simple logger with millisecond precision
// Format: timestamp [LEVEL] CATEGORY: message

type LogOutput = (message: string) => void;
type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

let outputFn: LogOutput = (msg) => console.log(msg);
let errorFn: LogOutput = (msg) => console.error(msg);
let minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

function timestamp(): string {
	return new Date().toISOString();
}

function formatArg(a: unknown): string {
	if (a instanceof Error) {
		return a.stack || a.message;
	}
	if (typeof a === "object") {
		return JSON.stringify(a);
	}
	return String(a);
}

function format(level: string, message: string, ...args: unknown[]): string {
	const argStr = args.length > 0 ? ` ${args.map(formatArg).join(" ")}` : "";
	return `${timestamp()} [${level}] ${message}${argStr}`;
}

function shouldLog(level: LogLevel): boolean {
	return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minLevel];
}

export const log = {
	setOutput(fn: LogOutput): void {
		outputFn = fn;
		errorFn = fn;
	},

	setLevel(level: LogLevel): void {
		minLevel = level;
	},

	info(message: string, ...args: unknown[]): void {
		if (!shouldLog("info")) return;
		outputFn(format("INFO", message, ...args));
	},

	warn(message: string, ...args: unknown[]): void {
		if (!shouldLog("warn")) return;
		outputFn(format("WARN", message, ...args));
	},

	error(message: string, ...args: unknown[]): void {
		if (!shouldLog("error")) return;
		errorFn(format("ERROR", message, ...args));
	},

	debug(message: string, ...args: unknown[]): void {
		if (!shouldLog("debug")) return;
		outputFn(format("DEBUG", message, ...args));
	},

	// MM specific logs - all use INFO level with category prefix
	quote(
		bid: number | null,
		ask: number | null,
		fair: number,
		spreadBps: number,
		mode: "normal" | "close" | "enhanced",
	): void {
		const bidStr = bid !== null ? `$${bid.toFixed(2)}` : "--";
		const askStr = ask !== null ? `$${ask.toFixed(2)}` : "--";
		outputFn(
			format(
				"INFO",
				`QUOTE: BID ${bidStr} | ASK ${askStr} | FAIR $${fair.toFixed(2)} | SPREAD ${spreadBps}bps | ${mode.toUpperCase()}`,
			),
		);
	},

	position(
		sizeBase: number,
		sizeUsd: number,
		isLong: boolean,
		isCloseMode: boolean,
	): void {
		const dir = isLong ? "LONG" : "SHORT";
		const mode = isCloseMode ? " [CLOSE MODE]" : "";
		outputFn(
			format(
				"INFO",
				`POS: ${dir} ${Math.abs(sizeBase).toFixed(6)} ($${Math.abs(sizeUsd).toFixed(2)})${mode}`,
			),
		);
	},

	fill(side: "buy" | "sell", price: number, size: number): void {
		outputFn(
			format(
				"INFO",
				`FILL: ${side.toUpperCase()} ${size} @ $${price.toFixed(2)}`,
			),
		);
	},

	banner(): void {
		outputFn(`
╔═══════════════════════════════════════╗
║         ZO MARKET MAKER BOT           ║
╚═══════════════════════════════════════╝
`);
	},

	config(cfg: Record<string, unknown>): void {
		outputFn(format("INFO", "CONFIG:"));
		for (const [key, value] of Object.entries(cfg)) {
			outputFn(`  ${key}: ${value}`);
		}
	},

	shutdown(): void {
		outputFn(format("INFO", "Shutting down..."));
	},
};

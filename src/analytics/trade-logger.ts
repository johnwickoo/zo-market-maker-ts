// Trade Logger — persists every fill and quote event to disk as JSONL
// Each line is a self-contained JSON object for easy streaming analysis

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface TradeRecord {
  timestamp: string;           // ISO 8601
  epoch: number;               // Unix ms
  type: "fill";
  symbol: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  sizeUsd: number;
  positionAfter: number;       // Position in base after this fill
  positionUsdAfter: number;    // Position in USD after this fill
  realizedPnl: number;         // PnL realized by this specific fill
  cumulativeRealizedPnl: number;
  unrealizedPnl: number;
  fairPrice: number;
  mode: "normal" | "close";
  spreadBps: number;
}

export interface SnapshotRecord {
  timestamp: string;
  epoch: number;
  type: "snapshot";
  symbol: string;
  positionBase: number;
  positionUsd: number;
  fairPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  totalPnl: number;
  drawdown: number;
  peakPnl: number;
  tradeCount: number;
  volume: number;
}

export type LogRecord = TradeRecord | SnapshotRecord;

const DEFAULT_DATA_DIR = join(process.cwd(), "data");

export class TradeLogger {
  private readonly filePath: string;
  private recordCount = 0;

  constructor(symbol: string, dataDir: string = DEFAULT_DATA_DIR) {
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    this.filePath = join(dataDir, `trades_${symbol.toLowerCase()}_${date}.jsonl`);

    // Count existing records if file exists
    if (existsSync(this.filePath)) {
      const content = readFileSync(this.filePath, "utf-8").trim();
      if (content.length > 0) {
        this.recordCount = content.split("\n").length;
      }
    }
  }

  logTrade(record: TradeRecord): void {
    this.append(record);
  }

  logSnapshot(record: SnapshotRecord): void {
    this.append(record);
  }

  private append(record: LogRecord): void {
    const line = JSON.stringify(record) + "\n";
    appendFileSync(this.filePath, line);
    this.recordCount++;
  }

  getFilePath(): string {
    return this.filePath;
  }

  getRecordCount(): number {
    return this.recordCount;
  }
}

// Read all records from a trade log file
export function readTradeLog(filePath: string): LogRecord[] {
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, "utf-8").trim();
  if (content.length === 0) return [];

  return content.split("\n").map((line) => JSON.parse(line) as LogRecord);
}

// Read all trade logs from a directory, optionally filtered by symbol
export function readAllTradeLogs(
  dataDir: string = DEFAULT_DATA_DIR,
  symbol?: string,
): LogRecord[] {
  if (!existsSync(dataDir)) return [];

  const files = readdirSync(dataDir)
    .filter((f: string) => f.startsWith("trades_") && f.endsWith(".jsonl"))
    .filter((f: string) => !symbol || f.includes(symbol.toLowerCase()))
    .sort();

  const records: LogRecord[] = [];
  for (const file of files) {
    records.push(...readTradeLog(join(dataDir, file)));
  }
  return records;
}

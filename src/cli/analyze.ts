// CLI entry point for trade analysis / backtesting
//
// Usage:
//   npm run analyze -- [symbol] [options]
//
// Examples:
//   npm run analyze                     # Analyze all symbols, all dates
//   npm run analyze -- ETH              # Analyze ETH only
//   npm run analyze -- ETH --json       # Output as JSON
//   npm run analyze -- --dir ./data     # Custom data directory

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readAllTradeLogs, readTradeLog } from "../analytics/trade-logger.js";
import { analyzeTradeLog, formatReport } from "../analytics/analyzer.js";
import { autoTune, formatTuneResult } from "../analytics/auto-tune.js";
import {
  SMALL_ACCOUNT_CONFIG,
  SMALL_ACCOUNT_RISK,
} from "../bots/mm/configs.js";

function main(): void {
  const args = process.argv.slice(2);
  const symbol = args.find((a) => !a.startsWith("--"))?.toUpperCase();
  const jsonOutput = args.includes("--json");
  const dataDir = getArgValue(args, "--dir") ?? join(process.cwd(), "data");
  const accountSize = Number(getArgValue(args, "--account") ?? SMALL_ACCOUNT_RISK.accountSizeUsd);
  const file = getArgValue(args, "--file");

  if (!existsSync(dataDir) && !file) {
    console.error(`No data directory found at: ${dataDir}`);
    console.error("Run the bot first to generate trade logs, or specify --dir");
    process.exit(1);
  }

  // Load records
  let records;
  if (file) {
    if (!existsSync(file)) {
      console.error(`File not found: ${file}`);
      process.exit(1);
    }
    records = readTradeLog(file);
  } else {
    records = readAllTradeLogs(dataDir, symbol);
  }

  if (records.length === 0) {
    console.error(`No trade records found${symbol ? ` for ${symbol}` : ""}`);
    console.error(`Looking in: ${dataDir}`);

    // List available files
    if (existsSync(dataDir)) {
      const files = readdirSync(dataDir).filter((f) => f.endsWith(".jsonl"));
      if (files.length > 0) {
        console.error("\nAvailable trade logs:");
        for (const f of files) {
          console.error(`  ${f}`);
        }
      }
    }
    process.exit(1);
  }

  console.log(`Loaded ${records.length} records${symbol ? ` for ${symbol}` : ""}`);

  const report = analyzeTradeLog(
    records,
    accountSize,
    SMALL_ACCOUNT_CONFIG.spreadBps,
    SMALL_ACCOUNT_CONFIG.orderSizeUsd,
  );

  // Auto-tune: generate optimized config from performance data
  const tuneResult = autoTune(report, SMALL_ACCOUNT_CONFIG, SMALL_ACCOUNT_RISK);

  if (jsonOutput) {
    // Convert Map to object for JSON serialization
    const jsonReport = {
      ...report,
      hourlyPnl: Object.fromEntries(report.hourlyPnl),
      tuning: tuneResult,
    };
    console.log(JSON.stringify(jsonReport, null, 2));
  } else {
    console.log(formatReport(report));
    console.log(formatTuneResult(tuneResult));
  }
}

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

main();

// CLI entry point for market maker bot

import "../utils/polyfills.js";
import "dotenv/config";
import { DEFAULT_CONFIG } from "../bots/mm/config.js";
import {
	SMALL_ACCOUNT_CONFIG,
	SMALL_ACCOUNT_RISK,
	SMALL_ACCOUNT_AGGRESSIVE,
	SMALL_ACCOUNT_AGGRESSIVE_RISK,
	ENHANCED_STRATEGY,
	ENHANCED_AGGRESSIVE,
	type EnhancedStrategyConfig,
	type RiskConfig,
} from "../bots/mm/configs.js";
import { MarketMaker } from "../bots/mm/index.js";
import { log } from "../utils/logger.js";

interface Profile {
	config: typeof DEFAULT_CONFIG;
	risk?: RiskConfig;
	enhanced?: EnhancedStrategyConfig;
}

const PROFILES: Record<string, Profile> = {
	default: { config: DEFAULT_CONFIG },
	small: { config: SMALL_ACCOUNT_CONFIG, risk: SMALL_ACCOUNT_RISK },
	aggressive: { config: SMALL_ACCOUNT_AGGRESSIVE, risk: SMALL_ACCOUNT_AGGRESSIVE_RISK },
	enhanced: { config: ENHANCED_STRATEGY.base, risk: ENHANCED_STRATEGY.risk, enhanced: ENHANCED_STRATEGY },
	"enhanced-aggressive": { config: ENHANCED_AGGRESSIVE.base, risk: ENHANCED_AGGRESSIVE.risk, enhanced: ENHANCED_AGGRESSIVE },
};

function main(): void {
	const symbol = process.argv[2]?.toUpperCase();
	const profile = process.argv[3]?.toLowerCase() ?? "enhanced";

	if (!symbol) {
		console.error("Usage: npm run bot -- <symbol> [profile]");
		console.error("Example: npm run bot -- ETH enhanced");
		console.error(`Profiles: ${Object.keys(PROFILES).join(", ")}`);
		process.exit(1);
	}

	const selected = PROFILES[profile];
	if (!selected) {
		console.error(`Unknown profile: ${profile}`);
		console.error(`Available: ${Object.keys(PROFILES).join(", ")}`);
		process.exit(1);
	}

	const privateKey = process.env.PRIVATE_KEY;
	if (!privateKey) {
		console.error("Missing required environment variable: PRIVATE_KEY");
		process.exit(1);
	}

	const mode = selected.enhanced ? "ENHANCED" : "SIMPLE";
	log.info(`Profile: ${profile.toUpperCase()} | Mode: ${mode} | Risk: ${selected.risk ? "enabled" : "disabled"}`);

	const bot = new MarketMaker(
		{
			symbol,
			...selected.config,
		},
		privateKey,
		selected.risk,
		selected.enhanced,
	);

	bot.run().catch((err) => {
		log.error("Fatal error:", err);
		process.exit(1);
	});
}

main();

# Zo Market Maker Bot - Setup Guide

## What This Bot Does

This bot places buy and sell orders on [01 Exchange](https://01.xyz) (a Solana perpetual futures DEX). It earns profit from the spread between buy and sell prices. When someone trades against your order, the bot automatically places a new order on the opposite side to close the position for a small profit.

---

## Step 1: Prerequisites

### Create a Wallet & Fund It

1. Go to [01.xyz](https://01.xyz) and connect/create a Solana wallet
2. Deposit USDC into your 01 Exchange account (this is your trading capital)
3. Export your wallet's **private key** (base58 string) - you'll need it later

### Install Node.js

**Recommended: Node.js 25+** (everything works out of the box)

```bash
# macOS (with Homebrew)
brew install node

# Or download from https://nodejs.org
```

**Also works: Node.js 22+** (the bot includes a polyfill for compatibility)

Check your version:
```bash
node --version
```

---

## Step 2: Install & Configure

```bash
# Clone the repo
git clone <repo-url>
cd zo-market-maker-ts

# Install dependencies
npm install

# Create your config file
cp .env.example .env
```

Edit the `.env` file and add your private key:

```
PRIVATE_KEY=your_base58_private_key_here
```

If you see a Solana RPC error like `403 Forbidden` (`Your IP or provider is blocked from this endpoint`), set a private RPC provider:

```
RPC_URL=https://your-solana-rpc-endpoint
```

---

## Step 3: DNS Setup (Important for Some Regions)

The bot needs to connect to Binance for price data. In some countries (Nigeria, etc.), ISPs block crypto exchange domains at the DNS level.

**Test if you're affected:**
```bash
nslookup fstream.binance.com
```

If it says "connection timed out" or "NXDOMAIN", your DNS is blocked.

**Fix: Change your DNS to Cloudflare**

| OS | Steps |
|----|-------|
| **macOS** | System Settings > Wi-Fi > Details (your network) > DNS > Remove existing, add `1.1.1.1` and `1.0.0.1` |
| **Windows** | Settings > Network > Wi-Fi > Hardware properties > DNS > Manual > `1.1.1.1` and `1.0.0.1` |
| **Linux** | Edit `/etc/resolv.conf`, set `nameserver 1.1.1.1` |

After changing DNS, verify:
```bash
nslookup fstream.binance.com
# Should show IP addresses (not timeout)
```

No VPN needed once DNS is fixed.

---

## Step 4: Run the Bot

```bash
# Trade ETH
npm run bot -- eth

# Trade BTC
npm run bot -- btc

# Trade SOL
npm run bot -- sol
```

Stop the bot with `Ctrl+C` (it will cancel all open orders before exiting).

---

## Configuration

Edit `src/bots/mm/config.ts` to change settings. Here's what each one does:

### Core Settings

| Setting | What It Does | Default |
|---------|-------------|---------|
| `spreadBps` | Distance between your buy/sell orders and fair price, in basis points (1 bps = 0.01%). **Wider = safer but fewer fills. Narrower = more fills but riskier.** | `8` |
| `orderSizeUsd` | How much USD each order is worth. Determines your position size per trade. | `3` |
| `takeProfitBps` | Spread used when closing a position (close mode). Tighter than normal to close quickly. | `0.1` |
| `closeThresholdUsd` | When your position value exceeds this, the bot switches to close mode with tighter spread. | `10` |

### Timing Settings

| Setting | What It Does | Default |
|---------|-------------|---------|
| `warmupSeconds` | Seconds to collect price data before placing first orders. Ensures fair price is accurate. | `10` |
| `updateThrottleMs` | Minimum milliseconds between order updates. Lower = more responsive but more API calls. | `100` |
| `orderSyncIntervalMs` | How often to sync order state with the exchange (ms). | `3000` |
| `statusIntervalMs` | How often to print status line (ms). | `1000` |
| `fairPriceWindowMs` | Time window for calculating fair price median offset (ms). | `300000` (5 min) |
| `positionSyncIntervalMs` | How often to sync position data with the exchange (ms). | `5000` |

### How the Bot Makes Money

```
1. Bot places BID at $1950 and ASK at $1954 (8 bps spread around $1952 fair price)
2. Someone sells into your BID → you BUY at $1950
3. Bot now has a LONG position, places ASK to sell
4. Someone buys your ASK → you SELL at $1954
5. Profit: $4 on this round trip (minus fees)
```

---

## Prebuilt Configs

Edit the values in `src/bots/mm/config.ts` in the `DEFAULT_CONFIG` object.

### Micro: < $100 account (learning/testing)

```ts
export const DEFAULT_CONFIG: Omit<MarketMakerConfig, 'symbol'> = {
  spreadBps: 10,           // wider spread = safer
  takeProfitBps: 0.5,      // wider close spread
  orderSizeUsd: 3,         // tiny orders
  closeThresholdUsd: 5,    // close positions early
  warmupSeconds: 10,
  updateThrottleMs: 200,   // less aggressive updates
  orderSyncIntervalMs: 3000,
  statusIntervalMs: 1000,
  fairPriceWindowMs: 5 * 60 * 1000,
  positionSyncIntervalMs: 5000,
}
```

- Risk per trade: ~$3
- Expected daily volume: low (wide spread = fewer fills)
- Goal: learn how the bot works without risking much

### Small: < $500 account

```ts
export const DEFAULT_CONFIG: Omit<MarketMakerConfig, 'symbol'> = {
  spreadBps: 8,
  takeProfitBps: 0.2,
  orderSizeUsd: 10,
  closeThresholdUsd: 25,
  warmupSeconds: 10,
  updateThrottleMs: 100,
  orderSyncIntervalMs: 3000,
  statusIntervalMs: 1000,
  fairPriceWindowMs: 5 * 60 * 1000,
  positionSyncIntervalMs: 5000,
}
```

- Risk per trade: ~$10
- Max position before close mode: $25
- Good balance of safety and activity

### Medium: < $1,000 account

```ts
export const DEFAULT_CONFIG: Omit<MarketMakerConfig, 'symbol'> = {
  spreadBps: 6,
  takeProfitBps: 0.1,
  orderSizeUsd: 25,
  closeThresholdUsd: 75,
  warmupSeconds: 15,
  updateThrottleMs: 100,
  orderSyncIntervalMs: 3000,
  statusIntervalMs: 1000,
  fairPriceWindowMs: 5 * 60 * 1000,
  positionSyncIntervalMs: 5000,
}
```

- Risk per trade: ~$25
- Tighter spread = more fills
- Longer warmup for more accurate fair price

### Large: $10,000+ account

```ts
export const DEFAULT_CONFIG: Omit<MarketMakerConfig, 'symbol'> = {
  spreadBps: 5,
  takeProfitBps: 0.1,
  orderSizeUsd: 100,
  closeThresholdUsd: 500,
  warmupSeconds: 30,
  updateThrottleMs: 100,
  orderSyncIntervalMs: 3000,
  statusIntervalMs: 1000,
  fairPriceWindowMs: 5 * 60 * 1000,
  positionSyncIntervalMs: 5000,
}
```

- Risk per trade: ~$100
- Tight spread for maximum fill rate
- Higher close threshold allows larger positions
- Longer warmup for stability

---

## Reading the Bot Output

```
STATUS: pos=0.00150 | bid=[$1947.80x0.0015] | ask=[$1951.00x0.0015]
```
- `pos=0.00150` → You're holding 0.0015 ETH (long)
- `bid=[$1947.80x0.0015]` → Your buy order: $1947.80, size 0.0015 ETH
- `ask=[$1951.00x0.0015]` → Your sell order: $1951.00, size 0.0015 ETH

```
FILL: BUY 0.0015 @ $1949.80
```
- Someone traded against your buy order. You now have a position.

```
POS: LONG 0.001500 ($2.92)
```
- Your current position: long 0.0015 ETH worth $2.92

```
QUOTE: BID $1947.80 | ASK $1951.00 | FAIR $1949.36 | SPREAD 8bps | NORMAL
```
- The bot's calculated prices. NORMAL = regular quoting. CLOSE = closing a position.

---

## Risks

- **Market risk**: If price moves sharply against your position before the bot can close it, you lose money
- **The bot is NOT guaranteed to be profitable** - it depends on market conditions, spread, and fill rate
- **Start small**, understand the behavior, then scale up
- **Never risk money you can't afford to lose**

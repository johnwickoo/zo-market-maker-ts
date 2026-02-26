# Zo Market Maker Bot - Setup Guide

## What This Bot Does

This bot places buy and sell orders on [01 Exchange](https://01.xyz) (a Solana perpetual futures DEX). It earns profit from the spread between buy and sell prices. When someone trades against your order, the bot automatically places a new order on the opposite side to close the position for a small profit.

The enhanced strategy uses Avellaneda-Stoikov inspired market making with inventory skew, volatility-adaptive spread, momentum guard, and gradual position decay.

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

Free RPC providers: [Helius](https://helius.dev) (recommended), [QuickNode](https://quicknode.com), or the default Solana public RPC.

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
# Build first
npm run build

# Run with a market and profile
npm run bot -- <SYMBOL> <PROFILE>
```

### Available Profiles

| Profile | Best For | Order Size | Spread | Levels | Description |
|---------|----------|-----------|--------|--------|-------------|
| `default` | Testing | $3 | 8 bps | 1 | Minimal config, no risk tracking |
| `small` | Thin markets | $10 | 8 bps | 1 | Simple strategy, conservative |
| `aggressive` | Liquid markets | $15 | 6 bps | 1 | Simple strategy, tighter spread |
| `enhanced` | **Thin markets** | $10 | 8 bps adaptive | 1 | Avellaneda-Stoikov with skew + vol + momentum |
| `enhanced-aggressive` | **Liquid markets** | $15 | 6 bps adaptive | 2 | Enhanced with multi-level orders |

### Examples

```bash
# Thin markets — use enhanced (1 level, strong skew)
npm run bot -- HYPE enhanced
npm run bot -- SOL enhanced

# Liquid markets — use enhanced-aggressive (2 levels, tighter spread)
npm run bot -- ETH enhanced-aggressive
npm run bot -- BTC enhanced-aggressive
```

Stop the bot with `Ctrl+C` (it will cancel all open orders before exiting).

---

## Strategy Profiles Explained

### Enhanced (recommended for most markets)

Designed for thin orderbooks. Uses strong inventory skew to mean-revert positions.

- **$10 per order** — slow inventory accumulation, more time two-sided
- **8 bps base spread** — adaptive: widens in volatile markets, tightens in calm
- **1 level per side** — no margin waste on thin books
- **Skew factor 3.0** — aggressively shifts quotes to reduce position
- **Close mode at $40** — stops adding side entirely above this exposure
- **Risk limits** — $3 max drawdown, $2 daily loss limit per bot

### Enhanced Aggressive (for BTC/ETH)

Designed for liquid orderbooks where tighter spreads are competitive.

- **$15 per order** — moderate sizing for liquid markets
- **6 bps base spread** — tighter to compete for fills
- **2 levels per side** — captures depth on thick books
- **Skew factor 2.5** — strong mean-reversion
- **Close mode at $50** — higher threshold for liquid markets
- **Risk limits** — $4 max drawdown, $3 daily loss limit per bot

### Multi-Bot Risk Budget ($50 account, 4 bots)

All configs are designed for 4 bots sharing a single $50 account at 10x leverage ($500 buying power):

| Risk Metric | Per Bot (enhanced) | Per Bot (aggressive) | 4 Bots Combined |
|---|---|---|---|
| Max Position | $50 | $60 | $200-$240 |
| Max Drawdown | $3 | $4 | $12-$16 |
| Daily Loss Limit | $2 | $3 | $8-$12 |
| Margin Used (max pos) | $5 | $6 | $20-$24 of $50 |

---

## Per-Fill Economics

```
Enhanced (8 bps spread, $10 orders):
  Gross per fill:  $10 × 4 bps (half-spread) = $0.004
  Maker fee:       $10 × 1 bps               = $0.001
  Net per fill:    $0.003
  For $1/day:      ~333 fills across all bots (~14/hour)

Enhanced Aggressive (6 bps spread, $15 orders):
  Gross per fill:  $15 × 3 bps = $0.0045
  Maker fee:       $15 × 1 bps = $0.0015
  Net per fill:    $0.003
  For $1/day:      ~333 fills across all bots (~14/hour)
```

---

## Configuration

Config presets are in `src/bots/mm/configs.ts`. The main settings:

### Core Settings

| Setting | What It Does |
|---------|-------------|
| `spreadBps` | Distance between your buy/sell orders and fair price (1 bps = 0.01%) |
| `orderSizeUsd` | USD value of each order |
| `closeThresholdUsd` | Position value where bot stops adding and only reduces |
| `repriceThresholdBps` | Only cancel+replace orders when price drifts more than this |
| `fees.makerFeeBps` | Maker fee rate (01 Exchange Tier 1: 1 bps) |

### Enhanced Quoter Settings

| Setting | What It Does |
|---------|-------------|
| `baseSpreadBps` | Minimum spread floor |
| `maxSpreadBps` | Maximum spread ceiling |
| `volMultiplier` | How much volatility widens the spread |
| `skewFactor` | How aggressively to shift quotes toward reducing position |
| `maxPositionUsd` | Position where skew reaches maximum |
| `sizeReductionStart` | Position ratio (0-1) where adding-side size starts shrinking |
| `levels` | Number of order levels per side (1-3) |
| `momentumPenaltyBps` | Extra spread on adversely-selected side during momentum |

### Risk Settings

| Setting | What It Does |
|---------|-------------|
| `maxDrawdownUsd` | Kill switch: stop all quoting if drawdown exceeds this |
| `maxPositionUsd` | Hard cap on position size |
| `dailyLossLimitUsd` | Stop trading for the day if daily PnL drops below this |

---

## Reading the Bot Output

```
STATUS: pos=0.35000 | bid=[$28.21x0.35] | ask=[$28.25x0.35] | pnl=$0.0234 dd=$0.0000 fills=12 vol=$120.50
```
- `pos=0.35000` → Holding 0.35 HYPE (long)
- `bid/ask` → Your resting orders with prices and sizes
- `pnl=$0.0234` → Total PnL this session
- `dd=$0.0000` → Current drawdown from peak PnL
- `fills=12` → Number of fills this session
- `vol=$120.50` → Total volume traded

```
FILL: BUY 0.35 @ $28.21
PNL: realized=$0.0012 | total=$0.0234 | dd=$0.0000
```
- A fill occurred. PnL tracker shows realized profit from this fill.

```
POS: LONG 0.350000 ($9.87) [CLOSE MODE]
```
- Position is above close threshold — only quoting the reducing side.

```
ENHANCED: inv=65% vol=0.8bps mom=-0.1bps skew=1.6bps
```
- `inv=65%` → Position is 65% of max
- `vol=0.8bps` → Current 1-min realized volatility
- `mom=-0.1bps` → Slight downward momentum
- `skew=1.6bps` → Mid price shifted 1.6 bps to reduce position

```
RISK HALT: Max drawdown breached: $3.12 >= $3.00
```
- Risk limit hit — bot cancels all orders and stops quoting.

---

## VPS Deployment

For 24/7 operation, deploy to a VPS (1 CPU / 1 GB RAM is enough for 4 bots).

### Setup

```bash
# Install Node.js 25 on Ubuntu
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 25
nvm use 25

# Install system dependency (needed on some Ubuntu versions)
apt install -y libatomic1

# Install pm2 (process manager)
npm install -g pm2
```

### First Deploy (from your Mac)

```bash
# Copy repo to VPS (excludes node_modules — will install fresh on server)
rsync -av --exclude node_modules --exclude .env ~/zo-market-maker-ts/ root@YOUR_VPS_IP:~/zo-market-maker-ts/

# SSH in and set up
ssh root@YOUR_VPS_IP
cd ~/zo-market-maker-ts
nano .env          # Add your PRIVATE_KEY and RPC_URL
npm install
npm run build
```

### Start Bots with pm2

```bash
# Thin markets
pm2 start npm --name "mm-hype" -- run bot -- HYPE enhanced
pm2 start npm --name "mm-sol"  -- run bot -- SOL enhanced

# Liquid markets
pm2 start npm --name "mm-eth"  -- run bot -- ETH enhanced-aggressive
pm2 start npm --name "mm-btc"  -- run bot -- BTC enhanced-aggressive

# Auto-restart on server reboot
pm2 startup
pm2 save
```

### pm2 Commands

```bash
pm2 status            # See all bots
pm2 logs              # Tail all logs
pm2 logs mm-hype      # Tail specific bot
pm2 stop mm-hype      # Stop a bot (keeps in list)
pm2 restart mm-hype   # Restart a bot
pm2 delete mm-hype    # Remove from pm2 entirely
pm2 restart all       # Restart all bots
pm2 stop all          # Stop all bots
```

### Deploy Updates (from your Mac)

```bash
# Sync code changes to VPS
rsync -av --exclude node_modules --exclude .env ~/zo-market-maker-ts/ root@YOUR_VPS_IP:~/zo-market-maker-ts/

# Build and restart on VPS
ssh root@YOUR_VPS_IP "cd ~/zo-market-maker-ts && npm run build && pm2 restart all"
```

Or add a shortcut to your `~/.zshrc`:
```bash
alias deploy-mm='rsync -av --exclude node_modules --exclude .env ~/zo-market-maker-ts/ root@YOUR_VPS_IP:~/zo-market-maker-ts/ && ssh root@YOUR_VPS_IP "cd ~/zo-market-maker-ts && npm run build && pm2 restart all"'
```

Then just run `deploy-mm` after making changes.

---

## Risks

- **Market risk**: If price moves sharply against your position before the bot can close it, you lose money
- **Inventory risk**: One-sided fills accumulate directional exposure — the #1 risk for small accounts
- **The bot is NOT guaranteed to be profitable** — it depends on market conditions, spread, and fill rate
- **Start small**, understand the behavior, then scale up
- **Never risk money you can't afford to lose**
- **Risk limits** (drawdown, daily loss) are your safety net — don't disable them

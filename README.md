# Meteora LP-Farm Bot — an AI co-pilot, not an autopilot

[![CI](https://github.com/Sofiia7/meteora_new_bot/actions/workflows/ci.yml/badge.svg)](https://github.com/Sofiia7/meteora_new_bot/actions/workflows/ci.yml)

> A semi-automatic assistant for **LP farming on Meteora DLMM memecoin pools** (Solana).
> The bot takes the grind and execution off your hands — it scans, screens for scams,
> tracks fees, manages the position — but **the decision to enter and the moment to exit
> stay with you**. A co-pilot that pairs machine routine with human judgment (and an
> optional AI second opinion).

## 💡 Killer feature

Not "yet another trading bot with an auto stop-loss". Two things set it apart:

1. **Human-in-the-loop by design.** The bot never enters or picks a pool on its own — it
   sends **all of a token's Meteora pools** to Telegram (with links to GMGN / Axiom /
   BubbleMaps / RugCheck / DexScreener / Solscan / Photon and a Meteora link per pool), and
   you press a button. The operator fully drives the process.
2. **A composite "panic detector" instead of a dumb stop-loss.** An auto-exit fires **not**
   on a single threshold (that produces false exits on memecoin volatility), but only when
   several independent negative factors line up at once — a **full picture of a rug**: volume
   crash + RSI + drawdown from ATH + security degradation (delayed rug) + pool TVL drain.

## 😖 The pain it solves

You can earn on LP fees in Meteora memecoin pools, but doing it by hand is hell: finding
fresh pools, screening tokens for scams across five services, catching the exit. And a full
autopilot is scary to leave unattended — it doesn't see the FUD on Twitter and dumps into a
rug the indicators miss. The bot takes the routine and execution; the human keeps the
judgment and a finger on the exit.

## 🔄 Workflow

```
Scanner (DexScreener, every 5 min)
   → Chart-health score (ATH distance, volume, liquidity, dump)
   → Security score 0–100 (GMGN + RugCheck + BubbleMaps, fail-closed)
   → [optional] AI analyst (a local LLM gives a plain-language verdict)
   → 📲 Telegram alert with metrics and LINKS
        → you press [✅ Enter pool X] / [⏳ Wait] / [❌ Skip]
   → LP Manager opens the position (Meteora DLMM, single-sided SOL)
   → Exit Strategy + Panic Detector manage the position
   → exit: 🔴 manual button at any time
           OR auto take-profit (fee target / new ATH / Bollinger)
           OR 🚨 composite panic (≥N factors at once)
```

## 🏗 Architecture

Isolated services, each with one job; they talk via callbacks; state lives in SQLite.

```
            ┌─────────────┐   new tokens      ┌──────────────────┐
            │  Scanner    │ ───────────────▶  │  Chart-Health    │
            │ DexScreener │                   │  (score 0–100)   │
            └─────────────┘                   └────────┬─────────┘
                                                       │ passed
                                              ┌────────▼─────────┐
                                              │  Security        │  GMGN
                                              │  score+fail-closed│─ RugCheck
                                              │  (+ AI analyst)  │  BubbleMaps
                                              └────────┬─────────┘
                                                       │ alert
   ┌──────────────┐   all Meteora pools      ┌─────────▼─────────┐
   │ Pool Watcher │ ◀────────────────────────│   Telegram Bot    │◀── you (buttons)
   │ DexScreener  │ ─── human's choice ──────▶│  allowlist + HTML │
   └──────┬───────┘                          └─────────┬─────────┘
          │ enter                                      │
   ┌──────▼───────┐   monitoring        ┌──────────────▼──────────────┐
   │  LP Manager  │ ◀───────────────────│ Exit Strategy + Panic Detector│
   │ Meteora DLMM │ ─── close ──────────▶│ take-profits / composite panic│
   └──────────────┘                     └───────────────────────────────┘

   Cross-cutting: HttpQueue (per-source throttle + backoff) · SQLite (positions, watched,
   price_history, token_ath) · ATH watcher (re-notify on a new high +X%) · restart recovery.
```

## ✨ Features

- **Entry by button only** — you see metrics and links before deciding; the bot never enters
  on its own.
- **All Meteora pools for a token** (DLMM + DAMM V2), each labeled by type, with TVL and a
  Meteora link; enter any of them. ⭐ marks the pool matching your strategy when the fee tier
  is known.
- **Security engine 0–100**: score-based decision (not "no warnings = fine"), **fail-closed**
  (an unreachable source penalizes rather than passes), explicit honeypot / mint / freeze
  authority checks; Twitter is a soft minus.
- **Composite panic detector**: auto-exit only when ≥N factors line up at once in a window.
- **Auto take-profits**: fee target, new ATH, Bollinger breakout.
- **Chart degradation** (RSI + volume) → a warning with a button, **no** auto-exit.
- **Manual exit** 🔴 right on the position message — the operator's main panic tool.
- **Re-notification on a new ATH** (+X% over the last notification, anti-spam, full re-run).
- **Watchlist**: `/watchlist`, manual add/remove; if no pool in 2 h → timeout + keep-watching.
- **Restart recovery**: positions and watches survive a restart.
- **Clickable resource links** in every notification.

## 🤖 AI layer (optional, local LLM)

`AI_ENABLED=true` connects a **local** LLM (OpenAI-compatible endpoint — Ollama / LM Studio /
vLLM) as a "second opinion": it receives the token metrics + security results and returns a
short plain-language verdict and a risk level (🟢/🟡/🔴) right in the alert. No cloud calls —
everything runs on your side. Disabled by default: the bot works fully without an LLM.

## 🛡 Safety gate

- `DRY_RUN=true` (default) — the bot does everything except real transactions. Safe to watch
  it scan and send alerts.
- **Real trading** requires **both** flags: `DRY_RUN=false` AND `ENABLE_MAINNET_TRADING=true`.
- **Telegram allowlist** — only a chat_id in `TELEGRAM_ALLOWED_CHAT_IDS` can control the bot
  (spend the wallet); everything else is cut by middleware before the handler.
- Private-key validation at startup (base58, 64 bytes) and a balance check before entry.

## 💬 Telegram commands

`/start` · `/status` — status · `/positions` — positions with a close button ·
`/watchlist` — watched tokens (+ remove) · `/watch <CA>` — add to watch ·
`/scan <CA>` — check a token manually

## 🚀 Run it in 2 minutes (DRY_RUN, no risk)

```bash
cd meteora-bot
npm install
cp .env.example .env
#  fill 3 fields: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, RPC_URL
#  (SOLANA_PRIVATE_KEY must be valid base58, but in DRY_RUN no money is spent)
npm run dev
```

The bot starts in `DRY_RUN`, prints a banner with the mode and wallet, and starts sending
alerts for new tokens to your Telegram. No transactions — you can watch the whole flow safely.

> Note: use **Node 20** (LTS). better-sqlite3 ships prebuilt binaries for it; on newer Node
> (24) you may need `npm rebuild better-sqlite3`. CI runs on Node 20.

## ⚙️ Enable mainnet

No devnet: Meteora memecoin pools don't exist on devnet, so there's nothing to test there.
Live mode is just two flags in `.env`:

```bash
DRY_RUN=false
ENABLE_MAINNET_TRADING=true
```

The bot has already run on mainnet with real money. Start with a small `LP_AMOUNT_SOL`.

## ✅ Code quality

```bash
npm run typecheck   # tsc --noEmit — 0 errors
npm run lint        # eslint (flat config, ESLint 9) — 0 warnings
npm test            # vitest — unit tests for the logic (security scoring, links, signals, mapper)
```

## 📌 Honest status

- ✅ Working: scanner, chart-health, pool watcher, LP open/close, exit strategies, composite
  panic, Telegram UX, recovery, watchlist, links. Has run on mainnet.
- ⚠️ External-API notes (verified live from the VPS): **Meteora's `dlmm-api` returns 404** on
  every endpoint, so pool discovery runs through **DexScreener** (it doesn't expose the fee
  tier / bin step, so pools show as "DLMM / DAMM V2" without the tier). **GMGN returns 403**
  (Cloudflare blocks the VPS IP) — its unavailability no longer penalizes a token. RugCheck +
  BubbleMaps parsing is verified against live responses.
- 🔜 Roadmap (see [PLAN.md](PLAN.md)): GeckoTerminal for socials + real OHLCV (true ATH/RSI),
  fee-tier enrichment via the on-chain DLMM SDK, broader tests, CI.

## 🧰 Stack

TypeScript · `@meteora-ag/dlmm` · `@solana/web3.js` · Anchor · better-sqlite3 · Telegraf ·
technicalindicators · axios · vitest · ESLint 9

## ⚠️ Disclaimer

- **Never commit `.env` or `SOLANA_PRIVATE_KEY`** to a public repository.
- Keep only the budget you can afford to lose on the trading wallet.
- This is not financial advice. Memecoins are extremely volatile and are often scams.

## 👤 About

A vibecoding project: the code was written with an AI assistant (Claude Code). **The personal
contribution** is the product strategy and risk architecture: human-in-the-loop instead of an
autopilot, dropping the hard stop-loss in favor of a composite detector, the "the bot
proposes — the human decides" philosophy, the thresholds and risk framing. **The AI**
generated the implementation from those decisions. Submitted to the LIFECHANGE vibecoding
contest.

> Sister project — [meteora_early_mem](https://github.com/Sofiia7/meteora_early_mem):
> a fast early-pool sniper. This bot is the calm, filtered farm.

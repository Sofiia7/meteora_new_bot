# Meteora LP Bot — Implementation Plan

> Source: spec (`TZ`) + code audit + product decisions (from 2026-06-06).
> We return to this document between phases. Each phase ends with a commit.

---

## Final product decisions

1. **Panic-exit = a composite signal, not a single threshold.**
   An auto-close fires only when a "full picture of a rug" forms — several negative factors at
   once (volume crashed + chart degrading + soft-rug signals from socials / security re-check + etc.).
   There is no hard price stop-loss.
2. **Manual "🔴 Exit now" button** — the human's main panic tool. Must be right on the
   position-opened message, not via `/positions`.
3. **Chart degradation** (RSI < 40 + volume drop) — only a **warning** with an exit button, no
   auto-close. (Otherwise it duplicates the composite panic.)
4. **Re-notification on a new ATH:** notify only when the new high exceeds `last_notified_ath`
   by `ATH_RENOTIFY_PCT` (default +10%). Anti-spam.
5. **On re-notification, re-run the full pipeline** (chart-health + security again). Catches a
   delayed rug. Requires the queue + backoff (Phase 3).

---

## Exit matrix

| Trigger | Action | Where it lives |
|---|---|---|
| Bollinger breakout (15m) | auto-close | exit-strategy |
| New ATH (> threshold over previous) | auto-close | exit-strategy |
| Fees ≥ 5% of position (unclaimed, SOL-equivalent) | auto-close | exit-strategy |
| Composite "things went south" (N of M factors) | auto-close | panic-detector |
| Chart degradation (RSI+volume) alone | ⚠️ warning + button | bot |
| "I want to exit now" | 🔴 manual button on the position message | bot |
| Hard price auto stop-loss | ❌ removed | — |

### Composite "full picture of a rug" (Phase 1, expanded in Phase 4)
Auto-exit when ≥ `PANIC_REQUIRED_FACTORS` factors are active at once in a `PANIC_TIME_WINDOW_MIN` window:
- F1: 24h volume dropped > `PANIC_VOLUME_DROP_PCT` from the 4h average;
- F2: RSI(15m) < `PANIC_RSI_THRESHOLD`;
- F3: price dropped > `PANIC_PRICE_DROP_FROM_ATH_PCT` from the in-position ATH;
- F4 *(Phase 4)*: security re-check worsened (RugCheck downgrade / mint-freeze authority returned);
- F5 *(Phase 4)*: pool TVL dropped > `PANIC_TVL_DROP_PCT` over the window (liquidity being pulled).

Default: `PANIC_REQUIRED_FACTORS=2`, 15-minute window. Parameters live in `.env`.

---

## Re-notification on a new ATH

- The `token_ath` table tracks: `ath`, `ath_at`, `last_notified_ath`, `last_notified_at`.
- A separate watcher of known tokens polls the price from DexScreener (via the queue).
- When `current_price > last_notified_ath * (1 + ATH_RENOTIFY_PCT)`:
  - check there is **no** `positions(status IN ('watching','active'))` for the address;
  - the `ATH_RENOTIFY_COOLDOWN_MIN` cooldown has elapsed;
  - **full re-run**: chart-health + security again;
  - if OK — a notification with the CA, the same button set as on first discovery;
  - update `last_notified_ath`.

Defaults: `ATH_RENOTIFY_PCT=10`, `ATH_RENOTIFY_COOLDOWN_MIN=30`.

---

## Phases

> **On mainnet:** there is no technical block — the bot has already run on mainnet with real
> money. "Safe" mode is just the flags `DRY_RUN=true` + `ENABLE_MAINNET_TRADING=false`
> (the Phase 0 safety gate). Live mode is enabled by flipping both flags. **Devnet is N/A:**
> Meteora memecoin pools don't exist on devnet, so there's nothing to test there; the real
> test is mainnet with a minimal amount. Recommendation: before live mode, close Phases 0–2
> (money correctness) and verify the security-API parsing (Phase 4) against live responses.

### Phase 0 — Safety gate ⚙️ ✅
- [x] `DRY_RUN=true` by default; real transactions only with `ENABLE_MAINNET_TRADING=true`.
- [x] **Telegram allowlist** `TELEGRAM_ALLOWED_CHAT_IDS` — middleware on all commands and callbacks.
- [x] `.env.example` with all keys; name sync (`SOLANA_PRIVATE_KEY`, `RPC_WS_URL`, etc.).
- [x] Private-key validation at startup (base58 format + length), explicit address log.
- [x] Balance check: `LP_AMOUNT_SOL + rent(~0.07) + buffer`. Refuse entry on shortfall.
- [x] `.gitignore`: track `package-lock.json` and `.env.example`.
- [x] Startup banner with mode (DRY_RUN / MAINNET), wallet address, DLMM version.

### Phase 1 — Money correctness and exits 💰 (test on mainnet with a minimal amount)
- [x] **Repository layer** with a snake↔camel mapper; remove all `SELECT *` from business code.
- [x] Fix `closePosition`: `poolAddress`/`positionPubkey`/`tokenAddress` come through the mapper.
- [ ] SOL side detection: `dlmmPool.tokenX.publicKey.equals(WSOL)` → build `totalXAmount`/`totalYAmount`
  accordingly; for **single-sided SOL** the range is strictly below the active bin.
- [ ] **PnL from wallet-balance delta**: `getBalance` before open and after the full exit flow.
- [ ] Don't swap if the on-chain position isn't found (current code swaps anyway).
- [ ] `getFeesRatio`: convert `feeX` to SOL at the current pool price, add `feeY` (SOL); divide
  by `position.solAmount`. This is **unclaimed**.
- [x] **Remove `stopLossPercent`** from exit-strategy (hidden behind `ENABLE_PRICE_STOP_LOSS=false`).
- [x] `chart_degradation` → only `notifyDegradation()` with a button, no auto-exit.
- [x] **Composite panic-detector** (Phase 1 version: F1+F2+F3): a new `services/panic-detector`,
  ticks every 30s, increments factor counters in a window, fires `exit` on the same bus as take-profit.
- [x] **Manual "🔴 Exit now" button** right on `notifyPositionOpened`. Idempotent on double click.
- [x] `status='closing'` before exit ops, clear price history only on success.
- [ ] Priority fees + `simulateTransaction` before send + retry with backoff in `sendTransaction`.

### Phase 2 — State & recovery 💾 ✅
- [x] On `main.ts` startup:
  - `positions(active)` → restore exit-strategy and panic-detector monitoring;
  - `watched_tokens(watching)` → restart `poolWatcher.watch`.
- [x] Scanner `seenTokens` → SQLite (`tokens` table with a `discovered_at` index).
- [x] exit-strategy `priceHistory` → `price_history(position_id, ts, price)` with retention.
- [x] ATH tracker → `token_ath(address, ath, ath_at, last_notified_ath, last_notified_at)`.
- [x] Idempotent exit: `active → closing → closed`; a repeat `closePosition` returns early.

### Phase 3 — Scanner + chart-health + ATH re-notify 📊 ✅
- [x] **Request queue**: 200ms throttle on DexScreener/GMGN/RugCheck/BubbleMaps.
- [x] Exponential backoff on 429/5xx; on retry exhaustion — skip the iteration, `warn` log.
- [ ] OHLCV provider (DexScreener candles or alternative) for 15m candles. → moved to GeckoTerminal (Phase 7).
- [x] Real **ATH tracker**: rolling max over the observed history + compare with `last_notified_ath`.
- [x] **Chart-health score 0–100**: ATH distance, volume score, liquidity, dump detection.
- [x] **Re-notification on a new ATH** — see the "Re-notification" section above.
- [x] Pool watcher: filter by pool type. → reworked in Phase 5.1 / pool source switched to DexScreener.
- [x] Handle `fetchTokenInfo === null` in `notifyPoolFound` (the pool was silently lost before).

### Phase 4 — Security engine 🔐 ✅
- [x] **Verified against live responses** (GMGN/RugCheck/BubbleMaps) on real tokens from the VPS.
  Findings: GMGN is 403 (Cloudflare blocks the VPS) → its unavailability no longer penalizes a
  token; RugCheck `score_normalised` is a RISK score (lower = safer) — was inverted; BubbleMaps
  `/map-metadata` returns `decentralisation_score`, not a `nodes[]` array.
- [x] RugCheck: explicit `honeypot / mint authority / freeze authority` checks (scan `risks[]` by
  name + `level==='danger'`).
- [x] BubbleMaps: **fail-closed** on error/empty data (unavailable ⇒ penalty, not "perfect").
- [x] **Score-based decision** (0–100) instead of `warnings.length===0`: `passed = !hardFail &&
  score>=MIN_SECURITY_SCORE`. Hard-fail (honeypot/authority) overrides the score. Twitter is a soft minus.
- [x] **Periodic security re-check** for active positions → **F4 `security_degraded`** and
  **F5 `tvl_drop`** in the panic-detector. Throttled by `SECURITY_RECHECK_MIN` (default 5m).
- New: `SecurityResult` extended (`score/hardFail/mint/freeze/honeypot/sourcesUnavailable`); score
  and flags shown in the token notification.

> Phase 4 `.env` params: `MIN_SECURITY_SCORE=60`, `MAX_HOLDER_CONCENTRATION_PCT=50`, `SECURITY_RECHECK_MIN=5`.

### Phase 4.1 — AI analyst (local LLM) 🤖 ✅
- [x] `ai-analyst` service: runs token metrics + security through a **local** LLM (OpenAI-compatible
  endpoint — Ollama/LM Studio/vLLM), a plain-language verdict + risk 🟢/🟡/🔴 right in the alert.
  Doesn't block the decision — a "second opinion" for human-in-the-loop.
- [x] `AI_ENABLED=false` by default (the bot works without an LLM); no cloud calls.
- [x] Tolerant response parser (extracts JSON from text, falls back to raw text).
- Params: `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`, `AI_TEMPERATURE`, `AI_MAX_TOKENS`, `AI_TIMEOUT_MS`.

### Phase 5 — Telegram per spec 💬
- [x] **CA in all messages / `editMessageText`** (enter_pool, wait_pool, skip_pool, etc.).
- [x] Wire the `force_enter` button into the UI (the security-failed message now has a real button).
- [ ] `/stop` — stops the scanner (per spec).
- [ ] Full exit notification format: entered/exited/fees/time-in-position/% PnL.
- [x] ~~Single MarkdownV2~~ → switched to a single `parse_mode:'HTML'` (more robust for links and
  escaping; `escMd`→`escHtml`/`escAttr`). Removed broken manual `\_`/`\.` escapes from V1.

### Phase 5.1 — Links + manual pool selection + watchlist 🔗 ✅ (decisions 2026-06-23)

**Product decisions:**
1. **Resource links everywhere, inline in the text** (not buttons): GMGN, Axiom, BubbleMaps,
   RugCheck, DexScreener, Solscan, Photon per token; a Meteora link per pool/position.
2. **Pools: show ALL of a token's Meteora pools, no strategy filtering.** Each pool gets an enter
   button, plus "⏳ Wait" / "❌ Don't enter". ⭐ marks the strategy-matching pool — a marker only,
   the human chooses. "Don't make anything up; the user fully controls the process."
3. **No pools at all → monitoring:** 2h active watch + a keep-watching button on timeout + a full
   **watchlist** with manual add/remove.
4. **Exits untouched** — the whole exit matrix stays as is.

**Implemented:**
- [x] `shared/links.ts` — links built from `config.links` templates (overridable via `.env`).
- [x] `config.links.*` templates + `POOL_BUTTONS_MAX` (pool button cap, default 8).
- [x] Links in every notification.
- [x] Pool-watcher: show all pools; dedup by `notifiedPoolAddrs` (re-notify only on new pools);
  the watch isn't stopped — the user decides.
- [x] `notifyPoolFound`: list of all pools, a Meteora link per pool, enter button by index.
- [x] Watchlist: `/watchlist` (list + 🗑 remove), `/watch <CA>` (add).
- [x] `DegradationWarning.tokenAddress` — passed through for links in the warning.

### Phase 6 — Tests + CI 🧪 ✅
- [x] Test runner (vitest) + `npm test`; unit tests for pure logic: **security scoring**, **link
  building**, **scanner filters**, **BB/RSI/ATH signals**, **snake↔camel mapper** (in-memory SQLite).
- [x] ESLint 9 flat config (`eslint.config.js`) — `npm run lint` green, 0 warnings.
- [x] GitHub Actions: `tsc --noEmit`, `eslint`, `vitest` on push/PR.
- [ ] Integration: Telegram callbacks via `bot.handleUpdate`, DB, mocked Meteora/Jupiter.
- [ ] Limited mainnet smoke with a minimal amount (devnet N/A — no memecoin pools).

### Phase 7 — GeckoTerminal + external-API resilience 🦎 ✅
- External-API status (verified live): **Meteora `dlmm-api` is 404** → pool discovery via
  **DexScreener** (`token-pairs`, all Meteora pool types: DLMM + DAMM V2). **GMGN is 403** on the VPS.
- [x] **GeckoTerminal** (free, no key) replaces the dead GMGN in security: `twitter_handle` /
  `websites` → `twitterActive`, and `gt_score` (0–100 trust) as a factor. Verified against live `/info`.
- [x] **GeckoTerminal OHLCV** (15m candles): chart-health now computes a real ATH (max high +
  rolling `token_ath`) and a real 15m RSI(14); the alert shows "From ATH -X% · RSI(15m) Y".
- [x] "No pools yet" notification + all Meteora pool types (DLMM + DAMM V2) surfaced.
- [ ] fee-tier / bin-step enrichment via the on-chain DLMM SDK (DexScreener doesn't expose them).

---

## Out of scope (explicitly)
- Hard price stop-loss (product decision).
- Auto-close on a single `chart_degradation` (it's a warning).
- Buying the memecoin with a separate swap before LP (single-sided SOL covers it).
- Non-Solana chains.

---

## Default parameters (`.env`)

```
# Safety
DRY_RUN=true
ENABLE_MAINNET_TRADING=false
TELEGRAM_ALLOWED_CHAT_IDS=         # comma-separated; empty = TELEGRAM_CHAT_ID only

# Composite panic
PANIC_REQUIRED_FACTORS=2
PANIC_TIME_WINDOW_MIN=15
PANIC_VOLUME_DROP_PCT=60
PANIC_RSI_THRESHOLD=40
PANIC_PRICE_DROP_FROM_ATH_PCT=50
PANIC_TVL_DROP_PCT=50

# ATH re-notify
ATH_RENOTIFY_PCT=10
ATH_RENOTIFY_COOLDOWN_MIN=30

# Chart health
MIN_HEALTH_SCORE=65
MAX_ATH_DISTANCE_PCT=30
```

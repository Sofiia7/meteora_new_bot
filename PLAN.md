# Meteora LP Bot — План реализации

> Источник: ТЗ (`TZ`) + аудит кода + решения заказчика от 2026-06-06.
> К этому документу возвращаемся между фазами. Каждая фаза заканчивается коммитом.

---

## Финальные дизайн-решения заказчика

1. **Panic-exit = композитный сигнал, не одиночный порог.**
   Авто-закрытие срабатывает только когда складывается «полная картина пиздеца» — несколько негативных факторов одновременно (объёмы упали + график деградирует + soft-rug сигналы из соцсетей/security re-check + т.п.).
   Жёсткого ценового стоп-лосса нет.
2. **Ручная кнопка «🔴 Выйти сейчас»** — главный инструмент паники для человека. Должна быть прямо на сообщении об открытии позиции, не через `/positions`.
3. **Деградация графика** (RSI<40 + просадка объёма) — только **предупреждение** с кнопкой выхода, без авто-закрытия. (Иначе дублируется с composite panic.)
4. **Re-notification по новому ATH:** уведомлять, только когда новый хай превышает `last_notified_ath` на `ATH_RENOTIFY_PCT` (по умолчанию +10%). Анти-спам.
5. **При повторном ATH-уведомлении — полный перепрогон пайплайна** (chart-health + security заново). Ловит отложенный руг. Требует очередь+backoff (Фаза 3).

---

## Матрица выходов

| Триггер | Действие | Где живёт |
|---|---|---|
| BB-пробой (15м) | авто-закрытие | exit-strategy |
| Новый ATH (>порог над предыдущим) | авто-закрытие | exit-strategy |
| Fees ≥ 5% от позиции (unclaimed, в SOL-эквиваленте) | авто-закрытие | exit-strategy |
| Композит «всё пошло по пизде» (N из M факторов) | авто-закрытие | panic-detector |
| Деградация графика (RSI+volume) одна | ⚠️ предупреждение + кнопка | bot |
| «Хочу выйти сейчас» | 🔴 ручная кнопка на сообщении позиции | bot |
| Жёсткий авто-SL по цене | ❌ убран | — |

### Композит «полная картина пиздеца» (Фаза 1, расширяется в Фазе 4)
Авто-выход при ≥ `PANIC_REQUIRED_FACTORS` факторов одновременно в окне `PANIC_TIME_WINDOW_MIN`:
- F1: объём 24h упал > `PANIC_VOLUME_DROP_PCT` от 4ч-среднего;
- F2: RSI(15м) < `PANIC_RSI_THRESHOLD`;
- F3: цена упала > `PANIC_PRICE_DROP_FROM_ATH_PCT` от ATH-в-позиции;
- F4 *(Фаза 4)*: security re-check ухудшился (RugCheck downgrade / mint-freeze authority вернулась);
- F5 *(Фаза 4)*: Twitter-аккаунт удалён / неактивен впервые за период позиции;
- F6 *(опц.)*: TVL пула упал > `PANIC_TVL_DROP_PCT` за окно (вытаскивают ликвидность).

Дефолт: `PANIC_REQUIRED_FACTORS=2`, окно 15 минут. Параметры — в `.env`.

---

## Re-notification по новому ATH

- Таблица `tokens` получает поля: `last_seen_ath`, `last_notified_ath`, `last_notified_at`.
- Отдельный watcher известных токенов опрашивает цену с DexScreener (через очередь).
- При `current_price > last_notified_ath * (1 + ATH_RENOTIFY_PCT)`:
  - проверить, что **нет** `positions(status IN ('watching','active'))` для адреса;
  - выдержан кулдаун `ATH_RENOTIFY_COOLDOWN_MIN`;
  - **полный перепрогон**: chart-health + security заново;
  - если ок — уведомление с CA, тем же набором кнопок, что и при первом обнаружении;
  - обновить `last_notified_ath`.

Параметры по умолчанию: `ATH_RENOTIFY_PCT=10`, `ATH_RENOTIFY_COOLDOWN_MIN=30`.

---

## Фазы

> **Про мейннет:** технического блока нет — бот уже работал на мейннете с реальными
> деньгами. «Безопасный» режим — это просто флаги `DRY_RUN=true` + `ENABLE_MAINNET_TRADING=false`
> (safety-gate Фазы 0). Боевой режим включается флипом обоих флагов. **Devnet неприменим:**
> мемкоин-пулов Meteora на devnet нет, тестировать там нечего; реальная проверка — мейннет
> на минимальной сумме. Рекомендация: до боевого режима закрыть Фазы 0–2 (корректность денег)
> и сверить парсинг security-API (Фаза 4) с живыми ответами.

### Фаза 0 — Safety gate ⚙️ (1–2 дня)
- [ ] `DRY_RUN=true` по умолчанию; реальные транзакции только при `ENABLE_MAINNET_TRADING=true`.
- [ ] **Telegram allowlist** `TELEGRAM_ALLOWED_CHAT_IDS` — middleware на все команды и callback'и.
- [ ] `.env.example` со всеми ключами; синхронизация имён (`SOLANA_PRIVATE_KEY`, `RPC_WS_URL`, `TWITTER_BEARER_TOKEN`, `HELIUS_API_KEY`).
- [ ] Валидация приватника на старте (формат base58 + длина), явный лог адреса.
- [ ] Проверка баланса: `LP_AMOUNT_SOL + rent(~0.07) + 15% buffer`. Отказ от входа при нехватке.
- [ ] `.gitignore`: добавить `!package-lock.json`, `!meteora-bot/package-lock.json`, `!meteora-bot/.env.example`.
- [ ] Баннер при старте с режимом (DRY_RUN / MAINNET), адресом кошелька, версией DLMM.

### Фаза 1 — Корректность денег и выходы 💰 (3–5 дней; тест — мейннет на минималке)
- [ ] **Repository-слой** с маппером snake↔camel: `findActivePositions`, `findPositionById`, `updatePositionStatus` и т.п. Убрать все `SELECT *` из бизнес-кода.
- [ ] Фикс `closePosition`: `poolAddress`/`positionPubkey`/`tokenAddress` берутся через маппер.
- [ ] Определение стороны SOL: `dlmmPool.tokenX.publicKey.equals(WSOL)` → строим `totalXAmount`/`totalYAmount` соответствующе; для **single-sided SOL** диапазон строго ниже активного бина.
- [ ] **PnL по дельте баланса кошелька**: `getBalance` до открытия и после полного exit-flow; tx-fees учитываются автоматически.
- [ ] Не свопить, если on-chain позиция не найдена (сейчас код всё равно идёт в swap).
- [ ] `getFeesRatio`: `feeX` конвертировать в SOL по текущей цене пула, сложить с `feeY` (SOL); делить на `position.solAmount`. Это **unclaimed**.
- [ ] **Убрать `stopLossPercent`** из exit-strategy (или спрятать за `ENABLE_PRICE_STOP_LOSS=false`).
- [ ] `chart_degradation` → только `notifyDegradation()` с кнопкой, без авто-выхода.
- [ ] **Composite panic-detector** (Фаза 1 версия: F1+F2+F3): новый модуль `services/panic-detector`, тикает раз в 30с, инкремент счётчиков факторов в окне, при достижении порога — `exit` через ту же шину, что и тейк-профит.
- [ ] **Ручная кнопка «🔴 Выйти сейчас»** прямо на `notifyPositionOpened` (callback `manual_exit:<positionId>`). Идемпотентно: при двойном клике — `answerCbQuery('Уже закрывается')`.
- [ ] `status='closing'` перед exit-операциями, чистка price history только после успеха.
- [ ] Priority fees + `simulateTransaction` перед отправкой + retry с backoff в `sendTransaction`.

### Фаза 2 — State & recovery 💾 (2–3 дня)
- [ ] При старте `main.ts`:
  - `positions(active)` → восстановить мониторинг exit-strategy и panic-detector;
  - `watched_tokens(watching)` → перезапустить `poolWatcher.watch`.
- [ ] `seenTokens` Scanner → SQLite (таблица `tokens` уже есть, нужен индекс по `discovered_at`).
- [ ] `priceHistory` exit-strategy → таблица `price_history(position_id, ts, price)` с retention.
- [ ] ATH-трекер → отдельная таблица `token_ath(address, ath, ath_at, last_notified_ath, last_notified_at)`.
- [ ] Идемпотентный exit: `status` workflow `active → closing → closed`, повторный `closePosition` коротко возвращается.

### Фаза 3 — Scanner + chart-health + ATH re-notify 📊 (3–4 дня)
- [ ] **Очередь запросов** (`p-queue` или своя): 200ms throttle на DexScreener/GMGN/RugCheck/BubbleMaps.
- [ ] Exponential backoff на 429/5xx; при исчерпании retry — пропуск итерации, лог `warn`.
- [ ] OHLCV-провайдер (DexScreener `pairs/.../candles` или альтернатива) для 15м-свечей.
- [ ] Реальный **ATH-трекер**: rolling-max за всю историю + сравнение с `last_notified_ath`.
- [ ] **Chart-health score 0–100** (`MIN_SCORE=65`, `MAX_ATH_DISTANCE=30`): ATH-distance, volume-score, RSI 15м, dump-detection.
- [ ] **Re-notification по новому ATH** — см. раздел «Re-notification» выше.
- [ ] Pool-watcher: фильтр по `binStep ∈ {80,100,125}` + проверка `pool_type === 'DLMM'`.
- [ ] Обработка `fetchTokenInfo === null` в `notifyPoolFound` (сейчас пул теряется молча).

### Фаза 4 — Security engine 🔐 (3–4 дня)
- [ ] ⚠️ **ОТКРЫТО (блокер качества):** верифицировать **реальные** ответы GMGN/RugCheck/BubbleMaps — нужен live-прогон с API-ключами на реальном токене, посмотреть JSON, подтвердить/поправить имена полей. Парсинг сейчас **защитный, но не верифицирован** (имена полей — предположения; неизвестное поле ⇒ false/недоступно, не ложный «ок»).
- [x] RugCheck: явные проверки `honeypot / mint authority / freeze authority` (скан `risks[]` по имени + `level==='danger'`); `score_normalised` нормализован.
- [x] BubbleMaps: при ошибке/пустых данных — **fail-closed** (было `0%`=«отлично» → стало «недоступно ⇒ 100%/штраф»).
- [x] **Score-based решение** (0–100) вместо `warnings.length===0`: `passed = !hardFail && score>=MIN_SECURITY_SCORE`. Hard-fail (honeypot/authority/danger) перебивает скор. Twitter — мягкий минус (−10). Недоступность RugCheck/BubbleMaps — −40 (fail-closed).
- [x] **Security re-check периодически** для активных позиций → **F4 `security_degraded`** (свежий hard-fail = отложенный руг) и **F5 `tvl_drop`** (падение TVL пула от пика) в panic-detector. Троттлинг `SECURITY_RECHECK_MIN` (деф. 5м) — бережём API-лимиты.
- Новое: `SecurityResult` расширен (`score/hardFail/mint/freeze/honeypot/sourcesUnavailable`); скор и флаги показываются в TG-уведомлении о токене.
- Проверка: `tsc --noEmit` — 0 ошибок.

> Параметры Фазы 4 в `.env`: `MIN_SECURITY_SCORE=60`, `MAX_HOLDER_CONCENTRATION_PCT=50`, `SECURITY_RECHECK_MIN=5`. F5 использует уже существующий `PANIC_TVL_DROP_PCT`.

### Фаза 4.1 — AI-аналитик (локальная LLM) 🤖
- [x] Сервис `ai-analyst`: прогон метрик токена + security через **локальную** LLM
  (OpenAI-совместимый эндпоинт — Ollama/LM Studio/vLLM), вердикт словами + риск 🟢/🟡/🔴
  прямо в Telegram-алерт. Не блокирует решение — «второе мнение» для human-in-the-loop.
- [x] По умолчанию `AI_ENABLED=false` (бот работает без LLM); никаких облачных вызовов.
- [x] Толерантный парсер ответа (вытаскивает JSON из текста, fallback на сырой текст).
- Параметры: `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`, `AI_TEMPERATURE`, `AI_MAX_TOKENS`, `AI_TIMEOUT_MS`.

### Фаза 5 — Telegram по ТЗ 💬 (1–2 дня)
- [x] **CA во всех сообщениях/`editMessageText`** (enter_pool, wait_pool, skip_pool, continue_watch, close_position, force_enter, wl_remove).
- [ ] Подключить кнопку `force_enter` к UI (сейчас handler есть, кнопка не отправляется).
- [ ] `/stop` — останавливает сканер (как требует ТЗ).
- [ ] Полный формат уведомления о выходе: вошли/вышли/fees/время в позиции/% PnL.
- [x] ~~Единый MarkdownV2~~ → **перешли на единый `parse_mode:'HTML'`** (надёжнее для ссылок и экранирования; `escMd`→`escHtml`/`escAttr`). Убраны битые ручные `\_`/`\.`-экраны из V1.

### Фаза 5.1 — Ссылки + ручной выбор пула + ватчлист 🔗 (решения заказчика 2026-06-23)

**Решения заказчика:**
1. **Ссылки на ресурсы — везде, инлайн в тексте** (не кнопками): GMGN, BubbleMaps, RugCheck, DexScreener, Solscan, Photon на каждый токен; Meteora-ссылка на каждый пул/позицию.
2. **Пулы: показывать ВСЕ DLMM-пулы по токену (все fee-%), не фильтровать по стратегии.** На каждый пул — кнопка входа, плюс «⏳ Ждать ещё» / «❌ Не входить». ⭐ помечает пул, совпадающий со стратегией (5% + binStep 80/100/125) — только пометка, выбирает человек. «Ничего сам не выдумывай, пользователь полностью контролирует процесс.»
3. **Нет пулов вообще → мониторинг:** 2ч активный watch + по таймауту кнопка «продолжить наблюдение» (как было) + полноценный **ватчлист** с ручным добавлением/удалением.
4. **Выходы НЕ трогаем** — вся матрица выходов остаётся как есть (ручная 🔴, тейк-профиты, composite panic, деградация-предупреждение).

**Реализовано:**
- [x] `shared/links.ts` — сборка ссылок из шаблонов `config.links` (override через `.env`); `tokenLinks()`, `meteoraPoolUrl()`. Битые URL (нет pairAddress) отбрасываются.
- [x] `config.links.*` (7 шаблонов) + `POOL_BUTTONS_MAX` (кап кнопок пулов, деф. 8).
- [x] Ссылки во всех уведомлениях: новый токен, пулы, позиция открыта/закрыта, деградация, ATH re-notify, `/positions`, `/watchlist`, таймаут.
- [x] Pool-watcher: показываем все DLMM-пулы; дедуп по `notifiedPoolAddrs` (повторно уведомляем только о новых пулах); watch не останавливаем — решает пользователь. `onPoolFound(token, pools)` (убран `hasTargetFee`).
- [x] `notifyPoolFound`: список всех пулов с ⭐, Meteora-ссылка на каждый, кнопка входа по индексу (`enter_pool:<ca>:<idx>` — укладываемся в лимит 64Б callback_data), «Ждать ещё»/«Не входить».
- [x] Ватчлист: `/watchlist` (список + 🗑 убрать), `/watch <CA>` (добавить), репозиторий `WatchedTokens.listActiveWatchlist()` + `cancel()`; `onCancelWatch`/`onAddWatch` в main.ts.
- [x] `DegradationWarning.tokenAddress` — проброс для ссылок в предупреждении.
- Проверка: `tsc --noEmit` — 0 ошибок.

### Фаза 6 — Тесты + CI 🧪 (2–3 дня)
- [x] Тест-раннер (vitest) + `npm test`; юнит-тесты на чистую логику: **security-скоринг**
  (hard-fail/fail-closed/soft-twitter) и **сборку ссылок**. 12 тестов зелёные.
- [x] ESLint 9 flat config (`eslint.config.js`) — `npm run lint` зелёный, 0 предупреждений.
- [ ] Расширить тесты: фильтры сканера, BB/RSI, mapper snake↔camel, PnL, окно panic-факторов.
- [ ] Integration: Telegram callback'и через `bot.handleUpdate`, БД, mocked Meteora/Jupiter.
- [ ] Ограниченный mainnet smoke на минимальной сумме (devnet неприменим — нет мем-пулов).
- [ ] GitHub Actions: `tsc --noEmit`, `eslint`, `vitest`.

---

## Не делаем (явно вне scope)
- Жёсткий ценовой стоп-лосс (решение заказчика).
- Авто-закрытие по одиночному `chart_degradation` (становится предупреждением).
- Покупка мемкоина отдельным свопом перед LP (single-sided SOL покрывает).
- Поддержка не-Solana сетей.

---

## Параметры по умолчанию (`.env`)

```
# Safety
DRY_RUN=true
ENABLE_MAINNET_TRADING=false
TELEGRAM_ALLOWED_CHAT_IDS=         # comma-separated; пусто = только TELEGRAM_CHAT_ID

# Composite panic
PANIC_REQUIRED_FACTORS=2
PANIC_TIME_WINDOW_MIN=15
PANIC_VOLUME_DROP_PCT=60
PANIC_RSI_THRESHOLD=40
PANIC_PRICE_DROP_FROM_ATH_PCT=50
PANIC_TVL_DROP_PCT=50              # опционально, Фаза 4

# ATH re-notify
ATH_RENOTIFY_PCT=10
ATH_RENOTIFY_COOLDOWN_MIN=30

# Chart health
MIN_HEALTH_SCORE=65
MAX_ATH_DISTANCE_PCT=30
```

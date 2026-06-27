import { Telegraf, Markup, Context } from 'telegraf';
import { config } from '../shared/config';
import { logger } from '../shared/logger';
import { Positions, WatchedTokens } from '../shared/repositories';
import { SecurityResult, TokenInfo, PoolInfo, Position, ExitReason, AiVerdict } from '../shared/types';
import { tokenLinks, meteoraPoolUrl, ResourceLink } from '../shared/links';
import { ChartHealth } from '../services/chart-health';

export class TelegramBot {
  readonly bot: Telegraf;
  private pendingPoolSelections = new Map<
    string,
    { pools: PoolInfo[]; tokenAddress: string; tokenSymbol: string }
  >();

  // Injected handlers from outside
  onEnterPool?: (tokenAddress: string, pool: PoolInfo) => Promise<void>;
  onManualScan?: (address: string) => Promise<void>;
  onExitPosition?: (positionId: number) => Promise<void>;
  onContinueWatching?: (tokenAddress: string, continueWatching: boolean) => void;
  /** «Не входить» в пул / убрать из ватчлиста — остановить наблюдение и отменить. */
  onCancelWatch?: (tokenAddress: string) => void;
  /** Ручное добавление токена в ватчлист (/watch <CA>). */
  onAddWatch?: (address: string) => Promise<void>;

  constructor() {
    this.bot = new Telegraf(config.telegram.botToken);
    this.setupAuthGuard();
    this.setupCommands();
    this.setupCallbackHandlers();
  }

  /**
   * Middleware: блокирует любые входящие апдейты от чатов, которых нет в allowlist.
   * Управляет ботом (тратит кошелёк) только тот, кто в TELEGRAM_ALLOWED_CHAT_IDS
   * (по умолчанию — только TELEGRAM_CHAT_ID).
   */
  private setupAuthGuard(): void {
    const allowed = new Set(config.telegram.allowedChatIds.map(String));
    this.bot.use(async (ctx: Context, next) => {
      const chatId = ctx.chat?.id !== undefined ? String(ctx.chat.id) : undefined;
      const userId = ctx.from?.id !== undefined ? String(ctx.from.id) : undefined;

      const ok =
        (chatId !== undefined && allowed.has(chatId)) ||
        (userId !== undefined && allowed.has(userId));

      if (!ok) {
        logger.warn(
          `Blocked unauthorized TG update: chat_id=${chatId} user=${userId} ` +
            `(@${ctx.from?.username ?? '?'})`
        );
        // Тихо отвечаем callback'у, чтобы не висел спиннер.
        if ('callbackQuery' in ctx.update) {
          try {
            await ctx.answerCbQuery('⛔ Доступ запрещён');
          } catch {
            /* ignore */
          }
        }
        return; // не пропускаем дальше
      }
      return next();
    });
  }

  start(): void {
    this.bot.launch();
    logger.info('Telegram bot started');
  }

  stop(): void {
    this.bot.stop('SIGTERM');
  }

  // ─── Resource links ────────────────────────────────────────────────────────

  /**
   * Строка кликабельных ссылок на ресурсы (инлайн в тексте — выбор заказчика).
   * Для сообщений с пулом передаём poolAddress → добавляется ссылка на Meteora.
   */
  private resourceLine(ca: string, pairAddress?: string, poolAddress?: string): string {
    const links = tokenLinks(ca, pairAddress);
    if (poolAddress) {
      const m = meteoraPoolUrl(poolAddress);
      if (m) links.push({ label: 'Meteora', url: m });
    }
    return this.linksLineHtml(links);
  }

  private linksLineHtml(links: ResourceLink[]): string {
    if (links.length === 0) return '';
    return (
      '🔗 ' +
      links.map((l) => `<a href="${escAttr(l.url)}">${escHtml(l.label)}</a>`).join(' · ')
    );
  }

  // ─── Outbound notifications ────────────────────────────────────────────────

  async notifyNewToken(
    token: TokenInfo,
    security: SecurityResult,
    ai?: AiVerdict,
    health?: ChartHealth
  ): Promise<void> {
    const statusIcon = security.passed ? '✅' : '⚠️';
    const chartLine = health
      ? `📉 От ATH: -${health.athDistancePct.toFixed(0)}%` +
        (health.rsi !== null ? ` · RSI(15м): ${health.rsi.toFixed(0)}` : '')
      : null;
    const text = [
      `${statusIcon} <b>Найден токен: ${escHtml(token.symbol)}</b>`,
      `CA: <code>${escHtml(token.address)}</code>`,
      this.resourceLine(token.address, token.pairAddress),
      '',
      `💰 MarketCap: $${fmt(token.marketCap)}`,
      `📊 Volume 24h: $${fmt(token.volume24h)}`,
      `💵 Price: $${token.priceUsd.toFixed(8)}`,
      `💧 Liquidity: $${fmt(token.liquidity)}`,
      ...(chartLine ? [chartLine] : []),
      '',
      `🧮 Security score: ${security.score}/100${security.hardFail ? ' — ❌ HARD-FAIL' : ''}`,
      `🛡 RugCheck: ${escHtml(security.rugcheckStatus)}`,
      `🦎 GeckoTerminal gt_score: ${security.gtScore !== null ? `${security.gtScore.toFixed(0)}/100` : 'n/a'}`,
      `🫧 BubbleMaps децентрализация: ${security.decentralisationScore.toFixed(0)}/100`,
      `🐦 Twitter: ${security.twitterActive ? 'есть' : 'нет'}`,
    ];

    const flags: string[] = [];
    if (security.honeypot) flags.push('🍯 Honeypot');
    if (security.mintAuthorityActive) flags.push('🔓 Mint authority активна');
    if (security.freezeAuthorityActive) flags.push('🧊 Freeze authority активна');
    if (security.sourcesUnavailable.length > 0)
      flags.push(`📡 Недоступны: ${escHtml(security.sourcesUnavailable.join(', '))}`);
    if (flags.length > 0) text.push('', ...flags);

    if (ai) {
      const riskIcon = { low: '🟢', medium: '🟡', high: '🔴', unknown: '⚪' }[ai.risk];
      text.push('', `🤖 <b>AI-аналитик</b> (${riskIcon} ${ai.risk}): ${escHtml(ai.verdict)}`);
    }

    if (security.warnings.length > 0) {
      text.push('', '⚠️ <b>Предупреждения:</b>');
      security.warnings.forEach((w) => text.push(`  • ${escHtml(w)}`));
    }

    await this.sendMessage(text.join('\n'));
  }

  /**
   * Токен не прошёл security — сообщение с РАБОЧЕЙ кнопкой «всё равно отслеживать»
   * (force_enter), а не текстовой инструкцией. Единый HTML-формат.
   */
  async notifySecurityFailed(token: TokenInfo, security: SecurityResult): Promise<void> {
    const lines = [
      `⚠️ <b>${escHtml(token.symbol)}</b> не прошёл проверку безопасности (score ${security.score}/100)`,
      `CA: <code>${escHtml(token.address)}</code>`,
      this.resourceLine(token.address, token.pairAddress),
    ];
    if (security.warnings.length > 0) {
      lines.push('', '⚠️ <b>Причины:</b>');
      security.warnings.forEach((w) => lines.push(`  • ${escHtml(w)}`));
    }
    lines.push('', 'Всё равно отслеживать пул?');
    await this.sendMessageWithButtons(lines.join('\n'), [
      [Markup.button.callback('⚠️ Всё равно отслеживать', `force_enter:${token.address}`)],
      [Markup.button.callback('❌ Пропустить', `skip_pool:${token.address}`)],
    ]);
  }

  /**
   * Все DLMM-пулы по токену — список + кнопка входа на каждый + «ждать»/«не входить».
   * Никакой авто-фильтрации: выбирает человек. ⭐ помечает пул, совпадающий со
   * стратегией (fee 5% + binStep 80/100/125) — только пометка, войти можно в любой.
   */
  async notifyPoolFound(token: TokenInfo, pools: PoolInfo[]): Promise<void> {
    this.pendingPoolSelections.set(token.address, {
      pools,
      tokenAddress: token.address,
      tokenSymbol: token.symbol,
    });

    const shown = pools.slice(0, config.poolWatcher.buttonsMax);
    const preferred = new Set(config.poolWatcher.preferredBinSteps);
    const isStrategy = (p: PoolInfo): boolean =>
      p.feeBps === config.poolWatcher.targetFeeBps && preferred.has(p.binStep);

    const lines: string[] = [
      `🪙 <b>${escHtml(token.symbol)}</b> — найдены пулы Meteora`,
      `CA: <code>${escHtml(token.address)}</code>`,
      this.resourceLine(token.address, token.pairAddress),
      '',
      'Доступные пулы:',
    ];
    const anyStrategy = shown.some(isStrategy);
    shown.forEach((p, i) => {
      const star = isStrategy(p) ? '⭐' : '▫️';
      const mUrl = meteoraPoolUrl(p.address);
      const meteora = mUrl ? ` · <a href="${escAttr(mUrl)}">Meteora↗</a>` : '';
      // feeBps/binStep часто неизвестны (DexScreener их не отдаёт) — показываем тип пула.
      const fee = p.feeBps > 0 ? ` · ${(p.feeBps / 100).toFixed(2)}%` : '';
      const step = p.binStep > 0 ? ` · step${p.binStep}` : '';
      lines.push(`${star} ${i + 1}) ${p.poolType}${fee}${step} · TVL $${fmtShort(p.tvl)}${meteora}`);
    });
    if (pools.length > shown.length) {
      lines.push('', `…и ещё ${pools.length - shown.length} пул(ов)`);
    }
    if (anyStrategy) lines.push('', '⭐ = совпадает со стратегией (5% + binStep 80/100/125)');

    const buttons = shown.map((p, i) => {
      const fee = p.feeBps > 0 ? ` ${(p.feeBps / 100).toFixed(2)}%` : '';
      const label = `✅ Войти ${i + 1} (${p.poolType}${fee}, $${fmtShort(p.tvl)})`;
      return [Markup.button.callback(label, `enter_pool:${token.address}:${i}`)];
    });
    buttons.push([
      Markup.button.callback('⏳ Ждать ещё', `wait_pool:${token.address}`),
      Markup.button.callback('❌ Не входить', `skip_pool:${token.address}`),
    ]);

    await this.sendMessageWithButtons(lines.join('\n'), buttons);
  }

  /** Пулов пока нет — явно сообщаем, что наблюдаем (чтобы не было «непонятно что происходит»). */
  async notifyNoPoolsYet(tokenAddress: string, tokenSymbol: string): Promise<void> {
    const text = [
      `🔭 <b>${escHtml(tokenSymbol)}</b>: пулов Meteora пока нет`,
      `CA: <code>${escHtml(tokenAddress)}</code>`,
      this.resourceLine(tokenAddress),
      '',
      `Наблюдаю — проверяю каждые 30с (таймаут 2ч). Пришлю, как только появятся.`,
    ].join('\n');
    await this.sendMessageWithButtons(text, [
      [Markup.button.callback('❌ Прекратить наблюдение', `skip_pool:${tokenAddress}`)],
    ]);
  }

  async notifyPoolTimeout(
    tokenAddress: string,
    tokenSymbol: string,
    foundAny = false
  ): Promise<void> {
    // Если пулы показывались, но в них не вошли — это НЕ «пул не найден».
    const head = foundAny
      ? `⏰ <b>2 часа: вход в пул так и не сделан</b>`
      : `⏰ <b>Пул не найден за 2 часа</b>`;
    const text = [
      head,
      `Токен: ${escHtml(tokenSymbol)}`,
      `CA: <code>${escHtml(tokenAddress)}</code>`,
      this.resourceLine(tokenAddress),
      '',
      `Продолжать отслеживание?`,
    ].join('\n');
    await this.sendMessageWithButtons(text, [
      [
        Markup.button.callback('✅ Да', `continue_watch:${tokenAddress}:yes`),
        Markup.button.callback('❌ Нет', `continue_watch:${tokenAddress}:no`),
      ],
    ]);
  }

  async notifyPositionOpened(position: Position): Promise<void> {
    const text = [
      `🟢 <b>Позиция открыта: ${escHtml(position.tokenSymbol)}</b>`,
      `CA: <code>${escHtml(position.tokenAddress)}</code>`,
      `Pool: <code>${escHtml(position.poolAddress)}</code>`,
      this.resourceLine(position.tokenAddress, undefined, position.poolAddress),
      '',
      `SOL: ${position.solAmount}`,
      `Fee: ${(position.feeBps / 100).toFixed(2)}%`,
      `Entry price: $${position.entryPrice.toFixed(8)}`,
    ].join('\n');
    // Кнопка «выйти сейчас» прямо на сообщении открытия — главный
    // инструмент паники для оператора (решение заказчика).
    await this.sendMessageWithButtons(text, [
      [Markup.button.callback('🔴 Выйти сейчас', `close_position:${position.id}`)],
    ]);
  }

  async notifyPositionClosed(position: Position, reason: ExitReason): Promise<void> {
    const pnlSign = (position.pnlSol ?? 0) >= 0 ? '+' : '';
    const reasonText: Record<ExitReason, string> = {
      stop_loss: '🛑 Стоп-лосс (страховка)',
      bollinger_breakout: '📈 Bollinger Bands breakout',
      new_ath: '🚀 Новый ATH',
      fee_target: '💰 Цель по комиссиям достигнута',
      chart_degradation: '📉 Деградация графика',
      panic_composite: '🚨 Panic-detector: совокупность негативных факторов',
      manual: '🖐 Ручное закрытие',
    };
    const text = [
      `🔴 <b>Позиция закрыта: ${escHtml(position.tokenSymbol)}</b>`,
      `CA: <code>${escHtml(position.tokenAddress)}</code>`,
      this.resourceLine(position.tokenAddress, undefined, position.poolAddress),
      '',
      `Причина: ${reasonText[reason]}`,
      `PnL: ${pnlSign}${(position.pnlSol ?? 0).toFixed(4)} SOL`,
    ].join('\n');
    await this.sendMessage(text);
  }

  /** Предупреждение о деградации графика — без авто-выхода, с кнопкой ручного выхода. */
  async notifyDegradation(
    positionId: number,
    tokenSymbol: string,
    message: string,
    tokenAddress: string
  ): Promise<void> {
    const text = [
      `⚠️ <b>Предупреждение: ${escHtml(tokenSymbol)}</b>`,
      escHtml(message),
      this.resourceLine(tokenAddress),
      ``,
      `Авто-выхода по одной деградации нет (решение заказчика).`,
      `Хочешь закрыть позицию #${positionId} вручную?`,
    ].join('\n');
    await this.sendMessageWithButtons(text, [
      [Markup.button.callback('🔴 Закрыть сейчас', `close_position:${positionId}`)],
      [Markup.button.callback('🤝 Держать', `keep_position:${positionId}`)],
    ]);
  }

  /** Повторное уведомление по новому ATH (+X% над прошлым уведомлением). */
  async notifyAthRenotify(token: TokenInfo, newAth: number, prevAth: number): Promise<void> {
    const text = [
      `🚀 <b>Новый ATH +${config.athRenotify.pct}%: ${escHtml(token.symbol)}</b>`,
      `CA: <code>${escHtml(token.address)}</code>`,
      this.resourceLine(token.address, token.pairAddress),
      '',
      `Цена: $${newAth.toFixed(8)} (прошлый ATH-уведом: $${prevAth.toFixed(8)})`,
    ].join('\n');
    await this.sendMessage(text);
  }

  async notifyError(message: string): Promise<void> {
    await this.sendMessage(`❌ <b>Ошибка:</b> ${escHtml(message)}`);
  }

  async sendMessage(text: string): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(config.telegram.chatId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      logger.error(`TG sendMessage error: ${err}`);
    }
  }

  private async sendMessageWithButtons(
    text: string,
    buttons: ReturnType<typeof Markup.button.callback>[][]
  ): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(config.telegram.chatId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...Markup.inlineKeyboard(buttons),
      });
    } catch (err) {
      logger.error(`TG sendMessageWithButtons error: ${err}`);
    }
  }

  // ─── Commands ──────────────────────────────────────────────────────────────

  private setupCommands(): void {
    this.bot.command('start', (ctx) => {
      ctx.reply(
        '🤖 <b>Meteora LP Bot</b>\n\n' +
          '/status — статус бота\n' +
          '/positions — активные позиции\n' +
          '/watchlist — список наблюдаемых токенов\n' +
          '/watch &lt;CA&gt; — добавить токен в наблюдение\n' +
          '/scan &lt;CA&gt; — проверить токен вручную',
        { parse_mode: 'HTML' }
      );
    });

    this.bot.command('status', async (ctx) => {
      const active = Positions.countActive();
      const watching = WatchedTokens.countWatching();

      ctx.reply(
        `🤖 <b>Бот работает</b>\n` +
          `📊 Активных позиций: ${active}/${config.lp.maxPositions}\n` +
          `👀 Отслеживается токенов: ${watching}`,
        { parse_mode: 'HTML' }
      );
    });

    this.bot.command('positions', async (ctx) => {
      const positions = Positions.findActive();

      if (positions.length === 0) {
        ctx.reply('Нет активных позиций');
        return;
      }

      const lines = positions.map((p, i) => {
        const age = Math.floor((Date.now() / 1000 - p.openedAt) / 60);
        return (
          `<b>${i + 1}. ${escHtml(p.tokenSymbol)}</b>\n` +
          `  Fee: ${(p.feeBps / 100).toFixed(2)}% | SOL: ${p.solAmount} | ${age}м\n` +
          `  ${this.resourceLine(p.tokenAddress, undefined, p.poolAddress)}`
        );
      });

      const text = `📊 <b>Активные позиции:</b>\n\n${lines.join('\n\n')}`;
      const closeButtons = positions.map((p) => [
        Markup.button.callback(`❌ Закрыть ${p.tokenSymbol}`, `close_position:${p.id}`),
      ]);

      await ctx.reply(text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...Markup.inlineKeyboard(closeButtons),
      });
    });

    this.bot.command('watchlist', async (ctx) => {
      const rows = WatchedTokens.listActiveWatchlist();
      if (rows.length === 0) {
        ctx.reply('Ватчлист пуст. Добавить: /watch <CA>');
        return;
      }

      const lines = rows.map((w, i) => {
        const age = Math.floor((Date.now() / 1000 - w.startedAt) / 60);
        return (
          `<b>${i + 1}. ${escHtml(w.tokenSymbol)}</b> — ${w.status}, ${age}м\n` +
          `  <code>${escHtml(w.tokenAddress)}</code>\n` +
          `  ${this.resourceLine(w.tokenAddress)}`
        );
      });
      const removeButtons = rows.map((w) => [
        Markup.button.callback(`🗑 Убрать ${w.tokenSymbol}`, `wl_remove:${w.tokenAddress}`),
      ]);

      await ctx.reply(`👀 <b>Ватчлист:</b>\n\n${lines.join('\n\n')}`, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...Markup.inlineKeyboard(removeButtons),
      });
    });

    this.bot.command('watch', async (ctx) => {
      const ca = ctx.message.text.split(' ').slice(1).join('').trim();
      if (!ca) {
        ctx.reply('Укажи CA токена: /watch <адрес>');
        return;
      }
      ctx.reply(`➕ Добавляю в наблюдение <code>${escHtml(ca)}</code>...`, { parse_mode: 'HTML' });
      this.onAddWatch?.(ca);
    });

    this.bot.command('scan', async (ctx) => {
      const text = ctx.message.text.split(' ').slice(1).join('').trim();
      if (!text) {
        ctx.reply('Укажи CA токена: /scan <адрес>');
        return;
      }
      ctx.reply(`🔍 Проверяю ${text}...`);
      this.onManualScan?.(text);
    });
  }

  // ─── Callback handlers ─────────────────────────────────────────────────────

  private setupCallbackHandlers(): void {
    // Вход в конкретный пул по индексу в списке (callback_data ограничен 64 байтами,
    // поэтому передаём индекс, а не адрес пула).
    this.bot.action(/^enter_pool:(.+):(\d+)$/, async (ctx) => {
      const tokenAddress = ctx.match[1];
      const idx = parseInt(ctx.match[2], 10);
      const selection = this.pendingPoolSelections.get(tokenAddress);

      if (!selection) {
        await ctx.answerCbQuery('Данные устарели');
        return;
      }

      const pool = selection.pools[idx];
      if (!pool) {
        await ctx.answerCbQuery('Пул не найден');
        return;
      }

      await ctx.answerCbQuery('Входим в пул...');
      await ctx.editMessageText(`⏳ Входим в пул ${escHtml(selection.tokenSymbol)}...`, {
        parse_mode: 'HTML',
      });
      this.pendingPoolSelections.delete(tokenAddress);
      this.onEnterPool?.(tokenAddress, pool);
    });

    // «Ждать ещё» — продолжаем наблюдение, повторно уведомим только о новых пулах.
    this.bot.action(/^wait_pool:(.+)$/, async (ctx) => {
      const tokenAddress = ctx.match[1];
      this.pendingPoolSelections.delete(tokenAddress);
      await ctx.answerCbQuery('Жду новые пулы');
      try {
        await ctx.editMessageText('⏳ Продолжаю наблюдение — уведомлю о новых пулах');
      } catch {
        /* ignore */
      }
    });

    // «Не входить» — останавливаем наблюдение и убираем из ватчлиста.
    this.bot.action(/^skip_pool:(.+)$/, async (ctx) => {
      const tokenAddress = ctx.match[1];
      this.pendingPoolSelections.delete(tokenAddress);
      this.onCancelWatch?.(tokenAddress);
      await ctx.answerCbQuery('Не входим, наблюдение остановлено');
      try {
        await ctx.editMessageText('❌ Не входим. Токен снят с наблюдения.');
      } catch {
        /* ignore */
      }
    });

    this.bot.action(/^wl_remove:(.+)$/, async (ctx) => {
      const tokenAddress = ctx.match[1];
      this.onCancelWatch?.(tokenAddress);
      await ctx.answerCbQuery('Убрано из ватчлиста');
      try {
        await ctx.editMessageText('🗑 Токен убран из ватчлиста');
      } catch {
        /* ignore */
      }
    });

    this.bot.action(/^continue_watch:(.+):(yes|no)$/, async (ctx) => {
      const tokenAddress = ctx.match[1];
      const continueWatching = ctx.match[2] === 'yes';
      await ctx.answerCbQuery(continueWatching ? 'Продолжаем наблюдение' : 'Наблюдение остановлено');
      await ctx.editMessageText(
        continueWatching ? `👀 Продолжаем наблюдение за токеном` : `🛑 Наблюдение остановлено`
      );
      this.onContinueWatching?.(tokenAddress, continueWatching);
    });

    this.bot.action(/^close_position:(\d+)$/, async (ctx) => {
      const positionId = parseInt(ctx.match[1], 10);
      // Идемпотентность: если позиции уже нет в статусе active — отвечаем
      // тихо, без второй попытки закрытия. LpManager тоже защищён переходом
      // active → closing, но лучше отрезать как можно раньше.
      const pos = Positions.findById(positionId);
      if (!pos || pos.status !== 'active') {
        await ctx.answerCbQuery(
          pos ? `Уже ${pos.status === 'closing' ? 'закрывается' : 'закрыта'}` : 'Нет такой позиции'
        );
        return;
      }
      await ctx.answerCbQuery('Закрываем позицию...');
      try {
        await ctx.editMessageText(`⏳ Закрываем позицию #${positionId}...`);
      } catch {
        // Сообщение могло быть уже отредактировано (двойной клик) — игнорируем.
      }
      this.onExitPosition?.(positionId);
    });

    // Кнопка «Держать» под предупреждением о деградации — ничего не делаем
    // на бекенде, только перерисовываем сообщение, чтобы убрать кнопки.
    this.bot.action(/^keep_position:(\d+)$/, async (ctx) => {
      const positionId = parseInt(ctx.match[1], 10);
      await ctx.answerCbQuery('Держим позицию');
      try {
        await ctx.editMessageText(`🤝 Держим позицию #${positionId} (предупреждение принято)`);
      } catch {
        /* ignore */
      }
    });

    // Manual override for security-failed tokens
    this.bot.action(/^force_enter:(.+)$/, async (ctx) => {
      const tokenAddress = ctx.match[1];
      await ctx.answerCbQuery('Запускаем наблюдение за пулом');
      await ctx.editMessageText(`⚠️ Принудительный вход для <code>${escHtml(tokenAddress)}</code>`, {
        parse_mode: 'HTML',
      });
      // Trigger pool watching despite security warnings
      this.onManualScan?.(`force:${tokenAddress}`);
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

function fmtShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toFixed(0);
}

/** Экранирование для parse_mode HTML (тело сообщения). */
function escHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Экранирование для значения href="…". */
function escAttr(text: string): string {
  return escHtml(text).replace(/"/g, '&quot;');
}

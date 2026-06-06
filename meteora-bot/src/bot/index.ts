import { Telegraf, Markup, Context } from 'telegraf';
import { config } from '../shared/config';
import { logger } from '../shared/logger';
import { Positions, WatchedTokens } from '../shared/repositories';
import { SecurityResult, TokenInfo, PoolInfo, Position, ExitReason } from '../shared/types';

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

  // ─── Outbound notifications ────────────────────────────────────────────────

  async notifyNewToken(token: TokenInfo, security: SecurityResult): Promise<void> {
    const statusIcon = security.passed ? '✅' : '⚠️';
    const text = [
      `${statusIcon} *Найден токен: ${escMd(token.symbol)}*`,
      `CA: \`${token.address}\``,
      '',
      `💰 MarketCap: $${fmt(token.marketCap)}`,
      `📊 Volume 24h: $${fmt(token.volume24h)}`,
      `💵 Price: $${token.priceUsd.toFixed(8)}`,
      `💧 Liquidity: $${fmt(token.liquidity)}`,
      '',
      `🔐 GMGN fees: ${security.gmgnFeesSol.toFixed(1)} SOL`,
      `🛡 RugCheck: ${security.rugcheckStatus}`,
      `👥 Топ холдеры: ${security.holderConcentration.toFixed(1)}%`,
      `🐦 Twitter: ${security.twitterActive ? 'есть' : 'нет'}`,
    ];

    if (security.warnings.length > 0) {
      text.push('', '⚠️ *Предупреждения:*');
      security.warnings.forEach((w) => text.push(`  • ${escMd(w)}`));
    }

    await this.sendMessage(text.join('\n'));
  }

  async notifyPoolFound(
    token: TokenInfo,
    pools: PoolInfo[],
    hasTargetFee: boolean
  ): Promise<void> {
    const selectionKey = token.address;
    this.pendingPoolSelections.set(selectionKey, {
      pools,
      tokenAddress: token.address,
      tokenSymbol: token.symbol,
    });

    if (hasTargetFee) {
      const pool = pools[0];
      const text = [
        `🎯 *Пул найден: ${escMd(token.symbol)}*`,
        `Pool: \`${pool.address}\``,
        `Fee: ${(pool.feeBps / 100).toFixed(2)}% | BinStep: ${pool.binStep}`,
        `TVL: $${fmt(pool.tvl)}`,
      ].join('\n');

      await this.sendMessageWithButtons(text, [
        [Markup.button.callback(`✅ Войти в пул`, `enter_pool:${token.address}:${pool.address}`)],
        [Markup.button.callback(`❌ Пропустить`, `skip_pool:${token.address}`)],
      ]);
    } else {
      // Alternative pools selection
      const text = [
        `⚠️ *Пул 5% не найден для ${escMd(token.symbol)}*`,
        `Доступные варианты:`,
      ].join('\n');

      const buttons = pools.slice(0, 5).map((pool) => [
        Markup.button.callback(
          `${(pool.feeBps / 100).toFixed(2)}% | step:${pool.binStep} | TVL:$${fmtShort(pool.tvl)}`,
          `enter_pool:${token.address}:${pool.address}`
        ),
      ]);
      buttons.push([Markup.button.callback(`❌ Не входить`, `skip_pool:${token.address}`)]);

      await this.sendMessageWithButtons(text, buttons);
    }
  }

  async notifyPoolTimeout(tokenAddress: string, tokenSymbol: string): Promise<void> {
    const text = `⏰ *Пул не найден за 2 часа*\nТокен: ${escMd(tokenSymbol)}\nПродолжать отслеживание?`;
    await this.sendMessageWithButtons(text, [
      [
        Markup.button.callback('✅ Да', `continue_watch:${tokenAddress}:yes`),
        Markup.button.callback('❌ Нет', `continue_watch:${tokenAddress}:no`),
      ],
    ]);
  }

  async notifyPositionOpened(position: Position): Promise<void> {
    const text = [
      `🟢 *Позиция открыта: ${escMd(position.tokenSymbol)}*`,
      `CA: \`${position.tokenAddress}\``,
      `Pool: \`${position.poolAddress}\``,
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
      `🔴 *Позиция закрыта: ${escMd(position.tokenSymbol)}*`,
      `CA: \`${position.tokenAddress}\``,
      `Причина: ${reasonText[reason]}`,
      `PnL: ${pnlSign}${(position.pnlSol ?? 0).toFixed(4)} SOL`,
    ].join('\n');
    await this.sendMessage(text);
  }

  /** Предупреждение о деградации графика — без авто-выхода, с кнопкой ручного выхода. */
  async notifyDegradation(positionId: number, tokenSymbol: string, message: string): Promise<void> {
    const text = [
      `⚠️ *Предупреждение: ${escMd(tokenSymbol)}*`,
      `${escMd(message)}`,
      ``,
      `Авто-выхода по одной деградации нет (решение заказчика).`,
      `Хочешь закрыть позицию #${positionId} вручную?`,
    ].join('\n');
    await this.sendMessageWithButtons(text, [
      [Markup.button.callback('🔴 Закрыть сейчас', `close_position:${positionId}`)],
      [Markup.button.callback('🤝 Держать', `keep_position:${positionId}`)],
    ]);
  }

  async notifyError(message: string): Promise<void> {
    await this.sendMessage(`❌ *Ошибка:* ${escMd(message)}`);
  }

  async sendMessage(text: string): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(config.telegram.chatId, text, {
        parse_mode: 'Markdown',
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
        parse_mode: 'Markdown',
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
        '🤖 *Meteora LP Bot*\n\n' +
          '/status — статус бота\n' +
          '/positions — активные позиции\n' +
          '/scan <CA> — проверить токен вручную',
        { parse_mode: 'Markdown' }
      );
    });

    this.bot.command('status', async (ctx) => {
      const active = Positions.countActive();
      const watching = WatchedTokens.countWatching();

      ctx.reply(
        `🤖 *Бот работает*\n` +
          `📊 Активных позиций: ${active}/${config.lp.maxPositions}\n` +
          `👀 Отслеживается токенов: ${watching}`,
        { parse_mode: 'Markdown' }
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
        return `*${i + 1}. ${escMd(p.tokenSymbol)}*\n  Fee: ${(p.feeBps / 100).toFixed(2)}% | SOL: ${p.solAmount} | ${age}м`;
      });

      const text = `📊 *Активные позиции:*\n\n${lines.join('\n\n')}`;
      const closeButtons = positions.map((p) => [
        Markup.button.callback(`❌ Закрыть ${p.tokenSymbol}`, `close_position:${p.id}`),
      ]);

      await ctx.reply(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(closeButtons),
      });
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
    this.bot.action(/^enter_pool:(.+):(.+)$/, async (ctx) => {
      const tokenAddress = ctx.match[1];
      const poolAddress = ctx.match[2];
      const selection = this.pendingPoolSelections.get(tokenAddress);

      if (!selection) {
        await ctx.answerCbQuery('Данные устарели');
        return;
      }

      const pool = selection.pools.find((p) => p.address === poolAddress);
      if (!pool) {
        await ctx.answerCbQuery('Пул не найден');
        return;
      }

      await ctx.answerCbQuery('Входим в пул...');
      await ctx.editMessageText(
        `⏳ Входим в пул ${escMd(selection.tokenSymbol)}...`,
        { parse_mode: 'Markdown' }
      );
      this.pendingPoolSelections.delete(tokenAddress);
      this.onEnterPool?.(tokenAddress, pool);
    });

    this.bot.action(/^skip_pool:(.+)$/, async (ctx) => {
      const tokenAddress = ctx.match[1];
      this.pendingPoolSelections.delete(tokenAddress);
      await ctx.answerCbQuery('Пропущено');
      await ctx.editMessageText('❌ Пул пропущен');
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
      await ctx.editMessageText(`⚠️ Принудительный вход для \`${tokenAddress}\``, { parse_mode: 'Markdown' });
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

function escMd(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

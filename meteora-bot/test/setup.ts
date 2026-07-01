import bs58 from 'bs58';

/**
 * Тестовое окружение. config.ts валидирует обязательные env ПРИ ИМПОРТЕ
 * (бросает, если их нет), поэтому проставляем заглушки ДО загрузки тест-модулей.
 * Vitest гоняет setupFiles перед тест-файлами — значения попадут в config.
 * Фиксируем и пороги security, чтобы тесты были детерминированы независимо от .env.
 */
process.env.SOLANA_PRIVATE_KEY = bs58.encode(Buffer.alloc(64, 7)); // валидный 64-байтовый ключ
process.env.TELEGRAM_BOT_TOKEN = 'test:token';
process.env.TELEGRAM_CHAT_ID = '123456';
process.env.RPC_URL = 'https://rpc.test.invalid';

process.env.MIN_SECURITY_SCORE = '60';
process.env.MAX_HOLDER_CONCENTRATION_PCT = '50';
process.env.MIN_GMGN_FEES_SOL = '30';

// Пороги сканера — фиксируем для детерминизма тестов фильтров.
process.env.MIN_MARKET_CAP = '250000';
process.env.MIN_VOLUME_24H = '1000000';
process.env.MAX_TOKEN_AGE_DAYS = '21';

// БД в памяти — тесты mapper'а не трогают боевой data/bot.db.
process.env.DB_PATH = ':memory:';

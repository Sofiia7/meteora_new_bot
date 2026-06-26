import axios from 'axios';
import { config } from '../../shared/config';
import { logger } from '../../shared/logger';
import { AiVerdict, SecurityResult, TokenInfo } from '../../shared/types';

/**
 * AI-аналитик (Фаза 4.1). Прогоняет метрики токена + security-данные через
 * ЛОКАЛЬНУЮ LLM (OpenAI-совместимый эндпоинт: Ollama/LM Studio/vLLM) и возвращает
 * короткий вердикт человеческим языком + уровень риска.
 *
 * Это «второе мнение» для оператора в human-in-the-loop: индикаторы дают цифры,
 * LLM — связное суждение. Не блокирует и не решает за человека — только подсказка.
 * При AI_ENABLED=false или недоступной модели возвращает null (бот работает как есть).
 */
export class AiAnalyst {
  isEnabled(): boolean {
    return config.ai.enabled;
  }

  async analyzeToken(token: TokenInfo, security: SecurityResult): Promise<AiVerdict | null> {
    if (!config.ai.enabled) return null;

    try {
      const resp = await axios.post(
        `${config.ai.baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          model: config.ai.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(token, security) },
          ],
          temperature: config.ai.temperature,
          max_tokens: config.ai.maxTokens,
          stream: false,
        },
        {
          timeout: config.ai.timeoutMs,
          headers: config.ai.apiKey
            ? { Authorization: `Bearer ${config.ai.apiKey}` }
            : undefined,
        }
      );

      const content: string = resp.data?.choices?.[0]?.message?.content ?? '';
      const verdict = parseVerdict(content);
      if (!verdict) logger.warn(`AI analyst: не удалось распарсить ответ модели`);
      return verdict;
    } catch (err) {
      logger.warn(`AI analyst failed: ${err}`);
      return null;
    }
  }
}

const SYSTEM_PROMPT =
  'Ты — риск-аналитик мемкоинов на Solana. Тебе дают метрики токена и результаты ' +
  'проверок безопасности. Оцени риск входа в LP-позицию. Отвечай СТРОГО одним ' +
  'JSON-объектом без пояснений вокруг: ' +
  '{"risk":"low|medium|high","verdict":"<1-2 коротких предложения по-русски>"}. ' +
  'Будь конкретным и опирайся на данные (ликвидность, концентрация холдеров, ' +
  'authorities, honeypot, объём, просадка). Не выдумывай факты, которых нет.';

function buildUserPrompt(token: TokenInfo, s: SecurityResult): string {
  const lines = [
    `Токен: ${token.symbol} (${token.name})`,
    `MarketCap: $${Math.round(token.marketCap)}`,
    `Volume 24h: $${Math.round(token.volume24h)}`,
    `Liquidity: $${Math.round(token.liquidity)}`,
    `Изменение цены 24h: ${token.priceChange24h.toFixed(1)}%`,
    `Security score: ${s.score}/100 (hardFail=${s.hardFail})`,
    `RugCheck: ${s.rugcheckStatus}`,
    `GeckoTerminal gt_score: ${s.gtScore !== null ? `${s.gtScore.toFixed(0)}/100` : 'n/a'}`,
    `Децентрализация (BubbleMaps): ${s.decentralisationScore.toFixed(0)}/100`,
    `Mint authority активна: ${s.mintAuthorityActive}`,
    `Freeze authority активна: ${s.freezeAuthorityActive}`,
    `Honeypot: ${s.honeypot}`,
    `Twitter/соцсети: ${s.twitterActive ? 'есть' : 'нет'}`,
    `Недоступные источники: ${s.sourcesUnavailable.join(', ') || 'нет'}`,
  ];
  if (s.warnings.length > 0) lines.push(`Предупреждения: ${s.warnings.join('; ')}`);
  return lines.join('\n');
}

/** Толерантный парсер: модель может обернуть JSON текстом — вытаскиваем первый {…}. */
function parseVerdict(content: string): AiVerdict | null {
  if (!content) return null;
  const match = content.match(/\{[\s\S]*\}/);
  const raw = match ? match[0] : content;
  try {
    const obj = JSON.parse(raw) as { risk?: string; verdict?: string };
    const risk = normalizeRisk(obj.risk);
    const verdict = (obj.verdict ?? '').toString().trim();
    if (!verdict) return { risk, verdict: content.trim().slice(0, 280) };
    return { risk, verdict };
  } catch {
    // Не JSON — берём как есть текстом, риск неизвестен.
    return { risk: 'unknown', verdict: content.trim().slice(0, 280) };
  }
}

function normalizeRisk(v: unknown): AiVerdict['risk'] {
  const s = String(v ?? '').toLowerCase();
  if (s.includes('low') || s.includes('низ')) return 'low';
  if (s.includes('med') || s.includes('сред')) return 'medium';
  if (s.includes('high') || s.includes('выс')) return 'high';
  return 'unknown';
}

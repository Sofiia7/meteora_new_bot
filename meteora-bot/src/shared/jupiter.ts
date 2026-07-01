/**
 * Чистые билдеры запросов к Jupiter Swap API — вынесены из lp-manager, чтобы
 * их можно было юнит-тестить без импорта тяжёлого @meteora-ag/dlmm SDK.
 */

export interface JupiterQuoteParamsInput {
  inputMint: string;
  outputMint: string;
  amountRaw: number;
  slippageBps: number;
  /** 0 = без реферальной комиссии. */
  platformFeeBps: number;
}

export function buildJupiterQuoteParams(
  opts: JupiterQuoteParamsInput
): Record<string, number | string> {
  const params: Record<string, number | string> = {
    inputMint: opts.inputMint,
    outputMint: opts.outputMint,
    amount: opts.amountRaw,
    slippageBps: opts.slippageBps,
  };
  if (opts.platformFeeBps > 0) {
    params.platformFeeBps = opts.platformFeeBps;
  }
  return params;
}

export interface JupiterSwapBodyInput {
  quoteResponse: unknown;
  userPublicKey: string;
  /** Пустая строка = реферальная комиссия не настроена. */
  feeAccount: string;
}

export function buildJupiterSwapBody(opts: JupiterSwapBodyInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    quoteResponse: opts.quoteResponse,
    userPublicKey: opts.userPublicKey,
    wrapAndUnwrapSol: true,
  };
  if (opts.feeAccount) {
    body.feeAccount = opts.feeAccount;
  }
  return body;
}

import { describe, it, expect } from 'vitest';
import { buildJupiterQuoteParams, buildJupiterSwapBody } from '../src/shared/jupiter';

describe('buildJupiterQuoteParams', () => {
  it('не добавляет platformFeeBps, если реферальная комиссия выключена (0)', () => {
    const params = buildJupiterQuoteParams({
      inputMint: 'TOKEN',
      outputMint: 'SOL',
      amountRaw: 1000,
      slippageBps: 100,
      platformFeeBps: 0,
    });
    expect(params).not.toHaveProperty('platformFeeBps');
    expect(params).toEqual({
      inputMint: 'TOKEN',
      outputMint: 'SOL',
      amount: 1000,
      slippageBps: 100,
    });
  });

  it('добавляет platformFeeBps, если реферальная комиссия настроена', () => {
    const params = buildJupiterQuoteParams({
      inputMint: 'TOKEN',
      outputMint: 'SOL',
      amountRaw: 1000,
      slippageBps: 100,
      platformFeeBps: 50,
    });
    expect(params.platformFeeBps).toBe(50);
  });
});

describe('buildJupiterSwapBody', () => {
  it('не добавляет feeAccount, если он не задан', () => {
    const body = buildJupiterSwapBody({
      quoteResponse: { foo: 'bar' },
      userPublicKey: 'USER',
      feeAccount: '',
    });
    expect(body).not.toHaveProperty('feeAccount');
    expect(body).toEqual({
      quoteResponse: { foo: 'bar' },
      userPublicKey: 'USER',
      wrapAndUnwrapSol: true,
    });
  });

  it('добавляет feeAccount, если он задан', () => {
    const body = buildJupiterSwapBody({
      quoteResponse: { foo: 'bar' },
      userPublicKey: 'USER',
      feeAccount: 'FEE_ACCOUNT_PUBKEY',
    });
    expect(body.feeAccount).toBe('FEE_ACCOUNT_PUBKEY');
  });
});

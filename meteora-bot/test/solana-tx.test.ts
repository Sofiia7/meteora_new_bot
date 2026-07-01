import { describe, it, expect } from 'vitest';
import { ComputeBudgetProgram, Keypair, TransactionInstruction, PublicKey } from '@solana/web3.js';
import { stripComputeBudgetInstructions } from '../src/shared/solana-tx';

function fakeIx(programId: PublicKey): TransactionInstruction {
  return new TransactionInstruction({ keys: [], programId, data: Buffer.alloc(0) });
}

describe('stripComputeBudgetInstructions', () => {
  it('вырезает ComputeBudget-инструкции (напр. setComputeUnitLimit от DLMM SDK)', () => {
    const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
    const other = fakeIx(Keypair.generate().publicKey);
    const result = stripComputeBudgetInstructions([cuLimit, other]);
    expect(result).toEqual([other]);
  });

  it('не трогает инструкции других программ', () => {
    const a = fakeIx(Keypair.generate().publicKey);
    const b = fakeIx(Keypair.generate().publicKey);
    expect(stripComputeBudgetInstructions([a, b])).toEqual([a, b]);
  });

  it('пустой массив -> пустой массив', () => {
    expect(stripComputeBudgetInstructions([])).toEqual([]);
  });
});

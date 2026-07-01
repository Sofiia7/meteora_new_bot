import { ComputeBudgetProgram, TransactionInstruction } from '@solana/web3.js';

/**
 * Некоторые методы @meteora-ag/dlmm SDK (напр. initializePositionAndAddLiquidityByStrategy)
 * сами добавляют ComputeBudgetProgram.setComputeUnitLimit в возвращаемую транзакцию.
 * lp-manager.sendTransaction() тоже добавляет свой priority-fee (limit+price) —
 * без фильтрации получаем дубль инструкции, и Solana runtime валит tx с
 * «Transaction contains a duplicate instruction».
 */
export function stripComputeBudgetInstructions(
  instructions: TransactionInstruction[]
): TransactionInstruction[] {
  return instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));
}

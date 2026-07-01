import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Transaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import DLMM, { LbPosition, StrategyType } from '@meteora-ag/dlmm';
import BN from 'bn.js';
import bs58 from 'bs58';
import axios from 'axios';
import { config, isMainnetTradingEnabled } from '../../shared/config';
import { logger } from '../../shared/logger';
import { Positions } from '../../shared/repositories';
import { PoolInfo, Position } from '../../shared/types';
import { buildJupiterQuoteParams, buildJupiterSwapBody } from '../../shared/jupiter';
import { stripComputeBudgetInstructions } from '../../shared/solana-tx';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export class LpManager {
  private connection: Connection;
  private wallet: Keypair;

  constructor() {
    this.connection = new Connection(config.solana.rpcUrl, 'confirmed');
    this.wallet = Keypair.fromSecretKey(bs58.decode(config.solana.privateKey));
    logger.info(`Wallet: ${this.wallet.publicKey.toBase58()}`);
  }

  getWalletAddress(): string {
    return this.wallet.publicKey.toBase58();
  }

  getActivePositionCount(): number {
    return Positions.countActive();
  }

  canOpenPosition(): boolean {
    return this.getActivePositionCount() < config.lp.maxPositions;
  }

  /**
   * Проверка баланса перед открытием: LP_AMOUNT_SOL + rent + buffer (раздел 3.4 ТЗ).
   * Возвращает null если ОК, иначе — описание проблемы для уведомления в TG.
   */
  async checkSufficientBalance(): Promise<string | null> {
    try {
      const lamports = await this.connection.getBalance(this.wallet.publicKey);
      const balanceSol = lamports / LAMPORTS_PER_SOL;

      const lpAmount = config.lp.amountSol;
      const bufferAbs = config.lp.safetyBufferSol;
      const bufferPct = (lpAmount * config.lp.safetyBufferPct) / 100;
      // rent для bin arrays + position (грубая оценка, уточним по факту на devnet).
      const rentEstimate = 0.07;
      const required = lpAmount + rentEstimate + Math.max(bufferAbs, bufferPct);

      if (balanceSol < required) {
        return (
          `Недостаточно SOL: баланс ${balanceSol.toFixed(4)}, нужно ≥ ${required.toFixed(4)} ` +
          `(LP ${lpAmount} + rent ${rentEstimate} + buffer)`
        );
      }
      return null;
    } catch (err) {
      logger.error(`Balance check failed: ${err}`);
      return `Не удалось проверить баланс: ${err}`;
    }
  }

  async openPosition(
    tokenAddress: string,
    tokenSymbol: string,
    pool: PoolInfo
  ): Promise<Position | null> {
    if (!this.canOpenPosition()) {
      logger.warn('Max positions reached, cannot open new position');
      return null;
    }

    // Safety gate: реальные транзакции только при явном разрешении.
    if (!isMainnetTradingEnabled()) {
      logger.warn(
        `[DRY_RUN] openPosition skipped for ${tokenSymbol}. ` +
          `Set DRY_RUN=false и ENABLE_MAINNET_TRADING=true чтобы торговать.`
      );
      return null;
    }

    const balanceError = await this.checkSufficientBalance();
    if (balanceError) {
      logger.warn(`openPosition aborted: ${balanceError}`);
      return null;
    }

    logger.info(`Opening LP position: ${tokenSymbol} in pool ${pool.address}`);

    try {
      const dlmmPool = await DLMM.create(this.connection, new PublicKey(pool.address));
      await dlmmPool.refetchStates();

      const activeBin = await dlmmPool.getActiveBin();
      const activeBinId = activeBin.binId;
      const currentPrice = parseFloat(dlmmPool.fromPricePerLamport(Number(activeBin.price)));

      const solAmountLamports = Math.floor(config.lp.amountSol * LAMPORTS_PER_SOL);

      // Определяем, какая сторона пула — SOL. Раньше код жёстко считал SOL=Y,
      // что на половине пулов даёт неверный side и упавшую транзакцию.
      const xIsSol = dlmmPool.tokenX.publicKey.toBase58() === WSOL_MINT;
      const yIsSol = dlmmPool.tokenY.publicKey.toBase58() === WSOL_MINT;
      if (!xIsSol && !yIsSol) {
        logger.error(`Pool ${pool.address} не является SOL-парой — single-sided SOL невозможен`);
        return null;
      }

      // Single-sided депозит «только солью» работает корректно только когда
      // ВЕСЬ диапазон лежит по ОДНУ сторону от активного бина — со стороны,
      // куда «вырастет цена». При покупке мемкоина другими его цена в SOL
      // растёт; в каком направлении это «выше binId» — зависит от того, какая
      // сторона пула SOL.
      //   - SOL = Y (Y/X = price): рост цены мемкоина = binId растёт → ликвидность ВЫШЕ active.
      //   - SOL = X: всё инвертировано → ликвидность НИЖЕ active.
      // Диапазон по ТЗ: от текущей цены до +(priceRangeUpper)% — берём только
      // верхнюю/нижнюю «полку», игнорируя priceRangeLower для single-sided
      // (защита −90% обеспечивается тем, что наш SOL автоматически
      // конвертируется в токен ПО ХОДУ роста, а не сразу).
      const upperPriceMultiplier = 1 + config.lp.priceRangeUpper / 100;
      const upperBinId = dlmmPool.getBinIdFromPrice(currentPrice * upperPriceMultiplier, false);

      let minBinId: number;
      let maxBinId: number;
      let totalXAmount: BN;
      let totalYAmount: BN;
      if (yIsSol) {
        // SOL = Y. Кладём Y, диапазон активный бин → upperBinId.
        minBinId = activeBinId + 1;
        maxBinId = Math.max(upperBinId, minBinId);
        totalXAmount = new BN(0);
        totalYAmount = new BN(solAmountLamports);
      } else {
        // SOL = X. Кладём X, диапазон lowerBinId → активный бин.
        const lowerPriceMultiplier = 1 / upperPriceMultiplier; // зеркально
        const lowerBinId = dlmmPool.getBinIdFromPrice(currentPrice * lowerPriceMultiplier, true);
        maxBinId = activeBinId - 1;
        minBinId = Math.min(lowerBinId, maxBinId);
        totalXAmount = new BN(solAmountLamports);
        totalYAmount = new BN(0);
      }

      logger.info(
        `LP plan: SOL side=${yIsSol ? 'Y' : 'X'}, bins [${minBinId}..${maxBinId}], active=${activeBinId}`
      );

      const positionKp = Keypair.generate();

      const tx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: positionKp.publicKey,
        user: this.wallet.publicKey,
        totalXAmount,
        totalYAmount,
        strategy: {
          maxBinId,
          minBinId,
          strategyType: StrategyType.Spot,
        },
      });

      const signature = await this.sendTransaction(tx as Transaction, [positionKp]);
      logger.info(`Position opened: ${signature}, pubkey: ${positionKp.publicKey.toBase58()}`);

      const id = Positions.insert({
        tokenAddress,
        tokenSymbol,
        poolAddress: pool.address,
        feeBps: pool.feeBps,
        binStep: pool.binStep,
        entryPrice: currentPrice,
        solAmount: config.lp.amountSol,
        positionPubkey: positionKp.publicKey.toBase58(),
      });

      return {
        id,
        tokenAddress,
        tokenSymbol,
        poolAddress: pool.address,
        feeBps: pool.feeBps,
        binStep: pool.binStep,
        entryPrice: currentPrice,
        solAmount: config.lp.amountSol,
        positionPubkey: positionKp.publicKey.toBase58(),
        status: 'active',
        openedAt: Math.floor(Date.now() / 1000),
        closedAt: null,
        pnlSol: null,
      };
    } catch (err) {
      logger.error(`Failed to open position: ${err}`);
      return null;
    }
  }

  async closePosition(positionId: number): Promise<{ pnlSol: number } | null> {
    // Идемпотентность: атомарный переход active → closing. Если кто-то уже
    // закрывает позицию (двойной клик / гонка panic+manual) — здесь второй
    // вызов получит false и тихо выйдет.
    if (!Positions.markClosing(positionId)) {
      logger.info(`Position ${positionId} is not active (already closing/closed) — skip`);
      return null;
    }

    const position = Positions.findById(positionId);
    if (!position) {
      logger.warn(`Position ${positionId} disappeared after markClosing`);
      return null;
    }

    if (!isMainnetTradingEnabled()) {
      logger.warn(
        `[DRY_RUN] closePosition skipped for position ${positionId}. ` +
          `Откатываю статус active.`
      );
      Positions.markActiveAgain(positionId);
      return null;
    }

    logger.info(`Closing position ${positionId} for ${position.tokenSymbol}`);

    // PnL считаем по дельте SOL-баланса кошелька — это автоматически учитывает
    // снятие ликвидности, заклеймленные fees, газ и slippage свопа. Никакого
    // ручного сложения feeX (мемкоин) + feeY (SOL).
    const solBalanceBefore = await this.connection.getBalance(this.wallet.publicKey);

    try {
      const dlmmPool = await DLMM.create(this.connection, new PublicKey(position.poolAddress));
      await dlmmPool.refetchStates();

      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(this.wallet.publicKey);
      const userPosition = userPositions.find(
        (p: LbPosition) => p.publicKey.toBase58() === position.positionPubkey
      );

      if (!userPosition) {
        // Позиции нет on-chain → НИ В КОЕМ СЛУЧАЕ не свопим (раньше код свопил).
        // Возможные причины: позиция закрыта вручную через Meteora UI, или
        // вообще никогда не открылась (DRY_RUN-история). Фиксируем как closed
        // с pnl=null, чтобы не дёргать её повторно.
        logger.warn(`Position ${positionId} not found on-chain — marking closed without swap`);
        Positions.markClosed(positionId, null);
        return { pnlSol: 0 };
      }

      // 1. Claim fees.
      const claimTxs = await dlmmPool.claimAllRewardsByPosition({
        owner: this.wallet.publicKey,
        position: userPosition,
      });
      for (const tx of claimTxs) {
        await this.sendTransaction(tx as Transaction);
      }
      logger.info(`Fees claimed for position ${positionId}`);

      // 2. Remove all liquidity.
      const { lowerBinId, upperBinId } = userPosition.positionData;
      const removeTxs = await dlmmPool.removeLiquidity({
        user: this.wallet.publicKey,
        position: userPosition.publicKey,
        fromBinId: lowerBinId,
        toBinId: upperBinId,
        bps: new BN(10000),
        shouldClaimAndClose: true,
      });
      for (const tx of Array.isArray(removeTxs) ? removeTxs : [removeTxs]) {
        await this.sendTransaction(tx as Transaction);
      }
      logger.info(`Liquidity removed for position ${positionId}`);

      // 3. Swap полученный мемкоин → SOL (если что-то осталось).
      const tokenBalance = await this.getTokenBalance(position.tokenAddress);
      if (tokenBalance > 0) {
        const got = await this.swapTokenToSol(position.tokenAddress, tokenBalance);
        logger.info(`Swapped ${tokenBalance} token → ~${got.toFixed(4)} SOL`);
      }

      // 4. Финальная дельта баланса.
      const solBalanceAfter = await this.connection.getBalance(this.wallet.publicKey);
      const pnlSol = (solBalanceAfter - solBalanceBefore) / LAMPORTS_PER_SOL - position.solAmount;
      // ↑ position.solAmount — то, что мы УЖЕ потратили в openPosition (вошло
      // в solBalanceBefore? — нет: solAmount был списан раньше). Поэтому:
      //   до   = баланс ПОСЛЕ входа в позицию (минус газ входа)
      //   после = баланс после полного exit
      // delta = после − до = (что нам вернули LP+fees+swap) − (ничего)
      // Это и есть «сколько SOL мы получили обратно». PnL относительно входа:
      //   pnl = delta − solAmount
      // (мы хотим знать «сколько заработали/потеряли поверх первоначальной 2.5 SOL»).

      Positions.markClosed(positionId, pnlSol);
      return { pnlSol };
    } catch (err) {
      logger.error(`Failed to close position ${positionId}: ${err}`);
      // На ошибке откатываем status обратно в active, чтобы можно было
      // попробовать ещё раз (вручную или через panic).
      Positions.markActiveAgain(positionId);
      return null;
    }
  }

  /**
   * Доля **unclaimed** комиссий относительно вложенной SOL-позиции.
   * Корректно приводит токеновую сторону комиссии к SOL по текущей цене пула,
   * не складывает разные активы как раньше.
   *
   * Это всё ещё приближение: реальные decimals токена X берутся через RPC.
   */
  async getFeesRatio(position: Position): Promise<number> {
    try {
      const dlmmPool = await DLMM.create(this.connection, new PublicKey(position.poolAddress));
      await dlmmPool.refetchStates();

      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(this.wallet.publicKey);
      const userPos = userPositions.find(
        (p: LbPosition) => p.publicKey.toBase58() === position.positionPubkey
      );
      if (!userPos) return 0;

      // Определяем какая сторона — SOL. Token Y в Meteora DLMM обычно "quote".
      const tokenXMint = dlmmPool.tokenX.publicKey.toBase58();
      const tokenYMint = dlmmPool.tokenY.publicKey.toBase58();
      const xIsSol = tokenXMint === WSOL_MINT;
      const yIsSol = tokenYMint === WSOL_MINT;

      // Decimals токенов — из SDK (Meteora их кладёт в tokenX/Y).
      const decX = (dlmmPool.tokenX as { decimal?: number }).decimal ?? 9;
      const decY = (dlmmPool.tokenY as { decimal?: number }).decimal ?? 9;

      const feeXraw = userPos.positionData.feeX.toNumber();
      const feeYraw = userPos.positionData.feeY.toNumber();
      const feeX = feeXraw / 10 ** decX;
      const feeY = feeYraw / 10 ** decY;

      // Цена пула: SOL за 1 token (если SOL=Y) или token за 1 SOL (если SOL=X).
      const activeBin = await dlmmPool.getActiveBin();
      const priceYperX = parseFloat(dlmmPool.fromPricePerLamport(Number(activeBin.price)));
      // priceYperX = сколько Y нужно отдать за 1 X.

      let feeInSol: number;
      if (yIsSol) {
        // Token = X (memcoin), SOL = Y. feeX_in_SOL = feeX * priceYperX.
        feeInSol = feeY + feeX * priceYperX;
      } else if (xIsSol) {
        // Token = Y (memcoin), SOL = X. feeY_in_SOL = feeY / priceYperX.
        const priceXperY = priceYperX > 0 ? 1 / priceYperX : 0;
        feeInSol = feeX + feeY * priceXperY;
      } else {
        // Не SOL-пара (странно, в нашем сценарии не должно быть). Игнорим.
        return 0;
      }

      return feeInSol / position.solAmount;
    } catch {
      return 0;
    }
  }

  async getCurrentPrice(poolAddress: string): Promise<number | null> {
    try {
      const dlmmPool = await DLMM.create(this.connection, new PublicKey(poolAddress));
      await dlmmPool.refetchStates();
      const activeBin = await dlmmPool.getActiveBin();
      return parseFloat(dlmmPool.fromPricePerLamport(Number(activeBin.price)));
    } catch {
      return null;
    }
  }

  private async getTokenBalance(tokenMint: string): Promise<number> {
    try {
      const accounts = await this.connection.getParsedTokenAccountsByOwner(
        this.wallet.publicKey,
        { mint: new PublicKey(tokenMint) }
      );
      if (!accounts.value.length) return 0;
      return (accounts.value[0].account.data as any).parsed.info.tokenAmount.uiAmount ?? 0;
    } catch {
      return 0;
    }
  }

  private async swapTokenToSol(tokenMint: string, amount: number): Promise<number> {
    try {
      const decimalsInfo = await this.connection.getParsedAccountInfo(new PublicKey(tokenMint));
      const decimals = (decimalsInfo.value?.data as any)?.parsed?.info?.decimals ?? 9;
      const amountRaw = Math.floor(amount * 10 ** decimals);

      const quoteResp = await axios.get(`${config.jupiter.apiBase}/quote`, {
        params: buildJupiterQuoteParams({
          inputMint: tokenMint,
          outputMint: WSOL_MINT,
          amountRaw,
          slippageBps: config.lp.swapSlippageBps,
          platformFeeBps: config.jupiter.platformFeeBps,
        }),
        timeout: 10000,
      });

      const quote = quoteResp.data;

      const swapResp = await axios.post(
        `${config.jupiter.apiBase}/swap`,
        buildJupiterSwapBody({
          quoteResponse: quote,
          userPublicKey: this.wallet.publicKey.toBase58(),
          feeAccount: config.jupiter.feeAccount,
        }),
        { timeout: 15000 }
      );

      const swapTx = VersionedTransaction.deserialize(
        Buffer.from(swapResp.data.swapTransaction, 'base64')
      );
      swapTx.sign([this.wallet]);

      const sig = await this.connection.sendRawTransaction(swapTx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });
      await this.connection.confirmTransaction(sig, 'confirmed');

      const outAmount = parseInt(quote.outAmount ?? '0', 10);
      return outAmount / LAMPORTS_PER_SOL;
    } catch (err) {
      logger.error(`Jupiter swap failed: ${err}`);
      return 0;
    }
  }

  /**
   * Отправка транзакции с защитой:
   *   - Priority fee (ComputeBudgetProgram) — без него на мейннете
   *     при волатильности мемов транзакции массово фейлятся.
   *   - simulate() перед отправкой — ловим явные ошибки до уплаты газа.
   *   - retry с exponential backoff на свежий blockhash.
   *
   * Версионные транзакции (от Jupiter и т.п.) подписываются и отправляются
   * отдельно — здесь только legacy Transaction (Meteora DLMM SDK).
   */
  private async sendTransaction(tx: Transaction, extraSigners: Keypair[] = []): Promise<string> {
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // Свежий blockhash на каждой попытке (старый может протухнуть).
        const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash(
          'confirmed'
        );

        // Pure-функция: создаём НОВЫЙ Transaction, чтобы не множить
        // ComputeBudget-инструкции при ретраях.
        const builtTx = new Transaction();
        builtTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
        builtTx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
        // DLMM SDK иногда сам добавляет свой ComputeBudget.setComputeUnitLimit
        // (напр. initializePositionAndAddLiquidityByStrategy) — не дублируем,
        // иначе runtime валит tx: "Transaction contains a duplicate instruction".
        for (const ix of stripComputeBudgetInstructions(tx.instructions)) builtTx.add(ix);
        builtTx.recentBlockhash = blockhash;
        builtTx.feePayer = this.wallet.publicKey;
        builtTx.sign(this.wallet, ...extraSigners);

        // Симуляция: если SDK/программа вернёт ошибку — узнаем заранее.
        // Не критично: если RPC отказывает в simulate, продолжаем.
        try {
          const sim = await this.connection.simulateTransaction(builtTx);
          if (sim.value.err) {
            const logs = sim.value.logs?.slice(-5).join(' | ') ?? '';
            throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)} | ${logs}`);
          }
        } catch (simErr) {
          // На некоторых RPC simulate может возвращать transient error даже
          // при валидной tx. Если это наш бросок «Simulation failed» — пробрасываем.
          if (simErr instanceof Error && simErr.message.startsWith('Simulation failed')) {
            throw simErr;
          }
          logger.warn(`simulate() unavailable, продолжаем без проверки: ${simErr}`);
        }

        const sig = await this.connection.sendRawTransaction(builtTx.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        });
        await this.connection.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          'confirmed'
        );
        if (attempt > 1) logger.info(`tx ${sig} confirmed on attempt ${attempt}`);
        return sig;
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_ATTEMPTS) {
          const delay = 1000 * 2 ** (attempt - 1); // 1s, 2s
          logger.warn(`sendTransaction attempt ${attempt} failed: ${err}. Retrying in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw new Error(`sendTransaction failed after ${MAX_ATTEMPTS} attempts: ${lastErr}`);
  }
}

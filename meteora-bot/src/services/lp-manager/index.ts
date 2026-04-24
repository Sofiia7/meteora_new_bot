import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Transaction,
} from '@solana/web3.js';
import DLMM, { LbPosition, StrategyType } from '@meteora-ag/dlmm';
import BN from 'bn.js';
import bs58 from 'bs58';
import axios from 'axios';
import { config } from '../../shared/config';
import { logger } from '../../shared/logger';
import { getDb } from '../../shared/db';
import { PoolInfo, Position } from '../../shared/types';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6';

export class LpManager {
  private connection: Connection;
  private wallet: Keypair;

  constructor() {
    this.connection = new Connection(config.solana.rpcUrl, 'confirmed');
    this.wallet = Keypair.fromSecretKey(bs58.decode(config.solana.privateKey));
    logger.info(`Wallet: ${this.wallet.publicKey.toBase58()}`);
  }

  getActivePositionCount(): number {
    const db = getDb();
    const row = db
      .prepare(`SELECT COUNT(*) as cnt FROM positions WHERE status='active'`)
      .get() as { cnt: number };
    return row.cnt;
  }

  canOpenPosition(): boolean {
    return this.getActivePositionCount() < config.lp.maxPositions;
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

    logger.info(`Opening LP position: ${tokenSymbol} in pool ${pool.address}`);

    try {
      const dlmmPool = await DLMM.create(this.connection, new PublicKey(pool.address));
      await dlmmPool.refetchStates();

      const activeBin = await dlmmPool.getActiveBin();
      const currentPrice = parseFloat(dlmmPool.fromPricePerLamport(Number(activeBin.price)));

      const solAmountLamports = Math.floor(config.lp.amountSol * LAMPORTS_PER_SOL);

      const lowerPriceMultiplier = 1 + config.lp.priceRangeLower / 100;
      const upperPriceMultiplier = 1 + config.lp.priceRangeUpper / 100;

      // getBinIdFromPrice is an instance method taking (price, min) - no binStep arg
      const minBinId = dlmmPool.getBinIdFromPrice(currentPrice * lowerPriceMultiplier, true);
      const maxBinId = dlmmPool.getBinIdFromPrice(currentPrice * upperPriceMultiplier, false);

      // Single-sided SOL liquidity (SOL is Y token in most Meteora pairs)
      const totalXAmount = new BN(0);
      const totalYAmount = new BN(solAmountLamports);

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

      const db = getDb();
      const result = db
        .prepare(
          `INSERT INTO positions
           (token_address, token_symbol, pool_address, fee_bps, bin_step, entry_price, sol_amount, position_pubkey, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`
        )
        .run(
          tokenAddress,
          tokenSymbol,
          pool.address,
          pool.feeBps,
          pool.binStep,
          currentPrice,
          config.lp.amountSol,
          positionKp.publicKey.toBase58()
        );

      return {
        id: result.lastInsertRowid as number,
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
    const db = getDb();
    const position = db
      .prepare(`SELECT * FROM positions WHERE id=? AND status='active'`)
      .get(positionId) as Position | undefined;

    if (!position) {
      logger.warn(`Position ${positionId} not found or already closed`);
      return null;
    }

    logger.info(`Closing position ${positionId} for ${position.tokenSymbol}`);

    try {
      const dlmmPool = await DLMM.create(this.connection, new PublicKey(position.poolAddress));
      await dlmmPool.refetchStates();

      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(this.wallet.publicKey);
      const userPosition = userPositions.find(
        (p: LbPosition) => p.publicKey.toBase58() === position.positionPubkey
      );

      if (userPosition) {
        // 1. Claim fees first
        const claimTxs = await dlmmPool.claimAllRewardsByPosition({
          owner: this.wallet.publicKey,
          position: userPosition,
        });
        for (const tx of claimTxs) {
          await this.sendTransaction(tx as Transaction);
        }
        logger.info(`Fees claimed for position ${positionId}`);

        // 2. Remove all liquidity
        const { lowerBinId, upperBinId } = userPosition.positionData;
        const removeTxs = await dlmmPool.removeLiquidity({
          user: this.wallet.publicKey,
          position: userPosition.publicKey,
          fromBinId: lowerBinId,
          toBinId: upperBinId,
          bps: new BN(10000), // 100%
          shouldClaimAndClose: true,
        });

        for (const tx of Array.isArray(removeTxs) ? removeTxs : [removeTxs]) {
          await this.sendTransaction(tx as Transaction);
        }
        logger.info(`Liquidity removed for position ${positionId}`);
      } else {
        logger.warn(`Position ${positionId} not found on-chain`);
      }

      // 3. Swap accumulated token → SOL via Jupiter
      const tokenBalance = await this.getTokenBalance(position.tokenAddress);
      let swappedSol = 0;
      if (tokenBalance > 0) {
        swappedSol = await this.swapTokenToSol(position.tokenAddress, tokenBalance);
        logger.info(`Swapped ${tokenBalance} token → ${swappedSol.toFixed(4)} SOL`);
      }

      // 4. PnL = swapped SOL + fees earned - initial investment
      // Approximate: difference in SOL balance covers fees + swap proceeds
      const pnlSol = swappedSol - position.solAmount;

      // 5. Update DB
      db.prepare(
        `UPDATE positions SET status='closed', closed_at=unixepoch(), pnl_sol=? WHERE id=?`
      ).run(pnlSol, positionId);

      return { pnlSol };
    } catch (err) {
      logger.error(`Failed to close position ${positionId}: ${err}`);
      return null;
    }
  }

  async getClaimedFeesRatio(position: Position): Promise<number> {
    try {
      const dlmmPool = await DLMM.create(this.connection, new PublicKey(position.poolAddress));
      await dlmmPool.refetchStates();

      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(this.wallet.publicKey);
      const userPos = userPositions.find(
        (p: LbPosition) => p.publicKey.toBase58() === position.positionPubkey
      );

      if (!userPos) return 0;

      const feeX = userPos.positionData.feeX.toNumber() / LAMPORTS_PER_SOL;
      const feeY = userPos.positionData.feeY.toNumber() / LAMPORTS_PER_SOL;
      const totalFees = feeX + feeY;

      return totalFees / position.solAmount;
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

      const quoteResp = await axios.get(`${JUPITER_QUOTE_API}/quote`, {
        params: {
          inputMint: tokenMint,
          outputMint: WSOL_MINT,
          amount: amountRaw,
          slippageBps: config.lp.swapSlippageBps,
        },
        timeout: 10000,
      });

      const quote = quoteResp.data;

      const swapResp = await axios.post(
        `${JUPITER_QUOTE_API}/swap`,
        {
          quoteResponse: quote,
          userPublicKey: this.wallet.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
        },
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

  private async sendTransaction(tx: Transaction, extraSigners: Keypair[] = []): Promise<string> {
    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.wallet.publicKey;
    tx.sign(this.wallet, ...extraSigners);

    const sig = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    await this.connection.confirmTransaction(sig, 'confirmed');
    return sig;
  }
}

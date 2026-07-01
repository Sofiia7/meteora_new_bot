// Одноразовая утилита: создаёт (если не существует) associated token account
// для Wrapped SOL под заданным кошельком. Нужен один раз, чтобы получить
// адрес для JUPITER_FEE_ACCOUNT (см. README → "Optional swap fee").
//
// Работает с ЛЮБЫМ приватным ключом — просто подставь его в WALLET_PRIVATE_KEY
// перед запуском. Ключ читается ТОЛЬКО из переменной окружения твоего
// локального терминала и никуда не отправляется и не сохраняется.
//
// Запуск (PowerShell, из папки meteora-bot — здесь уже стоит node_modules):
//   $env:WALLET_PRIVATE_KEY = "<base58 приватник, полный, из Phantom → Show Private Key → Copy>"
//   node scripts/create-fee-token-account.js
//   Remove-Item Env:\WALLET_PRIVATE_KEY   # после — очистить из сессии терминала
//
// Нужно ~0.003 SOL на кошельке (rent + комиссия).

const { Connection, Keypair, PublicKey, sendAndConfirmTransaction, Transaction } = require('@solana/web3.js');
const {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');
const bs58 = require('bs58').default;

const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';

async function main() {
  const pk = process.env.WALLET_PRIVATE_KEY;
  if (!pk) {
    console.error('Задай WALLET_PRIVATE_KEY (base58 приватник) в переменной окружения.');
    process.exit(1);
  }

  let wallet;
  try {
    wallet = Keypair.fromSecretKey(bs58.decode(pk));
  } catch (err) {
    console.error(
      'Ключ невалиден (provided secretKey is invalid). Обычно это обрыв символа при копировании — ' +
        'экспортируй заново через Phantom → аккаунт → Show Private Key → кнопка Copy (не выделять текст руками).'
    );
    process.exit(1);
  }

  const conn = new Connection(RPC_URL, 'confirmed');

  const ata = getAssociatedTokenAddressSync(WSOL_MINT, wallet.publicKey);
  console.log('Кошелёк:', wallet.publicKey.toBase58());
  console.log('Адрес wSOL token-account (детерминированный):', ata.toBase58());

  const existing = await conn.getAccountInfo(ata);
  if (existing) {
    console.log('Уже существует на чейне — можно использовать в JUPITER_FEE_ACCOUNT прямо сейчас.');
    return;
  }

  const bal = await conn.getBalance(wallet.publicKey);
  console.log('Баланс SOL:', bal / 1e9);
  if (bal < 0.003 * 1e9) {
    console.error('Нужно ~0.003 SOL на rent + комиссию, баланс маловат.');
    process.exit(1);
  }

  const ix = createAssociatedTokenAccountInstruction(
    wallet.publicKey, // payer
    ata,
    wallet.publicKey, // owner
    WSOL_MINT,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(conn, tx, [wallet]);
  console.log('Создано. Tx:', sig);
  console.log('Используй в JUPITER_FEE_ACCOUNT:', ata.toBase58());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

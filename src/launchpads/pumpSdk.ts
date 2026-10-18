// pump.fun create_v2 (+ optional buy_v2 dev buy) built locally with the official SDK, the same
// instructions pump.fun's own frontend sends. Lazy-loaded: the SDK is ~250 KB gzipped.
import { PUMP_SDK, OnlinePumpSdk, getBuyTokenAmountFromSolAmount } from '@pump-fun/pump-sdk';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import BN from 'bn.js';

export const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
/** pump.fun frontend's lookup table; without it create_v2 + buy_v2 is too big for one transaction. */
export const PUMP_ALT = 'Hyif6eWb8x88RVrvjPfabsgRYnwkVnyByEXTVTXbUcyP';

export interface PumpSdkArgs {
  rpcUrl: string;
  creator: string;
  name: string;
  symbol: string;
  uri: string;
  devBuySol: number;
  priorityMicroLamports?: number;
}

export async function buildPumpSdkTx(a: PumpSdkArgs, mint: Keypair = Keypair.generate()): Promise<{ tx: VersionedTransaction; mint: Keypair }> {
  const connection = new Connection(a.rpcUrl, 'confirmed');
  const user = new PublicKey(a.creator);
  const common = { mint: mint.publicKey, name: a.name, symbol: a.symbol, uri: a.uri, creator: user, user, mayhemMode: false };
  let ixs;
  let units: number;
  if (!a.devBuySol) {
    ixs = [await PUMP_SDK.createV2Instruction(common)];
    units = 150_000;
  } else {
    const online = new OnlinePumpSdk(connection);
    const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig()]);
    // quoteAmount is the total SOL the creator spends on the buy, fees included.
    const quoteAmount = new BN(Math.round(a.devBuySol * 1e9));
    const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: quoteAmount, quoteMint: NATIVE_MINT });
    ixs = await PUMP_SDK.createV2AndBuyV2Instructions({ ...common, global, amount, quoteAmount });
    units = 300_000;
  }
  const [alt, bh] = await Promise.all([
    connection.getAddressLookupTable(new PublicKey(PUMP_ALT)),
    connection.getLatestBlockhash('confirmed'),
  ]);
  const message = new TransactionMessage({
    payerKey: user,
    recentBlockhash: bh.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: a.priorityMicroLamports ?? 100_000 }),
      ...ixs,
    ],
  }).compileToV0Message(alt.value ? [alt.value] : []);
  const tx = new VersionedTransaction(message);
  tx.sign([mint]);
  return { tx, mint };
}

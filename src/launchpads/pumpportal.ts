// Builds launch transactions through PumpPortal's Local Transaction API (https://pumpportal.fun),
// which returns an unsigned transaction that targets the launchpad's own on-chain program.
// The fresh mint keypair is generated in the browser and signs here; the wallet adds the payer signature.
import { Keypair, VersionedTransaction } from '@solana/web3.js';

export const PUMPPORTAL_URL = 'https://pumpportal.fun/api/trade-local';

export interface CreateRequest {
  creator: string;
  name: string;
  symbol: string;
  uri: string;
  devBuySol: number;
  pool: 'pump' | 'bonk';
  slippage?: number;
  priorityFeeSol?: number;
}

export async function buildCreateTx(
  req: CreateRequest,
  fetchImpl: typeof fetch = fetch,
  mint: Keypair = Keypair.generate(),
): Promise<{ tx: VersionedTransaction; mint: Keypair }> {
  const res = await fetchImpl(PUMPPORTAL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey: req.creator,
      action: 'create',
      tokenMetadata: { name: req.name, symbol: req.symbol, uri: req.uri },
      mint: mint.publicKey.toBase58(),
      denominatedInSol: 'true',
      amount: req.devBuySol,
      slippage: req.slippage ?? 10,
      priorityFee: req.priorityFeeSol ?? 0.00005,
      pool: req.pool,
    }),
  });
  if (res.status !== 200) {
    const text = await res.text().catch(() => '');
    throw new Error(`PumpPortal ${res.status}: ${text.slice(0, 200) || res.statusText}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(bytes);
  } catch {
    throw new Error(`PumpPortal returned something that is not a transaction: ${new TextDecoder().decode(bytes.slice(0, 160))}`);
  }
  assertTx(tx, req.creator, mint.publicKey.toBase58());
  tx.sign([mint]);
  return { tx, mint };
}

/** Defensive checks so a misbehaving API can't hand the wallet something unexpected to sign. */
export function assertTx(tx: VersionedTransaction, creator: string, mint: string): void {
  const m = tx.message;
  const signers = m.staticAccountKeys.slice(0, m.header.numRequiredSignatures).map((k) => k.toBase58());
  if (signers[0] !== creator) throw new Error('Launch transaction has an unexpected fee payer. Aborting.');
  if (!signers.includes(mint)) throw new Error('Launch transaction is not signed by the new mint. Aborting.');
  const extra = signers.filter((s) => s !== creator && s !== mint);
  if (extra.length) throw new Error('Launch transaction asks for unexpected signers. Aborting.');
}

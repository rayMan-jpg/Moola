// Shared helpers for mainnet simulation tests. Nothing here ever broadcasts a transaction.
export const RPC = process.env.SIM_RPC ?? 'https://api.mainnet-beta.solana.com';

// Large, plain system-owned wallets used only as *fee payers in simulations* (sigVerify=false).
// We never have or need their keys. Override with SIM_PAYER.
export const CANDIDATE_PAYERS = [
  process.env.SIM_PAYER,
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhLu3oc5',
  'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS',
  '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm',
].filter(Boolean);

export async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

export async function fundedPayer(minSol = 50) {
  for (const a of CANDIDATE_PAYERS) {
    try {
      const r = await rpc('getAccountInfo', [a, { encoding: 'base64' }]);
      const v = r?.value;
      if (v && v.owner === '11111111111111111111111111111111' && v.lamports / 1e9 >= minSol && !v.executable) return a;
    } catch {
      /* try next */
    }
  }
  throw new Error('no funded system-owned payer found; set SIM_PAYER');
}

export async function simulate(txBytes) {
  const b64 = Buffer.from(txBytes).toString('base64');
  const r = await rpc('simulateTransaction', [b64, { sigVerify: false, replaceRecentBlockhash: true, encoding: 'base64', commitment: 'processed' }]);
  return r.value; // { err, logs, unitsConsumed }
}

// Maps wallet / RPC / API failures to short messages a degen can act on.
export function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err);
  const m = (raw || '').toLowerCase();
  if ((err as { friendly?: boolean })?.friendly) return raw;
  if (/user rejected|rejected the request|user denied|declined|cancell?ed by user|4001/.test(m)) return 'you rejected it in the wallet. nothing was paid or launched. hit REA IT when ready.';
  if (/insufficient (funds|lamports)|0x1\b|custom program error: 0x1$|attempt to debit an account but found no record/.test(m)) return 'not enough balance for the payment + launch + fees. top up and retry.';
  if (/blockhash not found|block height exceeded|expired/.test(m)) return 'transaction expired before it landed (you took too long or the network is congested). hit REA IT again.';
  if (/429|too many requests|rate limit/.test(m)) return 'the launchpad API is rate limiting us. wait a few seconds and try again.';
  if (/failed to fetch|networkerror|load failed|network request failed/.test(m)) return 'network error. check your connection (or an ad blocker) and retry.';
  if (/simulation failed|transaction simulation/.test(m)) return `the wallet simulation failed, nothing was sent: ${raw.slice(0, 220)}`;
  return raw.slice(0, 300) || 'something broke. try again.';
}

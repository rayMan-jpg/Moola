// Maps wallet / RPC / API failures to short messages a degen can act on.

const REJECTED = /user rejected|rejected the request|user denied|declined|cancell?ed by user|4001/;

/** The user said no in the wallet. */
export function isRejection(err: unknown): boolean {
  if ((err as { friendly?: boolean })?.friendly) return false;
  return REJECTED.test(rawText(err).toLowerCase()) || (err as { code?: number })?.code === 4001;
}

function rawText(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err);
}

/** Before any money moved (order form, project-page prompts). */
export function friendlyError(err: unknown): string {
  const raw = rawText(err);
  const m = (raw || '').toLowerCase();
  if ((err as { friendly?: boolean })?.friendly) return raw;
  if (isRejection(err)) return 'you rejected it in the wallet. nothing was paid or launched. hit REA IT when ready.';
  // The engine refused a payment that did land: never invite a second one.
  if (/landed after the quote expired|older than the quote/.test(m)) return `your payment landed but the engine refused it (${raw}). don't pay again: contact support with the transaction.`;
  if (/insufficient (funds|lamports)|0x1\b|custom program error: 0x1$|attempt to debit an account but found no record/.test(m)) return 'not enough balance for the payment + launch + fees. top up and retry.';
  if (/blockhash not found|block height exceeded|transaction expired/.test(m)) return 'transaction expired before it landed (you took too long or the network is congested). nothing was charged. hit REA IT again.';
  if (/429|too many requests|rate limit|slow down/.test(m)) return 'getting rate limited. wait a few seconds and try again.';
  if (/failed to fetch|networkerror|load failed|network request failed/.test(m)) return 'network error. check your connection (or an ad blocker) and retry.';
  if (/simulation failed|transaction simulation/.test(m)) return `the wallet simulation failed, nothing was sent: ${raw.slice(0, 220)}`;
  return raw.slice(0, 300) || 'something broke. try again.';
}

export const PAID = 'your payment went through';

/** For after a landed payment: adds that the payment went through when the message doesn't say so. */
export function withPaid(msg: string): string {
  return msg.includes(PAID) ? msg : `${msg} (${PAID}, no need to pay again.)`;
}

/** The payment provably never went through (failed on-chain, expired, dropped): nothing was charged. */
export function notCharged(message: string): Error {
  return Object.assign(new Error(message), { friendly: true, unpaid: true });
}

export function isNotCharged(err: unknown): boolean {
  return (err as { unpaid?: boolean })?.unpaid === true;
}

/**
 * After the payment landed (the token launch, finishing setup): says the money is safe and never
 * tells anyone to pay again.
 */
export function paidError(err: unknown): string {
  const raw = rawText(err);
  const m = (raw || '').toLowerCase();
  if (isNotCharged(err)) return raw;
  if ((err as { friendly?: boolean })?.friendly) return withPaid(raw);
  if (isRejection(err)) return `launch skipped: you rejected it in the wallet. ${PAID} and the job is running; launch from the project page, no extra charge.`;
  const why = /failed to fetch|networkerror|load failed|network request failed/.test(m)
    ? 'network error'
    : /429|too many requests|rate limit/.test(m)
      ? 'rate limited'
      : raw.slice(0, 160) || 'unknown error';
  return `the launch hit a snag (${why}). ${PAID} and the job is running; launch from the project page, no extra charge.`;
}

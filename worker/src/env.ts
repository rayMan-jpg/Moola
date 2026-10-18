export interface Env {
  DB: D1Database;
  /** Claude API key with Managed Agents access. */
  ANTHROPIC_API_KEY: string;
  /** GitHub token that can create repos under GITHUB_OWNER and push to them. */
  GITHUB_TOKEN: string;
  /** User or org that owns the clone repos, e.g. "rea4u-builds". */
  GITHUB_OWNER: string;
  /** HMAC key for quotes. Any long random string. */
  QUOTE_SECRET: string;
  TREASURY_SOLANA?: string;
  TREASURY_EVM?: string;
  /** Comma-separated Solana RPC URLs. */
  SOLANA_RPC?: string;
  /** Comma-separated Robinhood Chain RPC URLs. */
  RH_RPC?: string;
  RH_CHAIN_ID?: string;
  /** Public repo mounted read-only into every session for skills + ECC playbooks. */
  ENGINE_REPO?: string;
  ENGINE_BRANCH?: string;
  /** Public URL of the rea4u site (used for CORS and project page links). */
  SITE_URL?: string;
  /** Extra comma-separated CORS origins (e.g. http://localhost:5173). */
  ALLOWED_ORIGINS?: string;
  /** Overrides the agent model (default claude-opus-5-5). */
  MODEL?: string;
  /** Percent added on top of the Claude budget, default 0. */
  MARGIN_PCT?: string;
  /**
   * Part of each payment held back from the session cap (percent, min 50 cents), default 6. The cap
   * is checked before each model request, so the last request can overshoot it.
   */
  RESERVE_PCT?: string;
}

import type { EngineApi, EngineEvent, OutputFile, SessionParams, SessionSnapshot } from '../../../worker/src/engine';

/** In-memory stand-in for the Managed Agents API (no JSON imports, so Playwright can load it too). */
export class FakeEngine implements EngineApi {
  agents: { id: string; version: number; metadata: Record<string, string> }[] = [];
  envs: { id: string; name: string; hosts: string[]; archived: boolean }[] = [];
  sessions: (SessionParams & { id: string })[] = [];
  snapshot: SessionSnapshot = { status: 'running', spentCents: 0 };
  events: EngineEvent[] = [];
  /** sizeBytes defaults to the text's UTF-8 length. */
  outputs: (Omit<OutputFile, 'sizeBytes'> & { sizeBytes?: number; text: string })[] = [];
  budgets: { id: string; cents: number }[] = [];
  denied: string[][] = [];
  resumed: { id: string; text: string }[] = [];
  /** Session creates that fail before reaching the API. */
  failCreateSession = 0;
  /** Session creates that commit upstream, then report an error (a lost response). */
  failAfterCreateSession = 0;
  findSessionCalls = 0;
  /** Runs inside findAgent / createEnvironment / createSession, e.g. to steal the lease mid-start. */
  onFindAgent?: () => void | Promise<void>;
  onCreateEnvironment?: () => void | Promise<void>;
  onCreateSession?: () => void | Promise<void>;

  async findAgent(name: string) {
    await this.onFindAgent?.();
    return name === 'rea4u-engine' ? (this.agents[0] ?? null) : null;
  }
  async createAgent(cfg: { metadata: Record<string, string> }) {
    const a = { id: `agent_${this.agents.length + 1}`, version: 1, metadata: cfg.metadata };
    this.agents.push(a);
    return a;
  }
  async updateAgent(id: string, version: number, cfg: { metadata: Record<string, string> }) {
    const a = this.agents.find((x) => x.id === id)!;
    a.version = version + 1;
    a.metadata = cfg.metadata;
    return a;
  }
  async createEnvironment(name: string, hosts: string[]) {
    await this.onCreateEnvironment?.();
    const e = { id: `env_${this.envs.length + 1}`, name, hosts, archived: false };
    this.envs.push(e);
    return e.id;
  }
  async archiveEnvironment(id: string) {
    this.envs.find((e) => e.id === id)!.archived = true;
  }
  async createSession(p: SessionParams) {
    await this.onCreateSession?.();
    if (this.failCreateSession > 0) {
      this.failCreateSession--;
      throw new Error('overloaded');
    }
    const s = { ...p, id: `sesn_${this.sessions.length + 1}` };
    this.sessions.push(s);
    if (this.failAfterCreateSession > 0) {
      this.failAfterCreateSession--;
      throw new Error('socket hang up');
    }
    return s.id;
  }
  async findSession(jobId: string) {
    this.findSessionCalls++;
    return this.sessions.find((s) => s.metadata.rea4u_job === jobId)?.id ?? null;
  }
  async retrieveSession() {
    return this.snapshot;
  }
  async recentEvents() {
    return [...this.events].reverse();
  }
  async denyTools(_id: string, ids: string[]) {
    this.denied.push(ids);
  }
  async resume(id: string, text: string) {
    this.resumed.push({ id, text });
  }
  async setBudget(id: string, cents: number) {
    this.budgets.push({ id, cents });
  }
  async listOutputs() {
    return this.outputs.map(({ text, ...o }) => ({ ...o, sizeBytes: o.sizeBytes ?? new TextEncoder().encode(text).length }));
  }
  async downloadText(id: string, maxBytes: number) {
    return this.outputs.find((o) => o.id === id)!.text.slice(0, maxBytes);
  }
}

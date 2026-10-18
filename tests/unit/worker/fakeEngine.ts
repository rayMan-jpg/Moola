import type { EngineApi, EngineEvent, OutputFile, SessionParams, SessionSnapshot } from '../../../worker/src/engine';

/** In-memory stand-in for the Managed Agents API (no JSON imports, so Playwright can load it too). */
export class FakeEngine implements EngineApi {
  agents: { id: string; version: number; metadata: Record<string, string> }[] = [];
  envs: { id: string; name: string; hosts: string[]; archived: boolean }[] = [];
  sessions: (SessionParams & { id: string })[] = [];
  snapshot: SessionSnapshot = { status: 'running', spentCents: 0 };
  events: EngineEvent[] = [];
  outputs: (OutputFile & { text: string })[] = [];
  budgets: { id: string; cents: number }[] = [];
  denied: string[][] = [];
  failCreateSession = 0;

  async findAgent(name: string) {
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
    const e = { id: `env_${this.envs.length + 1}`, name, hosts, archived: false };
    this.envs.push(e);
    return e.id;
  }
  async archiveEnvironment(id: string) {
    this.envs.find((e) => e.id === id)!.archived = true;
  }
  async createSession(p: SessionParams) {
    if (this.failCreateSession > 0) {
      this.failCreateSession--;
      throw new Error('overloaded');
    }
    const s = { ...p, id: `sesn_${this.sessions.length + 1}` };
    this.sessions.push(s);
    return s.id;
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
  async setBudget(id: string, cents: number) {
    this.budgets.push({ id, cents });
  }
  async listOutputs() {
    return this.outputs;
  }
  async downloadText(id: string) {
    return this.outputs.find((o) => o.id === id)!.text;
  }
}

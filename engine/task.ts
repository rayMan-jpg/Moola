// Builds the user.define_outcome event for a rea4u job: the task description and the rubric
// the outcome grader scores each iteration against.

import { TIERS, type Target, type Tier } from '../shared/contract';

export const RUBRIC = `# rea4u job rubric

Grade each criterion on its own. Check the files and git state in /workspace/build and /mnt/session/outputs; don't take the agent's word for it.

## Refused targets
R. If /mnt/session/outputs/rea4u.json has "status": "refused" and a specific "refusal" reason that applies one of the engine's ground rules (impersonation, fraud, credential collection, bypassing access controls, personal data), the outcome is satisfied and the criteria below don't apply. A refusal that is vague, or that names no ground rule, fails.

## Deliverables
1. /mnt/session/outputs/rea4u.json exists, parses as JSON, and has these fields: status ("complete" or "partial"), project (equal to the requested project name), summary, target.url, target.license, target.approach ("fork" or "clean-room"), stack, kind ("static", "server" or "fullstack"), needs (server, database, websockets, cron, storage, env), build, features (a non-empty array), verified (build, smoke).
2. /mnt/session/outputs/SPEC.md exists, is the same as SPEC.md at the repo root, and has all nine sections: Overview, Approach and licence, Features, User flows, Data model, API and integrations, Architecture, Run and deploy, Gaps.
3. The clone is pushed. In /workspace/build, the working tree is clean, origin/main has commits beyond the initial one, and origin/main contains SPEC.md, README.md and rea4u.json.

## Working software
4. A clean install plus the build command from rea4u.json succeeds when the grader runs it in /workspace/build. If it doesn't, verified.build must be false.
5. Every feature with status "done" in rea4u.json is implemented in code: the grader can find its route, component or handler, and it isn't a stub, a TODO or hardcoded placeholder output.
6. The core flow from SPEC.md works end-to-end in the running app, or for a static kind, in the built output.

## Integrity
7. It's rebranded. The original product's name, logo and trademarks don't appear in UI strings, page titles, package names or assets. A single "Inspired by" line in the README is allowed.
8. It respects the licence. If the approach is fork, the original LICENSE file and copyright notices are kept and the README credits the original. If it's clean-room, the repo has no verbatim copies of the original's proprietary source, copy, images or fonts.
9. It has no secrets. The repo contains no API keys, tokens, passwords or private keys. If the code reads env vars, .env.example lists every one.

## Packaging
10. README.md has a local quick start and a deploy section whose commands, output directory, start command and env vars match rea4u.json.
11. The deploy files match the kind. A static kind has a relative-base build pushed to a gh-pages branch. A server or fullstack kind has a Dockerfile that listens on $PORT.
12. It's honest. rea4u.json status, verified.* and the feature statuses match what the grader observes. "complete" requires every core feature in SPEC.md to be done.`;

const SCOPE: Record<Tier, string> = {
  lite: 'Lite: the spec is the main deliverable. Write a complete SPEC.md plus a minimal runnable version of the single most important flow. Mark everything else "todo".',
  standard: 'Standard: write the full SPEC.md plus a working clone of the core features (the main user flows end to end). Mark nice-to-haves "todo" if the budget gets tight.',
  deep: 'Deep: write the full SPEC.md plus a full-featured clone, including secondary features, tests for the important logic, and deploy configs for every host it suits.',
};

export interface TaskInput {
  jobId: string;
  target: Target;
  tier: Tier;
  projectName: string;
  tokenName: string;
  tokenTicker: string;
}

/** The outcome description. Every interpolated value was validated by the worker (URL parser, name regexes). */
export function taskDescription(t: TaskInput): string {
  const where =
    t.target.kind === 'github'
      ? `GitHub repository ${t.target.url}. Clone it with: git clone --depth 1 ${t.target.url}.git /workspace/target`
      : `Website or service ${t.target.url}. Study it through its public pages, docs and network requests.`;
  return `Reverse engineer this target into a working, rebranded clone plus a spec, following the rea4u-reverse-engineer skill.

Target: ${where}
New project name: ${t.projectName}
The project has a community token, ${t.tokenName} ($${t.tokenTicker}). You may mention it once in the README footer and nowhere else.
Scope: ${SCOPE[t.tier]}
Build repo: /workspace/build (push to main). Deliverables: SPEC.md, rea4u.json and the clone, with rea4u.json and SPEC.md also copied to /mnt/session/outputs.
rea4u job id: ${t.jobId}`;
}

export function outcomeEvent(t: TaskInput) {
  return {
    type: 'user.define_outcome' as const,
    description: taskDescription(t),
    rubric: { type: 'text' as const, content: RUBRIC },
    max_iterations: TIERS[t.tier].iterations,
  };
}

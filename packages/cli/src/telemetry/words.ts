// The two closed word lists the pool's rollup reads (`measures.ts`) beside the schema that checks them (`schema.ts`). A leaf on purpose: it imports nothing, so a Worker that imports it takes no
// file-system module along (`schema.ts` reaches `node:fs/promises` through the session outbox).

/** Whether a run was in CI and by which provider: the word is chosen from the provider's own variable (`ciWord` in `fields.ts`), so the variable's value never reaches the spool. `other` is a bare `CI`. */
export const CI_WORDS = ['none', 'github-actions', 'gitlab-ci', 'circleci', 'travis-ci', 'jenkins', 'buildkite', 'azure-pipelines', 'bitbucket', 'teamcity', 'appveyor', 'codebuild', 'other'] as const;
export type CiWord = (typeof CI_WORDS)[number];

/** How this copy of oars arrived, from the folder it runs in and the package manager that started it (`surfaceWord` in `fields.ts`); the path itself never reaches the spool. A folder it cannot place is `unknown`. */
export const SURFACE_WORDS = ['npm-global', 'npx', 'claude-plugin', 'codex-plugin', 'gemini-extension', 'unknown'] as const;
export type SurfaceWord = (typeof SURFACE_WORDS)[number];

/** The steps of `oars pool join`, as the `join-step` event and the join plan name them. A name outside this list never reaches the spool. */
export const JOIN_STEPS = ['signin', 'region', 'terms', 'batch', 'outbox', 'covenant', 'send'] as const;
export type JoinStep = (typeof JOIN_STEPS)[number];
/** What a step did in one run: finished now, found already done and skipped, or stopped the run. */
export const JOIN_STATES = ['done', 'skipped', 'stopped'] as const;
export type JoinState = (typeof JOIN_STATES)[number];

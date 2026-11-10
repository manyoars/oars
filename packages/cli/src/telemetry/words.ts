// The two closed word lists the pool's rollup reads (`measures.ts`) beside the schema that checks them (`schema.ts`). A leaf on purpose: it imports nothing, so a Worker that imports it takes no
// file-system module along (`schema.ts` reaches `node:fs/promises` through the session outbox).

/** Whether a run was in CI and by which provider: the word is chosen from the provider's own variable (`ciWord` in `fields.ts`), so the variable's value never reaches the spool. `other` is a bare `CI`. */
export const CI_WORDS = ['none', 'github-actions', 'gitlab-ci', 'circleci', 'travis-ci', 'jenkins', 'buildkite', 'azure-pipelines', 'bitbucket', 'teamcity', 'appveyor', 'codebuild', 'other'] as const;
export type CiWord = (typeof CI_WORDS)[number];

/** How this copy of oars arrived, from the folder it runs in and the package manager that started it (`surfaceWord` in `fields.ts`); the path itself never reaches the spool. A folder it cannot place is `unknown`. */
export const SURFACE_WORDS = ['npm-global', 'npx', 'claude-plugin', 'codex-plugin', 'gemini-extension', 'unknown'] as const;
export type SurfaceWord = (typeof SURFACE_WORDS)[number];

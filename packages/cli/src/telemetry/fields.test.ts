import { describe, expect, it } from 'vitest';
import { ciWord, frameWords, harnessWord, surfaceWord } from './fields.js';
import { CI_WORDS, SURFACE_WORDS } from './schema.js';

describe('frameWords', () => {
  it('names the harness from the closed list, and any other name as other', () => {
    expect(harnessWord('codex')).toBe('codex');
    expect(harnessWord('acme-private')).toBe('other');
  });

  it('carries the harness a caller names, and none for the scheduled nightly, which runs under no harness', () => {
    expect(frameWords(undefined, '2.1.300', null)).toEqual({ harnessVersion: '2.1.300' });
  });

  it('always carries a named harness, and the version and model only when seen', () => {
    expect(frameWords('claude-code', undefined, null)).toEqual({ harness: 'claude-code' });
    expect(frameWords('codex', '2.1.300', 'claude-opus-4-5')).toEqual({ harness: 'codex', harnessVersion: '2.1.300', model: 'claude-opus-4-5' });
  });
});

describe('ciWord', () => {
  // One row per word the schema admits, named by the variable that makes it: a provider's own variable, never the generic CI.
  const PROVIDERS: [string, NodeJS.ProcessEnv][] = [
    ['github-actions', { GITHUB_ACTIONS: 'true' }],
    ['gitlab-ci', { GITLAB_CI: 'true' }],
    ['circleci', { CIRCLECI: 'true' }],
    ['travis-ci', { TRAVIS: 'true' }],
    ['jenkins', { JENKINS_URL: 'https://jenkins.example.test/' }],
    ['buildkite', { BUILDKITE: 'true' }],
    ['azure-pipelines', { TF_BUILD: 'True' }],
    ['bitbucket', { BITBUCKET_BUILD_NUMBER: '41' }],
    ['teamcity', { TEAMCITY_VERSION: '2026.1' }],
    ['appveyor', { APPVEYOR: 'True' }],
    ['codebuild', { CODEBUILD_BUILD_ID: 'build:1' }],
    ['other', { CI: 'true' }],
    ['none', {}],
  ];

  it.each(PROVIDERS)('%s', (word, env) => {
    expect(ciWord(env)).toBe(word);
  });

  it('has a test for every word the schema admits, and no word the schema does not', () => {
    expect(PROVIDERS.map(([word]) => word).sort()).toEqual([...CI_WORDS].sort());
  });

  it('reads a provider before the generic CI variable, which most providers also set', () => {
    expect(ciWord({ CI: 'true', GITHUB_ACTIONS: 'true' })).toBe('github-actions');
  });

  it.each([['0'], ['false'], ['FALSE'], ['no'], ['off'], ['']])('reads CI=%j as not a CI run', (value) => {
    expect(ciWord({ CI: value })).toBe('none');
    expect(ciWord({ GITHUB_ACTIONS: value })).toBe('none');
  });

  it('reads any other value of CI as a CI run, and never returns the value', () => {
    expect(ciWord({ CI: '1' })).toBe('other');
    expect(ciWord({ CI: '/home/someone/private-token' })).toBe('other');
  });

  it('reads only the variables it names', () => {
    expect(ciWord({ HOME: '/home/someone', BUILD_ID: '7' })).toBe('none');
  });
});

describe('surfaceWord', () => {
  const NPM_AGENT = 'npm/10.9.0 node/v22.11.0 linux x64 workspaces/false';
  const PNPM_AGENT = 'pnpm/9.12.0 npm/? node/v22.11.0 linux x64';
  const BUN_AGENT = 'bun/1.1.30 npm/? node/v22.6.0 linux x64';
  const PACKAGE = 'node_modules/@manyoars/oars/dist/bin.js';
  /** A Windows path, as `import.meta.url` gives it: drive, backslashes. */
  const win = (path: string): string => path.split('/').join(String.fromCharCode(92));

  // One row per word the schema admits: the path (and agent) that earns it.
  const ROWS: [string, string, string | undefined][] = [
    ['npm-global', `/usr/lib/${PACKAGE}`, undefined],
    ['npx', `/home/someone/.npm/_npx/6b1f0c2d3e4a5f60/${PACKAGE}`, NPM_AGENT],
    ['claude-plugin', `/home/someone/.claude/plugins/cache/manyoars/oars/1.0.0/${PACKAGE}`, undefined],
    ['codex-plugin', `/home/someone/.codex/plugins/cache/manyoars/oars/1.0.0/${PACKAGE}`, undefined],
    ['gemini-extension', `/home/someone/.gemini/extensions/oars/${PACKAGE}`, undefined],
    ['unknown', `/home/someone/projects/app/${PACKAGE}`, undefined],
  ];

  it.each(ROWS)('%s', (word, path, agent) => {
    expect(surfaceWord(path, agent)).toBe(word);
  });

  it('has a test for every word the schema admits, and no word the schema does not', () => {
    expect(ROWS.map(([word]) => word).sort()).toEqual([...SURFACE_WORDS].sort());
  });

  it.each([
    ['nvm', `/home/someone/.nvm/versions/node/v22.11.0/lib/${PACKAGE}`],
    ['Homebrew', `/opt/homebrew/lib/${PACKAGE}`],
    ['Windows npm', win(`C:/Users/someone/AppData/Roaming/npm/${PACKAGE}`)],
    ['pnpm global', `/home/someone/.local/share/pnpm/global/5/.pnpm/@manyoars+oars@1.0.0/${PACKAGE}`],
    ['yarn global', `/home/someone/.config/yarn/global/${PACKAGE}`],
    ['bun global', `/home/someone/.bun/install/global/${PACKAGE}`],
  ])('reads a global install under %s as npm-global', (_name, path) => {
    expect(surfaceWord(path, undefined)).toBe('npm-global');
  });

  it('reads a global install the same with or without a package manager agent', () => {
    expect(surfaceWord(`/usr/lib/${PACKAGE}`, NPM_AGENT)).toBe('npm-global');
  });

  it.each([
    ['npm, the path alone', `/home/someone/.npm/_npx/6b1f0c2d3e4a5f60/${PACKAGE}`, undefined],
    ['npm on Windows', win(`C:/Users/someone/AppData/Local/npm-cache/_npx/6b1f0c2d3e4a5f60/${PACKAGE}`), NPM_AGENT],
    ['pnpm dlx, with its agent', `/home/someone/.cache/pnpm/dlx/abc123/19c2/${PACKAGE}`, PNPM_AGENT],
    ['bunx, with its agent', `/tmp/bunx-1000-@manyoars/oars@latest/${PACKAGE}`, BUN_AGENT],
  ])('reads a package runner as npx: %s', (_name, path, agent) => {
    expect(surfaceWord(path, agent)).toBe('npx');
  });

  it('needs the package manager agent to read a dlx or bunx folder as npx, since any folder can carry that name', () => {
    expect(surfaceWord(`/home/someone/.cache/pnpm/dlx/abc123/19c2/${PACKAGE}`, undefined)).toBe('unknown');
    expect(surfaceWord(`/home/someone/dlx/${PACKAGE}`, 'curl/8.5.0')).toBe('unknown');
    expect(surfaceWord(`/tmp/bunx-1000-@manyoars/oars@latest/${PACKAGE}`, '')).toBe('unknown');
  });

  it.each([
    ['Claude Code', win(`C:/Users/someone/.claude/plugins/marketplaces/manyoars/${PACKAGE}`), 'claude-plugin'],
    ['Codex', win(`C:/Users/someone/.codex/plugins/cache/manyoars/${PACKAGE}`), 'codex-plugin'],
    ['Gemini CLI', win(`C:/Users/someone/.gemini/extensions/oars/${PACKAGE}`), 'gemini-extension'],
  ])('reads a plugin store on Windows (%s)', (_name, path, word) => {
    expect(surfaceWord(path, undefined)).toBe(word);
  });

  it('reads a harness store before a global-looking path, since a plugin can hold its own node_modules', () => {
    expect(surfaceWord(`/home/someone/.claude/plugins/cache/x/lib/${PACKAGE}`, undefined)).toBe('claude-plugin');
  });

  it.each([
    ['a path nobody listed', '/opt/tools/oars/bin.js', undefined],
    ['a project dependency run by a package manager', `/home/someone/projects/app/${PACKAGE}`, NPM_AGENT],
    ['a source checkout', '/home/someone/src/oars/packages/cli/src/bin.ts', undefined],
    ['a worktree under a .claude folder that is not a plugin store', '/home/someone/.claude/worktrees/t1/packages/cli/dist/bin.js', undefined],
    ['an empty path', '', undefined],
    ['an agent with no path', '', NPM_AGENT],
  ])('reads %s as unknown', (_name, path, agent) => {
    expect(surfaceWord(path, agent)).toBe('unknown');
  });

  it('never returns any part of the path', () => {
    expect(SURFACE_WORDS).toContain(surfaceWord('/home/someone-private/.npm/_npx/abc/node_modules/x.js', undefined));
  });
});

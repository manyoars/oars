import { describe, expect, it } from 'vitest';
import { ciWord, frameWords, harnessWord } from './fields.js';
import { CI_WORDS } from './schema.js';

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

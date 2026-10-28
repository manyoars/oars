// The release workflow (design 1T minimum §2.5): a main push touching the template runs the `check` job (tests and the container
// smoke test, read-only token, nothing published); a tag paid-api-v<semver> also runs the tag-only `release` job, which
// pushes ghcr.io/manyoars/paid-api:<semver> for linux/amd64, attests its provenance and writes the digest into the release
// notes. The repository is public, so only GitHub-hosted runners, and every action is pinned to a commit like ci.yml's.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);
const asRecord = (value: unknown): { [key: string]: unknown } => (isRecord(value) ? value : {});

const text = readFileSync(new URL('../../../../.github/workflows/template-paid-api.yml', import.meta.url), 'utf8');
const workflow = asRecord(parse(text));
const jobs = asRecord(workflow['jobs']);
const check = asRecord(jobs['check']);
const release = asRecord(jobs['release']);
const stepsOf = (job: { [key: string]: unknown }): { [key: string]: unknown }[] => (Array.isArray(job['steps']) ? job['steps'] : []).map(asRecord);
const checkSteps = stepsOf(check);
const releaseSteps = stepsOf(release);
const tagOnly = "startsWith(github.ref, 'refs/tags/')";

const indexIn = (steps: { [key: string]: unknown }[], needle: string): number =>
  steps.findIndex((step) => [step['uses'], step['run'], step['name']].some((field) => typeof field === 'string' && field.includes(needle)));

const stepIndex = (needle: string): number => indexIn(checkSteps, needle);
const releaseIndex = (needle: string): number => indexIn(releaseSteps, needle);

describe('.github/workflows/template-paid-api.yml', () => {
  it('runs on a paid-api-v tag and on a main push touching the template, the client, a root dependency file, or the workflow, on GitHub-hosted jobs', () => {
    expect(asRecord(workflow['on'])).toEqual({
      push: {
        tags: ['paid-api-v*'],
        branches: ['main'],
        paths: [
          'templates/paid-api/**',
          'packages/client/**',
          'package.json',
          'package-lock.json',
          'tsconfig.base.json',
          '.github/workflows/template-paid-api.yml',
        ],
      },
    });
    expect(Object.keys(jobs)).toEqual(['check', 'release']);
    expect(check['runs-on']).toBe('ubuntu-latest');
    expect(release['runs-on']).toBe('ubuntu-latest');
  });

  it('holds only a read token at the top and on the check job, and grants the write token to a release job that runs only for a tag after the check', () => {
    expect(workflow['permissions']).toEqual({ contents: 'read' });
    expect(check['permissions']).toBeUndefined();
    expect(release['needs']).toBe('check');
    expect(release['if']).toBe(tagOnly);
    expect(release['permissions']).toEqual({ contents: 'write', packages: 'write', 'id-token': 'write', attestations: 'write' });
  });

  it('pins every action to a commit', () => {
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((match) => match[1] ?? '');

    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) expect(action).toMatch(/^[\w-]+\/[\w./-]+@[0-9a-f]{40}$/);
  });

  it('tests and smoke-tests the built image in the check job, then logs in, pushes, attests, and writes the digest in the release job, in that order', () => {
    const pushed = releaseSteps.findIndex((step) => asRecord(step['with'])['push'] === true);
    const checked = [stepIndex('npm test'), stepIndex('test:monorepo'), stepIndex('npm run test:smoke')];
    const released = [releaseIndex('docker/login-action'), pushed, releaseIndex('attest-build-provenance'), releaseIndex('gh release')];

    for (const order of [checked, released]) {
      expect(order.every((index) => index >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((first, second) => first - second));
    }
  });

  it('builds the client right after npm ci, before any typecheck, test, or build', () => {
    const client = stepIndex('npm run build -w packages/client');

    expect(client).toBe(stepIndex('npm ci') + 1);
    expect(client).toBeLessThan(stepIndex('npm run typecheck'));
    expect(client).toBeLessThan(stepIndex('docker/build-push-action'));
  });

  it('publishes only in the release job: the check job never logs in, pushes, attests, or releases, and the release job never installs', () => {
    for (const needle of ['docker/login-action', 'attest-build-provenance', 'gh release']) {
      expect(stepIndex(needle)).toBe(-1);
      expect(releaseIndex(needle)).toBeGreaterThanOrEqual(0);
    }
    expect(checkSteps.some((step) => asRecord(step['with'])['push'] === true)).toBe(false);
    expect(releaseSteps.some((step) => asRecord(step['with'])['push'] === true)).toBe(true);
    for (const needle of ['npm ci', 'npm run typecheck', 'npm test', 'test:monorepo', 'npm run test:smoke']) expect(releaseIndex(needle)).toBe(-1);
    for (const step of [...checkSteps, ...releaseSteps]) expect(step['if']).toBeUndefined();
  });

  it('builds for linux/amd64 from the repository root and pushes ghcr.io/manyoars/paid-api:<semver>', () => {
    const builds = [...checkSteps, ...releaseSteps]
      .filter((step) => typeof step['uses'] === 'string' && step['uses'].startsWith('docker/build-push-action@'))
      .map((step) => asRecord(step['with']));

    expect(builds).toHaveLength(2);
    for (const build of builds) {
      expect(build['platforms']).toBe('linux/amd64');
      expect(build['context']).toBe('.');
      expect(build['file']).toBe('templates/paid-api/Dockerfile');
    }
    expect(builds[1]?.['push']).toBe(true);
    expect(builds[1]?.['tags']).toBe('${{ env.IMAGE }}:${{ steps.version.outputs.semver }}');
    expect(text).toContain('IMAGE: ghcr.io/manyoars/paid-api');
  });

  it('attests the pushed digest and puts it in the release notes', () => {
    const attest = releaseSteps.find((step) => typeof step['uses'] === 'string' && step['uses'].startsWith('actions/attest-build-provenance@'));

    expect(asRecord(attest?.['with'])['subject-digest']).toBe('${{ steps.push.outputs.digest }}');
    const notes = releaseSteps[releaseIndex('gh release')];
    expect(asRecord(notes?.['env'])['DIGEST']).toBe('${{ steps.push.outputs.digest }}');
    expect(String(notes?.['run'])).toContain('Image: `%s@%s`');
    expect(String(notes?.['run'])).toContain('"$IMAGE" "$DIGEST"');
  });
});

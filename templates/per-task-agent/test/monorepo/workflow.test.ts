// The release workflow (design 1T minimum §2.5): a tag per-task-agent-v<semver> runs the tests and the container smoke test, then
// pushes ghcr.io/manyoars/per-task-agent:<semver> for linux/amd64, attests its provenance and writes the digest into the release
// notes. The repository is public, so only GitHub-hosted runners, and every action is pinned to a commit like ci.yml's.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);
const asRecord = (value: unknown): { [key: string]: unknown } => (isRecord(value) ? value : {});

const text = readFileSync(new URL('../../../../.github/workflows/template-per-task-agent.yml', import.meta.url), 'utf8');
const workflow = asRecord(parse(text));
const jobs = asRecord(workflow['jobs']);
const release = asRecord(jobs['release']);
const steps = (Array.isArray(release['steps']) ? release['steps'] : []).map(asRecord);

const stepIndex = (needle: string): number =>
  steps.findIndex((step) => [step['uses'], step['run'], step['name']].some((field) => typeof field === 'string' && field.includes(needle)));

describe('.github/workflows/template-per-task-agent.yml', () => {
  it('runs on a per-task-agent-v tag and on a main push touching the template, the client or the workflow, on one GitHub-hosted job', () => {
    expect(asRecord(workflow['on'])).toEqual({
      push: {
        tags: ['per-task-agent-v*'],
        branches: ['main'],
        paths: ['templates/per-task-agent/**', 'packages/client/**', '.github/workflows/template-per-task-agent.yml'],
      },
    });
    expect(Object.keys(jobs)).toEqual(['release']);
    expect(release['runs-on']).toBe('ubuntu-latest');
  });

  it('pins every action to a commit', () => {
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((match) => match[1] ?? '');

    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) expect(action).toMatch(/^[\w-]+\/[\w./-]+@[0-9a-f]{40}$/);
  });

  it('tests, smoke-tests the built image, then logs in, pushes, attests and writes the digest, in that order', () => {
    const pushed = steps.findIndex((step) => asRecord(step['with'])['push'] === true);
    const order = [
      stepIndex('npm test'),
      stepIndex('test:monorepo'),
      stepIndex('npm run test:smoke'),
      stepIndex('docker/login-action'),
      pushed,
      stepIndex('attest-build-provenance'),
      stepIndex('gh release'),
    ];

    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((first, second) => first - second));
  });

  it('builds the client right after npm ci, before any typecheck, test or build', () => {
    const client = stepIndex('npm run build -w packages/client');

    expect(client).toBe(stepIndex('npm ci') + 1);
    expect(client).toBeLessThan(stepIndex('npm run typecheck'));
    expect(client).toBeLessThan(stepIndex('docker/build-push-action'));
  });

  it('publishes only on a tag: the version, login, push, attestation and release steps are tag-gated, the build is not', () => {
    const gated = (needle: string): unknown => steps[stepIndex(needle)]?.['if'];
    const pushed = steps.find((step) => asRecord(step['with'])['push'] === true);
    const tagOnly = "startsWith(github.ref, 'refs/tags/')";

    for (const needle of ['Read the version', 'docker/login-action', 'attest-build-provenance', 'gh release']) expect(gated(needle)).toBe(tagOnly);
    expect(pushed?.['if']).toBe(tagOnly);
    for (const needle of ['npm ci', 'npm run typecheck', 'npm test', 'test:monorepo', 'Build the image for the smoke test', 'npm run test:smoke']) {
      expect(gated(needle)).toBeUndefined();
    }
  });

  it('builds for linux/amd64 from the repository root and pushes ghcr.io/manyoars/per-task-agent:<semver>', () => {
    const builds = steps.filter((step) => typeof step['uses'] === 'string' && step['uses'].startsWith('docker/build-push-action@')).map((step) => asRecord(step['with']));

    expect(builds).toHaveLength(2);
    for (const build of builds) {
      expect(build['platforms']).toBe('linux/amd64');
      expect(build['context']).toBe('.');
      expect(build['file']).toBe('templates/per-task-agent/Dockerfile');
    }
    expect(builds[1]?.['push']).toBe(true);
    expect(builds[1]?.['tags']).toBe('${{ env.IMAGE }}:${{ steps.version.outputs.semver }}');
    expect(text).toContain('IMAGE: ghcr.io/manyoars/per-task-agent');
  });

  it('attests the pushed digest and puts it in the release notes', () => {
    const attest = steps.find((step) => typeof step['uses'] === 'string' && step['uses'].startsWith('actions/attest-build-provenance@'));

    expect(asRecord(attest?.['with'])['subject-digest']).toBe('${{ steps.push.outputs.digest }}');
    const notes = steps[stepIndex('gh release')];
    expect(asRecord(notes?.['env'])['DIGEST']).toBe('${{ steps.push.outputs.digest }}');
    expect(String(notes?.['run'])).toContain('Image: `%s@%s`');
    expect(String(notes?.['run'])).toContain('"$IMAGE" "$DIGEST"');
  });
});

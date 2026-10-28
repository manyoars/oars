// The release workflow (design 1T minimum §2.5): a main push touching the template runs the `check` job (tests and the container
// smoke test, read-only token, nothing published); a tag paid-api-v<semver> also runs the tag-only `release` job, which
// pushes ghcr.io/manyoars/paid-api:<semver> for linux/amd64, attests its provenance, and writes the digest into the release
// notes. The repository is public, so only GitHub-hosted runners, and every action is pinned to a commit like ci.yml's.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);
const asRecord = (value: unknown): { [key: string]: unknown } => (isRecord(value) ? value : {});

const text = readFileSync(new URL('../../../../.github/workflows/template-paid-api.yml', import.meta.url), 'utf8');
const workflow = asRecord(parse(text));
const jobs = asRecord(workflow['jobs']);
const image = asRecord(jobs['image']);
const check = asRecord(jobs['check']);
const release = asRecord(jobs['release']);
const stepsOf = (job: { [key: string]: unknown }): { [key: string]: unknown }[] => (Array.isArray(job['steps']) ? job['steps'] : []).map(asRecord);
const imageSteps = stepsOf(image);
const checkSteps = stepsOf(check);
const releaseSteps = stepsOf(release);
const tagOnly = "startsWith(github.ref, 'refs/tags/')";

const indexIn = (steps: { [key: string]: unknown }[], needle: string): number =>
  steps.findIndex((step) => [step['uses'], step['run'], step['name']].some((field) => typeof field === 'string' && field.includes(needle)));

const imageIndex = (needle: string): number => indexIn(imageSteps, needle);
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
    expect(Object.keys(jobs)).toEqual(['image', 'check', 'release']);
    expect(image['runs-on']).toBe('ubuntu-latest');
    expect(check['runs-on']).toBe('ubuntu-latest');
    expect(release['runs-on']).toBe('ubuntu-latest');
  });

  it('holds only a read token at the top and on the image and check jobs, and grants the write token to a release job that runs only for a tag after both', () => {
    expect(workflow['permissions']).toEqual({ contents: 'read' });
    expect(image['permissions']).toBeUndefined();
    expect(check['permissions']).toBeUndefined();
    expect(image['needs']).toBeUndefined();
    expect(check['needs']).toBe('image');
    expect(release['needs']).toEqual(['image', 'check']);
    expect(release['if']).toBe(tagOnly);
    expect(release['permissions']).toEqual({ contents: 'write', packages: 'write', 'id-token': 'write', attestations: 'write' });
  });

  it('pins every action to a commit', () => {
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((match) => match[1] ?? '');

    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) expect(action).toMatch(/^[\w-]+\/[\w./-]+@[0-9a-f]{40}$/);
  });

  it('builds and saves the image in the image job, tests and smoke-tests the loaded image in the check job, then loads it, logs in, pushes, attests, and writes the digest in the release job, in that order', () => {
    const built = [imageIndex('docker/build-push-action'), imageIndex('upload-artifact')];
    const checked = [stepIndex('download-artifact'), stepIndex('docker load'), stepIndex('npm test'), stepIndex('test:monorepo'), stepIndex('npm run test:smoke')];
    const released = [
      releaseIndex('download-artifact'),
      releaseIndex('docker load'),
      releaseIndex('docker/login-action'),
      releaseIndex('docker push'),
      releaseIndex('attest-build-provenance'),
      releaseIndex('gh release'),
    ];

    for (const order of [built, checked, released]) {
      expect(order.every((index) => index >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((first, second) => first - second));
    }
  });

  it('builds the client right after npm ci, before any typecheck, test, or build', () => {
    const client = stepIndex('npm run build -w packages/client');

    expect(client).toBe(stepIndex('npm ci') + 1);
    expect(client).toBeLessThan(stepIndex('npm run typecheck'));
  });

  it('publishes only in the release job: the image and check jobs never log in, push, attest, or release, and the release job never installs', () => {
    for (const needle of ['docker/login-action', 'docker push', 'attest-build-provenance', 'gh release']) {
      expect(imageIndex(needle)).toBe(-1);
      expect(stepIndex(needle)).toBe(-1);
      expect(releaseIndex(needle)).toBeGreaterThanOrEqual(0);
    }
    for (const step of [...imageSteps, ...checkSteps]) expect(asRecord(step['with'])['push']).toBeUndefined();
    for (const needle of ['npm ci', 'npm run typecheck', 'npm test', 'test:monorepo', 'npm run test:smoke']) expect(releaseIndex(needle)).toBe(-1);
    for (const step of [...imageSteps, ...checkSteps, ...releaseSteps]) expect(step['if']).toBeUndefined();
  });

  it('never installs npm packages on the runner that builds the image, so install scripts cannot touch the image the release job pushes', () => {
    for (const needle of ['npm ci', 'npm install', 'setup-node']) expect(imageIndex(needle)).toBe(-1);
  });

  it('builds the image once, in the image job for linux/amd64 from the repository root, and the release job pushes that image, not a rebuild', () => {
    const builds = [...imageSteps, ...checkSteps, ...releaseSteps].filter((step) => String(step['uses']).startsWith('docker/build-push-action@'));

    expect(builds).toHaveLength(1);
    expect(imageSteps).toContain(builds[0]);
    const build = asRecord(builds[0]?.['with']);
    expect(build['platforms']).toBe('linux/amd64');
    expect(build['context']).toBe('.');
    expect(build['file']).toBe('templates/paid-api/Dockerfile');
    expect(build['outputs']).toBe('type=docker,dest=${{ runner.temp }}/paid-api-image.tar');
    expect(build['tags']).toBe('paid-api:smoke');
    expect(text).toContain('IMAGE: ghcr.io/manyoars/paid-api');
  });

  it('hands the saved image to the check and release jobs through one artifact, and the release job tags it ghcr.io/manyoars/paid-api:<semver> before it pushes', () => {
    const upload = asRecord(imageSteps[imageIndex('upload-artifact')]?.['with']);

    expect(upload['path']).toBe('${{ runner.temp }}/paid-api-image.tar');
    for (const steps of [checkSteps, releaseSteps]) {
      const download = asRecord(steps[indexIn(steps, 'download-artifact')]?.['with']);
      expect(download['name']).toBe(upload['name']);
      expect(download['path']).toBe('${{ runner.temp }}');
      expect(String(steps[indexIn(steps, 'docker load')]?.['run'])).toContain('paid-api-image.tar');
    }
    expect(String(releaseSteps[releaseIndex('docker push')]?.['run'])).toContain('docker tag paid-api:smoke "$IMAGE:$SEMVER"');
  });

  it('leaves no credential in the release job checkout, which holds the write token and never pushes to git', () => {
    const checkouts = releaseSteps.filter((step) => String(step['uses']).startsWith('actions/checkout@'));

    expect(checkouts.length).toBeGreaterThan(0);
    for (const checkout of checkouts) expect(asRecord(checkout['with'])['persist-credentials']).toBe(false);
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

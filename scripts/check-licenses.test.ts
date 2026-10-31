import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('./check-licenses.mjs', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

type LockEntry = { version?: string; license?: string; dev?: boolean; link?: boolean; resolved?: string };

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'check-licenses-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// A lockfile with the repo's own root entry (Apache-2.0, skipped) and the given packages.
const lockfile = (packages: Readonly<Record<string, LockEntry>>) => {
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: { '': { name: 'fixture', license: 'Apache-2.0' }, ...packages } }),
  );
};

const run = (target = root) => {
  const result = spawnSync(process.execPath, [script, target], { encoding: 'utf8' });
  return { status: result.status, out: result.stdout, err: result.stderr };
};

describe('check-licenses', () => {
  it('passes a shipped package under an allowed license', () => {
    lockfile({ 'node_modules/a': { version: '1.0.0', license: 'MIT' } });
    expect(run().status).toBe(0);
  });

  it('passes every license on the allowlist', () => {
    lockfile({
      'node_modules/mit': { version: '1.0.0', license: 'MIT' },
      'node_modules/isc': { version: '1.0.0', license: 'ISC' },
      'node_modules/apache': { version: '1.0.0', license: 'Apache-2.0' },
      'node_modules/bsd2': { version: '1.0.0', license: 'BSD-2-Clause' },
      'node_modules/bsd3': { version: '1.0.0', license: 'BSD-3-Clause' },
      'node_modules/zero': { version: '1.0.0', license: '0BSD' },
    });
    expect(run().status).toBe(0);
  });

  it('fails an unlisted license and names the package path and the license', () => {
    lockfile({ 'node_modules/ok': { version: '1.0.0', license: 'MIT' }, 'node_modules/copyleft': { version: '2.3.4', license: 'GPL-3.0-only' } });
    const { status, err } = run();
    expect(status).toBe(1);
    expect(err).toContain('node_modules/copyleft');
    expect(err).toContain('GPL-3.0-only');
    expect(err).not.toContain('node_modules/ok');
  });

  it('passes an OR expression with one allowed alternative', () => {
    lockfile({ 'node_modules/either': { version: '1.0.0', license: '(MIT OR GPL-3.0-only)' } });
    expect(run().status).toBe(0);
  });

  it('fails an OR expression with no allowed alternative', () => {
    lockfile({ 'node_modules/neither': { version: '1.0.0', license: '(GPL-2.0-only OR GPL-3.0-only)' } });
    const { status, err } = run();
    expect(status).toBe(1);
    expect(err).toContain('node_modules/neither');
  });

  it('fails an AND expression unless every part is allowed', () => {
    lockfile({ 'node_modules/both': { version: '1.0.0', license: '(MIT AND GPL-3.0-only)' } });
    const { status, err } = run();
    expect(status).toBe(1);
    expect(err).toContain('node_modules/both');
    expect(err).toContain('(MIT AND GPL-3.0-only)');
  });

  it('passes an AND expression when every part is allowed', () => {
    lockfile({ 'node_modules/both': { version: '1.0.0', license: '(MIT AND ISC)' } });
    expect(run().status).toBe(0);
  });

  it('fails a shipped package with no license field', () => {
    lockfile({ 'node_modules/nolicense': { version: '1.0.0' } });
    const { status, err } = run();
    expect(status).toBe(1);
    expect(err).toContain('node_modules/nolicense');
    expect(err).toContain('no license');
  });

  it('passes a dev-only entry with no license field', () => {
    lockfile({ 'node_modules/devtool': { version: '1.0.0', dev: true } });
    expect(run().status).toBe(0);
  });

  it('passes a dev-only entry under an unlisted license, because development tools do not ship', () => {
    lockfile({ 'node_modules/lightningcss': { version: '1.0.0', license: 'MPL-2.0', dev: true } });
    expect(run().status).toBe(0);
  });

  it('skips a workspace link and the root entry', () => {
    lockfile({ 'node_modules/@manyoars/oars': { resolved: 'packages/cli', link: true }, 'packages/cli': { version: '0.1.0', license: 'Apache-2.0' } });
    expect(run().status).toBe(0);
  });

  it('reports every offender, not only the first', () => {
    lockfile({ 'node_modules/one': { version: '1.0.0', license: 'GPL-3.0-only' }, 'node_modules/two': { version: '1.0.0' } });
    const { status, err } = run();
    expect(status).toBe(1);
    expect(err).toContain('node_modules/one');
    expect(err).toContain('node_modules/two');
  });

  it('fails when the lockfile is missing', () => {
    const { status, err } = run();
    expect(status).toBe(1);
    expect(err).toContain('package-lock.json');
  });

  it("passes this repository's real lockfile (its development-only entries must not fail it)", () => {
    const { status, err } = run(repositoryRoot);
    expect(err).toBe('');
    expect(status).toBe(0);
  });
});

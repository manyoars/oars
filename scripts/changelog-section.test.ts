import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('./changelog-section.mjs', import.meta.url));
const changelog = fileURLToPath(new URL('../packages/cli/CHANGELOG.md', import.meta.url));

const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
const lines = (text: string) => text.replace(/\n$/, '').split('\n');

describe('changelog-section', () => {
  it('prints the 0.4.1 body, from its first line to its last, without the heading', () => {
    const r = run('0.4.1', changelog);
    expect(r.status).toBe(0);
    const out = lines(r.stdout);
    expect(out[0]).toMatch(/^Text only, no change in behavior\./);
    expect(out.at(-1)).toMatch(/DO_NOT_TRACK=1.*still turn it off\.$/);
    expect(r.stdout).not.toContain('## ');
  });

  it('prints the 0.4.0 body up to the 0.3.0 heading', () => {
    const r = run('0.4.0', changelog);
    expect(r.status).toBe(0);
    const out = lines(r.stdout);
    expect(out[0]).toMatch(/^Changes since 0\.3\.0\./);
    expect(out.at(-1)).toMatch(/^- `oars sessions books --by package`/);
    expect(r.stdout).not.toContain('Text only, no change');
  });

  it('prints the last section of the file, which has no heading after it', () => {
    const r = run('0.1.0', changelog);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).not.toBe('');
  });

  it('fails with a clear message when the version has no section', () => {
    const r = run('9.9.9', changelog);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('no "## 9.9.9" section');
  });

  it('does not match a version by prefix ("0.4" is not 0.4.1)', () => {
    expect(run('0.4', changelog).status).toBe(1);
  });

  it('refuses an empty section', () => {
    const dir = mkdtempSync(join(tmpdir(), 'changelog-section-'));
    try {
      const file = join(dir, 'CHANGELOG.md');
      writeFileSync(file, '# Changelog\n\n## 1.0.0\n\n## 0.9.0\n\nbody\n');
      const r = run('1.0.0', file);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('is empty');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires a version', () => {
    expect(run().status).toBe(2);
  });
});

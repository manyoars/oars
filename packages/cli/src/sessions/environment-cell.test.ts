// Fit's third pool form (spec Section 3): calls and errors per (name, `platform`, `shell`). It is a cell of its own, version-free and model-free, because the pair beside a version and a
// model would be five dimensions over `q_dims`; it carries `week` and `exposure` and nothing else, and no read that answers from the version cells sees it.
import { describe, expect, it } from 'vitest';
import { cellsOf, projectedStore } from './cell-increments.js';
import { ENVIRONMENT_BUCKET, environmentBucketOf, environmentFieldsOf, isEnvironmentCell, poolOf, UNKNOWN } from './cells.js';
import { motifName } from './motif.js';
import { frame, prompt, session, step, storedNames, store, tool } from './pool-fixture.js';
import { atGrain, unitCells } from './read-support.js';

const framed = frame({ platform: 'linux', shell: 'bash' });
const windows = frame({ platform: 'win32', shell: 'PowerShell', day: '2026-11-02' });

const fixture = () =>
  store({
    sessions: [session('s1', { frame: framed }), session('s2', { frame: windows })],
    prompts: [prompt('s1', 0, { frame: framed }), prompt('s2', 0, { frame: windows })],
    tools: [
      tool('s1', 0, 'Bash', { steps: [step(0, 0, 'shell.exec', { native: 'Bash', identity: { program: 'git', sub: 'push', flags: ['--force'], pulls: [{ registry: 'npm', name: 'left-pad', version: null }] } })] }),
      tool('s1', 1, 'Bash', { status: 'error', steps: [step(1, 0, 'shell.exec', { native: 'Bash', status: 'error', identity: { program: 'git', sub: 'push', flags: [] } })] }),
      tool('s2', 0, 'Bash', { steps: [step(0, 0, 'shell.exec', { native: 'Bash', identity: { program: 'git', sub: 'push', flags: [] } })] }),
      tool('s1', 2, 'Read'),
    ],
  });

const derived = () => cellsOf(projectedStore(fixture(), storedNames));
const environmentCells = () => derived().cells.filter(isEnvironmentCell);

describe('the (name, platform, shell) cell', () => {
  it('names the platform and the shell and no version, model, or harness', () => {
    expect(environmentBucketOf(framed)).toBe(`${ENVIRONMENT_BUCKET}linux:bash`);
    expect(environmentBucketOf(frame({ platform: 'darwin', shell: null }))).toBe(`${ENVIRONMENT_BUCKET}darwin:${UNKNOWN}`);
    expect(environmentFieldsOf(environmentBucketOf(windows))).toEqual({ platform: 'win32', shell: 'PowerShell' });
  });

  it('counts a one-step named shell call once per (platform, shell) at the week grain', () => {
    const cells = environmentCells();
    const set = derived();
    const names = new Map(set.motifs.map((motif) => [motif.motifId, motif]));
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.grain).toBe('week');
      const motif = names.get(cell.motifId);
      expect(motif?.level).toBe('named');
      expect(motif?.steps).toHaveLength(1);
    }
    const push = cells.filter((cell) => motifName(names.get(cell.motifId) ?? { motifId: '', level: 'named', steps: [], cls: null }) === 'shell.exec[program=git sub=push]');
    expect(push.map((cell) => [cell.frameBucket, cell.ok, cell.failed]).sort()).toEqual([
      [`${ENVIRONMENT_BUCKET}linux:bash`, 1, 1],
      [`${ENVIRONMENT_BUCKET}win32:PowerShell`, 1, 0],
    ]);
  });

  it('holds no flag cell and no pull cell, which would be four dimensions with the pair', () => {
    const names = new Map(derived().motifs.map((motif) => [motif.motifId, motif]));
    for (const cell of environmentCells()) {
      const identity = names.get(cell.motifId)?.steps[0]?.identity;
      if (identity !== null && identity !== undefined && 'program' in identity) {
        expect(identity.flags).toEqual([]);
        expect(identity.pulls ?? []).toEqual([]);
      }
    }
  });

  it('is invisible to every read of the version cells: they answer from the grain they take and never from this cell', () => {
    const pool = poolOf(derived(), []);
    expect(pool.cells.some(isEnvironmentCell)).toBe(true);
    expect(atGrain(pool, 'week').some(isEnvironmentCell)).toBe(false);
    expect(unitCells(pool, 'week').some(({ cell }) => isEnvironmentCell(cell))).toBe(false);
  });
});

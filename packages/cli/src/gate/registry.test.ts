import { describe, expect, it, vi } from 'vitest';
import { askable, managerReader, readNpmView, readPipIndex, type ManagerRun, type ManagerRunner } from './registry.js';

const ran = (code: number | null, stdout = '', stderr = ''): ManagerRun => ({ code, stdout, stderr });

describe('reading a manager answer', () => {
  it.each<[string, ManagerRun, object]>([
    ['found', ran(0, '{"dist-tags.latest":"5.1.0","time.created":"2012-11-30T00:00:00.000Z"}'), { state: 'found', latest: '5.1.0', created: '2012-11-30T00:00:00.000Z' }],
    ['not found on stdout', ran(1, '{"error":{"code":"E404"}}'), { state: 'not-found' }],
    ['not found on stderr', ran(1, '', 'npm error code E404'), { state: 'not-found' }],
    ['a failed run', ran(1, '', 'npm error network'), { state: 'unreachable' }],
    ['a run that never started', ran(null), { state: 'unreachable' }],
    ['not JSON', ran(0, 'hello'), { state: 'unreachable' }],
    ['no latest', ran(0, '{}'), { state: 'unreachable' }],
  ])('npm: %s', (_label, run, expected) => {
    expect(readNpmView(run)).toMatchObject(expected);
  });

  it.each<[string, ManagerRun, object]>([
    ['found', ran(0, 'requests (2.32.3)\nAvailable versions: 2.32.3, 2.32.2\n'), { state: 'found', latest: '2.32.3', created: null }],
    ['not found', ran(1, '', 'ERROR: No matching distribution found for nothing-here'), { state: 'not-found' }],
    ['a failed run', ran(1, '', 'ERROR: unknown command'), { state: 'unreachable' }],
    ['no first line', ran(0, 'WARNING: nothing'), { state: 'unreachable' }],
  ])('pip: %s', (_label, run, expected) => {
    expect(readPipIndex(run)).toMatchObject(expected);
  });
});

describe('what may be asked', () => {
  it.each<[Parameters<typeof askable>[0], string, boolean]>([
    ['npm-package', 'left-pad', true],
    ['npm-package', '@scope/pkg', true],
    ['npm-package', '--registry=http://x', false],
    ['npm-package', 'a&calc', false],
    ['npm-package', 'a b', false],
    ['npm-package', 'https://example.test/a.git', false],
    ['python-package', 'some-package', true],
    ['python-package', '-r', false],
    ['python-package', 'a|b', false],
    ['mcp-server', 'one', false],
    ['skill', 'one', false],
  ])('%s %s: %s', (cls, name, expected) => {
    expect(askable(cls, name)).toBe(expected);
  });
});

describe('the reader', () => {
  it('asks the manager in the folder of the call, and never starts one for a name it cannot ask', async () => {
    const runner = vi.fn<ManagerRunner>(async () => Promise.resolve(ran(0, '{"dist-tags.latest":"1.0.0"}')));
    const read = managerReader(runner);
    await expect(read({ class: 'npm-package', name: 'one', cwd: 'here' })).resolves.toMatchObject({ state: 'found', latest: '1.0.0' });
    expect(runner).toHaveBeenCalledWith('npm', expect.arrayContaining(['view', 'one']), 'here');
    await expect(read({ class: 'npm-package', name: 'a&calc', cwd: 'here' })).resolves.toMatchObject({ state: 'unreachable' });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('asks pip for a Python name', async () => {
    const runner = vi.fn<ManagerRunner>(async () => Promise.resolve(ran(0, 'one (1.0.0)\n')));
    await expect(managerReader(runner)({ class: 'python-package', name: 'one', cwd: 'here' })).resolves.toMatchObject({ state: 'found', latest: '1.0.0' });
    expect(runner).toHaveBeenCalledWith('pip', expect.arrayContaining(['index', 'versions', 'one']), 'here');
  });
});

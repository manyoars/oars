import { describe, expect, it, vi } from 'vitest';
import { askable, managerOptions, managerReader, readNpmView, readPipIndex, stopTree, type ManagerRun, type ManagerRunner } from './registry.js';

const ran = (code: number | null, stdout = '', stderr = ''): ManagerRun => ({ code, stdout, stderr });

describe('reading a manager answer', () => {
  it.each<[string, ManagerRun, object]>([
    ['found', ran(0, '{"dist-tags.latest":"5.1.0","time.created":"2012-11-30T00:00:00.000Z"}'), { state: 'found', latest: '5.1.0', created: '2012-11-30T00:00:00.000Z' }],
    ['found, wrapped in a one-element array (npm 12 with two fields)', ran(0, '[\n  {\n    "dist-tags.latest": "7.0.2",\n    "time.created": "2012-10-01T15:35:39.553Z"\n  }\n]\n'), { state: 'found', latest: '7.0.2', created: '2012-10-01T15:35:39.553Z' }],
    ['an empty array', ran(0, '[]'), { state: 'unreachable' }],
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

describe('how a manager is started', () => {
  it('keeps the folder of the call out of the executable search, so a shim a transcript left there does not run', () => {
    const options = managerOptions('here', 'win32');
    expect(options).toMatchObject({ cwd: 'here', shell: true, windowsHide: true, encoding: 'utf8' });
    expect(options.env).toMatchObject({ NoDefaultCurrentDirectoryInExePath: '1' });
    expect(options.timeout).toBeGreaterThan(0);
  });

  it('runs through a shell on Windows only, where the managers are .cmd shims', () => {
    expect(managerOptions('here', 'linux').shell).toBe(false);
    expect(managerOptions('here', 'linux').env).toMatchObject({ NoDefaultCurrentDirectoryInExePath: '1' });
  });
});

describe('stopping a manager', () => {
  const spawned = () => {
    const calls: { program: string; args: readonly string[] }[] = [];
    const start = ((program: string, args: readonly string[]) => {
      calls.push({ program, args });
      return { on: () => undefined };
    }) as unknown as Parameters<typeof stopTree>[2];
    return { calls, start };
  };

  it('kills the tree through taskkill on Windows, where the shell stands first', () => {
    const { calls, start } = spawned();
    const kill = vi.fn();
    stopTree({ pid: 4242, kill }, 'win32', start);
    expect(calls).toEqual([{ program: 'taskkill', args: ['/pid', '4242', '/T', '/F'] }]);
    expect(kill).not.toHaveBeenCalled();
  });

  it('kills the child itself elsewhere, and when it never got a pid', () => {
    const { calls, start } = spawned();
    const kill = vi.fn();
    stopTree({ pid: 4242, kill }, 'linux', start);
    stopTree({ pid: undefined, kill }, 'win32', start);
    expect(kill).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([]);
  });
});

describe('the reader', () => {
  it('hands the abort signal of the ask to the manager', async () => {
    const runner = vi.fn<ManagerRunner>(async () => Promise.resolve(ran(0, '{"dist-tags.latest":"1.0.0"}')));
    const signal = new AbortController().signal;
    await managerReader(runner)({ class: 'npm-package', name: 'one', cwd: 'here', signal });
    expect(runner.mock.calls[0]?.[3]).toBe(signal);
  });

  it('asks the manager in the folder of the call, and never starts one for a name it cannot ask', async () => {
    const runner = vi.fn<ManagerRunner>(async () => Promise.resolve(ran(0, '{"dist-tags.latest":"1.0.0"}')));
    const read = managerReader(runner);
    await expect(read({ class: 'npm-package', name: 'one', cwd: 'here' })).resolves.toMatchObject({ state: 'found', latest: '1.0.0' });
    expect(runner).toHaveBeenCalledWith('npm', expect.arrayContaining(['view', 'one']), 'here', undefined);
    await expect(read({ class: 'npm-package', name: 'a&calc', cwd: 'here' })).resolves.toMatchObject({ state: 'unreachable' });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('hands the manager its own timeout when given one, so the child ends itself with the process', async () => {
    const npm = vi.fn<ManagerRunner>(async () => Promise.resolve(ran(0, '{"dist-tags.latest":"1.0.0"}')));
    await managerReader(npm, 650)({ class: 'npm-package', name: 'one', cwd: 'here' });
    expect(npm.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['--fetch-timeout=650', '--fetch-retries=0']));
    const pip = vi.fn<ManagerRunner>(async () => Promise.resolve(ran(0, 'one (1.0.0)\n')));
    await managerReader(pip, 650)({ class: 'python-package', name: 'one', cwd: 'here' });
    expect(pip.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['--timeout', '1', '--retries', '0']));
  });

  it('gives pip a longer budget in whole seconds', async () => {
    const pip = vi.fn<ManagerRunner>(async () => Promise.resolve(ran(0, 'one (1.0.0)\n')));
    await managerReader(pip, 15_000)({ class: 'python-package', name: 'one', cwd: 'here' });
    expect(pip.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['--timeout', '15']));
  });

  it('adds no timeout flags when none is given, so a replay keeps the manager defaults', async () => {
    const npm = vi.fn<ManagerRunner>(async () => Promise.resolve(ran(0, '{"dist-tags.latest":"1.0.0"}')));
    await managerReader(npm)({ class: 'npm-package', name: 'one', cwd: 'here' });
    expect(npm.mock.calls[0]?.[1].join(' ')).not.toContain('timeout');
    const pip = vi.fn<ManagerRunner>(async () => Promise.resolve(ran(0, 'one (1.0.0)\n')));
    await managerReader(pip)({ class: 'python-package', name: 'one', cwd: 'here' });
    expect(pip.mock.calls[0]?.[1].join(' ')).not.toContain('timeout');
  });

  it('asks pip for a Python name', async () => {
    const runner = vi.fn<ManagerRunner>(async () => Promise.resolve(ran(0, 'one (1.0.0)\n')));
    await expect(managerReader(runner)({ class: 'python-package', name: 'one', cwd: 'here' })).resolves.toMatchObject({ state: 'found', latest: '1.0.0' });
    expect(runner).toHaveBeenCalledWith('pip', expect.arrayContaining(['index', 'versions', 'one']), 'here', undefined);
  });
});

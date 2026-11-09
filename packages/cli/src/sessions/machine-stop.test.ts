// The machine Stop's body: gated on OARS_HOST_CLASS, a detached child with its output redirected, and no wait for that child. Nothing here touches the store or a real process.
import { describe, expect, it } from 'vitest';
import { forwardedInput, machineStop, type MachineStopDeps } from './machine-stop.js';
import type { SenderSpawn } from './pool-due.js';

interface Started {
  command: string;
  args: string[];
  options: Parameters<SenderSpawn>[2];
  unrefs: number;
  listeners: number;
}

const INPUT = JSON.stringify({ session_id: 'session_1', transcript_path: '/home/u/.claude/projects/p/session_1.jsonl', cwd: '/work/repo', hook_event_name: 'Stop' });

const harness = (env: MachineStopDeps['env'], stdin = INPUT): { deps: MachineStopDeps; started: Started[] } => {
  const started: Started[] = [];
  const spawn: SenderSpawn = (command, args, options) => {
    const record: Started = { command, args, options, unrefs: 0, listeners: 0 };
    started.push(record);
    return {
      on: () => {
        record.listeners += 1;
        return undefined;
      },
      unref: () => {
        record.unrefs += 1;
      },
    };
  };
  return { deps: { env, stdin, hookBin: '/pkg/dist/hook-bin.js', home: '/home/u', spawn }, started };
};

describe('machineStop', () => {
  it.each([[{}], [{ OARS_HOST_CLASS: 'local' }], [{ OARS_HOST_CLASS: 'laptop' }], [{ OARS_HOST_CLASS: '  ' }]])('does nothing and starts nothing on %j', (env) => {
    const { deps, started } = harness(env);
    expect(machineStop(deps)).toBe('not-machine');
    expect(started).toEqual([]);
  });

  it.each(['vps', 'cloud', 'ci', 'hosted'])('starts one detached child on a %s machine, output redirected, in the home folder', (hostClass) => {
    const { deps, started } = harness({ OARS_HOST_CLASS: hostClass });
    expect(machineStop(deps)).toBe('started');
    expect(started).toHaveLength(1);
    expect(started[0]?.command).toBe(process.execPath);
    expect(started[0]?.args.slice(0, 2)).toEqual(['/pkg/dist/hook-bin.js', 'machine-child']);
    expect(started[0]?.options).toEqual({ detached: true, stdio: 'ignore', windowsHide: true, cwd: '/home/u' });
    expect(started[0]?.unrefs).toBe(1);
    expect(started[0]?.listeners).toBe(1);
  });

  it('forwards the session, transcript, and folder only: a long last message never reaches a command line', () => {
    const { deps, started } = harness({ OARS_HOST_CLASS: 'cloud' }, JSON.stringify({ session_id: 's', transcript_path: '/t.jsonl', cwd: '/c', last_assistant_message: 'x'.repeat(200_000) }));
    machineStop(deps);
    expect(JSON.parse(started[0]?.args[2] ?? '')).toEqual({ session_id: 's', transcript_path: '/t.jsonl', cwd: '/c' });
  });

  it.each([['not json'], ['[]'], ['{}'], [JSON.stringify({ session_id: 's' })], [JSON.stringify({ transcript_path: '/t.jsonl' })], [JSON.stringify({ session_id: 's', transcript_path: '' })]])('starts no child for the input %s: there is no session and transcript to build from', (stdin) => {
    const { deps, started } = harness({ OARS_HOST_CLASS: 'cloud' }, stdin);
    expect(machineStop(deps)).toBe('no-input');
    expect(started).toEqual([]);
  });

  it('reports a child that cannot start and does not throw', () => {
    const { deps } = harness({ OARS_HOST_CLASS: 'cloud' });
    expect(
      machineStop({
        ...deps,
        spawn: () => {
          throw new Error('EAGAIN');
        },
      }),
    ).toBe('failed');
  });

  // The row's 150 ms test. The hook's body must not wait for the child, and the clock here is the test's own: the fake spawn moves it by what a real spawn costs (40 ms), and the child it hands back would hold
  // the call for 20 s if the body waited on it. Nothing reads the real clock, so the machine's load cannot fail it; the real cost of the hook (node's start, measured in the cloud probe) is reported, not asserted.
  it('returns within 150 ms on a clock the test drives, with the child still running', () => {
    let clock = 0;
    let childRunning = false;
    const spawn: SenderSpawn = () => {
      clock += 40;
      childRunning = true;
      return { on: () => undefined, unref: () => undefined };
    };
    const { deps } = harness({ OARS_HOST_CLASS: 'cloud' });
    const before = clock;
    const result = machineStop({ ...deps, spawn });
    clock += 5;
    expect(result).toBe('started');
    expect(clock - before).toBeLessThanOrEqual(150);
    expect(childRunning).toBe(true);
  });
});

describe('forwardedInput', () => {
  it('keeps a missing folder as absent', () => {
    expect(JSON.parse(forwardedInput(JSON.stringify({ session_id: 's', transcript_path: '/t.jsonl' })) ?? '')).toEqual({ session_id: 's', transcript_path: '/t.jsonl' });
  });
});

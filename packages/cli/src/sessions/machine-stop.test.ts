// The machine Stop's body: gated on OARS_HOST_CLASS, a detached child with its output redirected, and no wait for that child, and the notice the last child left printed once before the next child starts. No real process starts; the one
// store here is a temp folder, and the test confirms it before it writes.
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { forwardedInput, machineStop, type MachineStopDeps } from './machine-stop.js';
import { messageOf, noticeFile, recordNotice } from './machine-notice.js';
import type { SenderSpawn } from './pool-due.js';
import { cleanup, stage } from './test-support.js';

afterEach(cleanup);

interface Started {
  order: number;
  command: string;
  args: string[];
  options: Parameters<SenderSpawn>[2];
  unrefs: number;
  listeners: number;
}

const INPUT = JSON.stringify({ session_id: 'session_1', transcript_path: '/home/u/.claude/projects/p/session_1.jsonl', cwd: '/work/repo', hook_event_name: 'Stop' });

const harness = (env: MachineStopDeps['env'], stdin = INPUT, storeDir = '/no/such/store'): { deps: MachineStopDeps; started: Started[]; printed: string[] } => {
  const started: Started[] = [];
  const printed: string[] = [];
  const spawn: SenderSpawn = (command, args, options) => {
    const record: Started = { order: printed.length, command, args, options, unrefs: 0, listeners: 0 };
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
  return { deps: { env, stdin, hookBin: '/pkg/dist/hook-bin.js', home: '/home/u', storeDir, write: (text) => printed.push(text), spawn }, started, printed };
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

  // The row's 150 ms test. The clock is the test's own, so the machine's load cannot fail it: the fake spawn charges what a real spawn costs (40 ms), and the child it hands back charges 20 s for each way the body
  // could hold the call on a child that is still running: a listener for anything but a failure to start (an exit or a close is a wait), and a child never unref'd (it keeps the hook's process alive until it ends).
  // The real cost of the hook (node's start, measured in a cloud probe) is reported, not asserted.
  it('returns within 150 ms on a clock the test drives, with the child still running', () => {
    let clock = 0;
    let unrefs = 0;
    const spawn: SenderSpawn = () => {
      clock += 40;
      return {
        on: (event: string) => {
          if (event !== 'error') clock += 20_000;
          return undefined;
        },
        unref: () => {
          unrefs += 1;
        },
      };
    };
    const { deps } = harness({ OARS_HOST_CLASS: 'cloud' });
    const result = machineStop({ ...deps, spawn });
    if (unrefs === 0) clock += 20_000;
    expect(result).toBe('started');
    expect(clock).toBeLessThanOrEqual(150);
  });
});

describe('machineStop and the notice file', () => {
  const store = (): string => {
    const { storeDir } = stage();
    if (!storeDir.startsWith(tmpdir())) throw new Error('the test store is not under the temp folder');
    mkdirSync(storeDir, { recursive: true });
    return storeDir;
  };
  const WORDS = messageOf([{ code: 'vocabulary_expired', at: 1 }]);

  it('prints the notice once as one systemMessage, before it starts its child, and clears it', async () => {
    const storeDir = store();
    await recordNotice(storeDir, 'vocabulary_expired', 1);
    const first = harness({ OARS_HOST_CLASS: 'cloud' }, INPUT, storeDir);
    expect(machineStop(first.deps)).toBe('started');
    expect(first.printed).toEqual([JSON.stringify({ systemMessage: WORDS })]);
    // Printed before the spawn: the child's record saw the notice already written.
    expect(first.started[0]?.order).toBe(1);
    expect(existsSync(noticeFile(storeDir))).toBe(false);
    const second = harness({ OARS_HOST_CLASS: 'cloud' }, INPUT, storeDir);
    expect(machineStop(second.deps)).toBe('started');
    expect(second.printed).toEqual([]);
  });

  it('prints nothing when there is no notice', () => {
    const { deps, printed } = harness({ OARS_HOST_CLASS: 'cloud' }, INPUT, store());
    machineStop(deps);
    expect(printed).toEqual([]);
  });

  it('still tells the person on a Stop that has no session to build from', async () => {
    const storeDir = store();
    await recordNotice(storeDir, 'vocabulary_expired', 1);
    const { deps, started, printed } = harness({ OARS_HOST_CLASS: 'cloud' }, '{}', storeDir);
    expect(machineStop(deps)).toBe('no-input');
    expect(started).toEqual([]);
    expect(printed).toHaveLength(1);
  });

  it('is not a machine on a laptop: nothing is printed and the notice is left where it is', async () => {
    const storeDir = store();
    await recordNotice(storeDir, 'vocabulary_expired', 1);
    const { deps, printed } = harness({}, INPUT, storeDir);
    expect(machineStop(deps)).toBe('not-machine');
    expect(printed).toEqual([]);
    expect(existsSync(noticeFile(storeDir))).toBe(true);
  });

  it('never fails the hook over a message it cannot print: the child still starts', async () => {
    const storeDir = store();
    await recordNotice(storeDir, 'vocabulary_expired', 1);
    const { deps, started } = harness({ OARS_HOST_CLASS: 'cloud' }, INPUT, storeDir);
    expect(
      machineStop({
        ...deps,
        write: () => {
          throw new Error('EPIPE');
        },
      }),
    ).toBe('started');
    expect(started).toHaveLength(1);
  });
});

describe('forwardedInput', () => {
  it('keeps a missing folder as absent', () => {
    expect(JSON.parse(forwardedInput(JSON.stringify({ session_id: 's', transcript_path: '/t.jsonl' })) ?? '')).toEqual({ session_id: 's', transcript_path: '/t.jsonl' });
  });
});

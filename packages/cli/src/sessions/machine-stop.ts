// The Stop of a machine (a cloud VM, a VPS, a self-hosted runner): `oars-hook stop --machine`. The hook's own body does one thing, it starts a detached child with its output redirected and returns, so the
// harness is never held by a capture, a settle wait, or a build; every one of those runs in the child (`machine-child.ts`). The gate is `OARS_HOST_CLASS` (`machineOf`): on a laptop, or anywhere the variable is not set to a
// machine class, this does nothing and starts nothing. It imports no store module, so the hook's cost is the node start plus this.
import { machineOf } from './machine.js';
import type { SenderSpawn } from './pool-due.js';

export type MachineStopResult = 'not-machine' | 'no-input' | 'started' | 'failed';

export interface MachineStopDeps {
  env: { [name: string]: string | undefined };
  /** The hook's stdin text. */
  stdin: string;
  /** The `hook-bin.js` that is running: the child is the same file with `machine-child`. */
  hookBin: string;
  /** The child's working folder, the home folder, so it never holds the session's repository open. */
  home: string;
  spawn: SenderSpawn;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** What the child needs of the hook's input: the session, its transcript, and the folder it ran in. The rest of the input (a long last message, say) never goes onto a command line. `undefined` when it has no session or no transcript. */
export const forwardedInput = (stdin: string): string | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdin);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const session = text(Reflect.get(parsed, 'session_id'));
  const transcript = text(Reflect.get(parsed, 'transcript_path'));
  if (session === undefined || transcript === undefined) return undefined;
  return JSON.stringify({ session_id: session, transcript_path: transcript, cwd: text(Reflect.get(parsed, 'cwd')) });
};

/** Never throws: a hook that cannot start its child must not fail the session. A child that cannot start later (its `error` event) is dropped; the next Stop builds the same batch. */
export const machineStop = (deps: MachineStopDeps): MachineStopResult => {
  if (machineOf(deps.env) === undefined) return 'not-machine';
  const input = forwardedInput(deps.stdin);
  if (input === undefined) return 'no-input';
  try {
    const child = deps.spawn(process.execPath, [deps.hookBin, 'machine-child', input], { detached: true, stdio: 'ignore', windowsHide: true, cwd: deps.home });
    child.on('error', () => undefined);
    child.unref();
    return 'started';
  } catch {
    return 'failed';
  }
};

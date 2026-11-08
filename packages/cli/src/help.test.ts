import { describe, expect, it } from 'vitest';
import { run } from './cli.js';
import { harness } from './test-support.js';

/** The help text each command prints, joined, with the wrapping collapsed. Commander ends the parse on --help with exit code 0 after printing. */
const helpOf = async (...argv: string[]): Promise<string> => {
  const h = harness();
  await run([...argv, '--help'], h.deps);
  return h.out.join('').replace(/\s+/g, ' ');
};

describe('help text states what the code does', () => {
  it('sessions hook install names all five hooks it writes and that sends ride the hook and commands', async () => {
    const text = await helpOf('sessions', 'hook', 'install');
    expect(text).toContain('merge the SessionStart, UserPromptSubmit, PreToolUse, PostToolUseFailure, and SessionEnd hooks into a settings file');
    expect(text).toContain('on Windows, remove the nightly task an earlier version registered (oars installs no scheduler: a due sweep and send, at most about hourly, starts from the session-end hook and from any oars command; telemetry goes only while it is on, and pool batches only after you accept a pool covenant)');
  });

  it('pool raw --mode says off sends nothing from that folder to the pool', async () => {
    expect(await helpOf('pool', 'raw')).toContain('off sends nothing from that folder to the pool from now on');
  });

  it('sessions deposit says a raw transcript is hard-linked or copied', async () => {
    expect(await helpOf('sessions', 'deposit')).toContain('is hard-linked or copied into the oars archive');
  });

  it('the program line says coding-agent sessions, not Claude Code sessions', async () => {
    const text = await helpOf();
    expect(text).toContain('a local, searchable record of your own coding-agent sessions');
    expect(text).not.toContain('Claude Code sessions');
  });

  it('pool names the redacted raw copies that a yes to the raw prompt adds', async () => {
    expect(await helpOf('pool')).toContain('and, after a yes to the raw prompt, redacted raw copies');
  });
});

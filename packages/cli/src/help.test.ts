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
  it('sessions hook install names all four hooks it writes and the nightly task that sends', async () => {
    const text = await helpOf('sessions', 'hook', 'install');
    expect(text).toContain('merge the SessionStart, PreToolUse, PostToolUseFailure, and SessionEnd hooks into a settings file');
    expect(text).toContain('on Windows register the nightly task (which sends to the pool after you accept its covenant)');
  });

  it('sessions deposit says a raw transcript is hard-linked or copied', async () => {
    expect(await helpOf('sessions', 'deposit')).toContain('is hard-linked or copied into the oars archive');
  });

  it('pool names the redacted raw copies that a yes to the raw prompt adds', async () => {
    expect(await helpOf('pool')).toContain('and, after a yes to the raw prompt, redacted raw copies');
  });
});

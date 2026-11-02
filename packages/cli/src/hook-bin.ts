// The one entry file the installed hooks and the nightly task run: `node hook-bin.js <session-start|post-tool|stop|nightly>`, with the
// hook event JSON on stdin. It imports only the store modules (not the CLI), so a call costs little more than the node start, and it
// always exits 0 with no output on any failure: a hook must never fail or block a session.
import { homedir } from 'node:os';
import { HOOK_EVENTS, hookRuntime, runHook, type HookEvent } from './sessions/hooks.js';

const readStdin = async (): Promise<string> => {
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
};

const eventOf = (name: string | undefined): HookEvent | undefined => HOOK_EVENTS.find((event) => event === name);

try {
  const event = eventOf(process.argv[2]);
  if (event !== undefined) {
    const output = await runHook(
      event,
      event === 'nightly' ? '' : await readStdin(),
      hookRuntime(event, process.env, process.platform, homedir(), { stdin: process.stdin, stdout: process.stdout }),
      Date.now,
    );
    if (output !== undefined) process.stdout.write(output);
  }
} catch {
  // Fail-open.
}
process.exitCode = 0;

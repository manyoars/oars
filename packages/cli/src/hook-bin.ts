// The one entry file the installed hooks and the nightly task run: `node hook-bin.js <session-start|post-tool|stop|nightly>`, with the
// hook event JSON on stdin. It imports only the store modules (not the CLI), so a call costs little more than the node start, and it
// always exits 0 with no output on any failure: a hook must never fail or block a session.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultConfigDir } from './credentials.js';
import { HOOK_EVENTS, runHook, type HookEvent } from './sessions/hooks.js';

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
      {
        storeDir: join(defaultConfigDir(process.env, process.platform, homedir()), 'oars', 'sessions'),
        projectsRoot: join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects'),
        stdin: process.stdin,
        stdout: process.stdout,
      },
      Date.now,
    );
    if (output !== undefined) process.stdout.write(output);
  }
} catch {
  // Fail-open.
}
process.exitCode = 0;

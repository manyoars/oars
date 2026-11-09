// The entry file Codex runs for the recording hook: `node codex-hook-bin.js`, with the hook event JSON on stdin. It imports only the store modules
// (not the CLI) and always exits 0 with no output: a hook must never fail or block a session.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultConfigDir } from '../credentials.js';
import { runCodexHook } from './codex-hook.js';
import { appendOwnerOnly } from './owner-only.js';

try {
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  const home = homedir();
  await runCodexHook(text, {
    storeDir: join(defaultConfigDir(process.env, process.platform, home), 'oars', 'sessions'),
    home,
    now: Date.now,
    append: appendOwnerOnly,
  });
} catch {
  // Fail-open.
}
process.exitCode = 0;

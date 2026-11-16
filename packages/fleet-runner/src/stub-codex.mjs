// A stand-in for the `codex` executable, for the Codex adapter's tests only. The first line of the prompt on stdin names the scenario; the stub writes what a real `codex exec --json`
// run would (JSONL events on stdout, a rollout file under $CODEX_HOME/sessions/YYYY/MM/DD) and records what it was started with in $CODEX_HOME/stub-seen.json. It never opens the network.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const valueOf = (/** @type {string} */ flag) => argv[argv.indexOf(flag) + 1] ?? '';
let prompt = '';
for await (const chunk of process.stdin) prompt += String(chunk);
const scenario = prompt.split('\n')[0]?.replace('scenario:', '').trim() ?? 'ok';
const home = process.env.CODEX_HOME ?? '';
const config = readFileSync(join(home, 'config.toml'), 'utf8');
writeFileSync(join(home, 'stub-seen.json'), JSON.stringify({ argv, envNames: Object.keys(process.env).sort(), cwd: process.cwd(), prompt }));

// What the real Codex does with `[shell_environment_policy]` (https://developers.openai.com/codex/config-advanced#shell-environment-policy): `inherit = "core"` keeps a trimmed set, `ignore_default_excludes = false`
// (the default is true, which keeps them) drops names holding KEY, SECRET, or TOKEN, then each `"PATTERN" = "exclude"` filter drops matches (case-insensitive, `*` and `?`). The stub applies those rules
// to start one child the way Codex starts a shell command, so a test shows the adapter asked for the documented policy, not that Codex honors it.
const CORE = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE'];
const section = (/** @type {string} */ name) => new RegExp(String.raw`^\[${name.replace('.', String.raw`\.`)}\]\n([^[]*)`, 'm').exec(config)?.[1] ?? '';
const policy = section('shell_environment_policy');
const inherit = /inherit = "(\w+)"/.exec(policy)?.[1] ?? 'all';
const dropSecrets = /ignore_default_excludes = false/.test(policy);
const excludes = [...section('shell_environment_policy.filters').matchAll(/^"([^"]+)" = "exclude"$/gm)].map((match) => new RegExp(`^${(match[1] ?? '').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i'));
/** @type {{ [name: string]: string }} */
const childEnv = {};
for (const [name, value] of Object.entries(process.env)) {
  if (value === undefined) continue;
  if (inherit === 'none' || (inherit === 'core' && !CORE.includes(name))) continue;
  if (dropSecrets && /KEY|SECRET|TOKEN/i.test(name)) continue;
  if (excludes.some((pattern) => pattern.test(name))) continue;
  childEnv[name] = value;
}
const childSaw = execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))'], { env: childEnv, encoding: 'utf8' });
writeFileSync(join(home, 'stub-child-seen.json'), childSaw);

const line = (/** @type {object} */ value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const model = scenario === 'model' ? 'other-deployment' : valueOf('--model');
const threadId = '019a0000-0000-7000-8000-000000000001';
line({ type: 'thread.started', thread_id: threadId });
line({ type: 'turn.started' });
const failed = (/** @type {string} */ message) => {
  line({ type: 'error', message });
  line({ type: 'turn.failed', error: { message } });
  process.exit(1);
};
if (scenario === 'tree') {
  // The harness starts MCP servers of its own; a timeout must end them too.
  const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 60000)'], {
    stdio: 'ignore',
    // On Windows a plain child can end with its parent through the host's job object, which would hide a missing tree kill; a detached one only a tree kill reaches. Elsewhere it stays in the group.
    detached: process.platform === 'win32',
  });
  writeFileSync(join(home, 'grandchild.pid'), String(grandchild.pid));
  setTimeout(() => undefined, 60000);
} else if (scenario === 'hang') setTimeout(() => undefined, 60000);
else if (scenario === 'crash') process.exit(139);
else if (scenario === 'auth') failed('unexpected status 401 Unauthorized: Incorrect API key provided');
else if (scenario === 'rate') failed('exceeded retry limit, last status: 429 Too Many Requests: rate limit reached');
else if (scenario === 'network') failed('error sending request: getaddrinfo ENOTFOUND example.openai.azure.com');
else if (scenario === 'server') failed('unexpected status 500 Internal Server Error');
else {
  if (scenario !== 'norollout') {
    const day = join(home, 'sessions', '2026', '11', '16');
    mkdirSync(day, { recursive: true });
    const rows = [
      { type: 'session_meta', payload: { id: threadId, cwd: process.cwd(), cli_version: scenario === 'version' ? '9.9.9' : '0.170.0' } },
      { type: 'turn_context', payload: { model, cwd: process.cwd(), approval_policy: 'never' } },
      { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 100, reasoning_output_tokens: 20 } } } },
      { type: 'event_msg', payload: { type: 'token_count', info: null } },
      { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 2000, cached_input_tokens: 1500, cache_write_input_tokens: 100, output_tokens: 200 } } } },
    ];
    if (scenario === 'subagent') {
      // A spawned agent's rollout sorts later and names a parent thread; it is no part of the run's own transcript.
      const child = '019a0000-0000-7000-8000-000000000002';
      writeFileSync(join(day, `rollout-2026-11-16T10-05-00-${child}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id: child, parent_thread_id: threadId, cli_version: '8.8.8' } })}
`);
    }
    writeFileSync(join(day, `rollout-2026-11-16T10-00-00-${threadId}.jsonl`), `${rows.map((row) => JSON.stringify({ timestamp: '2026-11-16T10:00:00Z', ...row })).join('\n')}\n`);
  }
  line({ type: 'turn.completed', usage: { input_tokens: 3000, cached_input_tokens: 1900, output_tokens: 300 } });
  process.exit(0);
}

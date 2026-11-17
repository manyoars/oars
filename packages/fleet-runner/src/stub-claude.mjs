// A stand-in for the `claude` executable, for the Bedrock adapter's tests only. The first line of the prompt on stdin names the scenario; the stub writes what a real
// run would (a stream-json stdout, a transcript under the config folder) and records what it was started with in <config>/stub-seen.json. It never opens the network.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const valueOf = (/** @type {string} */ flag) => argv[argv.indexOf(flag) + 1] ?? '';
let prompt = '';
for await (const chunk of process.stdin) prompt += String(chunk);
const scenario = prompt.split('\n')[0]?.replace('scenario:', '').trim() ?? 'ok';
const config = process.env.CLAUDE_CONFIG_DIR ?? '';
const sessionId = valueOf('--session-id');
writeFileSync(join(config, 'stub-seen.json'), JSON.stringify({ argv, envNames: Object.keys(process.env).sort(), cwd: process.cwd(), prompt }));
// What the real Claude Code does with CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 (env-vars.md): its Bash, hook, and stdio MCP children get no credential. The stub starts one child
// the way Claude Code starts its Bash tool and records the names that child sees; the stub applies the documented scrub itself, so this shows the adapter asked for it, not that Claude Code honors it.
const childEnv = { ...process.env };
if (process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB === '1') delete childEnv.AWS_BEARER_TOKEN_BEDROCK;
const childSaw = execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))'], { env: childEnv, encoding: 'utf8' });
writeFileSync(join(config, 'stub-child-seen.json'), childSaw);
// Every stdout line is also kept in <config>/stub-stdout.txt, so a test can compare what the adapter saved with what the child wrote.
const line = (/** @type {object} */ value) => {
  const text = `${JSON.stringify(value)}\n`;
  appendFileSync(join(config, 'stub-stdout.txt'), text);
  process.stdout.write(text);
};
const model = scenario === 'model' ? 'other-model-id' : valueOf('--model');
line({ type: 'system', subtype: 'init', session_id: sessionId, claude_code_version: scenario === 'version' ? '9.9.9' : '2.1.326', model });
if (scenario === 'tree') {
  // The harness starts MCP servers of its own; a timeout must end them too.
  const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 60000)'], {
    stdio: 'ignore',
    // On Windows a plain child can end with its parent through the host's job object, which would hide a missing tree kill; a detached one only a tree kill reaches. Elsewhere it stays in the group.
    detached: process.platform === 'win32',
  });
  writeFileSync(join(config, 'grandchild.pid'), String(grandchild.pid));
  setTimeout(() => undefined, 60000);
} else if (scenario === 'echokey') {
  // A harness that prints the key's value into its output; the saved copy must not hold it.
  line({ type: 'assistant', text: `key is ${process.env.AWS_BEARER_TOKEN_BEDROCK ?? ''}` });
  process.exit(0);
} else if (scenario === 'hang') setTimeout(() => undefined, 60000);
else if (scenario === 'crash') process.exit(139);
else {
  const projects = join(config, 'projects', process.env.CLAUDE_CODE_PROJECT_DIR_NAME ?? 'work');
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, `${sessionId}.jsonl`), `transcript of ${sessionId}\n`);
  const status = scenario === 'auth' ? 401 : scenario === 'rate' ? 429 : null;
  line({
    type: 'result',
    subtype: status === null ? 'success' : 'error_during_execution',
    is_error: status !== null,
    api_error_status: status,
    session_id: sessionId,
    modelUsage: { [model]: { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 4000, cacheCreationInputTokens: 500 } },
  });
  process.exit(status === null ? 0 : 1);
}

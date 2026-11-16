// A stand-in for the `claude` executable, for the Bedrock adapter's tests only. The first line of the prompt on stdin names the scenario; the stub writes what a real
// run would (a stream-json stdout, a transcript under the config folder) and records what it was started with in <config>/stub-seen.json. It never opens the network.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const valueOf = (/** @type {string} */ flag) => argv[argv.indexOf(flag) + 1] ?? '';
let prompt = '';
for await (const chunk of process.stdin) prompt += String(chunk);
const scenario = prompt.split('\n')[0]?.replace('scenario:', '').trim() ?? 'ok';
const config = process.env.CLAUDE_CONFIG_DIR ?? '';
const sessionId = valueOf('--session-id');
writeFileSync(join(config, 'stub-seen.json'), JSON.stringify({ argv, envNames: Object.keys(process.env).sort(), cwd: process.cwd(), prompt }));
const line = (/** @type {object} */ value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const model = scenario === 'model' ? 'other-model-id' : valueOf('--model');
line({ type: 'system', subtype: 'init', session_id: sessionId, claude_code_version: scenario === 'version' ? '9.9.9' : '2.1.30', model });
if (scenario === 'hang') setTimeout(() => undefined, 60000);
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

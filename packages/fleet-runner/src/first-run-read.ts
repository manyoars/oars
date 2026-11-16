// `npm run first-run-read -w packages/fleet-runner -- --transcript <file> --output <file> --run-book <file> --model-id <Bedrock ID> [--run-id <id>] [--marker <text>] [--allow-server <name>]... [--allow-skill <name>]...`
// Reads the files ONE real run leaves behind (the transcript copy, the captured `claude -p --output-format stream-json` stdout, and the run's line in the run book) and prints one line per question
// t1359 left open: `yes`, `no`, or `cannot tell`, and the evidence it read. It only prints. It never decides a void, never edits a record, and opens every input read-only; a test proves the inputs are byte-identical after.
// The marker may also come from the FIRST_RUN_MARKER environment variable, which keeps it out of shell history and the process list.
// Evidence lines name a line number or a field, never a matched secret: neither the key nor `--marker` is ever printed.
// Field names (https://code.claude.com/docs/en/agent-sdk/typescript.md, read 2026-11-16, and headless.md): the `system`/`init` event has `model`, `mcp_servers[].name`, `skills`, and `claude_code_version`;
// the `result` event has `subtype`, `is_error`, `api_error_status` (HTTP status of the API error that ended the turn, absent or null otherwise), `permission_denials[]`, and `modelUsage.<model>` with
// `inputTokens`, `outputTokens`, `cacheReadInputTokens`, and `cacheCreationInputTokens`. A `permission_denied` system message may also appear in the stream (headless.md, "permission_denials").
import { readFile } from 'node:fs/promises';
import { isObject, type JsonObject, parseJson } from './json.js';

type Answer = 'yes' | 'no' | 'cannot tell';

const flag = (argv: string[], name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

const flags = (argv: string[], name: string): string[] => argv.flatMap((arg, at) => (arg === name ? [argv[at + 1] ?? ''] : []));

const USAGE = 'usage: first-run-read --transcript <file> --output <file> --run-book <file> --model-id <Bedrock model ID> [--run-id <id>] [--marker <text>] [--allow-server <name>]... [--allow-skill <name>]...';

const jsonLines = (text: string): { at: number; value: unknown }[] =>
  text.split('\n').flatMap((line, index) => {
    if (line.trim() === '') return [];
    try {
      return [{ at: index + 1, value: parseJson(line, 'line') }];
    } catch {
      return [];
    }
  });

const objects = (text: string): { at: number; event: JsonObject }[] => jsonLines(text).flatMap(({ at, value }) => (isObject(value) ? [{ at, event: value }] : []));

/** Every `tool_result` block anywhere inside one transcript line, as text. */
const toolResults = (value: unknown, found: string[] = []): string[] => {
  if (Array.isArray(value)) for (const item of value) toolResults(item, found);
  else if (isObject(value)) {
    if (value['type'] === 'tool_result') found.push(JSON.stringify(value['content'] ?? ''));
    else for (const item of Object.values(value)) toolResults(item, found);
  }
  return found;
};

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap((item) => (typeof item === 'string' ? [item] : isObject(item) && typeof item['name'] === 'string' ? [item['name']] : [])) : []);

// Each server as `name` or `name (source)`; `source` is where its definition came from (typescript.md, SDKSystemMessage `mcp_servers[].source`).
const servers = (value: unknown, keep: (name: string) => boolean = () => true): string[] =>
  Array.isArray(value) ? value.flatMap((item) => (isObject(item) && typeof item['name'] === 'string' && keep(item['name']) ? [typeof item['source'] === 'string' ? `${item['name']} (${item['source']})` : item['name']] : [])) : [];

const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);

// What Claude Code prints before a first run is usable: a sign-in or onboarding prompt. Searched only in stream lines that are not JSON and in an error result's text.
const ONBOARDING = /sign in|log ?in|onboarding|welcome to claude|select login method|choose (a|the) (text style|theme)|trust (this|the) folder|api key.*(detected|approve)/i;

export interface Inputs {
  transcript: string;
  output: string;
  runBook: string;
  modelId: string;
  runId?: string;
  marker?: string;
  allowServers: string[];
  allowSkills: string[];
}

const line = (name: string, answer: Answer, evidence: string): string => `${answer.padEnd(11)} ${name}: ${evidence}`;

/** The seven lines, from the file contents alone (no file is touched here). */
export const readFirstRun = (inputs: Inputs): string[] => {
  const events = objects(inputs.output);
  const init = events.find(({ event }) => event['type'] === 'system' && event['subtype'] === 'init');
  const result = events.filter(({ event }) => event['type'] === 'result').at(-1);
  const lines: string[] = [];

  // The scrub: no tool result in the transcript shows the variable's name or a marker of its value.
  const results = jsonLines(inputs.transcript).flatMap(({ at, value }) => toolResults(value).map((text) => ({ at, text })));
  const needles = ['AWS_BEARER_TOKEN_BEDROCK', ...(inputs.marker === undefined || inputs.marker === '' ? [] : [inputs.marker])];
  const leaked = results.filter(({ text }) => needles.some((needle) => text.includes(needle)));
  if (leaked.length > 0) lines.push(line('scrub (the key did not reach a tool)', 'no', `tool results on transcript line ${leaked.map(({ at }) => String(at)).join(', ')} show the key's name or marker`));
  else if (results.length === 0) lines.push(line('scrub (the key did not reach a tool)', 'cannot tell', 'the transcript holds no tool result to search (or its tool_result shape is not the one read)'));
  else lines.push(line('scrub (the key did not reach a tool)', 'yes', `${String(results.length)} tool results read; none shows the key's name${inputs.marker === undefined || inputs.marker === '' ? '' : ' or the marker'}`));

  // (a) A sign-in or onboarding prompt in the output.
  const prose = inputs.output.split('\n').filter((text) => text.trim() !== '' && jsonLines(text).length === 0);
  // The error arm has no `result` string: it carries `errors: string[]` and, on a known startup refusal, `startup_failure_reason`.
  const errorText = events.flatMap(({ event }) => {
    if (event['type'] !== 'result' || event['is_error'] !== true) return [];
    const reason = typeof event['startup_failure_reason'] === 'string' ? [`startup_failure_reason ${event['startup_failure_reason']}`] : [];
    const errors = Array.isArray(event['errors']) ? event['errors'].filter((item): item is string => typeof item === 'string') : [];
    return [...(typeof event['result'] === 'string' ? [event['result']] : []), ...errors, ...reason];
  });
  const startup = events.some(({ event }) => event['type'] === 'result' && typeof event['startup_failure_reason'] === 'string');
  const prompts = [...prose, ...errorText].filter((text) => ONBOARDING.test(text) || text.startsWith('startup_failure_reason '));
  if (prompts.length > 0 || startup) lines.push(line('(a) an onboarding or sign-in prompt appeared', 'yes', `${String(prompts.length)} output lines match, first: "${(prompts[0] ?? '').slice(0, 80)}"`));
  else if (result === undefined) lines.push(line('(a) an onboarding or sign-in prompt appeared', 'cannot tell', 'the output has no result event, so the run may have stopped before any prompt could show'));
  else lines.push(line('(a) an onboarding or sign-in prompt appeared', 'no', `the run reached its result event (line ${String(result.at)}) and no output line reads like a prompt`));

  // (b) The fixture's own .claude/ or .mcp.json loaded: init lists a server or skill the run did not allow.
  if (init === undefined) lines.push(line("(b) the fixture's own config loaded", 'cannot tell', 'the output has no system init event'));
  else if (init.event['mcp_servers'] === undefined || init.event['skills'] === undefined) lines.push(line("(b) the fixture's own config loaded", 'cannot tell', `init (line ${String(init.at)}) lacks ${init.event['mcp_servers'] === undefined ? 'mcp_servers' : 'skills'}`));
  else {
    const extraServers = servers(init.event['mcp_servers'], (name) => !inputs.allowServers.includes(name));
    const extraSkills = strings(init.event['skills']).filter((name) => !inputs.allowSkills.includes(name));
    if (extraServers.length + extraSkills.length > 0) lines.push(line("(b) the fixture's own config loaded", 'yes', `init (line ${String(init.at)}) lists servers not allowed [${extraServers.join(', ')}] and skills not allowed [${extraSkills.join(', ')}]`));
    else lines.push(line("(b) the fixture's own config loaded", 'no', `init (line ${String(init.at)}) lists only the allowed servers [${strings(init.event['mcp_servers']).join(', ')}] and skills [${strings(init.event['skills']).join(', ')}]`));
  }

  // (c) An API error carries a status in the result event.
  if (result === undefined) lines.push(line('(c) an API error carries a status', 'cannot tell', 'the output has no result event'));
  else if (result.event['subtype'] !== 'success') lines.push(line('(c) an API error carries a status', 'cannot tell', `the result (line ${String(result.at)}) is subtype ${String(result.event['subtype'])}; api_error_status exists only on the success arm`));
  else if (result.event['is_error'] !== true) lines.push(line('(c) an API error carries a status', 'cannot tell', `the result (line ${String(result.at)}) is not an error, so no API error was seen`));
  else {
    const status = num(result.event['api_error_status']);
    lines.push(status === null ? line('(c) an API error carries a status', 'no', `the error result (line ${String(result.at)}) has no api_error_status`) : line('(c) an API error carries a status', 'yes', `api_error_status ${String(status)} on result line ${String(result.at)}`));
  }

  // (d) The task finished with no permission denial.
  const denied = events.filter(({ event }) => event['type'] === 'system' && event['subtype'] === 'permission_denied').length;
  const denials = result === undefined ? null : result.event['permission_denials'];
  if (result === undefined || !Array.isArray(denials)) lines.push(line('(d) the task finished with no permission denial', 'cannot tell', 'the output has no result event with a permission_denials list'));
  else if (denials.length > 0 || denied > 0) lines.push(line('(d) the task finished with no permission denial', 'no', `permission_denials holds ${String(denials.length)} (tools: ${denials.map((item) => (isObject(item) ? String(item['tool_name']) : '?')).join(', ')}); ${String(denied)} permission_denied messages`));
  else if (result.event['subtype'] === 'success' && result.event['is_error'] === true) lines.push(line('(d) the task finished with no permission denial', 'no', `the success result (line ${String(result.at)}) has is_error true (api_error_status ${String(num(result.event['api_error_status']) ?? 'absent')}): an API error ended the turn, so the task did not finish`));
  else lines.push(line('(d) the task finished with no permission denial', result.event['subtype'] === 'success' ? 'yes' : 'no', `result subtype ${String(result.event['subtype'])}, permission_denials empty`));

  // (e) The init model ID equals the Bedrock ID passed.
  const model = init?.event['model'];
  if (typeof model !== 'string') lines.push(line('(e) the init model equals the Bedrock ID passed', 'cannot tell', 'the output has no init event with a model'));
  else lines.push(model === inputs.modelId ? line('(e) the init model equals the Bedrock ID passed', 'yes', `init model is ${model}`) : line('(e) the init model equals the Bedrock ID passed', 'no', `init model is ${model}, passed ${inputs.modelId}`));

  // (f) The token fields are present, and how cache read and creation appear.
  const usage = result === undefined ? null : result.event['modelUsage'];
  const record = runOf(inputs);
  if (!isObject(usage) || Object.keys(usage).length === 0) lines.push(line('(f) the token fields are present', 'cannot tell', 'the result has no modelUsage'));
  else {
    const names = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'];
    const entries = Object.entries(usage).flatMap(([id, value]) => (isObject(value) ? [{ id, value }] : []));
    const missing = entries.flatMap(({ id, value }) => names.filter((name) => num(value[name]) === null).map((name) => `${id}.${name}`));
    const read = entries.reduce((sum, { value }) => sum + (num(value['cacheReadInputTokens']) ?? 0), 0);
    const created = entries.reduce((sum, { value }) => sum + (num(value['cacheCreationInputTokens']) ?? 0), 0);
    const detail = `cache read ${String(read)}, cache creation ${String(created)}, run record cacheTokens ${record === null ? 'unreadable' : String(record.cacheTokens)}`;
    if (missing.length > 0 || entries.length === 0) lines.push(line('(f) the token fields are present', 'no', `missing ${missing.join(', ')}`));
    else if (record === null) lines.push(line('(f) the token fields are present', 'cannot tell', `fields present; ${detail}`));
    else lines.push(record.cacheTokens === read + created ? line('(f) the token fields are present', 'yes', `${detail}: the record's cache is read plus creation`) : line('(f) the token fields are present', 'no', `${detail}: the record's cache is not read plus creation`));
  }
  return lines;
};

const runOf = (inputs: Inputs): { cacheTokens: number } | null => {
  const runs = objects(inputs.runBook).filter(({ event }) => typeof event['runId'] === 'string' && (inputs.runId === undefined || event['runId'] === inputs.runId));
  const only = runs.length === 1 ? runs[0] : undefined;
  const tokens = only === undefined ? null : only.event['cacheTokens'];
  return only === undefined || typeof tokens !== 'number' ? null : { cacheTokens: tokens };
};

export const main = async (argv: string[], print: (line: string) => void, env: NodeJS.ProcessEnv = process.env): Promise<number> => {
  const transcript = flag(argv, '--transcript');
  const output = flag(argv, '--output');
  const runBook = flag(argv, '--run-book');
  const modelId = flag(argv, '--model-id');
  if (transcript === undefined || output === undefined || runBook === undefined || modelId === undefined) {
    print(USAGE);
    return 2;
  }
  try {
    const inputs: Inputs = {
      transcript: await readFile(transcript, 'utf8'),
      output: await readFile(output, 'utf8'),
      runBook: await readFile(runBook, 'utf8'),
      modelId,
      allowServers: flags(argv, '--allow-server'),
      allowSkills: flags(argv, '--allow-skill'),
    };
    const runId = flag(argv, '--run-id');
    const marker = flag(argv, '--marker') ?? env['FIRST_RUN_MARKER'];
    if (runId !== undefined) inputs.runId = runId;
    if (marker !== undefined) inputs.marker = marker;
    print('first-run-read: reads only, decides no void, edits no record');
    for (const text of readFirstRun(inputs)) print(text);
    return 0;
  } catch (error) {
    print(`first-run-read: ${error instanceof Error ? error.message : 'failed'}`);
    return 2;
  }
};

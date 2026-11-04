import { describe, expect, it } from 'vitest';
import { ACTION_TABLES } from './actions.js';
import { captureSession, type Capture } from './extract.js';
import { callIdentity } from './identity.js';
import { BUNDLING_PROGRAMS, PUBLIC_MCP_SERVERS, PUBLIC_MCP_TOOLS, PUBLIC_PROGRAMS } from './public-vocabulary.js';
import { makeRedactor } from './redact.js';
import type { StepObservation, ToolObservation } from './schema.js';

const line = (value: object): string => JSON.stringify(value);

interface Call {
  name: string;
  input: object;
  /** The output of a failed result, so the call also leaves an error-line record. */
  failure?: string;
}

/** One prompt holding the given calls. */
const captured = (calls: readonly Call[], harness?: 'claude-code' | 'cursor'): Capture => {
  const text = [
    line({ type: 'user', timestamp: '2026-05-29T04:30:00Z', message: { role: 'user', content: 'p' } }),
    ...calls.flatMap((call, index) => [
      line({ type: 'assistant', timestamp: '2026-05-29T04:30:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${String(index)}`, name: call.name, input: call.input }] } }),
      ...(call.failure === undefined ? [] : [line({ type: 'user', timestamp: '2026-05-29T04:30:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${String(index)}`, is_error: true, content: call.failure }] } })]),
    ]),
  ].join('\n');
  return captureSession({ text, session: 's', project: 'p', rev: 1, at: 'x', bytes: 1, redact: makeRedactor([]), ...(harness === undefined ? {} : { harness }) });
};

const capture = (calls: readonly Call[], harness?: 'claude-code' | 'cursor'): ToolObservation[] => captured(calls, harness).tools;
const stepsOf = (calls: readonly Call[]): StepObservation[] => capture(calls).flatMap((tool) => tool.steps ?? []);
const shell = (command: string): StepObservation[] => stepsOf([{ name: 'Bash', input: { command } }]);

// The class A and L fields of each record, from the class table in `docs/sessions-store.md`. Named as the fields to drop, so a field added later counts as class P and is checked until someone classes it.
const NOT_POOLED = {
  session: ['session', 'parent', 'spawnedBy', 'spawnedIn', 'at', 'tsFirst', 'tsLast', 'promptFingerprint', 'repo', 'tools', 'fileHashes', 'urls', 'searches', 'branches', 'tldrs', 'confidences', 'project', 'files'],
  prompt: ['session', 'ts', 'head', 'promptFingerprint', 'skills'],
  tool: ['session', 'parent', 'toolUseId', 'ts', 'tool', 'target', 'segments', 'pulls', 'packages', 'manifest', 'commits'],
  errorLine: ['session', 'toolUseId', 'tool', 'ts', 'line'],
} as const;

const withoutFields = (record: object, fields: readonly string[]): object => Object.fromEntries(Object.entries(record).filter(([field]) => !fields.includes(field)));

/** Every class P field of the four capture records. */
const pooled = (capture: Capture): string =>
  JSON.stringify([
    withoutFields(capture.session, NOT_POOLED.session),
    capture.prompts.map((prompt) => withoutFields(prompt, NOT_POOLED.prompt)),
    capture.tools.map((tool) => withoutFields(tool, NOT_POOLED.tool)),
    capture.errorLines.map((errorLine) => withoutFields(errorLine, NOT_POOLED.errorLine)),
  ]);

describe('identity holds public names only', () => {
  it('reads a shell step as its program, subcommand, and flag names', () => {
    expect(shell('git push --force origin main')[0]?.identity).toEqual({ program: 'git', sub: 'push', flags: ['--force'] });
  });

  it('keeps copilot as a public program name', () => {
    expect(shell('copilot --resume')[0]?.identity).toMatchObject({ program: 'copilot' });
  });

  it('finds the subcommand behind a global flag and its value', () => {
    expect(shell('git -C /home/alice/repo status')[0]?.identity).toMatchObject({ program: 'git', sub: 'status' });
    expect(shell('git -c user.name=alice commit -m "hello"')[0]?.identity).toMatchObject({ program: 'git', sub: 'commit' });
  });

  it.each([
    ['an assignment before the command', 'FOO=hunter2value git status', 'hunter2value'],
    ['a flag with its value joined', 'git push --token=abcvalue', 'abcvalue'],
    ['a flag with its value apart', 'git push --token abcvalue', 'abcvalue'],
    ['a value in a program flag', 'mysql -pmypassword', 'mypassword'],
    ['a short value in a program flag', 'mysql -pabc', 'abc'],
    ['a define', 'mvn -Dapi.key=defvalue test', 'defvalue'],
    ['a path holding a username', 'cat /home/alicesmith/notes.txt', 'alicesmith'],
    ['a Windows path holding a username', 'type C:\\Users\\alicesmith\\notes.txt', 'alicesmith'],
    ['a private program by path', '/home/alicesmith/bin/acme-deploy --prod', 'acme-deploy'],
    ['a private script', './scripts/acme-release.sh', 'acme-release'],
    ['a private package', 'npm install @acme-corp/internal-ledger@1.2.3', 'acme-corp'],
    ['a private package on a runner', 'npx acme-private-tool --customer=globex', 'acme-private-tool'],
    ['a private flag on a public program', 'node run.js --acme-customer-list', 'acme-customer-list'],
    ['a private word where a subcommand goes', 'git acmealias', 'acmealias'],
    ['a private word in a quoted sentence', 'git commit -m "for acme corp"', 'acme'],
    ['a URL with credentials', 'curl https://alice:s3cretpw@corp.example/x', 's3cretpw'],
  ])('keeps %s out of every class P field', (_name, command, value) => {
    const steps = shell(command);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0]?.identity).toBeDefined();
    // Failed, with the command in its output, so an error-line record is in the check too.
    const failed = captured([{ name: 'Bash', input: { command }, failure: `boom: ${command}` }]);
    expect(failed.errorLines).toHaveLength(1);
    expect(pooled(failed)).not.toContain(value);
  });

  it('masks a private program and takes no flags from it', () => {
    expect(shell('acme-deploy --force --prod')[0]?.identity).toEqual({ program: '<literal>', sub: null, flags: [] });
  });

  it('masks a word that is not one of a public program subcommands', () => {
    expect(shell('git acmealias')[0]?.identity).toMatchObject({ program: 'git', sub: '<literal>' });
  });

  it('keeps flag names sorted and single, whatever order they came in, and masks a name outside the list', () => {
    expect(shell('git log --oneline --all --oneline')[0]?.identity).toMatchObject({ flags: ['--all', '--oneline'] });
    expect(shell('git log --all --acme-private')[0]?.identity).toMatchObject({ flags: ['--all', '<literal>'] });
  });

  // Names the 120-session re-derive found masked. Each value below must stay out while its flag name comes through.
  it.each([
    ['cut -c1-200 file', ['-c']],
    ['grep -A3 needle', ['-A']],
    ['mysql -p12345', ['-p']],
    ['head -20 file', ['-N']],
    ['tail -5 file', ['-N']],
    ['Get-Content x | Select-Object -First 5', ['-First']],
    ['git log --no-merges --max-count=3', ['--max-count', '--no-merges']],
  ])('reads the flag name of %s with no value', (command, flags) => {
    const steps = shell(command);
    expect(steps.at(-1)?.identity).toMatchObject({ flags });
    for (const value of ['200', '12345', '20']) expect(JSON.stringify(steps.map((step) => step.identity))).not.toContain(value);
  });

  it.each(['for', 'foreach', 'break', 'continue', 'exit', 'get-date', 'out-null', 'convertfrom-json', 'join-path', 'basename', 'dirname', 'seq', 'cmp'])('knows %s as a public program', (program) => {
    expect(shell(`${program} x`)[0]?.identity).toMatchObject({ program });
  });

  it.each(['p', 'acme-deploy', 'acme-billing-service', 'run8.sh', 'tool.ps1'])('keeps %s, a name only this machine knows, off the list', (program) => {
    expect(shell(`${program} x`)[0]?.identity).toEqual({ program: '<literal>', sub: null, flags: [] });
  });

  it('splits a short flag cluster into letters, and masks a short flag holding anything else', () => {
    expect(shell('rm -rf build')[0]?.identity).toMatchObject({ flags: ['-f', '-r'] });
    expect(shell('ls -l')[0]?.identity).toMatchObject({ flags: ['-l'] });
    expect(shell('git log -9x')[0]?.identity).toMatchObject({ flags: ['<literal>'] });
    expect(shell('git log -ABCDEF')[0]?.identity).toMatchObject({ flags: ['<literal>'] });
    expect(shell('git log -abcdefgh')[0]?.identity).toMatchObject({ flags: ['<literal>'] });
  });

  it('reads a short value joined to a flag as the literal, not as flag letters, on a program that does not bundle', () => {
    expect(shell('mysql -pabc')[0]?.identity).toMatchObject({ flags: ['<literal>'] });
    expect(shell('git commit -am x')[0]?.identity).toMatchObject({ flags: ['-a', '-m'] });
  });

  it('holds only public programs in the list of those that bundle short flags', () => {
    expect([...BUNDLING_PROGRAMS].filter((program) => !PUBLIC_PROGRAMS.has(program))).toEqual([]);
  });

  it('stops reading flags at the end-of-options marker', () => {
    expect(shell('git checkout -- --force')[0]?.identity).toMatchObject({ flags: [] });
  });

  it('skips a flag written through a variable', () => {
    expect(shell('git log $ARGS --$NAME')[0]?.identity).toMatchObject({ flags: [] });
  });

  it('reads a pull as a registry, name, and version, through the allowlist', () => {
    expect(shell('npm install typescript@5.4.2')[0]?.identity).toMatchObject({ program: 'npm', sub: 'install', pulls: [{ registry: 'npm', name: 'typescript', version: '5.4.2' }] });
    expect(shell('pip install requests')[0]?.identity).toMatchObject({ pulls: [{ registry: 'pypi', name: 'requests', version: null }] });
    expect(shell('cargo add serde@1.0.0')[0]?.identity).toMatchObject({ pulls: [{ registry: 'crates', name: 'serde', version: '1.0.0' }] });
  });

  it('masks a private pull and its version, and a version that is not one', () => {
    expect(shell('npm install @acme-corp/internal-ledger@1.2.3')[0]?.identity).toMatchObject({ pulls: [{ registry: 'npm', name: '<literal>', version: '<literal>' }] });
    expect(shell('npm install acme-only')[0]?.identity).toMatchObject({ pulls: [{ registry: 'npm', name: '<literal>', version: null }] });
    expect(shell('npm install typescript@beta')[0]?.identity).toMatchObject({ pulls: [{ registry: 'npm', name: 'typescript', version: '<literal>' }] });
  });

  it('masks a version whose suffix is a private build tag, and keeps digits and release words', () => {
    for (const version of ['5.4.2-acmecorp', '5.4.2+acmecorp.1', '5.4.2-beta.acmecorp', '5.4.2-rcacme']) {
      expect(shell(`npm install typescript@${version}`)[0]?.identity).toMatchObject({ pulls: [{ name: 'typescript', version: '<literal>' }] });
    }
    for (const version of ['5.4.2-beta.1', '5.4.2-rc1', '5.4.2+7', '5.x', '^5.4.2', '~5.4']) {
      expect(shell(`npm install typescript@${version}`)[0]?.identity).toMatchObject({ pulls: [{ name: 'typescript', version }] });
    }
  });

  it('holds a shell step with no readable command as a masked program', () => {
    expect(shell('$TOOL --force')[0]?.identity).toEqual({ program: '<literal>', sub: null, flags: [] });
    expect(shell('')[0]?.identity).toEqual({ program: '<literal>', sub: null, flags: [] });
  });

  it('reads an MCP call in full when its server and tool are public, past the cut the tool sequence takes', () => {
    const [step] = stepsOf([{ name: 'mcp__claude-in-chrome__navigate', input: {} }]);
    expect(step).toMatchObject({ action: 'mcp.call', native: 'mcp__claude-in-chrome__navigate', identity: { server: 'claude-in-chrome', tool: 'navigate' } });
  });

  it('masks a private MCP server and its tool, and the name that holds them', () => {
    const call = { name: 'mcp__acme-internal__read_ledger', input: {} };
    expect(stepsOf([call])[0]).toMatchObject({ action: 'mcp.call', native: '<literal>', identity: { server: '<literal>', tool: '<literal>' } });
    expect(pooled(captured([call]))).not.toContain('acme');
    expect(pooled(captured([call]))).not.toContain('ledger');
  });

  it('masks a tool name on a public server that is not shaped like one', () => {
    expect(stepsOf([{ name: 'mcp__github__has space', input: {} }])[0]).toMatchObject({ native: '<literal>', identity: { server: 'github', tool: '<literal>' } });
  });

  it('masks a tool a public server does not publish, since a server name is a label the user picks', () => {
    for (const [name, server] of [['mcp__postgres__acme_ledger', 'postgres'], ['mcp__github__acme__query', 'github']] as const) {
      const call = { name, input: {} };
      const masked = { native: '<literal>', identity: { server, tool: '<literal>' } };
      expect(stepsOf([call])[0]).toMatchObject({ action: 'mcp.call', ...masked });
      expect(pooled(captured([call]))).not.toContain('acme');
      // Codex spells a call the same way, and the capture path reaches it through this function once its adapter lands.
      expect(callIdentity(ACTION_TABLES.codex, 'mcp.call', name, '<literal>', { skill: undefined, url: undefined })).toEqual(masked);
    }
  });

  it('masks a published tool of one server when another server calls it', () => {
    expect(stepsOf([{ name: 'mcp__postgres__navigate', input: {} }])[0]).toMatchObject({ native: '<literal>', identity: { server: 'postgres', tool: '<literal>' } });
  });

  it('reads a published tool of its own server in full', () => {
    expect(stepsOf([{ name: 'mcp__postgres__query', input: {} }])[0]).toMatchObject({ native: 'mcp__postgres__query', identity: { server: 'postgres', tool: 'query' } });
    expect(stepsOf([{ name: 'mcp__sequential-thinking__sequentialthinking', input: {} }])[0]).toMatchObject({ identity: { server: 'sequential-thinking', tool: 'sequentialthinking' } });
    // Codex has no recall row, so its recall call reads as an MCP call through the same list.
    expect(callIdentity(ACTION_TABLES.codex, 'mcp.call', 'mcp__oars__oars_recall', '<literal>', { skill: undefined, url: undefined })).toEqual({ native: 'mcp__oars__oars_recall', identity: { server: 'oars', tool: 'oars_recall' } });
  });

  it('seeds tools only under a server the list itself makes public', () => {
    expect([...PUBLIC_MCP_TOOLS.keys()].filter((server) => !PUBLIC_MCP_SERVERS.has(server))).toEqual([]);
  });

  it('masks every tool of a public server with none seeded', () => {
    expect(stepsOf([{ name: 'mcp__notion__search', input: {} }])[0]).toMatchObject({ native: '<literal>', identity: { server: 'notion', tool: '<literal>' } });
  });

  it('reads a public skill, and masks a private one', () => {
    expect(stepsOf([{ name: 'Skill', input: { skill: 'pdf' } }])[0]?.identity).toEqual({ skill: 'pdf' });
    expect(stepsOf([{ name: 'Skill', input: { skill: 'acme-release' } }])[0]?.identity).toEqual({ skill: '<literal>' });
    expect(stepsOf([{ name: 'Skill', input: {} }])[0]?.identity).toEqual({ skill: '<literal>' });
  });

  it('reads a public host, and masks any other', () => {
    expect(stepsOf([{ name: 'WebFetch', input: { url: 'https://github.com/acme/private?token=abc' } }])[0]?.identity).toEqual({ host: 'github.com' });
    const call = { name: 'WebFetch', input: { url: 'https://alice:s3cretpw@corp.example/acme?token=abc' } };
    expect(stepsOf([call])[0]?.identity).toEqual({ host: '<literal>' });
    expect(pooled(captured([call]))).not.toContain('s3cretpw');
    expect(pooled(captured([call]))).not.toContain('corp.example');
  });

  it('does not take a public name as a part of a host', () => {
    for (const url of ['https://acme.github.io/x', 'https://github.com.acme.example/x', 'https://notgithub.com/x', 'not a url']) {
      expect(stepsOf([{ name: 'WebFetch', input: { url } }])[0]?.identity).toEqual({ host: '<literal>' });
    }
  });

  it('gives a search and a fetch with no address no host', () => {
    expect(stepsOf([{ name: 'WebSearch', input: { query: 'acme secret plan' } }])[0]?.identity).toEqual({ host: null });
    expect(stepsOf([{ name: 'WebFetch', input: {} }])[0]?.identity).toEqual({ host: null });
  });

  it('holds no identity for a call whose action has none', () => {
    expect(stepsOf([{ name: 'Read', input: { file_path: '/home/alicesmith/notes.txt' } }])[0]?.identity).toBeNull();
    expect(stepsOf([{ name: 'AcmeTool', input: {} }])[0]).toMatchObject({ action: 'other', native: '<literal>', identity: null });
  });

  it('reads a harness with its own MCP spelling through the same rules', () => {
    const [tool] = capture([{ name: 'mcp_acme_read', input: {} }], 'cursor');
    expect(tool?.steps?.[0]).toMatchObject({ action: 'mcp.call', native: '<literal>', identity: { server: '<literal>', tool: '<literal>' } });
  });

  it('holds back the tool when a harness spelling cannot say where the server name ends', () => {
    // `mcp_postgres_acme_query` may be tool `acme_query` on `postgres` or tool `query` on a private `postgres_acme`, so what follows the first word is unknown.
    const call = { name: 'mcp_postgres_acme_query', input: {} };
    const [tool] = capture([call], 'cursor');
    expect(tool?.steps?.[0]).toMatchObject({ action: 'mcp.call', native: '<literal>', identity: { server: 'postgres', tool: '<literal>' } });
    expect(pooled(captured([call], 'cursor'))).not.toContain('acme');
  });
});

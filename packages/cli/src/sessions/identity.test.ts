import { describe, expect, it } from 'vitest';
import { captureSession } from './extract.js';
import { makeRedactor } from './redact.js';
import type { StepObservation, ToolObservation } from './schema.js';

const line = (value: object): string => JSON.stringify(value);

/** One prompt holding the given calls. */
const capture = (calls: ReadonlyArray<{ name: string; input: object }>, harness?: 'claude-code' | 'cursor'): ToolObservation[] => {
  const text = [
    line({ type: 'user', timestamp: '2026-05-29T04:30:00Z', message: { role: 'user', content: 'p' } }),
    ...calls.map((call, index) => line({ type: 'assistant', timestamp: '2026-05-29T04:30:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${String(index)}`, name: call.name, input: call.input }] } })),
  ].join('\n');
  return captureSession({ text, session: 's', project: 'p', rev: 1, at: 'x', bytes: 1, redact: makeRedactor([]), ...(harness === undefined ? {} : { harness }) }).tools;
};

const stepsOf = (calls: ReadonlyArray<{ name: string; input: object }>): StepObservation[] => capture(calls).flatMap((tool) => tool.steps ?? []);
const shell = (command: string): StepObservation[] => stepsOf([{ name: 'Bash', input: { command } }]);

/** Everything on a step is class P, by the schema. */
const pooled = (steps: readonly StepObservation[]): string => JSON.stringify(steps);

describe('identity holds public names only', () => {
  it('reads a shell step as its program, subcommand, and flag names', () => {
    expect(shell('git push --force origin main')[0]?.identity).toEqual({ program: 'git', sub: 'push', flags: ['--force'] });
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
    expect(pooled(steps)).not.toContain(value);
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

  it('splits a short flag cluster into letters, and masks a short flag holding anything else', () => {
    expect(shell('rm -rf build')[0]?.identity).toMatchObject({ flags: ['-f', '-r'] });
    expect(shell('ls -l')[0]?.identity).toMatchObject({ flags: ['-l'] });
    expect(shell('git log -9x')[0]?.identity).toMatchObject({ flags: ['<literal>'] });
    expect(shell('git log -ABCDEF')[0]?.identity).toMatchObject({ flags: ['<literal>'] });
    expect(shell('git log -abcdefgh')[0]?.identity).toMatchObject({ flags: ['<literal>'] });
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

  it('holds a shell step with no readable command as a masked program', () => {
    expect(shell('$TOOL --force')[0]?.identity).toEqual({ program: '<literal>', sub: null, flags: [] });
    expect(shell('')[0]?.identity).toEqual({ program: '<literal>', sub: null, flags: [] });
  });

  it('reads an MCP call in full when its server is public, past the cut the tool sequence takes', () => {
    const [step] = stepsOf([{ name: 'mcp__claude-in-chrome__navigate', input: {} }]);
    expect(step).toMatchObject({ action: 'mcp.call', native: 'mcp__claude-in-chrome__navigate', identity: { server: 'claude-in-chrome', tool: 'navigate' } });
  });

  it('masks a private MCP server and its tool, and the name that holds them', () => {
    const steps = stepsOf([{ name: 'mcp__acme-internal__read_ledger', input: {} }]);
    expect(steps[0]).toMatchObject({ action: 'mcp.call', native: '<literal>', identity: { server: '<literal>', tool: '<literal>' } });
    expect(pooled(steps)).not.toContain('acme');
    expect(pooled(steps)).not.toContain('ledger');
  });

  it('masks a tool name on a public server that is not shaped like one', () => {
    expect(stepsOf([{ name: 'mcp__github__has space', input: {} }])[0]).toMatchObject({ native: '<literal>', identity: { server: 'github', tool: '<literal>' } });
  });

  it('reads a public skill, and masks a private one', () => {
    expect(stepsOf([{ name: 'Skill', input: { skill: 'pdf' } }])[0]?.identity).toEqual({ skill: 'pdf' });
    expect(stepsOf([{ name: 'Skill', input: { skill: 'acme-release' } }])[0]?.identity).toEqual({ skill: '<literal>' });
    expect(stepsOf([{ name: 'Skill', input: {} }])[0]?.identity).toEqual({ skill: '<literal>' });
  });

  it('reads a public host, and masks any other', () => {
    expect(stepsOf([{ name: 'WebFetch', input: { url: 'https://github.com/acme/private?token=abc' } }])[0]?.identity).toEqual({ host: 'github.com' });
    const hostile = stepsOf([{ name: 'WebFetch', input: { url: 'https://alice:s3cretpw@corp.example/acme?token=abc' } }]);
    expect(hostile[0]?.identity).toEqual({ host: '<literal>' });
    expect(pooled(hostile)).not.toContain('s3cretpw');
    expect(pooled(hostile)).not.toContain('corp.example');
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
});

// D11's leak test (pool vocabulary spec Section 2): one planted identifier through every field the section lists, in each shell form the parser accepts.
import { describe, expect, it } from 'vitest';
import { captureSession } from './extract.js';
import { CUSTOM, PRIVATE_PROGRAM, projectAgentType, projectKeys, projectShell, projectSkills, projectStoredShell, projectTool } from './projection.js';
import { PRIVATE } from './public-vocabulary.js';
import { makeRedactor } from './redact.js';
import type { ToolObservation } from './schema.js';
import { readVocabulary } from './vocab-load.js';

// A fictional name: no real project, person, or customer. It stands for any identifier that must never pool.
const PLANTED = 'AcmeWidgetMerger';
const vocab = readVocabulary();
const redact = makeRedactor();
const UNREAD = { commands: [PRIVATE_PROGRAM], programs: [PRIVATE] };

// The capture parser lowercases every program (extract.ts), so a projection that copied the name through would emit it in lowercase: compare without case.
const leaks = (projected: unknown): boolean => JSON.stringify(projected).toLowerCase().includes(PLANTED.toLowerCase());

// Every form the capture parser reads, with the planted name in each position it could sit in, and the forms it cannot read.
const SHELL_FORMS = [
  `${PLANTED} --prod`,
  `grep ${PLANTED}`,
  `git ${PLANTED}`,
  `git commit --${PLANTED}`,
  `git commit --message=${PLANTED}`,
  `git commit -m "${PLANTED}"`,
  `grep '${PLANTED}' file.txt`,
  `cat file.txt | ${PLANTED}`,
  `cat file.txt | grep ${PLANTED} | sort | uniq | wc | ${PLANTED}`,
  `cd /work && ${PLANTED} && npm test`,
  `npm test; ${PLANTED}`,
  `FOO=${PLANTED} grep x`,
  `FOO=bar ${PLANTED}`,
  `${PLANTED}=1 BAR=2 ls`,
  `sudo ${PLANTED}`,
  `sudo -u ${PLANTED} grep x`,
  `sudo env FOO=${PLANTED} ${PLANTED} --flag`,
  `env ${PLANTED}=1 ${PLANTED}`,
  `bash -c "${PLANTED} --run"`,
  `sh -c 'grep ${PLANTED}'`,
  `echo $(${PLANTED} --version)`,
  `echo \`${PLANTED}\``,
  `(cd ${PLANTED} && ls)`,
  `ls $(find . -name ${PLANTED})`,
  `"${PLANTED}" arg`,
  `'${PLANTED}'`,
  `grep '${PLANTED}`,
  `grep "${PLANTED}`,
  `./${PLANTED}/run.sh`,
  `C:\\tools\\${PLANTED}.exe --x`,
  `& "${PLANTED}.exe"`,
  `cat <<EOF\n${PLANTED}\nEOF`,
  PLANTED,
  `$(${PLANTED})`,
  `{ ${PLANTED}; }`,
  `if ${PLANTED}; then ls; fi`,
  `for x in ${PLANTED}; do ls $x; done`,
];

// Forms with no program the parser can find, the planted name among them: each projects to exactly one `private` program.
const UNREADABLE_FORMS = ['', '   ', '$(', '"', '|', '&&', `$(${PLANTED}`, `|${PLANTED}`, `"${PLANTED}`, `'${PLANTED}`, `&&${PLANTED}`, `${PLANTED}|`, `;${PLANTED}`, `(${PLANTED}`, `<<${PLANTED}`, `>${PLANTED}`, `\`${PLANTED}`, `${PLANTED}$(`];

const shellSession = (): string =>
  [
    JSON.stringify({ type: 'user', uuid: 'u0', timestamp: '2026-06-01T00:00:01.000Z', version: '2.1.300', cwd: '/w', message: { role: 'user', content: 'run them' } }),
    ...SHELL_FORMS.map((command, i) =>
      JSON.stringify({
        type: 'assistant', uuid: `m${String(i)}`, timestamp: '2026-06-01T00:00:02.000Z', version: '2.1.300', cwd: '/w',
        message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: `t${String(i)}`, name: 'Bash', input: { command } }], usage: { input_tokens: 1, output_tokens: 1 } },
      }),
    ),
  ].join('\n');

// The records the account store holds for the same forms: the only input a deposit can project from (spec Section 2 migration).
const storedTools = (): ToolObservation[] =>
  captureSession({ text: shellSession(), session: 's', project: 'p', rev: 1, at: 'x', bytes: 1, redact, salt: 'salt', sid: null, repoRoot: () => null, runtime: { oars: '1.2.3', node: 'v99', os: 'plan9' } }).tools;

describe('D11: a planted identifier never reaches a pooled field', () => {
  it('compares without case: the check fails on the name copied through in any case', () => {
    for (const copied of [PLANTED, PLANTED.toLowerCase(), PLANTED.toUpperCase()]) {
      expect(leaks({ program: copied, subcommand: null, flags: [] })).toBe(true);
    }
    expect(leaks(PRIVATE_PROGRAM)).toBe(false);
  });

  it.each(SHELL_FORMS)('shell form %j projects without the planted text', (command) => {
    expect(leaks(projectShell(vocab, command, redact))).toBe(false);
  });

  it('projects every stored shell form without the planted text, from what the account store holds', () => {
    const tools = storedTools();
    expect(tools).toHaveLength(SHELL_FORMS.length);
    for (const tool of tools) {
      expect(leaks(projectStoredShell(vocab, tool))).toBe(false);
    }
  });

  it.each(UNREADABLE_FORMS)('projects the unreadable form %j to one private program, never to its text', (unreadable) => {
    expect(projectShell(vocab, unreadable, redact)).toEqual({ commands: [PRIVATE_PROGRAM], programs: [PRIVATE] });
  });

  it('projects a stored record whose target the store cut, masked, or could not read to private', () => {
    for (const target of [null, '', `git ${PLANTED.repeat(3)}`, `${PLANTED} a b`, `git <${PLANTED}>`]) {
      expect(projectStoredShell(vocab, { tool: 'Bash', target })).toEqual(UNREAD);
    }
    expect(projectStoredShell(vocab, { tool: 'Bash', target: PLANTED })).toEqual(UNREAD);
    expect(projectStoredShell(vocab, { tool: 'Bash', target: `${PLANTED.toLowerCase()} --flag` })).toEqual(UNREAD);
  });

  it('keeps an admitted program of a compound command and drops the rest to private', () => {
    expect(projectShell(vocab, `cat f | ${PLANTED} | grep x`, redact).programs).toEqual(['cat', PRIVATE, 'grep']);
    expect(projectShell(vocab, `sudo ${PLANTED}`, redact).programs).toEqual([PRIVATE]);
  });

  it('projects tool names: an MCP server or tool that is not admitted is mcp:private, any other unknown name is private', () => {
    for (const name of [PLANTED, `mcp__${PLANTED}__run`, `mcp__${PLANTED}__${PLANTED}`, `mcp__github__${PLANTED}`, `mcp__${PLANTED}`, `${PLANTED}__mcp__x`]) {
      expect(leaks(projectTool(name))).toBe(false);
    }
    expect(projectTool(PLANTED)).toBe(PRIVATE);
    expect(projectTool(`mcp__${PLANTED}__run`)).toBe('mcp:private');
    expect(projectTool('Bash')).toBe('Bash');
  });

  it('projects skills as admitted names and a count, never the private name', () => {
    const projected = projectSkills([PLANTED, 'pdf', PLANTED, `${PLANTED}:review`]);
    expect(projected).toEqual({ names: ['pdf'], privateCount: 2 });
    expect(leaks(projected)).toBe(false);
  });

  it('projects an agent type as a built-in or custom', () => {
    expect(projectAgentType(PLANTED)).toBe(CUSTOM);
    expect(projectAgentType(`${PLANTED}:reviewer`)).toBe(CUSTOM);
    expect(projectAgentType('Explore')).toBe('Explore');
    expect(projectAgentType(null)).toBeNull();
    for (const agent of [PLANTED, PLANTED.toLowerCase(), `${PLANTED}:reviewer`, `plugin:${PLANTED}`]) {
      expect(leaks(projectAgentType(agent))).toBe(false);
    }
  });

  it('projects keys as the names a built-in tool lists and a count, and every key of an MCP or unknown tool as a count', () => {
    expect(projectKeys('Bash', ['command', PLANTED, 'timeout', PLANTED])).toEqual({ names: ['command', 'timeout'], privateCount: 1 });
    expect(projectKeys(`mcp__${PLANTED}__run`, [PLANTED, 'query'])).toEqual({ names: [], privateCount: 2 });
    expect(projectKeys(PLANTED, [PLANTED])).toEqual({ names: [], privateCount: 1 });
    for (const tool of ['Read', 'Bash', `mcp__${PLANTED}__run`, PLANTED]) {
      expect(leaks(projectKeys(tool, [PLANTED, PLANTED.toLowerCase(), 'file_path']))).toBe(false);
    }
  });
});

// D11's leak test (pool vocabulary spec Section 2): one planted identifier through every field the section lists, in each shell form the parser accepts.
import { describe, expect, it } from 'vitest';
import { CUSTOM, PRIVATE_PROGRAM, projectAgentType, projectKeys, projectShell, projectSkills, projectTool } from './projection.js';
import { PRIVATE } from './public-vocabulary.js';
import { makeRedactor } from './redact.js';
import { readVocabulary } from './vocab-load.js';

// A fictional name: no real project, person, or customer. It stands for any identifier that must never pool.
const PLANTED = 'AcmeWidgetMerger';
const vocab = readVocabulary();
const redact = makeRedactor();

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

describe('D11: a planted identifier never reaches a pooled field', () => {
  it.each(SHELL_FORMS)('shell form %j projects without the planted text', (command) => {
    const projected = projectShell(vocab, command, redact);
    expect(JSON.stringify(projected)).not.toContain(PLANTED);
  });

  it('projects a form the parser cannot read to private, never to its text', () => {
    for (const unreadable of ['', '   ', '$(', '"', '|', '&&']) {
      const { commands, programs } = projectShell(vocab, unreadable, redact);
      expect(JSON.stringify([commands, programs])).not.toContain(PLANTED);
    }
    expect(projectShell(vocab, PLANTED, redact).programs).toEqual([PRIVATE]);
    expect(projectShell(vocab, '', redact).commands).toEqual([PRIVATE_PROGRAM]);
  });

  it('keeps an admitted program of a compound command and drops the rest to private', () => {
    expect(projectShell(vocab, `cat f | ${PLANTED} | grep x`, redact).programs).toEqual(['cat', PRIVATE, 'grep']);
    expect(projectShell(vocab, `sudo ${PLANTED}`, redact).programs.every((program) => program !== PLANTED)).toBe(true);
  });

  it('projects tool names: an MCP server or tool that is not admitted is mcp:private, any other unknown name is private', () => {
    for (const name of [PLANTED, `mcp__${PLANTED}__run`, `mcp__${PLANTED}__${PLANTED}`, `mcp__github__${PLANTED}`, `mcp__${PLANTED}`, `${PLANTED}__mcp__x`]) {
      expect(projectTool(name)).not.toContain(PLANTED);
    }
    expect(projectTool(PLANTED)).toBe(PRIVATE);
    expect(projectTool(`mcp__${PLANTED}__run`)).toBe('mcp:private');
    expect(projectTool('Bash')).toBe('Bash');
  });

  it('projects skills as admitted names and a count, never the private name', () => {
    const projected = projectSkills([PLANTED, 'pdf', PLANTED, `${PLANTED}:review`]);
    expect(projected).toEqual({ names: ['pdf'], privateCount: 2 });
    expect(JSON.stringify(projected)).not.toContain(PLANTED);
  });

  it('projects an agent type as a built-in or custom', () => {
    expect(projectAgentType(PLANTED)).toBe(CUSTOM);
    expect(projectAgentType(`${PLANTED}:reviewer`)).toBe(CUSTOM);
    expect(projectAgentType('Explore')).toBe('Explore');
    expect(projectAgentType(null)).toBeNull();
  });

  it('projects keys as the names a built-in tool lists and a count, and every key of an MCP or unknown tool as a count', () => {
    expect(projectKeys('Bash', ['command', PLANTED, 'timeout', PLANTED])).toEqual({ names: ['command', 'timeout'], privateCount: 1 });
    expect(projectKeys(`mcp__${PLANTED}__run`, [PLANTED, 'query'])).toEqual({ names: [], privateCount: 2 });
    expect(projectKeys(PLANTED, [PLANTED])).toEqual({ names: [], privateCount: 1 });
    expect(JSON.stringify(projectKeys('Read', [PLANTED, 'file_path']))).not.toContain(PLANTED);
  });
});

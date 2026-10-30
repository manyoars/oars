// The Claude Code skill at skills/make-me-money/SKILL.md (found by `npx skills add manyoars/oars --skill make-me-money -g -y`,
// https://github.com/vercel-labs/skills/blob/main/docs/creating-skills.md, checked 2026-10-30) names CLI commands, flags, messages, and
// exit codes. This reads the skill as the installer does and fails when it names one the CLI does not have.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ExitCode } from './errors.js';

const source = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const skill = source('../../../skills/make-me-money/SKILL.md');
const cli = source('./cli.ts');
const wired = `${cli}\n${source('./issuer.ts')}`;

/** The installer reads `name` and `description` from the YAML block at the top of the file. */
const frontmatter = (text: string): Map<string, string> => {
  const block = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (block?.[1] === undefined) throw new Error('SKILL.md has no frontmatter block');
  const fields = new Map<string, string>();
  for (const line of block[1].split(/\r?\n/)) {
    const field = /^([a-z]+):\s*(.+)$/.exec(line);
    if (field?.[1] !== undefined && field[2] !== undefined) fields.set(field[1], field[2]);
  }
  return fields;
};

/** Each `npx @manyoars/oars <command>` the text runs, as the command word. */
const namedCommands = (text: string): string[] =>
  [...text.matchAll(/npx @manyoars\/oars ([a-z][a-z-]*)/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));

const registeredCommands = (cliSource: string): Set<string> =>
  new Set([...cliSource.matchAll(/\.command\('([a-z][a-z-]*)'\)/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]])));

/** Every flag inside an inline code span; prose between spans is not read. */
const namedFlags = (text: string): string[] => {
  const spans = [...text.matchAll(/`([^`\n]+)`/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
  return [...new Set(spans.flatMap((span) => span.match(/--[a-z][a-z-]*/g) ?? []))];
};

/** A flag counts as declared only as a whole quoted token, so `--pri` does not pass for `'--price'`. */
const declares = (cliSource: string, flag: string): boolean => new RegExp(`'${flag}[ ']`).test(cliSource);

describe('skills/make-me-money/SKILL.md', () => {
  it('has the frontmatter the installer needs: a lowercase-hyphen name equal to its folder, and a description that triggers on the money phrases', () => {
    const fields = frontmatter(skill);
    expect(fields.get('name')).toBe('make-me-money');
    const description = fields.get('description') ?? '';
    for (const phrase of ['make me money', 'ship a paid agent', 'get paid for an agent']) expect(description).toContain(phrase);
  });

  it('reads no frontmatter from a file without it', () => {
    expect(() => frontmatter('# no frontmatter')).toThrow('no frontmatter');
  });

  it('runs only commands that cli.ts registers', () => {
    const named = namedCommands(skill);
    const registered = registeredCommands(cli);
    for (const command of named) expect(registered, `cli.ts has no command "${command}"`).toContain(command);
    expect(new Set(named)).toEqual(new Set(['login', 'templates', 'deploy', 'status', 'test-charge']));
  });

  it('catches a command name the CLI does not have', () => {
    const wrong = namedCommands('Run `npx @manyoars/oars deploi --template paid-api`.');
    expect(wrong).toEqual(['deploi']);
    expect(registeredCommands(cli)).not.toContain('deploi');
  });

  it('names only flags the CLI declares', () => {
    const flags = namedFlags(skill);
    expect(flags).toEqual(expect.arrayContaining(['--no-browser', '--template', '--no-start', '--secret-from-env', '--price', '--json', '--idempotency-key']));
    for (const flag of flags) {
      if (flag === '--issuer-url') expect(wired, flag).toContain(flag);
      else expect(declares(cli, flag), `cli.ts declares no ${flag}`).toBe(true);
    }
  });

  it('catches a flag that is only a prefix of a declared one, and reads a second flag in one span', () => {
    expect(declares(cli, '--price')).toBe(true);
    expect(declares(cli, '--pri')).toBe(false);
    expect(declares(cli, '--secret-from')).toBe(false);
    expect(namedFlags('Run `deploy --template x --no-start` and --prose between `login --no-browser`.')).toEqual(['--template', '--no-start', '--no-browser']);
  });

  it('quotes the CLI messages it tells the agent to watch for, and the exit codes it handles', () => {
    expect(wired).toContain('Many Oars has not launched yet: pass --issuer-url or set OARS_ISSUER_URL.');
    expect(skill).toContain('Many Oars has not launched yet: pass --issuer-url or set OARS_ISSUER_URL.');
    for (const line of ['Needs you:', 'Rerun to resume:', 'SDK key (shown once; save it now):']) {
      expect(skill).toContain(line);
      expect(`${cli}\n${source('./commands/deploy.ts')}`).toContain(line);
    }
    const rows = [...skill.matchAll(/^\| (\d) \|/gm)].flatMap((match) => (match[1] === undefined ? [] : [Number(match[1])]));
    expect(new Set(rows)).toEqual(new Set(Object.values(ExitCode)));
  });

  it('stays short enough to read in one pass', () => {
    expect(skill.split('\n').length).toBeLessThan(150);
  });
});

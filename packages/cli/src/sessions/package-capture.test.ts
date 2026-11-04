import { describe, expect, it } from 'vitest';
import { captureSession } from './extract.js';
import { resolveName, resolvePull } from './package-resolve.js';
import { PRIVATE } from './public-vocabulary.js';
import { projectStoredPackage } from './projection.js';
import { makeRedactor } from './redact.js';
import type { ToolObservation, ToolPackage } from './schema.js';
import { readVocabulary } from './vocab-load.js';

const vocab = readVocabulary();
const line = (value: object): string => JSON.stringify(value);

/** One prompt holding the given shell commands, each a call of its own, in order. `failing` lists the commands whose result is an error. */
const session = (commands: readonly string[], failing: readonly string[] = []): ToolObservation[] => {
  const text = [
    line({ type: 'user', timestamp: '2026-05-29T04:30:00Z', message: { role: 'user', content: 'p' } }),
    ...commands.flatMap((command, index) => [
      line({ type: 'assistant', timestamp: '2026-05-29T04:30:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${String(index)}`, name: 'Bash', input: { command } }] } }),
      line({ type: 'user', timestamp: '2026-05-29T04:30:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${String(index)}`, is_error: failing.includes(command), content: failing.includes(command) ? 'Exit code 1\nfailed' : 'ok' }] } }),
    ]),
  ].join('\n');
  return captureSession({ text, session: 's', project: 'p', rev: 1, at: 'x', bytes: 1, redact: makeRedactor([]) }).tools;
};

const packagesOf = (command: string): ToolPackage[] => session([command])[0]?.packages ?? [];

describe('packages from install commands', () => {
  it.each([
    ['npm install', 'npm install left-pad@1.3.0', [{ package: 'npm:left-pad', packageVersion: '1.3.0', first: true }]],
    ['npm install of a scoped name', 'npm i -D @types/node@24.0.0', [{ package: 'npm:@types/node', packageVersion: '24.0.0', first: true }]],
    ['pnpm add of a name in capitals, which npm lowercases', 'pnpm add React', [{ package: 'npm:react', packageVersion: null, first: true }]],
    ['npx', 'npx -y cowsay@1.6.0 hi', [{ package: 'npm:cowsay', packageVersion: '1.6.0', first: true }]],
    ['pip install with a pin', 'pip install requests==2.31.0', [{ package: 'pypi:requests', packageVersion: '2.31.0', first: true }]],
    ['pip install with a range, which is no version', 'pip install "requests>=2.0"', [{ package: 'pypi:requests', packageVersion: null, first: true }]],
    ['pip install folding the name', 'python -m pip install Typing_Extensions', [{ package: 'pypi:typing-extensions', packageVersion: null, first: true }]],
    ['uv add', 'uv add httpx', [{ package: 'pypi:httpx', packageVersion: null, first: true }]],
    ['cargo add with a version', 'cargo add serde@1.0.200', [{ package: 'crates:serde', packageVersion: '1.0.200', first: true }]],
    ['cargo add with a caret range', 'cargo add serde@^1', [{ package: 'crates:serde', packageVersion: null, first: true }]],
    ['cargo add with a bare major, which is a range', 'cargo add serde@1', [{ package: 'crates:serde', packageVersion: null, first: true }]],
    ['pip install with a two-part pin, which is no exact version', 'pip install requests==2.31', [{ package: 'pypi:requests', packageVersion: null, first: true }]],
    ['cargo install folding the name', 'cargo install cargo_edit', [{ package: 'crates:cargo-edit', packageVersion: null, first: true }]],
    ['go get a module', 'go get github.com/spf13/cobra@v1.8.0', [{ package: 'go:github.com/spf13/cobra', packageVersion: 'v1.8.0', first: true }]],
    ['gem install with a version flag', 'gem install rails -v 7.1.0', [{ package: 'rubygems:rails', packageVersion: '7.1.0', first: true }]],
    ['yarn add', 'yarn add left-pad@1.3.0', [{ package: 'npm:left-pad', packageVersion: '1.3.0', first: true }]],
    ['bun add', 'bun add zod', [{ package: 'npm:zod', packageVersion: null, first: true }]],
    ['bunx', 'bunx cowsay@1.6.0', [{ package: 'npm:cowsay', packageVersion: '1.6.0', first: true }]],
    ['pnpm dlx', 'pnpm dlx cowsay@1.6.0', [{ package: 'npm:cowsay', packageVersion: '1.6.0', first: true }]],
    ['uvx', 'uvx ruff', [{ package: 'pypi:ruff', packageVersion: null, first: true }]],
    ['pipx install', 'pipx install httpie', [{ package: 'pypi:httpie', packageVersion: null, first: true }]],
    ['go install a module', 'go install github.com/spf13/cobra@v1.8.0', [{ package: 'go:github.com/spf13/cobra', packageVersion: 'v1.8.0', first: true }]],
    ['brew install', 'brew install Jq', [{ package: 'homebrew:jq', packageVersion: null, first: true }]],
  ])('%s', (_name, command, expected) => {
    expect(packagesOf(command)).toEqual(expected);
  });

  it.each([
    ['a local folder', 'npm install ./local-dir'],
    ['a parent folder', 'npm install ../shared'],
    ['an absolute path', 'pip install /srv/acme/wheels/acme_internal-1.0-py3-none-any.whl'],
    ['a git URL', 'npm install git+https://github.com/acme/widget.git'],
    ['a GitHub shorthand', 'npm install acme/widget'],
    ['an https URL', 'pip install https://example.com/x.tar.gz'],
    ['a workspace link', 'pnpm add workspace:*'],
    ['a masked word', 'npm install <secret>'],
    ['a variable', 'npm install $PACKAGE'],
    ['an editable install', 'pip install -e .'],
    ['a cargo path', 'cargo add --path ../acme-core'],
    ['a cargo git source', 'cargo install --git https://github.com/acme/tool'],
    ['a Go standard library path', 'go get fmt'],
  ])('stores nothing for %s', (_name, command) => {
    expect(packagesOf(command)).toEqual([]);
  });

  it('marks the first call of each version in a session, and the later calls of it not', () => {
    const calls = session(['npm install left-pad@1.3.0', 'npm install left-pad@1.3.0', 'npm install left-pad@1.2.0', 'npm install left-pad', 'cd x && npm install left-pad@1.3.0 left-pad@1.3.0']);
    expect(calls.map((call) => call.packages?.map(({ first }) => first))).toEqual([[true], [false], [true], [true], [false]]);
  });

  it('marks a version that failed on its first try, since the mark is made from the command', () => {
    const calls = session(['pip install acme-nope==9.9.9', 'pip install acme-nope==9.9.9'], ['pip install acme-nope==9.9.9']);
    expect(calls.map((call) => call.packages?.map(({ first }) => first))).toEqual([[true], [false]]);
    expect(calls[0]?.status).toBe('error');
  });

  it('marks each package of one command, and counts a repeat inside one command once', () => {
    expect(packagesOf('pip install requests httpx requests')).toEqual([
      { package: 'pypi:requests', packageVersion: null, first: true },
      { package: 'pypi:httpx', packageVersion: null, first: true },
    ]);
  });

  it('stores no packages on a call that installs nothing', () => {
    expect(session(['npm run build', 'ls'])).toSatisfy((calls: ToolObservation[]) => calls.every((call) => !('packages' in call)));
  });

  it('keeps a skill, a plugin, and an MCP pull out of packages', () => {
    expect(packagesOf('npx skills add owner/repo')).toEqual([]);
  });
});

describe('resolving a name', () => {
  it('checks shape only, in each registry`s spelling', () => {
    expect(resolveName('npm', 'Left-Pad')).toBe('npm:left-pad');
    expect(resolveName('npm', 'acme/widget')).toBeNull();
    expect(resolveName('npm', 'left-pad')).toBe('npm:left-pad');
    expect(resolveName('pypi', 'Zope.Interface')).toBe('pypi:zope-interface');
    expect(resolveName('pypi', '-e')).toBeNull();
    expect(resolveName('unknown', 'x')).toBeNull();
  });

  it('gives no package for an ecosystem outside the registries', () => {
    expect(resolvePull({ ecosystem: 'plugin', name: 'acme', version: null })).toBeNull();
    expect(resolvePull({ ecosystem: 'mcp', name: 'acme', version: null })).toBeNull();
  });
});

describe('projectStoredPackage', () => {
  const seeded = (ecosystem: string, name: string): { name: string; version: string } => {
    const versions = vocab.packages.get(ecosystem)?.seed.get(name);
    const version = [...(versions ?? [])][0];
    if (version === undefined) throw new Error(`${ecosystem}:${name} is not seeded`);
    return { name, version };
  };

  it('keeps a seeded name and a version the snapshot lists', () => {
    const { name, version } = seeded('npm', 'semver');
    expect(projectStoredPackage(vocab, { package: `npm:${name}`, packageVersion: version })).toEqual({ package: `npm:${name}`, packageVersion: version });
  });

  it('pools an invented name as private, with no version', () => {
    expect(projectStoredPackage(vocab, { package: 'npm:acme-deploy', packageVersion: '1.0.0' })).toEqual({ package: PRIVATE, packageVersion: null });
  });

  it('pools a real name outside seed_top as private: it resolves, but nothing admits it', () => {
    const outside = [...(vocab.packages.get('npm')?.resolved ?? [])].find((name) => vocab.packages.get('npm')?.seed.has(name) === false);
    expect(outside).toBeDefined();
    expect(projectStoredPackage(vocab, { package: `npm:${outside ?? ''}`, packageVersion: '1.0.0' })).toEqual({ package: PRIVATE, packageVersion: null });
  });

  it('keeps a scoped npm name, as captured', () => {
    const { name, version } = seeded('npm', '@types/node');
    const [stored] = packagesOf(`npm install ${name}@${version}`);
    expect(stored).toEqual({ package: `npm:${name}`, packageVersion: version, first: true });
    expect(projectStoredPackage(vocab, stored ?? { package: '', packageVersion: null })).toEqual({ package: `npm:${name}`, packageVersion: version });
  });

  it('counts one name in two ecosystems as two packages', () => {
    const both = [...(vocab.packages.get('npm')?.seed.keys() ?? [])].find((name) => vocab.packages.get('crates')?.seed.has(name) === true);
    expect(both).toBeDefined();
    const name = both ?? '';
    const [npm] = packagesOf(`npm install ${name}`);
    const [crate] = packagesOf(`cargo add ${name}`);
    const projected = [npm, crate].map((stored) => projectStoredPackage(vocab, stored ?? { package: '', packageVersion: null }).package);
    expect(projected).toEqual([`npm:${name}`, `crates:${name}`]);
    expect(new Set(projected).size).toBe(2);
  });

  it('pools a version the snapshot lacks as private beside the admitted name', () => {
    const { name } = seeded('npm', 'semver');
    expect(projectStoredPackage(vocab, { package: `npm:${name}`, packageVersion: '0.0.0-acme' })).toEqual({ package: `npm:${name}`, packageVersion: PRIVATE });
  });

  it('pools a Go module as private: the ecosystem seeds nothing', () => {
    expect(projectStoredPackage(vocab, { package: 'go:github.com/spf13/cobra', packageVersion: 'v1.8.0' })).toEqual({ package: PRIVATE, packageVersion: null });
  });
});

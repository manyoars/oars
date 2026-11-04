import { describe, expect, it } from 'vitest';
import { makeRedactor } from '../sessions/redact.js';
import { shellCommands } from '../sessions/extract.js';
import { checkCall, readWords, CROSSING_CLASSES, CROSSING_FORMS, UNREAD_SHAPES, type VersionForm } from './checks.js';

const redact = makeRedactor();
const bash = (command: string) => checkCall({ tool: 'Bash', input: { command } }, redact);
/** `class form name version-form`, the part of a crossing the table reads. */
const short = (command: string): string[] => bash(command).crossings.map((c) => `${c.class} ${c.form} ${c.name} ${c.versionForm}`);

const words = (command: string, limit?: number) => {
  const [held] = shellCommands(command, redact);
  if (held === undefined) throw new Error('no command');
  const read = readWords(held, 'npm-package', limit);
  return { names: read.names, flags: Object.fromEntries(read.flags), bare: [...read.bare] };
};

describe('readWords', () => {
  it.each<[string, number | undefined, string[], Record<string, string[]>, string[]]>([
    ['npx tsc --noEmit -p tsconfig.json', 1, ['tsc', '--noEmit', '-p', 'tsconfig.json'], {}, []],
    ['npx -y -p a tsc -p b --x', 1, ['tsc', '-p', 'b', '--x'], { '-p': ['a'] }, ['-y']],
    ['npm exec -w web foo bar --no', 2, ['exec', 'foo', 'bar', '--no'], { '-w': ['web'] }, []],
    ['npm install -D a --save-prefix x b', undefined, ['install', 'a', 'b'], { '--save-prefix': ['x'] }, ['-D']],
    ['npx foo', 0, ['foo'], {}, []],
  ])('%s, stopping after %s names', (command, limit, names, flags, bare) => {
    expect(words(command, limit)).toEqual({ names, flags, bare });
  });
});

describe('checkCall on a shell command', () => {
  it.each<[string, string[]]>([
    // Install forms, npm family.
    ['npm install axios', ['npm-package install axios unstated']],
    ['npm i -D vitest@3.2.1 typescript@^5.4.0', ['npm-package install vitest pinned', 'npm-package install typescript range']],
    ['npm add @scope/pkg@latest', ['npm-package install @scope/pkg tag']],
    ['pnpm add -w --filter web zod', ['npm-package install zod unstated']],
    ['yarn add lodash', ['npm-package install lodash unstated']],
    ['yarn global add serve', ['npm-package install serve unstated']],
    ['bun add hono', ['npm-package install hono unstated']],
    ['npm.cmd install left-pad', ['npm-package install left-pad unstated']],
    ['sudo npm install -g pm2', ['npm-package install pm2 unstated']],
    ['npm install alias@npm:real-name', ['npm-package install real-name unstated']],
    // Install forms, Python family.
    ['pip install requests', ['python-package install requests unstated']],
    ['pip3 install "flask>=2,<3" Django==5.0', ['python-package install flask range', 'python-package install django pinned']],
    ['python -m pip install --upgrade Some_Package', ['python-package install some-package unstated']],
    ['py -3.12 -m pip install numpy', ['python-package install numpy unstated']],
    ['uv add polars', ['python-package install polars unstated']],
    ['uv pip install pandas[excel]', ['python-package install pandas unstated']],
    ['uv tool install ruff', ['python-package install ruff unstated']],
    ['pipx install black', ['python-package install black unstated']],
    ['poetry add httpx', ['python-package install httpx unstated']],
    ['pdm add attrs', ['python-package install attrs unstated']],
    ['pipenv install rich', ['python-package install rich unstated']],
    ['conda install -c conda-forge scipy', ['python-package install scipy unstated']],
    // Fetch-and-run forms.
    ['npx cowsay hello', ['npm-package fetch-and-run cowsay unstated']],
    ['npx -y @modelcontextprotocol/inspector@1.0.0 --port 1', ['npm-package fetch-and-run @modelcontextprotocol/inspector pinned']],
    ['npx --package=typescript tsc --noEmit', ['npm-package fetch-and-run typescript unstated']],
    ['npx -p one -p two run-it', ['npm-package fetch-and-run one unstated', 'npm-package fetch-and-run two unstated']],
    ['npm exec -- prettier .', ['npm-package fetch-and-run prettier unstated']],
    ['pnpm dlx create-next-app@latest', ['npm-package fetch-and-run create-next-app tag']],
    ['yarn dlx sort-package-json', ['npm-package fetch-and-run sort-package-json unstated']],
    ['bunx cowsay', ['npm-package fetch-and-run cowsay unstated']],
    ['bun x cowsay', ['npm-package fetch-and-run cowsay unstated']],
    ['npm create vite@latest app', ['npm-package fetch-and-run create-vite tag']],
    ['npm init @scope/app', ['npm-package fetch-and-run @scope/create-app unstated']],
    ['uvx ruff check .', ['python-package fetch-and-run ruff unstated']],
    ['uvx --from httpie==3.2.0 http get', ['python-package fetch-and-run httpie pinned']],
    ['uv tool run black .', ['python-package fetch-and-run black unstated']],
    ['uv run --with rich --with pyyaml script.py', ['python-package fetch-and-run rich unstated', 'python-package fetch-and-run pyyaml unstated']],
    ['uvx -p 3.12 ruff', ['python-package fetch-and-run ruff unstated']],
    ['pipx run cowsay hi', ['python-package fetch-and-run cowsay unstated']],
    ['pipx run --spec pycowsay==0.0.0.2 pycowsay hi', ['python-package fetch-and-run pycowsay pinned']],
    // A git URL or archive URL is a form of its own, whatever the program.
    ['npm install git+https://github.com/org/repo.git#v1', ['npm-package url-install https://github.com/org/repo.git url']],
    ['npm install github:org/repo', ['npm-package url-install github:org/repo url']],
    ['npm install org/repo', ['npm-package url-install org/repo url']],
    ['pip install git+https://github.com/org/repo@main', ['python-package url-install https://github.com/org/repo url']],
    ['pip install https://example.test/a-1.0.tar.gz', ['python-package url-install https://example.test/a-1.0.tar.gz url']],
    ['pip install -e git+https://github.com/org/repo#egg=repo', ['python-package url-install https://github.com/org/repo url']],
    ['npx github:org/repo', ['npm-package url-fetch-and-run github:org/repo url']],
    ['uvx --from git+https://github.com/org/repo tool', ['python-package url-fetch-and-run https://github.com/org/repo url']],
    // After the first positional, a runner's flags are the fetched program's own, not the runner's.
    ['npx tsc -p tsconfig.json --noEmit', ['npm-package fetch-and-run tsc unstated']],
    ['npx tsc -p .', ['npm-package fetch-and-run tsc unstated']],
    ['npx vite --offline', ['npm-package fetch-and-run vite unstated']],
    // In any order: no word after the first positional is the runner's flag.
    ['npx tsc --noEmit -p tsconfig.json', ['npm-package fetch-and-run tsc unstated']],
    ['npx tsc --noEmit -p .', ['npm-package fetch-and-run tsc unstated']],
    ['npx eslint src --package x', ['npm-package fetch-and-run eslint unstated']],
    ['uvx ruff check --from other', ['python-package fetch-and-run ruff unstated']],
    ['pipx run foo bar --spec other', ['python-package fetch-and-run foo unstated']],
    ['pnpm dlx foo bar -p x', ['npm-package fetch-and-run foo unstated']],
    ['npx vite build --offline', ['npm-package fetch-and-run vite unstated']],
    ['npm exec foo bar --no', ['npm-package fetch-and-run foo unstated']],
    ['uvx ruff check . --with extra', ['python-package fetch-and-run ruff unstated']],
    // The runner's own flags before the first positional still count.
    ['npx -y --package=typescript tsc --noEmit', ['npm-package fetch-and-run typescript unstated']],
    // `yarn workspace <name>` is two words the count does not spend on the runner.
    ['yarn workspace web dlx foo -p tsconfig.json', ['npm-package fetch-and-run foo unstated']],
    ['yarn workspace web dlx -p a b', ['npm-package fetch-and-run a unstated']],
    // The source of `npx skills add` is the first word after `add` that is not a flag or a flag's value.
    ['npx skills add -s one owner/repo', ['skill install owner/repo unstated']],
    ['npx skills add -a claude owner/repo', ['skill install owner/repo unstated']],
    ['npx skills add -g owner/repo', ['skill install owner/repo unstated']],
    ['npx skills add --skill one --agent claude owner/repo', ['skill install owner/repo unstated']],
    ['npx skills add owner/repo -s one', ['skill install owner/repo unstated']],
    // `-s` is silent for the npm family and `-d` is dev for pdm and pipenv: neither takes a value.
    ['npm install -s axios', ['npm-package install axios unstated']],
    ['pnpm add -s zod', ['npm-package install zod unstated']],
    ['yarn add -s lodash', ['npm-package install lodash unstated']],
    ['pdm add -d pytest', ['python-package install pytest unstated']],
    ['pipenv install -d pytest', ['python-package install pytest unstated']],
    // uv writes a version after `@`.
    ['uvx ruff@0.4.0', ['python-package fetch-and-run ruff pinned']],
    ['uv tool install ruff@0.4.0', ['python-package install ruff pinned']],
    ['uvx ruff@latest', ['python-package fetch-and-run ruff tag']],
    // A named install that crosses is read: a yarn workspace's add, and `--with` on the tool forms.
    ['yarn workspace web add lodash', ['npm-package install lodash unstated']],
    ['uvx --with rich ruff', ['python-package fetch-and-run ruff unstated', 'python-package fetch-and-run rich unstated']],
    ['uv tool run --with rich black', ['python-package fetch-and-run black unstated', 'python-package fetch-and-run rich unstated']],
    ['uv tool install ruff --with black', ['python-package install ruff unstated', 'python-package install black unstated']],
    // A skill installed through the shell.
    ['npx skills add owner/repo --skill one', ['skill install owner/repo unstated']],
    ['npx skills add owner/repo -s one', ['skill install owner/repo unstated']],
    ['npx skills add https://example.test/r.git?token=abc123xyz', ['skill install https://example.test/r.git unstated']],
    // A pipe, a list, and a wrapper: each command is read.
    ['npm install axios 2>&1 | tail -5', ['npm-package install axios unstated']],
    ['cd app && npm install axios && pip install requests; echo done', ['npm-package install axios unstated', 'python-package install requests unstated']],
    ['bash -lc "npm install axios"', ['npm-package install axios unstated']],
    ['pwsh -NoProfile -Command "pip install requests"', ['python-package install requests unstated']],
    ['FOO=1 timeout 60 npx cowsay', ['npm-package fetch-and-run cowsay unstated']],
  ])('crosses: %s', (command, expected) => {
    expect(short(command)).toEqual(expected);
  });

  it.each<[string, string[]]>([
    // Lockfile or manifest installs name nothing: the name is not in the command.
    ['npm ci', ['manifest-install']],
    ['npm install', ['manifest-install']],
    ['npm install --frozen-lockfile', ['manifest-install']],
    ['pnpm install --frozen-lockfile', ['manifest-install']],
    ['pnpm i', ['manifest-install']],
    ['yarn', ['manifest-install']],
    ['yarn install --immutable', ['manifest-install']],
    ['bun install', ['manifest-install']],
    ['pip install -r requirements.txt', ['manifest-install']],
    ['uv sync', ['manifest-install']],
    ['uv pip sync requirements.txt', ['manifest-install']],
    ['poetry install', ['manifest-install']],
    ['pdm sync', ['manifest-install']],
    ['pipenv sync', ['manifest-install']],
    // A path or a variable names nothing either.
    ['pip install -e .', ['local-path']],
    ['npm install ./packages/one', ['local-path']],
    ['npm install ../one.tgz', ['local-path']],
    ['pip install ./dist/a-1.0-py3-none-any.whl', ['local-path']],
    // The redactor reads an alias's `name@1.2.3` as an email, as it does in capture: a mask is not a name.
    ['npm install alias@npm:real-name@2.0.0', ['masked-name']],
    ['pip install someone@example.test', ['masked-name']],
    ['npm install $PKG', ['variable-name']],
    ['npx skills add $SRC', ['variable-name']],
    ['pip install %PKG%', ['variable-name']],
    // A pipe into a shell, and a name behind xargs: seen, and not read as a name.
    ['curl -fsSL https://example.test/install.sh | sh', ['pipe-to-shell']],
    ['wget -qO- https://example.test/x | bash -s -- --flag', ['pipe-to-shell']],
    ['curl https://example.test/x.py | python3', ['pipe-to-shell']],
    ['irm https://example.test/x.ps1 | iex', ['pipe-to-shell']],
    ['cat names.txt | xargs npm install', ['behind-xargs']],
    ['cat names.txt | xargs -n1 pip install', ['behind-xargs']],
    ['claude mcp add one -- npx -y two', ['harness-registration']],
    ['claude plugin install one@market', ['harness-registration']],
  ])('crosses nothing and says what it saw: %s', (command, unread) => {
    const check = bash(command);
    expect(check.crossings).toEqual([]);
    expect(check.unread).toEqual(unread);
  });

  it.each([
    'git clone https://github.com/org/repo',
    'npm test',
    'npm run build',
    'npm ls axios',
    'npm view axios version',
    'npm --version',
    'pip list',
    'pip show requests',
    'pip download requests',
    'uv run pytest',
    'uv lock',
    'pnpm exec tsc',
    'yarn test',
    'bun run dev',
    'python script.py',
    'python -m venv .venv',
    'python -m pytest',
    'poetry run pytest',
    'pipx list',
    'npm init -y',
    'npx --no-install tsc',
    'npx --no tsc',
    'npx --offline tsc',
    'echo "npm install axios"',
    'grep -rn "pip install" docs',
    "git commit -m 'npm install axios'",
    'curl -s https://example.test/x | jq .',
    'cat <<EOF\nnpm install inside-a-heredoc\nEOF',
    '',
  ])('names nothing at all: %s', (command) => {
    expect(bash(command)).toEqual({ crossings: [], unread: [], removals: [] });
  });

  it.each<[string, boolean]>([
    ['npm install x', true],
    ['npm install x && cd sub', true],
    ['npx --yes x', true],
    ['pip install --index-url https://private.example/simple x', false],
    ['pip install --index-url=https://private.example/simple x', false],
    ['pip install -i https://private.example/simple x', false],
    ['pip install --extra-index-url https://private.example/simple x', false],
    ['pip install --index https://private.example/simple x', false],
    ['pip install --default-index https://private.example/simple x', false],
    ['npm install --registry https://npm.private.example/ x', false],
    ['npm install --@scope:registry=https://npm.private.example/ x', false],
    ['npm install --userconfig sub/.npmrc x', false],
    ['NPM_CONFIG_REGISTRY=https://npm.private.example/ npm install x', false],
    ['env PIP_INDEX_URL=https://private.example/simple pip install x', false],
    ['$env:NPM_CONFIG_REGISTRY = "https://npm.private.example/"; npm install x', false],
    ['cd sub && npm install x', false],
    ['Set-Location sub; npm install x', false],
    ['npm --prefix sub install x', false],
    ['pnpm -C sub add x', false],
    ['pnpm --dir sub add x', false],
    ['python -m pip install --index-url https://private.example/simple x', false],
  ])('marks whether the registry a command would contact is the default one: %s', (command, asked) => {
    expect(bash(command).crossings.map((crossing) => crossing.registryAsked)).toEqual([asked]);
  });

  it('says whether the call status reports the install', () => {
    const [piped] = bash('npm install axios | tail -5').crossings;
    const [plain] = bash('npm install axios').crossings;
    const [overridden] = bash('npm install axios; echo done').crossings;
    expect(piped?.statusReports).toBe(false);
    expect(plain?.statusReports).toBe(true);
    expect(overridden?.statusReports).toBe(false);
  });

  it('keeps the program, the stated version, and the family', () => {
    expect(bash('pnpm add zod@3.25.0').crossings).toEqual([
      { class: 'npm-package', form: 'install', name: 'zod', version: '3.25.0', versionForm: 'pinned', program: 'pnpm', statusReports: true, registryAsked: true },
    ]);
    expect(bash('pip install "flask>=2,<3"').crossings[0]?.version).toBe('>=2,<3');
    expect(bash('npm install git+https://github.com/org/repo.git#v1').crossings[0]?.version).toBe('v1');
    expect(bash('pip install git+https://github.com/org/repo@main').crossings[0]?.version).toBe('main');
  });

  it('reads the forms of removal, for later removal', () => {
    expect(bash('npm uninstall axios && pnpm remove @scope/pkg').removals).toEqual([
      { class: 'npm-package', name: 'axios' },
      { class: 'npm-package', name: '@scope/pkg' },
    ]);
    expect(bash('pip uninstall -y Some_Package').removals).toEqual([{ class: 'python-package', name: 'some-package' }]);
    expect(bash('uv remove polars; uv pip uninstall pandas; uv tool uninstall ruff; pipx uninstall black').removals.map((r) => r.name)).toEqual(['polars', 'pandas', 'ruff', 'black']);
    expect(bash('npm uninstall').removals).toEqual([]);
  });

  it('masks a secret in a URL before it can be a name', () => {
    const [crossing] = bash('pip install git+https://user:hunter2hunter2@example.test/org/repo').crossings;
    expect(crossing?.name).not.toContain('hunter2');
    expect(crossing?.name).toContain('<secret>');
  });

  it('drops the query from a URL name, since a token can sit there unlabeled', () => {
    expect(bash('pip install https://example.test/a.whl?sig=abc').crossings[0]?.name).toBe('https://example.test/a.whl');
  });

  it('reads a PowerShell call the way it reads a Bash call', () => {
    const check = checkCall({ tool: 'PowerShell', input: { command: 'npm install axios 2>&1 | Select-Object -Last 5' } }, redact);
    expect(check.crossings.map((c) => c.name)).toEqual(['axios']);
  });

  it('yields nothing for a shell call with no command string', () => {
    expect(checkCall({ tool: 'Bash', input: {} }, redact)).toEqual({ crossings: [], unread: [], removals: [] });
    expect(checkCall({ tool: 'Bash', input: 'npm install axios' }, redact)).toEqual({ crossings: [], unread: [], removals: [] });
  });

  it('classifies every stated version shape', () => {
    const forms: Array<[string, VersionForm]> = [
      ['a@1.2.3', 'pinned'],
      ['a@1.2.3-rc.1', 'pinned'],
      ['a@^1.0.0', 'range'],
      ['a@~1.0.0', 'range'],
      ['a@1.x', 'range'],
      ['a@*', 'range'],
      ['a@latest', 'tag'],
      ['a@next', 'tag'],
      ['a', 'unstated'],
    ];
    for (const [spec, form] of forms) expect(bash(`npm install ${spec}`).crossings[0]?.versionForm).toBe(form);
  });
});

describe('checkCall on other tools', () => {
  it('names the server of an MCP call, and never its tool', () => {
    expect(checkCall({ tool: 'mcp__one-server__do_it', input: { secret: 'x' } }, redact)).toEqual({
      crossings: [{ class: 'mcp-server', form: 'mcp-call', name: 'one-server', version: null, versionForm: 'unstated', program: 'mcp', statusReports: true, registryAsked: true }],
      unread: [],
      removals: [],
    });
  });

  it('skips a malformed MCP name', () => {
    expect(checkCall({ tool: 'mcp__', input: {} }, redact).crossings).toEqual([]);
  });

  it('names a skill from either input key', () => {
    const skill = { class: 'skill', form: 'skill-call', name: 'one-skill', version: null, versionForm: 'unstated', program: 'skill', statusReports: true, registryAsked: true };
    expect(checkCall({ tool: 'Skill', input: { skill: 'one-skill', args: 'x' } }, redact).crossings).toEqual([skill]);
    expect(checkCall({ tool: 'Skill', input: { command: 'one-skill' } }, redact).crossings).toEqual([skill]);
    expect(checkCall({ tool: 'Skill', input: {} }, redact).crossings).toEqual([]);
  });

  it('reads no other tool', () => {
    for (const tool of ['Read', 'Edit', 'Write', 'Grep', 'WebFetch', 'Agent']) {
      expect(checkCall({ tool, input: { command: 'npm install axios' } }, redact)).toEqual({ crossings: [], unread: [], removals: [] });
    }
  });
});

describe('the closed vocabulary', () => {
  it('holds exactly these classes, forms, and unread shapes', () => {
    expect(CROSSING_CLASSES).toEqual(['npm-package', 'python-package', 'mcp-server', 'skill']);
    expect(CROSSING_FORMS).toEqual(['install', 'url-install', 'fetch-and-run', 'url-fetch-and-run', 'mcp-call', 'skill-call']);
    expect(UNREAD_SHAPES).toEqual(['manifest-install', 'local-path', 'variable-name', 'masked-name', 'pipe-to-shell', 'behind-xargs', 'harness-registration']);
  });
});

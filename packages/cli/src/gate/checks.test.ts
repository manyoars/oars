import { describe, expect, it } from 'vitest';
import { makeRedactor } from '../sessions/redact.js';
import { shellCommands } from '../sessions/extract.js';
import { admitName, checkCall, readWords, CROSSING_CLASSES, CROSSING_FORMS, UNREAD_SHAPES, type VersionForm } from './checks.js';

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
    ['npm install --globalconfig sub/.npmrc x', ['npm-package install x unstated']],
    // A value flag owns its word, so a relative path after it is no `org/repo`.
    ['npm install --cafile certs/ca.pem plain-one', ['npm-package install plain-one unstated']],
    ['pnpm add --store-dir sub/store plain-two', ['npm-package install plain-two unstated']],
    ['pnpm add --modules-dir sub/mods x', ['npm-package install x unstated']],
    ['yarn add --cache-folder sub/cache x', ['npm-package install x unstated']],
    ['yarn add --modules-folder sub/mods x', ['npm-package install x unstated']],
    ['npm install --nodedir sub/node x', ['npm-package install x unstated']],
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
    // Forms npm's own docs give: scp after `ssh://`, an `@` inside a path, and pip's `name @ url` with spaces.
    ['npm install git+ssh://git@github.com:npm/cli.git#v1.0.27', ['npm-package url-install ssh://<email>:npm/cli.git url']],
    ['npm install https://registry.npmjs.org/@scope/x/-/x-1.0.0.tgz', ['npm-package url-install https://registry.npmjs.org/@scope/x/-/x-1.0.0.tgz url']],
    ['pip install "foo @ https://host.example/x.whl"', ['python-package url-install https://host.example/x.whl url']],
    ['pip install git+https://github.com/org/repo@main', ['python-package url-install https://github.com/org/repo url']],
    // A git URL's ref is what follows its first `@` past the host, so a ref that holds a slash is dropped and never part of the name.
    ['pip install git+https://github.com/org/repo@feature/secret', ['python-package url-install https://github.com/org/repo url']],
    ['pip install "git+https://host.example/org/repo@/secret/home/x"', ['python-package url-install https://host.example/org/repo url']],
    ['npm install git+https://host.example/org/repo.git@/secret/home/x', ['npm-package url-install https://host.example/org/repo.git url']],
    ['npm install git+ssh://host.example/org/repo@/secret/home/x', ['npm-package url-install ssh://host.example/org/repo url']],
    ['npm install ssh://host.example:org/repo@/secret/home/x', ['npm-package url-install ssh://host.example:org/repo url']],
    ['npx git+https://host.example/org/repo@/secret/home/x', ['npm-package url-fetch-and-run https://host.example/org/repo url']],
    ['uv add git+https://host.example/org/repo@/secret/home/x', ['python-package url-install https://host.example/org/repo url']],
    ['pip install https://example.test/a-1.0.tar.gz', ['python-package url-install https://example.test/a-1.0.tar.gz url']],
    // A credential before the host is not a ref: a word with no path has no ref, and the user is stripped.
    ['pip install git+https://hunter2@gitserver', ['python-package url-install https://gitserver url']],
    ['npm install ssh://deploy@gitserver', ['npm-package url-install ssh://gitserver url']],
    ['npm install ssh://git@gitserver:repo.git', ['npm-package url-install ssh://gitserver:repo.git url']],
    ['npx skills add ssh://deploy@gitserver', ['skill install ssh://gitserver unstated']],
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
    // A `file:` spec is a folder or a file on this machine, whatever its slashes: nothing crossed, and no path is kept.
    ['npm install file:///home/someone/private/x', ['local-path']],
    ['pip install file:///home/someone/private/x.whl', ['local-path']],
    ['pip install git+file:///home/someone/private/repo', ['local-path']],
    ['uvx --from file:///home/someone/private/x tool', ['local-path']],
    // The same behind a package name, in every spelling the managers take: the word is not a name, and no path is kept.
    ['npm install foo@file:///secret/home/x', ['local-path']],
    ['npm install foo@file:../secret/x', ['local-path']],
    ['npm install foo@git+file:///secret/home/x', ['local-path']],
    ['yarn add foo@file:/secret/x', ['local-path']],
    ['bun add foo@file:./secret/x', ['local-path']],
    ['pnpm add foo@link:../secret/x', ['local-path']],
    ['pnpm add foo@workspace:*', ['local-path']],
    ['pip install foo@file:///secret/home/x', ['local-path']],
    ['pip install "foo @ file:///secret/home/x.whl"', ['local-path']],
    ['uv add "foo @ file:///secret/home/x"', ['local-path']],
    ['uvx --from "foo @ file:///secret/home/x" tool', ['local-path']],
    ['uv run --with "foo @ file:///secret/home/x" s.py', ['local-path']],
    ['npm exec foo@file:///secret/home/x', ['local-path']],
    ['npm create file:///secret/home/x', ['local-path']],
    // A creator is a name: a path or an `org/repo` is no creator, and none is prefixed into a name.
    ['npm create /secret', ['local-path']],
    ['npm create ../secret', ['local-path']],
    ['npm init /secret', ['local-path']],
    ['npm create ./secret', ['local-path']],
    ['bun create ./secret', ['local-path']],
    ['npm create secret/dir', ['unreadable-name']],
    // A path-shaped word that fits `org/repo` or `host:path` by its slashes and colon alone.
    ['npm install .secret/pkg', ['local-path']],
    ['npx .secret/tool', ['local-path']],
    // A plain URL has no ref past its path: an `@` that ends a segment or sits inside one is a path, not a name.
    ['npx skills add https://host.example/org/repo@/secret/home', ['local-path']],
    ['npm install https://host.example/x.tgz@/secret/home/x', ['local-path']],
    ['pip install https://host.example/org/repo@/secret/home/x', ['local-path']],
    ['npm install https://github.com/org/repo@feature/secret', ['local-path']],
    ['npm install sub/..', ['local-path']],
    ['npm install C:secret/x', ['local-path']],
    ['npm install foo@C:secret/x', ['local-path']],
    ['npx skills add .claude/skills/private-one', ['local-path']],
    ['npx skills add owner/../../secret', ['local-path']],
    ['npx skills add git+file:///secret/home/x', ['local-path']],
    ['npx skills add file:///secret/home/x', ['local-path']],
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
    ['pip install --no-index --find-links ./wheels x', false],
    ['pip install -f ./wheels x', false],
    ['pnpm add --config.registry=https://npm.private.example/ x', false],
    ['pip install -ihttps://private.example/simple x', false],
    ['Push-Location sub; npm install x', false],
    ['Push-Location sub; Pop-Location; npm install x', false],
    ['pushd sub && npm install x', false],
    ['npm install --globalconfig=sub/.npmrc x', false],
    ['npm install --globalconfig sub/.npmrc x', false],
    ['UV_INDEX_URL=https://private.example/simple uvx tool', false],
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

  it('keeps no credentials of a URL in its name, masked or not', () => {
    expect(bash('pip install git+https://user:hunter2hunter2@example.test/org/repo').crossings[0]?.name).toBe('https://example.test/org/repo');
    expect(bash('npm install https://user:secret@host.example/x.tgz?token=secret').crossings[0]?.name).toBe('https://host.example/x.tgz');
    expect(bash('npm install git+ssh://git@host.example/org/repo.git').crossings[0]?.name).toBe('ssh://<email>/org/repo.git');
    expect(bash('npm install git@host.example:org/repo.git').crossings[0]?.name).toBe('<email>:org/repo.git');
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
    expect(UNREAD_SHAPES).toEqual(['manifest-install', 'local-path', 'variable-name', 'masked-name', 'pipe-to-shell', 'behind-xargs', 'harness-registration', 'unreadable-name']);
  });
});

describe('admitName, the one point every recorded name passes', () => {
  type Held = Parameters<typeof admitName>;
  const named = (name: string) => ({ kind: 'named', name });
  const unread = (shape: string) => ({ kind: 'unread', shape });

  it.each<[Held[0], Held[1], string, unknown]>([
    // Names inside the grammar pass as they are.
    ['npm-package', 'install', '@scope/name.js', named('@scope/name.js')],
    ['npm-package', 'fetch-and-run', 'Legacy_Name', named('Legacy_Name')],
    ['python-package', 'install', 'zope.interface', named('zope.interface')],
    ['mcp-server', 'mcp-call', 'claude_ai_One-Server', named('claude_ai_One-Server')],
    ['skill', 'skill-call', 'plugin:one-skill', named('plugin:one-skill')],
    ['skill', 'install', 'owner/repo', named('owner/repo')],
    ['npm-package', 'url-install', 'github:org/repo', named('github:org/repo')],
    ['python-package', 'url-install', 'https://<org-domain>/x/y.git', named('https://<org-domain>/x/y.git')],
    // A path separator, a scheme, or an `@` past the scope is a path whatever the family.
    ['npm-package', 'install', 'pkg@https://evil.test/x', unread('local-path')],
    ['npm-package', 'install', 'sub\\dir\\pkg', unread('local-path')],
    ['npm-package', 'install', '@scope/name@1.2', unread('local-path')],
    ['npm-package', 'install', 'C:secret', unread('local-path')],
    ['npm-package', 'fetch-and-run', 'a/b/c', unread('local-path')],
    ['python-package', 'install', 'wheelhouse/pkg', unread('local-path')],
    ['python-package', 'install', 'pkg@host', unread('local-path')],
    ['mcp-server', 'mcp-call', 'https://host.example', unread('local-path')],
    ['mcp-server', 'mcp-call', 'a/b', unread('local-path')],
    ['skill', 'skill-call', '../x', unread('local-path')],
    ['npm-package', 'url-install', 'ftp://host.example/x', unread('local-path')],
    // A word that is no name and no path is an unread shape of its own, and never a name.
    ['npm-package', 'install', 'two words', unread('unreadable-name')],
    ['npm-package', 'install', 'name?query=1', unread('unreadable-name')],
    ['npm-package', 'install', '@scope', unread('unreadable-name')],
    ['npm-package', 'install', '', unread('unreadable-name')],
    ['python-package', 'install', 'numpy;python_version<3', unread('unreadable-name')],
    ['python-package', 'install', '-bad', unread('unreadable-name')],
    ['python-package', 'install', '.hidden', unread('unreadable-name')],
    ['mcp-server', 'mcp-call', 'bad name', unread('unreadable-name')],
    ['skill', 'skill-call', 'x'.repeat(300), unread('unreadable-name')],
    ['npm-package', 'url-install', 'https://host.example/a b', unread('local-path')],
    ['npm-package', 'url-install', 'a b', unread('unreadable-name')],
    ['skill', 'install', 'one two', unread('unreadable-name')],
    // A dot segment or a dotted owner is a folder on this machine, not an `owner/repo` or a host.
    ['npm-package', 'url-install', '.secret/pkg', unread('local-path')],
    ['npm-package', 'url-fetch-and-run', '.secret/tool', unread('local-path')],
    ['skill', 'install', '.claude/skills/private-one', unread('local-path')],
    ['skill', 'install', 'owner/../../secret', unread('local-path')],
    ['npm-package', 'url-install', 'sub/..', unread('local-path')],
    ['npm-package', 'url-install', 'C:secret/x', unread('local-path')],
    ['npm-package', 'url-install', 'owner/.', unread('local-path')],
    ['npm-package', 'url-install', 'https://host.example/a/../b', unread('local-path')],
    ['npm-package', 'url-install', 'host.example:../x', unread('local-path')],
    // The widened URL grammar keeps its edges: a scp spelling after `ssh://`, an `@` in a path, and a host of its own.
    ['npm-package', 'url-install', 'ssh://<email>:npm/cli.git', named('ssh://<email>:npm/cli.git')],
    ['npm-package', 'url-install', 'https://registry.npmjs.org/@scope/x/-/x-1.0.0.tgz', named('https://registry.npmjs.org/@scope/x/-/x-1.0.0.tgz')],
    ['npm-package', 'url-install', 'https://host.example/org/repo@/secret/home', unread('local-path')],
    ['npm-package', 'url-install', 'https://host.example/org/repo@', unread('local-path')],
    ['npm-package', 'url-install', 'https://host.example/org/repo@feature/secret', unread('local-path')],
    ['npm-package', 'url-install', 'git+https://host.example/org/repo@/secret', unread('local-path')],
    // `/@` opens a segment only when a name follows, and an `@` inside or ending a segment is refused.
    ['npm-package', 'url-install', 'https://host.example/@/secret', unread('local-path')],
    ['npm-package', 'url-install', 'https://host.example/x/@', unread('local-path')],
    ['npm-package', 'url-install', 'https://host.example/@@x', unread('local-path')],
    // A host starts with a letter, a digit, or a mask: dots alone name the parent folder, not a host.
    ['npm-package', 'url-install', 'https://../secret/home/x', unread('local-path')],
    ['npm-package', 'url-install', 'ssh://./x', unread('local-path')],
    ['npm-package', 'url-install', 'https://-x/y', unread('local-path')],
    ['npm-package', 'url-install', 'https://host.example:8080/x.tgz', named('https://host.example:8080/x.tgz')],
    ['npm-package', 'url-install', 'https://host.example:secret/x', unread('local-path')],
    // A mask and a variable keep the shapes they have.
    ['npm-package', 'install', '<secret>', unread('masked-name')],
    ['mcp-server', 'mcp-call', '<secret>', unread('masked-name')],
    ['skill', 'skill-call', '$NAME', unread('variable-name')],
    // A URL keeps a scheme, a host, and a path, and loses what a credential or token could ride in.
    ['npm-package', 'url-install', 'https://user:secret@host.example/x.tgz?token=secret', named('https://host.example/x.tgz')],
    ['python-package', 'url-fetch-and-run', 'https://host.example/a/b#sig=1', named('https://host.example/a/b')],
    ['npm-package', 'url-install', 'git@host.example:org/repo.git', named('host.example:org/repo.git')],
    ['skill', 'install', 'https://user:pw@host.example/org/repo?x=1', named('https://host.example/org/repo')],
  ])('%s %s %j', (cls, form, name, expected) => {
    expect(admitName(cls, form, name)).toEqual(expected);
  });

  it('refuses a version that holds a path', () => {
    expect(bash('npm install foo@../secret/dir').crossings).toEqual([]);
    expect(bash('npm install foo@../secret/dir').unread).toEqual(['local-path']);
    expect(bash('npm install foo@^1.2.0 bar@next').crossings.map((c) => c.version)).toEqual(['^1.2.0', 'next']);
  });

  it.each<[string, string, string | null]>([
    ['npm install "https://host.example/x.tgz#/secret/home/x"', 'https://host.example/x.tgz', null],
    ['pip install "git+https://host.example/org/repo#subdirectory=secret/home&egg=x"', 'https://host.example/org/repo', null],
    ['npm install "https://host.example/x.tgz#token=secret"', 'https://host.example/x.tgz', null],
    ['npm install "https://host.example/x.tgz#v1?token=secret"', 'https://host.example/x.tgz', null],
    ['npm install "https://host.example/x.tgz#sha256=abc"', 'https://host.example/x.tgz', null],
    ['npm install "https://host.example/x.tgz#semver:^1.2.0"', 'https://host.example/x.tgz', 'semver:^1.2.0'],
    ['npm install git+https://github.com/org/repo.git#v1', 'https://github.com/org/repo.git', 'v1'],
    ['pip install git+https://github.com/org/repo@main', 'https://github.com/org/repo', 'main'],
    ['pip install git+https://github.com/org/repo@feature/x', 'https://github.com/org/repo', null],
    // A scope's `/@` is not a ref: the first `@` after it is.
    ['npm install git+https://github.com/@scope/repo@v1', 'https://github.com/@scope/repo', 'v1'],
    ['pip install git+https://github.com/org/repo@feature/secret', 'https://github.com/org/repo', null],
    ['pip install "git+https://host.example/org/repo@/secret/home/x"', 'https://host.example/org/repo', null],
  ])('keeps a URL ref only when it is a plain ref, and the crossing either way: %s', (command, name, version) => {
    const { crossings } = bash(command);
    expect(crossings).toHaveLength(1);
    expect(crossings[0]?.name).toBe(name);
    expect(crossings[0]?.version).toBe(version);
  });

  it('reaches every crossing and removal a call yields', () => {
    expect(checkCall({ tool: 'mcp__a/b__go', input: {} }, redact)).toEqual({ crossings: [], unread: ['local-path'], removals: [] });
    expect(checkCall({ tool: 'Skill', input: { skill: '../x' } }, redact)).toEqual({ crossings: [], unread: ['local-path'], removals: [] });
    expect(bash('npm install "two words"').unread).toEqual(['unreadable-name']);
    expect(bash('npm uninstall "two words" real').removals).toEqual([{ class: 'npm-package', name: 'real' }]);
  });
});

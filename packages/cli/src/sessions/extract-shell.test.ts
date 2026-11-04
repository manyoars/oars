// The captured `pulls`, `commits`, and `segments` of a shell call (t746 Item 2): one table row per form.
import { describe, expect, it } from 'vitest';
import { commitsRead, captureSession, pullsOfTool, readShell, storedToolName } from './extract.js';
import { makeRedactor } from './redact.js';
import { CAPTURE_VERSION } from './schema.js';

const redact = makeRedactor();
const pullsOf = (command: string): string[] =>
  readShell(command, redact).pulls.map((pull) => `${pull.ecosystem}:${pull.name}${pull.version === null ? '' : `@@${pull.version}`}`);

describe('pulls: one row per form', () => {
  const rows: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ['npm install', 'npm install foo', ['npm:foo']],
    ['npm i with a version', 'npm i foo@1.2.3', ['npm:foo@@1.2.3']],
    ['npm add, a dev flag, two names', 'npm add -D foo bar@latest', ['npm:foo', 'npm:bar@@latest']],
    ['npm scoped, whole', 'npm install @scope/pkg', ['npm:@scope/pkg']],
    ['npm scoped with a version', 'npm install @scope/pkg@^2.0.0', ['npm:@scope/pkg@@^2.0.0']],
    ['npm global', 'npm install -g foo', ['npm:foo']],
    ['npm workspace flag takes a value', 'npm install -w packages/cli foo', ['npm:foo']],
    ['npm registry flag takes a value', 'npm install --registry https://r.example foo', ['npm:foo']],
    ['npm equals flag', 'npm install --prefix=./x foo', ['npm:foo']],
    ['pnpm add', 'pnpm add foo', ['npm:foo']],
    ['pnpm install name', 'pnpm install foo', ['npm:foo']],
    ['pnpm i with a filter', 'pnpm i --filter web foo', ['npm:foo']],
    ['pnpm dlx takes one name', 'pnpm dlx create-foo my-app', ['npm:create-foo']],
    ['yarn add', 'yarn add foo@1', ['npm:foo@@1']],
    ['yarn global add', 'yarn global add foo', ['npm:foo']],
    ['yarn dlx', 'yarn dlx foo --flag', ['npm:foo']],
    ['pnpm dlx behind a package flag', 'pnpm --package=foo dlx bar', ['npm:foo']],
    ['pnpm dlx behind a filter whose value reads dlx', 'pnpm --filter dlx dlx foo', ['npm:foo']],
    ['bun add', 'bun add foo', ['npm:foo']],
    ['bun install name', 'bun install foo', ['npm:foo']],
    ['bun i', 'bun i foo', ['npm:foo']],
    ['bun dlx', 'bun dlx foo', ['npm:foo']],
    ['npx', 'npx foo arg', ['npm:foo']],
    ['npx scoped keeps the slash', 'npx @manyoars/oars sessions', ['npm:@manyoars/oars']],
    ['npx with a yes flag and version', 'npx -y foo@2 run', ['npm:foo@@2']],
    ['npx package flag names the pull', 'npx -p foo bar', ['npm:foo']],
    ['npx package equals flag', 'npx --package=foo@1 bar', ['npm:foo@@1']],
    ['npx workspace flag', 'npx -w packages/cli vitest run', ['npm:vitest']],
    ['bunx', 'bunx foo', ['npm:foo']],
    ['pip', 'pip install foo', ['pypi:foo']],
    ['pip3 pinned', 'pip3 install foo==1.2', ['pypi:foo@@1.2']],
    ['pip range', 'pip install "foo>=1.2"', ['pypi:foo@@>=1.2']],
    ['pip extras', 'pip install foo[bar]==1', ['pypi:foo@@1']],
    ['python -m pip', 'python -m pip install foo', ['pypi:foo']],
    ['pip name beside a requirements file', 'pip install -r req.txt foo', ['pypi:foo']],
    ['uv add', 'uv add foo', ['pypi:foo']],
    ['uv pip install', 'uv pip install foo==1', ['pypi:foo@@1']],
    ['uv tool install', 'uv tool install foo', ['pypi:foo']],
    ['uvx', 'uvx foo --help', ['pypi:foo']],
    ['uvx at a version', 'uvx foo@1.2 run', ['pypi:foo@@1.2']],
    ['uvx from', 'uvx --from foo bar', ['pypi:foo']],
    ['pipx install', 'pipx install foo', ['pypi:foo']],
    ['pipx run', 'pipx run foo arg', ['pypi:foo']],
    ['cargo add', 'cargo add foo@1.2', ['cargo:foo@@1.2']],
    ['cargo install with a version flag', 'cargo install foo --version 1.2', ['cargo:foo@@1.2']],
    ['go get', 'go get github.com/a/b@v1.2.3', ['go:github.com/a/b@@v1.2.3']],
    ['go install', 'go install golang.org/x/tools/gopls@latest', ['go:golang.org/x/tools/gopls@@latest']],
    ['gem', 'gem install foo', ['gem:foo']],
    ['gem version flag', 'gem install foo -v 1.2', ['gem:foo@@1.2']],
    ['brew', 'brew install foo', ['brew:foo']],
    ['brew cask, tap path whole', 'brew install --cask a/b/foo', ['brew:a/b/foo']],
    ['skills installer', 'npx skills add owner/repo', ['skill:owner/repo']],
    ['skills installer with a yes flag and version', 'npx -y skills@latest add owner/repo --skill one', ['skill:owner/repo']],
    ['skills, not an install, is the npm package', 'npx skills list', ['npm:skills']],
    ['yarn install with a name', 'yarn install foo', ['npm:foo']],
    ['yarn i with a name', 'yarn i foo', ['npm:foo']],
    ['npm dlx', 'npm dlx foo', ['npm:foo']],
    ['pnpm add with the workspace-root flag', 'pnpm add -w foo', ['npm:foo']],
    ['pnpm with the workspace-root flag first', 'pnpm -w add foo', ['npm:foo']],
    ['npm silent flag takes no value', 'npm install -s foo', ['npm:foo']],
    ['npm silent flag after the name', 'npm install foo -s', ['npm:foo']],
    ['npx skills add -s takes the skill name', 'npx skills add -s one owner/repo', ['skill:owner/repo']],
    ['yarn workspace names the folder, not the pull', 'yarn workspace web add foo', ['npm:foo']],
    ['yarn workspace with a version', 'yarn workspace @scope/web add foo@2', ['npm:foo@@2']],
    ['cargo with a toolchain word', 'cargo +nightly install foo', ['cargo:foo']],
    ['cargo add with a toolchain word', 'cargo +stable add foo@1', ['cargo:foo@@1']],
    ['cargo install from a git URL', 'cargo install --git https://github.com/a/b', ['cargo:https://github.com/a/b']],
    ['cargo install from a git URL, named', 'cargo install --git https://github.com/a/b foo', ['cargo:foo']],
    ['sudo -u takes a user', 'sudo -u root npm i foo', ['npm:foo']],
    ['sudo -g takes a group', 'sudo -g wheel pip install foo', ['pypi:foo']],
    ['env -u takes a variable', 'env -u X npm i foo', ['npm:foo']],
    ['nice -n takes a level', 'nice -n 5 npm i foo', ['npm:foo']],
    ['timeout -k takes a duration', 'timeout -k 5 60 npm i foo', ['npm:foo']],
    ['timeout -s takes a signal', 'timeout -s KILL 60 npm i foo', ['npm:foo']],
    ['sudo with a flag that takes no value', 'sudo -E npm i foo', ['npm:foo']],
    ['claude plugin', 'claude plugin install foo@market', ['plugin:foo@market']],
    ['codex plugin', 'codex plugin add foo', ['plugin:foo']],
    ['a Windows wrapper', '& "C:\\Program Files\\nodejs\\npm.cmd" install foo', ['npm:foo']],
  ];
  it.each(rows)('%s', (_name, command, expected) => {
    expect(pullsOf(command)).toEqual(expected);
  });
});

describe('pulls: what names nothing', () => {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ['npm lockfile install', 'npm install'],
    ['npm ci', 'npm ci'],
    ['npm i with only flags', 'npm i --no-audit'],
    ['pnpm lockfile install', 'pnpm install --frozen-lockfile'],
    ['yarn lockfile install', 'yarn install'],
    ['bun lockfile install', 'bun install'],
    ['pip requirements file', 'pip install -r requirements.txt'],
    ['pip editable', 'pip install -e .'],
    ['pip local path', 'pip install ./pkg'],
    ['pip local wheel', 'pip install foo-1.0-py3-none-any.whl'],
    ['uv sync', 'uv sync'],
    ['cargo path', 'cargo install --path .'],
    ['cargo build', 'cargo build'],
    ['go relative', 'go install ./cmd/x'],
    ['go bare', 'go get'],
    ['go with no module path', 'go install cmd/x'],
    ['go test', 'go test ./...'],
    ['npm local folder', 'npm install ../pkg'],
    ['an scp-style git spec, whose name reads as a mask', 'npm install git@github.com:org/repo.git'],
    ['npm file spec', 'npm install file:../pkg'],
    ['npm variable', 'npm install $PKG'],
    ['PowerShell variable', 'npm install $env:PKG'],
    ['npm test', 'npm test'],
    ['words in an echo', 'echo npm install foo'],
    ['a quoted command in an echo', 'echo "x && npm install foo"'],
    ['a commit message', 'git commit -m "npm install foo; pip install bar"'],
    ['a comment', '# npm install foo'],
    ['a trailing comment', 'ls # npm install foo'],
    ['a heredoc body', "cat > f <<'EOF'\nnpm install foo\nEOF"],
    ['a heredoc inside a commit message', 'git commit -m "$(cat <<\'EOF\'\nnpm install foo\nEOF\n)"'],
    ['a PowerShell here-string', "git commit -m @'\nnpm install foo\n'@"],
    ['a claude call that is not an install', 'claude plugin list'],
    ['codex otherwise', 'codex exec foo'],
    ['an empty command', ''],
  ];
  it.each(rows)('%s', (_name, command) => {
    expect(pullsOf(command)).toEqual([]);
  });
});

describe('pulls: every line and every segment', () => {
  it('reads a compound command at every separator', () => {
    expect(pullsOf('cd web && npm install a; pip install b || cargo add c | tee log & go get x.io/d')).toEqual(['npm:a', 'pypi:b', 'cargo:c', 'go:x.io/d']);
  });
  it('reads every line', () => {
    expect(pullsOf('echo start\nnpm install a\n\npip install b')).toEqual(['npm:a', 'pypi:b']);
  });
  it('reads across a line continuation', () => {
    expect(pullsOf('npm install \\\n  a \\\n  b')).toEqual(['npm:a', 'npm:b']);
  });
  it('reads a subshell and a shell -c argument', () => {
    expect(pullsOf('(cd x && npm i a)')).toEqual(['npm:a']);
    expect(pullsOf('bash -c "npm i a && pip install b"')).toEqual(['npm:a', 'pypi:b']);
    expect(pullsOf('pwsh -Command "npm i a"')).toEqual(['npm:a']);
  });
  it('reads an unquoted command after cmd, pwsh, and powershell', () => {
    expect(pullsOf('cmd /c npm install foo')).toEqual(['npm:foo']);
    expect(pullsOf('powershell -Command npm install foo')).toEqual(['npm:foo']);
  });
  it('does not read a quoted argument of that command as a command', () => {
    expect(pullsOf('cmd /c git commit -m "a && npm i b"')).toEqual([]);
  });
  it('skips a prelude', () => {
    expect(pullsOf('CI=1 sudo env FOO=2 npm i a')).toEqual(['npm:a']);
    expect(pullsOf('$env:CI = "1"; npm i a')).toEqual(['npm:a']);
    expect(pullsOf('timeout 60 npm i a')).toEqual(['npm:a']);
  });
  it('strips a quoted argument and keeps it one word', () => {
    expect(pullsOf(`npm install "foo@1" 'bar'`)).toEqual(['npm:foo@@1', 'npm:bar']);
    expect(pullsOf('npm install "@scope/pkg@2"')).toEqual(['npm:@scope/pkg@@2']);
  });
  it('names a pull once in a call', () => {
    expect(pullsOf('npm i a && npm i a')).toEqual(['npm:a']);
  });
  it('ignores a redirect', () => {
    expect(pullsOf('npm i a > log 2>&1')).toEqual(['npm:a']);
    expect(pullsOf('npm i a >log.txt 2>/dev/null')).toEqual(['npm:a']);
  });
});

describe('pulls: redaction', () => {
  it('masks a credential in a URL pull and keeps the rest of the name', () => {
    expect(pullsOf('pip install git+https://me:hunter22@github.com/a/b.git')).toEqual(['pypi:git+https://<secret>@github.com/a/b.git']);
  });
  it('keeps a token out of a name and out of a version', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz012345';
    // A version that holds a mask says only that something was masked, so it is dropped rather than kept as noise.
    expect(pullsOf(`npm install foo@${token}`)).toEqual(['npm:foo']);
    expect(pullsOf(`pip install foo==${token}`)).toEqual(['pypi:foo']);
    expect(JSON.stringify(readShell(`npm install foo@${token}`, redact))).not.toContain(token);
  });
  it('keeps a mask out of the version of an npm alias, which the redactor reads as an email', () => {
    expect(pullsOf('npm install alias@npm:foo@1.2.3')).toEqual(['npm:alias']);
  });
  it('drops a name that is all mask, which says nothing', () => {
    expect(pullsOf('npm install ghp_abcdefghijklmnopqrstuvwxyz012345 foo')).toEqual(['npm:foo']);
  });
  it('masks an organization domain', () => {
    const domains = makeRedactor(['corp.example']);
    expect(readShell('pip install https://pkgs.corp.example/x.tar.gz', domains).pulls[0]?.name).toBe('https://<org-domain>/x.tar.gz');
  });
});

describe('MCP pulls', () => {
  it('names the full server from the tool name, which shortName cuts to 10 characters', () => {
    expect(pullsOfTool('mcp__claude-in-chrome__navigate', redact)).toEqual([{ ecosystem: 'mcp', name: 'claude-in-chrome', version: null }]);
    expect(pullsOfTool('mcp__a-very-long-server-name__do', redact)).toEqual([{ ecosystem: 'mcp', name: 'a-very-long-server-name', version: null }]);
  });
  it('names nothing for any other tool', () => {
    expect(pullsOfTool('Read', redact)).toEqual([]);
    expect(pullsOfTool('mcp__', redact)).toEqual([]);
  });
  it('redacts the server name, and drops one that is all mask, which says nothing', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz012345';
    expect(pullsOfTool(`mcp__${token}__x`, redact)).toEqual([]);
    expect(pullsOfTool(`mcp__me-${token}__x`, redact)).toEqual([{ ecosystem: 'mcp', name: 'me-<secret>', version: null }]);
  });
});

describe('MCP tool names: a token behind an underscore or in a later part is redacted', () => {
  const token = 'ghp_abcdefghijklmnopqrstuvwxyz012345';
  const line = (message: object, extra: object = {}): string => JSON.stringify({ timestamp: '2026-06-10T00:00:00.000Z', cwd: '/w', ...extra, message });
  const capturedFor = (toolName: string) =>
    captureSession({
      text: [
        line({ role: 'user', content: 'go' }, { type: 'user' }),
        line({ role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: toolName, input: {} }] }, { type: 'assistant' }),
        line({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'Exit code 1\nboom', is_error: true }] }, { type: 'user' }),
      ].join('\n'),
      session: 's',
      project: 'p',
      rev: 1,
      at: '',
      bytes: 0,
      redact,
    });
  it.each([`mcp__me_${token}__find`, `mcp__me__${token}__find`, `mcp__me__find_${token}`])('keeps the token out of every stored field for %s', (toolName) => {
    expect(JSON.stringify(capturedFor(toolName))).not.toContain(token);
  });
  const hex36 = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const gh = `ghp_${hex36}`;
  const sk = 'sk-ant-api03-AAAAAAAA';
  const tail32 = 'abcdefghijklmnopqrstuvwxyzABCDEF';
  const aiza = 'AIzaAAAAAAAAAA';
  const tail28 = 'abcdefghijklmnopqrstuvwxyz01';
  it.each<readonly [string, readonly string[]]>([
    [`mcp__me_${gh}_x__find`, [gh, hex36]],
    [`mcp__${gh}_x__find`, [gh, hex36]],
    [`mcp__me__${gh}_find`, [gh, hex36]],
    [`mcp__${sk}__${tail32}__find`, [sk, tail32]],
    [`mcp__me-${aiza}__${tail28}__find`, [aiza, tail28]],
    [`mcp_me-${gh}_find`, [gh, hex36]],
  ])('keeps no part of the token in any stored field for %s', (toolName, parts) => {
    const stored = JSON.stringify(capturedFor(toolName));
    for (const part of parts) expect(stored).not.toContain(part);
  });
  it('reads a name past the cap as one masked value rather than slicing it', () => {
    const long = `mcp__${'a_'.repeat(100)}find`;
    expect(storedToolName(long, redact)).toBe('mcp__<oversized>');
    expect(pullsOfTool(long, redact)).toEqual([{ ecosystem: 'mcp', name: '<oversized>', version: null }]);
  });
  it('leaves an ordinary name alone', () => {
    expect(storedToolName('mcp__github__create_issue', redact)).toBe('mcp__github__create_issue');
    expect(storedToolName('mcp_oars_oars_recall', redact)).toBe('mcp_oars_oars_recall');
    expect(storedToolName('Bash', redact)).toBe('Bash');
  });
  it('masks the token in the stored name and the pull for both forms', () => {
    expect(storedToolName(`mcp__me_${token}__find`, redact)).toBe('mcp__me_<secret>__find');
    expect(storedToolName(`mcp__me__${token}__find`, redact)).toBe('mcp__me__<secret>__find');
    expect(pullsOfTool(`mcp__me_${token}__find`, redact)).toEqual([{ ecosystem: 'mcp', name: 'me_<secret>', version: null }]);
    expect(pullsOfTool(`mcp__me__${token}__find`, redact)).toEqual([{ ecosystem: 'mcp', name: 'me', version: null }]);
  });
});

describe('MCP tool names: a server name that holds a token is stored redacted', () => {
  const token = 'ghp_abcdefghijklmnopqrstuvwxyz012345';
  const line = (message: object, extra: object = {}): string => JSON.stringify({ timestamp: '2026-06-10T00:00:00.000Z', cwd: '/w', ...extra, message });
  const lines = [
    line({ role: 'user', content: 'go' }, { type: 'user' }),
    line({ role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: `mcp__me-${token}__find`, input: {} }] }, { type: 'assistant' }),
    line({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'Exit code 1\nboom', is_error: true }] }, { type: 'user' }),
  ];
  const captured = captureSession({ text: lines.join('\n'), session: 's', project: 'p', rev: 1, at: '', bytes: 0, redact });
  it('keeps the token out of the tool record, the per-session count, and the error line', () => {
    expect(captured.tools[0]?.tool).toBe('mcp__me-<secret>__find');
    expect(captured.session.tools).toEqual({ 'mcp__me-<secret>__find': 1 });
    expect(captured.errorLines[0]?.tool).toBe('mcp__me-<secret>__find');
    expect(JSON.stringify(captured)).not.toContain(token);
  });
  it('leaves a name with no secret as it was', () => {
    expect(storedToolName('mcp__claude-in-chrome__navigate', redact)).toBe('mcp__claude-in-chrome__navigate');
    expect(storedToolName('Read', redact)).toBe('Read');
    expect(storedToolName('mcp__', redact)).toBe('mcp__');
  });
});

describe('shell structure: forms that must not hide the commands after them', () => {
  const runs = (command: string): Array<readonly [string, boolean]> => readShell(command, redact).segments.map((segment) => [segment.run, segment.read]);
  it('opens no here-string for a line that merely ends in @ and a quote', () => {
    expect(pullsOf('echo "me@"\nnpm install foo')).toEqual(['npm:foo']);
    expect(pullsOf("echo 'me@'\nnpm install foo")).toEqual(['npm:foo']);
  });
  it('still opens a here-string at the start of a line, after a space, an equals sign, or a parenthesis', () => {
    for (const opening of ["@'", "git commit -m @'", "$x=@'", "$x = @'", "f(@'"]) expect(pullsOf(`${opening}\nnpm install hidden\n'@\nnpm install shown`)).toEqual(['npm:shown']);
  });
  it('opens no heredoc for a << inside quotes', () => {
    expect(pullsOf('echo "a << b"\nnpm install foo')).toEqual(['npm:foo']);
    expect(pullsOf('git commit -m "x << y"\nnpm install foo')).toEqual(['npm:foo']);
    expect(pullsOf("echo 'a <<EOF'\nnpm install foo")).toEqual(['npm:foo']);
  });
  it('still opens a heredoc outside quotes and inside a command substitution', () => {
    expect(pullsOf("cat <<'EOF'\nnpm install hidden\nEOF\nnpm install shown")).toEqual(['npm:shown']);
    expect(pullsOf('echo "$(cat <<EOF\nnpm install hidden\nEOF\n)"\nnpm install shown')).toEqual(['npm:shown']);
  });
  it('reads a command behind a PowerShell assignment', () => {
    expect(runs('$x = npm test')).toEqual([['npm test', true]]);
    expect(readShell('$sha = git commit -m x', redact).commitPlan).toHaveLength(1);
    expect(runs('$out = & npm test')).toEqual([['npm test', true]]);
  });
  it('reads a quoted or numeric assignment value as no command, as before', () => {
    expect(runs('$x = "1"')).toEqual([]);
    expect(runs('$x = 5')).toEqual([]);
    expect(runs('$env:CI = "1"; npm test')).toEqual([['npm test', true]]);
  });
  it('reads only -c and a prefix of -command as the command flag of PowerShell', () => {
    expect(runs('powershell -Exec Bypass -Command "npm test"')).toEqual([['npm test', true]]);
    expect(runs('pwsh -NoProfile -c "npm test"')).toEqual([['npm test', true]]);
    expect(runs('pwsh -Com "npm test"')).toEqual([['npm test', true]]);
    expect(runs('powershell -Exec Bypass')).toEqual([['powershell Bypass', true]]);
    expect(runs('bash -lc "npm test"')).toEqual([['npm test', true]]);
    expect(runs('cmd /c npm test')).toEqual([['npm test', true]]);
  });
  it('hides every command of a group a pipe follows', () => {
    expect(runs('(npm test && echo ok) | tail')).toEqual([['npm test', false], ['echo ok', false], ['tail', true]]);
    expect(runs('(npm test) | tail')).toEqual([['npm test', false], ['tail', true]]);
  });
  it('hides the commands of a group opened behind a word when a pipe follows its close', () => {
    expect(runs('echo $(npm test && echo ok) | tail').filter(([run]) => run.startsWith('npm') || run.startsWith('echo ok'))).toEqual([['npm test', false], ['echo ok', false]]);
    expect(runs('foreach ($f in $x) { npm test && echo ok } | tail').filter(([run]) => run.startsWith('npm') || run.startsWith('echo ok'))).toEqual([['npm test', false], ['echo ok', false]]);
  });
  it('hides the commands of a group that holds a nested group, and the command whose words open a group', () => {
    const only = (command: string, ...starts: string[]) => runs(command).filter(([run]) => starts.some((start) => run.startsWith(start)));
    expect(only('(npm test && foreach ($f in $x) { echo $f }) | tail', 'npm')).toEqual([['npm test', false]]);
    expect(only('(npm test && if ($y) { echo ok }) | tail', 'npm')).toEqual([['npm test', false]]);
    expect(only('pytest $(git ls-files) | tail', 'pytest', 'git')).toEqual([['pytest', false], ['git ls-files', false]]);
    expect(only('npm run build $(x) | tail', 'npm')).toEqual([['npm run build', false]]);
    expect(only('echo $(npm test && echo ok) | tail', 'echo', 'npm')).toEqual([['echo', false], ['npm test', false], ['echo ok', false]]);
    expect(only('pytest $(git ls-files) && tail', 'pytest')).toEqual([['pytest', true]]);
  });
  it('hides only the command before the pipe when no group closes before it', () => {
    expect(runs('a && b | c')).toEqual([['a', true], ['b', false], ['c', true]]);
    expect(runs('a | (b && c)')).toEqual([['a', false], ['b', true], ['c', true]]);
    expect(runs('(a && b) && c')).toEqual([['a', true], ['b', true], ['c', true]]);
  });
});

describe('segments: what the status of the call says about each', () => {
  const read = (command: string): Array<readonly [string, boolean]> => readShell(command, redact).segments.map((segment) => [segment.run, segment.read]);
  it('names a program and its plain words, without flags, paths, and variables', () => {
    expect(read('npm run -w packages/cli test')).toEqual([['npm run test', true]]);
    expect(read('just -f $env:ORCH_ROOT/justfile build oars run check')).toEqual([['just build oars run check', true]]);
    expect(read('C:/tools/Mvn.CMD -pl mod-x -am verify')).toEqual([['mvn mod-x verify', true]]);
    expect(read('./gradlew.bat test')).toEqual([['gradlew test', true]]);
  });
  it('reads the status of the last command of the last list, through &&', () => {
    expect(read('a && b')).toEqual([['a', true], ['b', true]]);
    expect(read('a; b')).toEqual([['a', false], ['b', true]]);
    expect(read('a\nb')).toEqual([['a', false], ['b', true]]);
    expect(read('a & b')).toEqual([['a', false], ['b', true]]);
  });
  it('does not read a command a pipe follows, or one || recovers', () => {
    expect(read('a | b')).toEqual([['a', false], ['b', true]]);
    expect(read('a || b')).toEqual([['a', false], ['b', true]]);
    expect(read('a && b | c')).toEqual([['a', true], ['b', false], ['c', true]]);
    expect(read('a && b; c')).toEqual([['a', false], ['b', false], ['c', true]]);
    expect(read('(a && b)')).toEqual([['a', true], ['b', true]]);
  });
  it('takes a pipe into a shell -c argument through its outer read', () => {
    expect(read('bash -c "a && b" | c')).toEqual([['a', false], ['b', false], ['c', true]]);
    expect(read('bash -c "a; b"')).toEqual([['a', false], ['b', true]]);
  });
  it('joins the unquoted words after the flag of cmd, pwsh, and powershell; bash takes one word', () => {
    expect(read('pwsh -c npm test')).toEqual([['npm test', true]]);
    expect(read('cmd /c npm test | tail')).toEqual([['npm test', false], ['tail', true]]);
    expect(read('bash -c npm test')).toEqual([['npm', true]]);
    expect(read('cmd /c "npm test" foo')).toEqual([['npm test', true]]);
  });
  it('keeps the closing words of a block out', () => {
    expect(read('for x in a; do b; done')).toEqual([['for x in a', false], ['b', true]]);
    expect(read('if a; then b; fi')).toEqual([['a', false], ['b', true]]);
    expect(read('if ($?) { a }')).toEqual([['a', true]]);
  });
  it('cuts a word and keeps a command of many segments to the last ones', () => {
    expect(read(`a ${'x'.repeat(40)}`)).toEqual([[`a ${'x'.repeat(30)}`, true]]);
    const many = readShell(Array.from({ length: 80 }, (_, index) => `p${String(index)}`).join(' && '), redact).segments;
    expect(many).toHaveLength(50);
    expect(many.at(-1)?.run).toBe('p79');
  });
  it('holds no free text: a quoted word with a space is not a plain word', () => {
    expect(read('git commit -m "a secret plan"')).toEqual([['git commit', true]]);
  });
  it('masks a secret', () => {
    expect(read('curl ghp_abcdefghijklmnopqrstuvwxyz012345')).toEqual([['curl <secret>', true]]);
  });
  it('never throws on a torn command', () => {
    for (const torn of ['"unclosed', "'unclosed", 'a \\', '$(', '"$(', '<<EOF', "@'", ') (', '&& ||', '> ']) expect(() => readShell(torn, redact)).not.toThrow();
  });
  it('never throws on a long chain of joining shells, and reads the command beneath the cap', () => {
    for (const count of [10, 1000, 5000]) expect(() => readShell(`${'pwsh -c '.repeat(count)}ls`, redact)).not.toThrow();
    expect(readShell('pwsh -c pwsh -c pwsh -c npm test', redact).segments.map((segment) => segment.run)).toEqual(['npm test']);
    // Past the cap a shell is a plain command, so the call still reads as a command and never as a crash.
    expect(readShell(`${'pwsh -c '.repeat(5000)}ls`, redact).segments.length).toBeGreaterThan(0);
  });
});

describe('commits: a successful `git commit` and the sha its result names', () => {
  const shas = (command: string, result: string): Array<string | null> => commitsRead(readShell(command, redact).commitPlan, result);
  const rows: ReadonlyArray<readonly [string, string, string, ReadonlyArray<string | null>]> = [
    ['the bracket line', 'git commit -m x', '[main abc1234] x\n 1 file changed', ['abc1234']],
    ['a branch with a slash', 'git commit -m x', '[task/t746 abc1234] x', ['abc1234']],
    ['a root commit', 'git commit -m x', '[main (root-commit) abc1234] x', ['abc1234']],
    ['behind another command', 'git add . && git commit -m x', '[main abc1234] x', ['abc1234']],
    ['on a later line', 'echo hi\ngit commit -m x', 'hi\n[main abc1234] x', ['abc1234']],
    ['after a repository flag', 'git -C /x commit -m x', '[main abc1234] x', ['abc1234']],
    ['after a config flag', 'git -c a.b=c commit -m x', '[main abc1234] x', ['abc1234']],
    ['a count with no sha', 'git commit -q -m x', '', [null]],
    ['quiet, then rev-parse', 'git commit -q -m x && git rev-parse --short HEAD', 'abc1234\n', ['abc1234']],
    ['quiet, then log -1', 'git commit -q -m x && git log --oneline -1', 'abc1234 x\n', ['abc1234']],
    ['log -n 1', 'git commit -qm x && git log -n 1 --format=%h', 'abc1234\n', ['abc1234']],
    ['log --max-count', 'git commit -qm x && git log --max-count=1 --oneline', 'abc1234 x', ['abc1234']],
    ['log -1 with the full form', 'git commit -qm x && git log -1', 'commit 0123456789012345678901234567890123456789\nAuthor: a', ['0123456789012345678901234567890123456789']],
    ['a pipe between them', 'git commit -qm x 2>&1 | tail -1 && git log --oneline -1', 'abc1234 x', ['abc1234']],
    ['same repository flag', 'git -C /a commit -qm x && git -C /a log --oneline -1', 'abc1234 x', ['abc1234']],
    ['a read of another repository is not this commit', 'git -C /a commit -qm x && git -C /b log --oneline -1', 'abc1234 x', [null]],
    ['a read of another --git-dir is not this commit', 'git --git-dir=/a commit -qm x && git --git-dir=/b log --oneline -1', 'abc1234 x', [null]],
    ['a read of the same --git-dir is this commit', 'git --git-dir=/a commit -qm x && git --git-dir=/a log --oneline -1', 'abc1234 x', ['abc1234']],
    ['a read of another --work-tree is not this commit', 'git --work-tree=/a commit -qm x && git --work-tree=/b rev-parse --short HEAD', 'abc1234', [null]],
    ['a quoted -h is a message, not help', 'git commit -m "-h"', '[main abc1234] x', ['abc1234']],
    ['a quoted --dry-run is a message', 'git commit -m "--dry-run"', '[main abc1234] x', ['abc1234']],
    ['an unquoted -h is help', 'git commit -h', '[main abc1234] x', []],
    ['rev-parse --abbrev-ref prints a branch, not a sha', 'git log --oneline -1 && git commit -qm x && git rev-parse --abbrev-ref HEAD', 'abc1234 prior\nmain', [null]],
    ['rev-parse --symbolic-full-name prints a ref, not a sha', 'git commit -qm x && git rev-parse --symbolic-full-name HEAD', 'refs/heads/main', [null]],
    ['a read of another ref is not this commit', 'git commit -qm x && git log --oneline -1 origin/main', 'abc1234 x', [null]],
    ['rev-parse of another ref', 'git commit -qm x && git rev-parse origin/main', 'abc1234', [null]],
    ['behind a semicolon, the log may read an older commit', 'git commit -qm x; git log --oneline -1', 'abc1234 x', [null]],
    ['a log of several is not this commit', 'git commit -qm x && git log --oneline -3', 'abc1234 x\ndef5678 y', [null]],
    ['two commits', 'git commit -m a && git commit -m b', '[main aaa1111] a\n[main bbb2222] b', ['aaa1111', 'bbb2222']],
    ['two quiet, the read-back names the last', 'git commit -qm a && git commit -qm b && git rev-parse --short HEAD', 'bbb2222', [null, 'bbb2222']],
    ['nothing to commit', 'git add . ; git commit -m x; echo done', 'On branch main\nnothing to commit, working tree clean\ndone', []],
    ['nothing added', 'git commit -m x; true', 'nothing added to commit but untracked files present', []],
    ['no changes added', 'git commit -m x; true', 'no changes added to commit (use "git add")', []],
    ['a dry run', 'git commit --dry-run -m x', 'On branch main', []],
    ['a help call', 'git commit -h', 'usage', []],
    ['no commit', 'git status', '[main abc1234] x', []],
    ['the word in a message', 'git log --grep="git commit"', '', []],
    ['an echo', 'echo git commit -m x', 'git commit -m x', []],
    ['a heredoc body', "cat > f <<'EOF'\ngit commit -m x\nEOF", '', []],
    ['a bash -c', 'bash -c "git commit -m x"', '[main abc1234] x', ['abc1234']],
    ['a Windows path', '"C:\\Program Files\\Git\\cmd\\git.exe" commit -m x', '[main abc1234] x', ['abc1234']],
    ['an unquoted cmd /c', 'cmd /c git commit -m x', '[main abc1234] x', ['abc1234']],
    ['a read-back another log follows is not the last hash', 'git commit -qm x && git rev-parse --short HEAD && git log --oneline -3', 'abc1234\nabc1234 x\nbcd2222 y\nfed3333 z', [null]],
    ['a read-back a count follows is not the last hash', 'git commit -qm x && git log --oneline -1 && wc -l big.txt', 'abc1234 x\n1234567 big.txt', [null]],
    ['only the final read-back names a commit', 'git commit -qm a && git rev-parse --short HEAD && git commit -qm b && git rev-parse --short HEAD', 'aaa1111\nbbb2222', [null, 'bbb2222']],
  ];
  it.each(rows)('%s', (_name, command, result, expected) => {
    expect(shas(command, result)).toEqual(expected);
  });
});

describe('capture of a shell call (CAPTURE 6)', () => {
  const line = (message: object, extra: object = {}): string => JSON.stringify({ timestamp: '2026-06-10T00:00:00.000Z', cwd: '/w', ...extra, message });
  const prompt = line({ role: 'user', content: 'go' }, { type: 'user' });
  const use = (id: string, name: string, input: object): string => line({ role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, { type: 'assistant' });
  const result = (id: string, content: string, isError = false): string => line({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, { type: 'user' });
  const capture = (lines: readonly string[]) => captureSession({ text: lines.join('\n'), session: 's', project: 'p', rev: 1, at: '', bytes: 0, redact }).tools;

  it('is a CAPTURE_VERSION bump', () => {
    expect(Number(CAPTURE_VERSION)).toBeGreaterThanOrEqual(6);
  });
  it('writes commits only on a clean result, behind another command', () => {
    const [ok, failed, open] = capture([
      prompt,
      use('a', 'Bash', { command: 'git add . && git commit -m x' }),
      result('a', '[main abc1234] x'),
      use('b', 'Bash', { command: 'git add . && git commit -m x' }),
      result('b', 'Exit code 1\nerror'),
      use('c', 'Bash', { command: 'git commit -m x' }),
    ]);
    expect(ok).toMatchObject({ status: 'ok', commits: ['abc1234'] });
    expect(failed).toMatchObject({ status: 'error' });
    expect(failed?.commits).toBeUndefined();
    expect(open?.commits).toBeUndefined();
  });
  it('leaves shellTarget and `target` as they were', () => {
    const [call] = capture([prompt, use('a', 'Bash', { command: 'npx @manyoars/oars sessions' }), result('a', 'ok')]);
    expect(call?.target).toBe('npx sessions');
    expect(call?.pulls).toEqual([{ ecosystem: 'npm', name: '@manyoars/oars', version: null }]);
  });
  it('writes `segments` on every shell call, and no `pulls` or `commits` when there are none', () => {
    const [call] = capture([prompt, use('a', 'PowerShell', { command: 'ls' }), result('a', 'x')]);
    expect(call?.segments).toEqual([{ run: 'ls', read: true }]);
    expect(call).not.toHaveProperty('pulls');
    expect(call).not.toHaveProperty('commits');
  });
  it('writes none of them on another tool, and an MCP pull on an MCP call', () => {
    const [read, mcp] = capture([prompt, use('a', 'Read', { file_path: 'x' }), result('a', 'x'), use('b', 'mcp__some-long-server-name__go', {}), result('b', 'x')]);
    expect(read).not.toHaveProperty('segments');
    expect(read).not.toHaveProperty('pulls');
    expect(mcp?.pulls).toEqual([{ ecosystem: 'mcp', name: 'some-long-server-name', version: null }]);
  });
  it('a repeated call in a resumed session is written once, so its commits are counted once', () => {
    const calls = capture([prompt, use('a', 'Bash', { command: 'git commit -m x' }), result('a', '[main abc1234] x'), use('a', 'Bash', { command: 'git commit -m x' }), result('a', '[main abc1234] x')]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.commits).toEqual(['abc1234']);
  });
});

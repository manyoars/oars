// The captured `pulls`, `commits`, and `segments` of a shell call (t746 Item 2): one table row per form.
import { describe, expect, it } from 'vitest';
import { commitsRead, captureSession, pullsOfTool, readShell } from './extract.js';
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
    expect(pullsOf(`npm install foo@${token}`)).toEqual(['npm:foo@@<secret>']);
    expect(JSON.stringify(readShell(`npm install foo@${token}`, redact))).not.toContain(token);
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

describe('segments: what the status of the call says about each', () => {
  const read = (command: string): Array<readonly [string, boolean]> => readShell(command, redact).segments.map((segment) => [segment.run, segment.read]);
  it('names a program and its plain words, without flags, paths, and variables', () => {
    expect(read('npm run -w packages/cli test')).toEqual([['npm run test', true]]);
    expect(read('just -f $env:ORCH_ROOT/justfile build oars run check')).toEqual([['just build oars run check', true]]);
    expect(read('C:/tools/Mvn.CMD -pl aor-x -am verify')).toEqual([['mvn aor-x verify', true]]);
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
  it('a repeated call in a resumed session keeps no commits', () => {
    const [first, repeat] = capture([prompt, use('a', 'Bash', { command: 'git commit -m x' }), result('a', '[main abc1234] x'), use('a', 'Bash', { command: 'git commit -m x' }), result('a', '[main abc1234] x')]);
    expect(first?.commits).toEqual(['abc1234']);
    expect(repeat?.commits).toBeUndefined();
  });
});

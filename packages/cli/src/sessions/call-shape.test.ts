// What a call touched, in shape and never in value (t870): the target class and the argument classes. Every path, URL, and value here is invented.
import { describe, expect, it } from 'vitest';
import { ARG_CLASSES, argClassOf, TARGET_CLASSES, targetClassOf, type TargetClass } from './call-shape.js';
import { captureSession } from './extract.js';
import { makeRedactor } from './redact.js';

describe('the class of a path target', () => {
  const cases: ReadonlyArray<readonly [string, TargetClass]> = [
    ['src/app/main.ts', 'source'],
    ['lib/Main.java', 'source'],
    ['scripts/build.sh', 'source'],
    ['web/styles/site.css', 'source'],
    ['src/app/main.test.ts', 'test'],
    ['src/app/main.spec.js', 'test'],
    ['pkg/test_main.py', 'test'],
    ['pkg/main_test.go', 'test'],
    ['src/FooTest.java', 'test'],
    ['tests/fixtures/data.json', 'test'],
    ['src/__tests__/helper.ts', 'test'],
    ['package.json', 'config'],
    ['.github/workflows/ci.yml', 'config'],
    ['tsconfig.base.json', 'config'],
    ['vite.config.ts', 'config'],
    ['Dockerfile', 'config'],
    ['.env.local', 'config'],
    ['.eslintrc', 'config'],
    ['config/app.toml', 'config'],
    ['README.md', 'doc'],
    ['docs/guide.html', 'doc'],
    ['notes/todo.txt', 'doc'],
    ['LICENSE', 'doc'],
    ['CHANGELOG.md', 'doc'],
    ['package-lock.json', 'lockfile'],
    ['pnpm-lock.yaml', 'lockfile'],
    ['Cargo.lock', 'lockfile'],
    ['go.sum', 'lockfile'],
    ['dist/bundle.js', 'generated'],
    ['node_modules/left-pad/index.js', 'generated'],
    ['web/app.min.js', 'generated'],
    ['types/index.d.ts', 'generated'],
    ['coverage/lcov.info', 'generated'],
    ['exports/report.csv', 'data'],
    ['var/app.sqlite', 'data'],
    ['out.log', 'data'],
    ['photo.png', 'other'],
    ['Makefile.bak', 'other'],
    ['C:\\work\\src\\main.ts', 'source'],
    ['.', 'other'],
    // The order is intended: a doc folder names the role before the source extension does, and a .json file outside a test, generated, or doc folder is config.
    ['src/doc/render.ts', 'doc'],
    ['data/rows.json', 'config'],
  ];
  it.each(cases)('reads %s as %s', (path, expected) => {
    expect(targetClassOf(path, 'repo')).toBe(expected);
    expect(targetClassOf(path, 'cwd')).toBe(expected);
  });

  it('reads a call with no path target as none, whatever the path argument says', () => {
    expect(targetClassOf(undefined, null)).toBe('none');
    expect(targetClassOf('', 'repo')).toBe('none');
    expect(targetClassOf('src/a.ts', null)).toBe('none');
  });

  it('returns only members of the closed list', () => {
    for (const [path] of cases) expect(TARGET_CLASSES).toContain(targetClassOf(path, 'repo'));
  });
});

describe('the classes of a call\'s arguments', () => {
  it('names the classes the input holds as a sorted set, one per class', () => {
    expect(argClassOf({ file_path: '/a/b.ts', offset: 3, limit: 10 })).toEqual(['number', 'path']);
    expect(argClassOf({ pattern: 'foo.*', path: 'src', output_mode: 'content', '-i': true })).toEqual(['flag', 'path', 'pattern', 'text']);
    expect(argClassOf({ command: 'ls -la', timeout: 5000, run_in_background: false })).toEqual(['command', 'flag', 'number']);
    expect(argClassOf({ url: 'https://example.org/x', prompt: 'summarize' })).toEqual(['text', 'url']);
    expect(argClassOf({ target: 'https://example.org/y' })).toEqual(['url']);
    expect(argClassOf({ todos: [{ content: 'x' }] })).toEqual(['text']);
  });

  it('reads a call with no argument value as none', () => {
    expect(argClassOf({})).toEqual(['none']);
    expect(argClassOf({ a: null, b: undefined })).toEqual(['none']);
  });

  it('returns only members of the closed list', () => {
    for (const kind of argClassOf({ file_path: 'a', url: 'b', pattern: 'c', command: 'd', n: 1, f: true, t: 'e' })) expect(ARG_CLASSES).toContain(kind);
  });
});

describe('capture stores the two classes and never the values', () => {
  const redact = makeRedactor();
  const line = (type: string, content: unknown): string =>
    JSON.stringify({ type, timestamp: '2026-06-10T00:00:00.000Z', cwd: '/w', message: { role: type, model: 'model-a', content } });
  const call = (id: string, name: string, input: object): string => line('assistant', [{ type: 'tool_use', id, name, input }]);

  it('puts targetClass and argClass on every call and leaves the path and the values out of them', () => {
    const text = [
      line('user', 'go'),
      call('t1', 'Read', { file_path: 'src/zebra-unicorn.test.ts', offset: 4 }),
      call('t2', 'Bash', { command: 'npm test', description: 'run the tests' }),
      call('t3', 'WebFetch', { url: 'https://example.org/page', prompt: 'read it' }),
      call('t4', 'Write', { file_path: 'package-lock.json', content: 'x' }),
    ].join('\n');
    const { tools } = captureSession({ text, session: 's', project: 'p', rev: 1, at: '', bytes: 0, redact });
    expect(tools.map(({ targetClass, argClass }) => ({ targetClass, argClass }))).toEqual([
      { targetClass: 'test', argClass: ['number', 'path'] },
      { targetClass: 'none', argClass: ['command', 'text'] },
      { targetClass: 'none', argClass: ['text', 'url'] },
      { targetClass: 'lockfile', argClass: ['path', 'text'] },
    ]);
    const stored = JSON.stringify(tools.map(({ targetClass, argClass }) => ({ targetClass, argClass })));
    for (const planted of ['zebra-unicorn', 'npm test', 'example.org', 'run the tests']) expect(stored).not.toContain(planted);
  });

  // Claude Code sends an absolute file_path, so the folders above the repository must not decide the class: only the key the target is hashed on (relative to the repository or the cwd) is read.
  describe('reads the path below the repository or the cwd, never the folders above it', () => {
    const roots = ['/home/me/build/app', '/workspace/out/app', '/srv/test/app', '/home/me/docs/app', '/opt/vendor/app', 'C:\\Users\\me\\dist\\app'];
    const classOfAbsolute = (root: string, file: string, repoRoot: boolean): string | undefined => {
      const cwd = root;
      const text = [
        JSON.stringify({ type: 'user', timestamp: '2026-06-10T00:00:00.000Z', cwd, message: { role: 'user', content: 'go' } }),
        JSON.stringify({ type: 'assistant', timestamp: '2026-06-10T00:00:00.000Z', cwd, message: { role: 'assistant', model: 'model-a', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: `${root}/${file}` } }] } }),
      ].join('\n');
      const input = { text, session: 's', project: 'p', rev: 1, at: '', bytes: 0, redact: makeRedactor() };
      return captureSession(repoRoot ? { ...input, repoRoot: () => root } : input).tools[0]?.targetClass;
    };
    it.each(roots)('a root named %s reads source for a source file, from the repository and from the cwd', (root) => {
      expect(classOfAbsolute(root, 'src/main.ts', true)).toBe('source');
      expect(classOfAbsolute(root, 'src/main.ts', false)).toBe('source');
    });
    it.each(roots)('a root named %s still reads the suffix below it as test, generated, doc, and lockfile', (root) => {
      expect(classOfAbsolute(root, 'tests/a.ts', true)).toBe('test');
      expect(classOfAbsolute(root, 'dist/a.js', false)).toBe('generated');
      expect(classOfAbsolute(root, 'docs/a.html', true)).toBe('doc');
      expect(classOfAbsolute(root, 'package-lock.json', false)).toBe('lockfile');
    });
  });

  it('reads the depth of a relative and of an absolute path to one file the same when the cwd is a folder inside the repository', () => {
    const root = '/home/me/acme';
    const cwd = `${root}/packages/app`;
    const line = (type: string, content: unknown, model?: string) => JSON.stringify({ type, timestamp: '2026-06-10T00:00:00.000Z', cwd, message: { role: type, ...(model === undefined ? {} : { model }), content } });
    const text = [
      line('user', 'go'),
      line('assistant', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/ui/button.ts' } }], 'model-a'),
      line('assistant', [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: `${cwd}/src/ui/button.ts` } }], 'model-a'),
    ].join('\n');
    const tools = captureSession({ text, session: 's', project: 'p', rev: 1, at: '', bytes: 0, redact: makeRedactor(), repoRoot: () => root }).tools;
    const [relative, absolute] = tools.map((call) => call.argFeatures?.[0]);
    expect(relative).toBeDefined();
    // The value's length differs; the path's own features do not.
    expect({ ...relative, valueSize: '' }).toEqual({ ...absolute, valueSize: '' });
    expect(tools[0]?.argFeatures?.[0]).toMatchObject({ pathDepth: '3-4' });
  });
});

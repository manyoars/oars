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
});

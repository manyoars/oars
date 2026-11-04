import { describe, expect, it } from 'vitest';
import { captureSession } from './extract.js';
import { FRAMEWORKS, LANGUAGES, PRIVATE } from './public-vocabulary.js';
import { projectFramework, projectLanguage, projectLanguageShare, projectRepoFiles } from './projection.js';
import { makeRedactor } from './redact.js';
import { LANGUAGE_SHARES, REPO_FILE_BUCKETS, type Strata } from './schema.js';
import { FRAMEWORK_OF_PACKAGE, languageShareBucket, repoFilesBucketOf, strataOf } from './strata.js';

const line = (value: object): string => JSON.stringify(value);

interface Step {
  name: string;
  input: object;
}

/** Two prompts: the first runs `first`, the second `second`, each a call of its own. The repository holds `files` tracked files when it is asked. */
const capture = (first: readonly Step[], second: readonly Step[] = [], files: number | null = null) => {
  let n = 0;
  const calls = (steps: readonly Step[]): string[] =>
    steps.flatMap((step) => {
      n += 1;
      const id = `t${String(n)}`;
      return [
        line({ type: 'assistant', cwd: '/w', timestamp: '2026-05-29T04:30:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: step.name, input: step.input }] } }),
        line({ type: 'user', cwd: '/w', timestamp: '2026-05-29T04:30:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }),
      ];
    });
  const text = [
    line({ type: 'user', cwd: '/w', timestamp: '2026-05-29T04:30:00Z', message: { role: 'user', content: 'one' } }),
    ...calls(first),
    line({ type: 'user', cwd: '/w', timestamp: '2026-05-29T04:31:00Z', message: { role: 'user', content: 'two' } }),
    ...calls(second),
  ].join('\n');
  return captureSession({ text, session: 's', project: 'p', rev: 1, at: 'x', bytes: 1, redact: makeRedactor([]), repoRoot: () => '/w', repoFiles: () => files });
};

const read = (path: string): Step => ({ name: 'Read', input: { file_path: path } });

describe('language and languageShare', () => {
  it('stores each touched language with its share bucket, and an unlisted extension as other', () => {
    const strata = capture([read('/w/a.ts'), read('/w/b.ts'), read('/w/c.ts'), read('/w/d.py'), read('/w/e.zzz')]).session.strata;
    expect(strata?.languages).toEqual([
      { language: 'other', share: '10-50' },
      { language: 'python', share: '10-50' },
      { language: 'typescript', share: 'over-50' },
    ]);
  });

  it('counts a path with no extension for nothing', () => {
    expect(capture([read('/w/Makefile'), read('/w/a.ts')]).session.strata?.languages).toEqual([{ language: 'typescript', share: 'over-50' }]);
    expect(capture([read('/w/Makefile')]).session.strata?.languages).toEqual([]);
  });

  it.each([
    [0, 10, '0'],
    [1, 11, 'under-10'],
    [999, 10000, 'under-10'],
    [1, 10, '10-50'],
    [1000, 10000, '10-50'],
    [49, 100, '10-50'],
    [499, 1000, '10-50'],
    [1, 2, 'over-50'],
    [50, 100, 'over-50'],
    [5001, 10000, 'over-50'],
    [3, 0, '0'],
  ] as const)('%i of %i files is %s', (count, total, expected) => {
    expect(languageShareBucket(count, total)).toBe(expected);
  });

  it('keeps names off the value: a path holding a private name leaves only a language', () => {
    expect(JSON.stringify(capture([read('/w/acme-secret-project/billing.ts')]).session.strata)).not.toContain('acme');
  });
});

describe('repoFiles', () => {
  it.each([
    [0, 'under-100'],
    [99, 'under-100'],
    [100, '100-1k'],
    [999, '100-1k'],
    [1000, '1k-10k'],
    [9999, '1k-10k'],
    [10000, '10k-100k'],
    [99999, '10k-100k'],
    [100000, 'over-100k'],
    [100001, 'over-100k'],
  ] as const)('%i tracked files is %s', (files, expected) => {
    expect(capture([read('/w/a.ts')], [], files).session.strata?.repoFiles).toBe(expected);
  });

  it('is null when the repository has no readable index', () => {
    expect(capture([read('/w/a.ts')], [], null).session.strata?.repoFiles).toBeNull();
    expect(repoFilesBucketOf(null)).toBeNull();
  });
});

describe('framework', () => {
  it('is the framework a resolved package shows, from an install or a manifest', () => {
    const installed = capture([
      { name: 'Bash', input: { command: 'npm install vite@6.0.0 left-pad' } },
      { name: 'Bash', input: { command: 'pip install Django' } },
    ]);
    expect(installed.session.strata?.frameworks).toEqual(['django', 'vite']);
    const manifest = capture([{ name: 'Write', input: { file_path: '/w/package.json', content: '{\n  "dependencies": {\n    "astro": "^5.0.0",\n    "acme-deploy": "1.0.0"\n  }\n}' } }]);
    expect(manifest.session.strata?.frameworks).toEqual(['astro']);
  });

  it('is empty when no resolved package is a framework, and never holds an invented name', () => {
    expect(capture([{ name: 'Bash', input: { command: 'npm install acme-deploy' } }]).session.strata?.frameworks).toEqual([]);
  });

  it('maps only to names the vocabulary lists', () => {
    for (const framework of FRAMEWORK_OF_PACKAGE.values()) expect(FRAMEWORKS.has(framework)).toBe(true);
  });
});

describe('explore', () => {
  it('counts the steps that only look, per prompt and for the file', () => {
    const run = capture(
      [read('/w/a.ts'), { name: 'Grep', input: { pattern: 'x' } }, { name: 'Edit', input: { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' } }],
      [
        { name: 'WebFetch', input: { url: 'https://example.com' } },
        { name: 'WebSearch', input: { query: 'q' } },
        { name: 'Bash', input: { command: 'ls' } },
      ],
    );
    expect(run.prompts.map((prompt) => prompt.strata?.explore)).toEqual([2, 2]);
    expect(run.session.strata?.explore).toBe(4);
  });

  it('gives a prompt the file strata beside its own explore', () => {
    const run = capture([read('/w/a.ts')], [], 5000);
    expect(run.prompts[0]?.strata).toEqual({ languages: [{ language: 'typescript', share: 'over-50' }], repoFiles: '1k-10k', frameworks: [], explore: 1 });
    expect(run.prompts[1]?.strata?.explore).toBe(0);
  });

  it('is zero on a session with no look', () => {
    expect(capture([{ name: 'Bash', input: { command: 'ls' } }]).session.strata?.explore).toBe(0);
  });
});

describe('strataOf', () => {
  it('is a pure function of its evidence', () => {
    const strata: Strata = strataOf({ paths: ['a.go'], packages: ['pypi:django', 'npm:nope'], size: 'xl', explore: 3 });
    expect(strata).toEqual({ languages: [{ language: 'go', share: 'over-50' }], repoFiles: 'over-100k', frameworks: ['django'], explore: 3 });
  });
});

describe('the projections', () => {
  it('keeps a language of the pinned list and sends any other to other', () => {
    for (const language of LANGUAGES) expect(projectLanguage(language)).toBe(language);
    expect(projectLanguage('klingon')).toBe('other');
    expect(projectLanguage('')).toBe('other');
  });

  it('keeps a bucket of its closed list and nothing else', () => {
    for (const bucket of LANGUAGE_SHARES) expect(projectLanguageShare(bucket)).toBe(bucket);
    for (const bucket of REPO_FILE_BUCKETS) expect(projectRepoFiles(bucket)).toBe(bucket);
    expect(projectLanguageShare('37')).toBeNull();
    expect(projectRepoFiles('12345')).toBeNull();
    expect(projectRepoFiles(null)).toBeNull();
  });

  it('keeps a framework the vocabulary lists and sends any other to private', () => {
    for (const framework of FRAMEWORKS) expect(projectFramework(framework)).toBe(framework);
    expect(projectFramework('acme-internal-framework')).toBe(PRIVATE);
  });
});

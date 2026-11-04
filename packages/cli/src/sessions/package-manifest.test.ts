import { describe, expect, it } from 'vitest';
import { captureSession } from './extract.js';
import { manifestFileOf, manifestNames } from './package-resolve.js';
import { makeRedactor } from './redact.js';
import type { ToolManifest } from './schema.js';

const line = (value: object): string => JSON.stringify(value);

/** One prompt, one call of `name` with `input`; `result` is the call's output. */
const manifestOf = (name: string, input: object, result = 'ok'): ToolManifest | undefined => {
  const text = [
    line({ type: 'user', timestamp: '2026-05-29T04:30:00Z', message: { role: 'user', content: 'p' } }),
    line({ type: 'assistant', timestamp: '2026-05-29T04:30:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name, input }] } }),
    line({ type: 'user', timestamp: '2026-05-29T04:30:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: result }] } }),
  ].join('\n');
  return captureSession({ text, session: 's', project: 'p', rev: 1, at: 'x', bytes: 1, redact: makeRedactor([]) }).tools[0]?.manifest;
};

const PACKAGE_JSON = ['{', '  "name": "acme-app",', '  "version": "1.0.0",', '  "scripts": { "build": "tsc" },', '  "dependencies": {', '    "left-pad": "^1.3.0",', '    "@types/node": "24.0.0",', '    "local-lib": "file:../lib"', '  },', '  "engines": {', '    "node": ">=20"', '  }', '}'];
const numbered = (lines: readonly string[]): string => lines.map((text, at) => `${String(at + 1).padStart(6)}→${text}`).join('\n');

describe('packages from manifests', () => {
  it('reads the dependency names of a package.json a session reads, and no other key', () => {
    expect(manifestOf('Read', { file_path: '/w/package.json' }, numbered(PACKAGE_JSON))).toEqual({ file: 'package.json', seen: ['npm:@types/node', 'npm:left-pad'], added: [], removed: [] });
  });

  it('reads the names of a requirements.txt a session writes, skipping options, comments, and URLs', () => {
    const content = ['# pins', 'Requests==2.31.0', 'typing_extensions>=4  # note', '-r other.txt', 'https://example.com/x.tar.gz', 'httpx[http2]~=0.27', ''].join('\n');
    expect(manifestOf('Write', { file_path: '/w/requirements-dev.txt', content })).toEqual({ file: 'requirements.txt', seen: ['pypi:httpx', 'pypi:requests', 'pypi:typing-extensions'], added: [], removed: [] });
  });

  it('reads the dependency tables of a Cargo.toml a session reads, and not the package table', () => {
    const toml = ['[package]', 'name = "acme"', 'version = "0.1.0"', '[dependencies]', 'serde = "1.0"', 'tokio = { version = "1", features = ["full"] }', 'local = { path = "../local" }', '[dev-dependencies]', 'tempfile.workspace = true', '[dependencies.rand]', 'version = "0.8"'];
    expect(manifestOf('Read', { file_path: 'C:/w/Cargo.toml' }, numbered(toml))).toEqual({ file: 'Cargo.toml', seen: ['crates:rand', 'crates:serde', 'crates:tempfile', 'crates:tokio'], added: [], removed: [] });
  });

  it('stores a dependency line an edit removes, and one it adds, by name', () => {
    const old_string = ['    "left-pad": "^1.3.0",', '    "lodash": "4.17.21"'].join('\n');
    const new_string = ['    "lodash": "4.17.21",', '    "zod": "3.0.0"'].join('\n');
    expect(manifestOf('Edit', { file_path: '/w/package.json', old_string, new_string })).toEqual({ file: 'package.json', seen: [], added: ['npm:zod'], removed: ['npm:left-pad'] });
  });

  it('sums the edits of a MultiEdit, and a version bump moves nothing', () => {
    const edits = [
      { old_string: 'serde = "1.0"', new_string: 'serde = "1.1"' },
      { old_string: 'tokio = "1"', new_string: '' },
    ];
    expect(manifestOf('MultiEdit', { file_path: '/w/Cargo.toml', edits })).toEqual({ file: 'Cargo.toml', seen: [], added: [], removed: ['crates:tokio'] });
  });

  it('stores nothing for a manifest read that failed, a file that is not a manifest, or text with no dependency', () => {
    expect(manifestOf('Read', { file_path: '/w/package.json' }, '')).toBeUndefined();
    expect(manifestOf('Read', { file_path: '/w/notes.json' }, numbered(PACKAGE_JSON))).toBeUndefined();
    expect(manifestOf('Edit', { file_path: '/w/package.json', old_string: '"version": "1.0.0"', new_string: '"version": "1.0.1"' })).toBeUndefined();
  });

  it('drops a name redaction would mask', () => {
    expect(manifestNames('requirements.txt', 'AKIAIOSFODNN7EXAMPLE1234')).toEqual(['pypi:akiaiosfodnn7example1234']);
  });

  it('names a manifest by its basename', () => {
    expect(['/a/package.json', 'C:\\w\\Cargo.toml', 'requirements.txt', 'requirements_test.txt', 'pyproject.toml', 'package.json.bak', 'cargo.toml'].map(manifestFileOf)).toEqual(['package.json', 'Cargo.toml', 'requirements.txt', 'requirements.txt', null, null, null]);
  });
});

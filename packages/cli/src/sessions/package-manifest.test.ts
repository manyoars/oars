import { describe, expect, it } from 'vitest';
import { captureSession } from './extract.js';
import { manifestFileOf, manifestNames } from './package-resolve.js';
import { makeRedactor } from './redact.js';
import type { ToolManifest } from './schema.js';

const line = (value: object): string => JSON.stringify(value);

/** One prompt, one call of `name` with `input`; `result` is the call's output. */
const manifestOf = (name: string, input: object, result = 'ok', isError = false): ToolManifest | undefined => {
  const text = [
    line({ type: 'user', timestamp: '2026-05-29T04:30:00Z', message: { role: 'user', content: 'p' } }),
    line({ type: 'assistant', timestamp: '2026-05-29T04:30:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name, input }] } }),
    line({ type: 'user', timestamp: '2026-05-29T04:30:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: result, ...(isError ? { is_error: true } : {}) }] } }),
  ].join('\n');
  return captureSession({ text, session: 's', project: 'p', rev: 1, at: 'x', bytes: 1, redact: makeRedactor([]) }).tools[0]?.manifest;
};

const PACKAGE_JSON = ['{', '  "name": "acme-app",', '  "version": "1.0.0",', '  "scripts": { "build": "tsc" },', '  "dependencies": {', '    "left-pad": "^1.3.0",', '    "@types/node": "24.0.0",', '    "local-lib": "file:../lib"', '  },', '  "engines": {', '    "node": ">=20"', '  }', '}'];
const SECRET_KEY = 'AKIAIOSFODNN7EXAMPLE';
const SECRET_MIXED = 'aB3dE5gH7jK9mN1pQ3sT5vX7zA9c';
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

  it('stores nothing for a secret written as a requirements line', () => {
    expect(manifestOf('Write', { file_path: '/w/requirements.txt', content: 'AKIAIOSFODNN7EXAMPLE' })).toBeUndefined();
  });

  it.each([SECRET_KEY, SECRET_MIXED])('keeps a secret line out of a manifest on every path that reads one: %s', (secret) => {
    const kept = (manifest: ToolManifest | undefined): string => JSON.stringify(manifest ?? null).toLowerCase();
    const results = [
      manifestOf('Read', { file_path: '/w/requirements.txt' }, numbered([secret])),
      manifestOf('Write', { file_path: '/w/requirements.txt', content: `${secret}\nrequests==2.31.0` }),
      manifestOf('Edit', { file_path: '/w/requirements.txt', old_string: 'x', new_string: secret }),
      manifestOf('Edit', { file_path: '/w/requirements.txt', old_string: secret, new_string: 'x' }),
      manifestOf('MultiEdit', { file_path: '/w/requirements.txt', edits: [{ old_string: 'y', new_string: secret }, { old_string: secret, new_string: 'z' }] }),
    ];
    for (const result of results) expect(kept(result)).not.toContain(secret.toLowerCase());
    expect(results.map((result) => result?.seen.length ?? 0)).toEqual([0, 1, 0, 0, 0]);
  });

  it('reads no top-level value of a whole package.json as a dependency', () => {
    const json = ['{', '  "name": "3d-viewer",', '  "description": "3 ways to view things",', '  "main": "1.js",', '  "dependencies": {', '    "left-pad": "1.3.0"', '  }', '}'];
    expect(manifestOf('Read', { file_path: '/w/package.json' }, numbered(json))).toEqual({ file: 'package.json', seen: ['npm:left-pad'], added: [], removed: [] });
  });

  it('reads no bare archive of a requirements file as a name', () => {
    const content = ['acme_internal-1.0-py3-none-any.whl', 'dist.tar.gz', 'a.tgz', 'b.tar.bz2', 'c.zip', 'd.egg', 'requests'].join('\n');
    expect(manifestNames('requirements.txt', content, makeRedactor([]))).toEqual(['pypi:requests']);
  });

  it('does not count the manifest of a dependency as the session manifest', () => {
    const paths = ['/w/node_modules/astro/package.json', 'C:\\w\\vendor\\acme\\requirements.txt', '/w/.venv/lib/site-packages/x/requirements.txt', '/w/lib/site-packages/x/Cargo.toml', '/w/.venv/Cargo.toml'];
    expect(paths.map(manifestFileOf)).toEqual([null, null, null, null, null]);
    expect(manifestOf('Read', { file_path: '/w/node_modules/astro/package.json' }, numbered(PACKAGE_JSON))).toBeUndefined();
    expect(manifestFileOf('/w/my-vendor/package.json')).toBe('package.json');
  });

  it('reads the real crate behind a renamed Cargo entry, and no entry that holds a path or a git source', () => {
    const toml = ['[dependencies]', 'alias = { package = "real-crate", version = "1" }', 'local = { path = "../local", version = "1" }', 'remote = { git = "https://example.com/x.git", version = "1" }', 'serde = { version = "1" }'];
    expect(manifestNames('Cargo.toml', toml.join('\n'), makeRedactor([]))).toEqual(['crates:real-crate', 'crates:serde']);
  });

  it('reads a Cargo dependency written as its own table by the same source rules as the inline form', () => {
    const names = (toml: readonly string[]): string[] => manifestNames('Cargo.toml', toml.join('\n'), makeRedactor([]));
    expect(names(['[dependencies.local]', 'path = "../local"', 'version = "1"'])).toEqual([]);
    expect(names(['[dependencies.remote]', 'git = "https://example.com/x.git"', 'version = "1"'])).toEqual([]);
    expect(names(['[dependencies.alias]', 'package = "real-crate"', 'version = "1"'])).toEqual(['crates:real-crate']);
    expect(names(['[dependencies.rand]', 'version = "0.8"'])).toEqual(['crates:rand']);
    expect(names(['[dependencies.rand]', 'version = "0.8"', '[dependencies.local]', 'path = "../local"'])).toEqual(['crates:rand']);
  });

  it('keeps the dependency state through an array-of-tables header no further than the header', () => {
    const toml = ['[dependencies]', 'serde = "1.0"', '[[bin]]', 'version = "1.0"', 'name = "tool"'];
    expect(manifestNames('Cargo.toml', toml.join('\n'), makeRedactor([]))).toEqual(['crates:serde']);
  });

  it('reads a Cargo entry that ends in a comment', () => {
    expect(manifestNames('Cargo.toml', ['[dependencies]', 'serde = "1.0" # pinned', 'tokio = { version = "1" } # async'].join('\n'), makeRedactor([]))).toEqual(['crates:serde', 'crates:tokio']);
  });

  it('reads no bare archive that carries an environment marker', () => {
    expect(manifestNames('requirements.txt', ['dist.tar.gz ; python_version<"3"', 'a.whl;x', 'requests ; python_version>"3"'].join('\n'), makeRedactor([]))).toEqual(['pypi:requests']);
  });

  it('reads no top-level name, description, or main of a package.json as a dependency', () => {
    const fragment = ['"name": "3d-viewer",', '"description": "3 ways",', '"main": "1.js",'].join('\n');
    expect(manifestOf('Edit', { file_path: '/w/package.json', old_string: '', new_string: fragment })).toBeUndefined();
  });

  it('does not count a manifest under a cargo registry, venv, or bower folder, in any case', () => {
    const paths = ['/h/.cargo/registry/src/x/Cargo.toml', '/w/venv/lib/x/requirements.txt', '/w/bower_components/x/package.json', 'C:\\w\\Vendor\\x\\package.json', '/w/Node_Modules/x/package.json'];
    expect(paths.map(manifestFileOf)).toEqual([null, null, null, null, null]);
  });

  it('stores no manifest for a call that failed', () => {
    const edit = { file_path: '/w/package.json', old_string: '"left-pad": "^1.3.0",', new_string: '"is-odd": "^3.0.1",' };
    expect(manifestOf('Edit', edit)).toEqual({ file: 'package.json', seen: [], added: ['npm:is-odd'], removed: ['npm:left-pad'] });
    expect(manifestOf('Edit', edit, 'String to replace not found in file', true)).toBeUndefined();
  });

  it('reads no config key of a headerless fragment as a dependency', () => {
    expect(manifestOf('Edit', { file_path: '/w/package.json', old_string: '', new_string: '"tag": "next"' })).toBeUndefined();
    expect(manifestOf('Edit', { file_path: '/w/Cargo.toml', old_string: '', new_string: 'opt-level = "3"' })).toBeUndefined();
  });

  it('names a manifest by its basename', () => {
    expect(['/a/package.json', 'C:\\w\\Cargo.toml', 'requirements.txt', 'requirements_test.txt', 'pyproject.toml', 'package.json.bak', 'cargo.toml'].map(manifestFileOf)).toEqual(['package.json', 'Cargo.toml', 'requirements.txt', 'requirements.txt', null, null, null]);
  });
});

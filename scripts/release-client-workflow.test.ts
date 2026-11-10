import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

// t1131: client-v0.1.2's push run (42905213803) died in the pack step for the reason t1110 fixed in release-cli.yml: `npm pack --pack-destination
// release-pack` does not create the directory. Same method as release-cli-workflow.test.ts: the workflow is read as text, and one test parses it.
const workflow = readFileSync(join(import.meta.dirname, '..', '.github', 'workflows', 'release-client.yml'), 'utf8')
  .split(String.fromCharCode(13)).join('');

/** The text of one job: from `  <name>:` to the next two-space key. */
const job = (name: string): string => {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  expect(start, `${name} is a job`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
};

describe('release-client workflow', () => {
  it('creates the pack destination before npm pack writes to it', () => {
    const build = job('build');
    const mkdir = build.indexOf('mkdir -p release-pack');
    const pack = build.indexOf('npm pack -w packages/client --pack-destination release-pack');
    expect(mkdir).toBeGreaterThanOrEqual(0);
    expect(pack).toBeGreaterThan(mkdir);
  });

  it('uploads and downloads the same directory the pack step fills', () => {
    expect(job('build')).toContain('path: release-pack/*.tgz');
    expect(job('publish')).toContain('path: release-pack');
  });

  it('parses as YAML', () => {
    expect(load(workflow)).toMatchObject({ on: { push: { tags: ['client-v*'] } } });
  });
});

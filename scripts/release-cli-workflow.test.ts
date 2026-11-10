import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

// t1110: cli-v0.5.0's push run died in the pack step because `npm pack --pack-destination release-pack` does not create the directory. The workflow
// is read as text and each check is a line it must carry; one test also loads it with js-yaml, because GitHub rejects a file that does not parse.
const workflow = readFileSync(join(import.meta.dirname, '..', '.github', 'workflows', 'release-cli.yml'), 'utf8')
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

describe('release-cli workflow', () => {
  it('creates the pack destination before npm pack writes to it', () => {
    const build = job('build');
    const mkdir = build.indexOf('mkdir -p release-pack');
    const pack = build.indexOf('npm pack -w packages/cli --pack-destination release-pack');
    expect(mkdir).toBeGreaterThanOrEqual(0);
    expect(pack).toBeGreaterThan(mkdir);
  });

  it('uploads and downloads the same directory the pack step fills', () => {
    expect(job('build')).toContain('path: release-pack/*.tgz');
    expect(job('publish')).toContain('path: release-pack');
  });

  it('fails a publish dispatch from a ref other than main instead of skipping every job', () => {
    const refuse = job('refuse-non-main');
    expect(refuse).toContain("if: github.event_name == 'workflow_dispatch' && inputs.publish && github.ref != 'refs/heads/main'");
    expect(refuse).toContain('::error::');
    expect(refuse).toContain('exit 1');
  });

  it('lets a manual run build and publish the tag, only when asked', () => {
    expect(workflow).toContain('TAG: ${{ inputs.tag || github.ref_name }}');
    expect(workflow).toMatch(/\n {6}publish:\n {8}description: [^\n]+\n {8}required: false\n {8}type: boolean\n {8}default: false/);
    const guard = "if: (github.event_name == 'push' || inputs.publish) && (github.event_name == 'push' || github.ref == 'refs/heads/main')";
    expect(job('build')).toContain(guard);
    expect(job('publish')).toContain(guard);
    expect(job('release')).toContain("(github.event_name == 'workflow_dispatch' && !inputs.publish)");
  });

  it('builds the tag\'s code and checks that commit, not the run\'s', () => {
    const build = job('build');
    expect(build).toContain('ref: refs/tags/${{ env.TAG }}');
    expect(build).toContain('git rev-parse HEAD');
    expect(build).not.toContain('GITHUB_SHA');
    expect(workflow).not.toContain('GITHUB_REF_NAME');
  });

  it('parses as YAML', () => {
    expect(load(workflow)).toMatchObject({ on: { workflow_dispatch: { inputs: { publish: { type: 'boolean' } } } } });
  });
});

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

// t1120: the MCP registry refuses the interactive `mcp-publisher login github` for an organization namespace (403: it cannot read organization
// roles), so each CLI release lists itself from GitHub Actions over OIDC, with no stored token. The file is read as text, one check per line it must
// carry; one test also loads it with js-yaml, because GitHub rejects a file that does not parse.
const path = join(import.meta.dirname, '..', '.github', 'workflows', 'release-mcp.yml');
const text = (): string => readFileSync(path, 'utf8').split(String.fromCharCode(13)).join('');

interface PermissionScopes {
  contents?: string;
  'id-token'?: string;
}

interface ParsedWorkflow {
  permissions: PermissionScopes;
  jobs: { publish: { permissions: PermissionScopes } };
}

// A guard, not an assertion: the permission checks below compare exact values, so the shape only has to be an object holding those two keys.
const isParsedWorkflow = (value: unknown): value is ParsedWorkflow =>
  typeof value === 'object' && value !== null && 'permissions' in value && 'jobs' in value && typeof value.jobs === 'object' && value.jobs !== null && 'publish' in value.jobs;

describe('release-mcp workflow', () => {
  it('exists', () => {
    expect(existsSync(path)).toBe(true);
  });

  it('parses as YAML and runs after a successful release-cli run or by dispatch with a tag input', () => {
    expect(load(text())).toMatchObject({
      on: {
        workflow_run: { workflows: ['release-cli'], types: ['completed'] },
        workflow_dispatch: { inputs: { tag: { required: true, type: 'string' } } },
      },
    });
  });

  it('lists only after a successful tag-push run of release-cli, and a dispatch only from main', () => {
    const workflow = text();
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain("github.event.workflow_run.event == 'push'");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
  });

  it('holds id-token: write and contents: read only, and no stored secret', () => {
    const parsed = load(text());
    if (!isParsedWorkflow(parsed)) {
      throw new Error('release-mcp.yml has no permissions or jobs');
    }
    // Exact matches: an added scope (packages: write, actions: write) or a second job must fail.
    expect(parsed.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(parsed.jobs)).toEqual(['publish']);
    expect(parsed.jobs.publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    // Only the one job may mint the token.
    expect(text().match(/^ +id-token: write/gm)).toHaveLength(1);
    expect(text()).not.toContain('secrets.');
  });

  it('checks out the tag, not the run\'s ref', () => {
    const workflow = text();
    expect(workflow).toContain('ref: refs/tags/${{ env.TAG }}');
    expect(workflow).toContain('TAG: ${{ inputs.tag || github.event.workflow_run.head_branch }}');
    expect(workflow).not.toContain('GITHUB_REF_NAME');
  });

  it('checks the tag, main ancestry, and server.json version before it logs in', () => {
    const workflow = text();
    const semver = workflow.indexOf('cli-v<major.minor.patch>');
    const ancestor = workflow.indexOf('git merge-base --is-ancestor');
    const version = workflow.indexOf("require('./server.json').version");
    const login = workflow.indexOf('mcp-publisher login github-oidc');
    expect(semver).toBeGreaterThanOrEqual(0);
    expect(ancestor).toBeGreaterThan(semver);
    expect(version).toBeGreaterThan(ancestor);
    expect(login).toBeGreaterThan(version);
    expect(workflow.indexOf('mcp-publisher publish')).toBeGreaterThan(login);
  });

  it('downloads a pinned mcp-publisher and verifies it against the release checksums', () => {
    const workflow = text();
    expect(workflow).toMatch(/MCP_PUBLISHER_VERSION: \d+\.\d+\.\d+/);
    expect(workflow).not.toContain('releases/latest');
    expect(workflow).toContain('registry_${MCP_PUBLISHER_VERSION}_checksums.txt');
    expect(workflow).toContain('sha256sum --check');
  });
});

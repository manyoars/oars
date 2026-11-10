import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The pool deploys itself from green main (docs/pool.md, "Deploy steps"). This pins what that workflow may and may not do. The repo has no YAML
// parser (and a dependency for one test is not worth it), so the file is read as text: every check below is a line the workflow must carry.
const root = join(import.meta.dirname, '..');
const read = (name: string): string => readFileSync(join(root, '.github', 'workflows', name), 'utf8');
const workflow = read('deploy-pool.yml');
const ci = read('ci.yml');

/** The text from the first line that contains `from` to the first later line that starts at column 0 (the end of that top-level key). */
const block = (text: string, from: string): string => {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(from));
  expect(start, `${from} is a top-level key`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\S/.test(line));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n').trimEnd();
};

/** The steps, each as the text from its `- ` to the next, in file order. */
const steps = (): string[] => {
  const text = block(workflow, 'jobs:');
  const parts = text.split(/\n(?= {6}- )/).slice(1);
  expect(parts.length).toBeGreaterThan(0);
  return parts;
};

const indexOfStep = (needle: string): number => {
  const found = steps().findIndex((step) => step.includes(needle));
  expect(found, `a step containing ${needle}`).toBeGreaterThanOrEqual(0);
  return found;
};

describe('deploy-pool workflow', () => {
  it('runs after a green ci on main, or by hand', () => {
    const on = block(workflow, 'on:');
    expect(on).toMatch(/workflow_run:\n\s+workflows: \[ci\]\n\s+types: \[completed\]\n\s+branches: \[main\]/);
    expect(on).toMatch(/\n {2}workflow_dispatch:/);
    // ci completes on failure and cancel too: only success deploys. A dispatch has no ci run to read.
    // A ci run on a pull request from a fork branch named main also matches `branches: [main]`: only a push to this repository deploys.
    expect(workflow).toContain(
      "if: github.event_name == 'workflow_dispatch' || (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_repository.full_name == github.repository)",
    );
  });

  it('never cancels a running deploy', () => {
    const concurrency = block(workflow, 'concurrency:');
    expect(concurrency).toMatch(/group: deploy-pool\n/);
    expect(concurrency).toMatch(/cancel-in-progress: false/);
  });

  it('holds read-only repository permissions and no OIDC token', () => {
    expect(block(workflow, 'permissions:')).toBe('permissions:\n  contents: read');
    expect(workflow).not.toMatch(/^\s+(permissions|contents|id-token|actions|packages|pull-requests):.*write/m);
    expect(workflow).not.toMatch(/id-token/);
  });

  it('reads its secrets from the pool-production environment, at the steps that need them', () => {
    expect(workflow).toMatch(/\n {4}environment: pool-production\n/);
    const withSecrets = steps().filter((step) => step.includes('secrets.CLOUDFLARE_API_TOKEN'));
    // The gate (to name a missing token), the migrations, and the deploy: never the install, whose scripts would read it.
    expect(withSecrets.map((step) => /name: (.*)/.exec(step)?.[1])).toEqual([
      'Check there is a token and this commit is still main',
      'Apply the unapplied D1 migrations',
      'Deploy the Worker',
    ]);
    expect(workflow.match(/secrets\.CLOUDFLARE_ACCOUNT_ID/g)).toHaveLength(withSecrets.length - 1);
    // Secrets are named here and never echoed.
    expect(workflow).not.toMatch(/echo[^\n]*(\$\{?(TOKEN|CLOUDFLARE_API_TOKEN)\b|\$\{\{ ?secrets\.)/);
    expect(workflow).not.toMatch(/\bset -x\b/);
  });

  it('warns and stops when the token is unset, and when a later main exists', () => {
    const gate = steps()[indexOfStep('id: gate')] ?? '';
    expect(gate).toContain('::warning::');
    expect(gate).toContain('CLOUDFLARE_API_TOKEN');
    expect(gate).toMatch(/echo "go=false" >> "\$GITHUB_OUTPUT"/);
    expect(gate).toMatch(/echo "go=true" >> "\$GITHUB_OUTPUT"/);
    // Out-of-order completions: only the sha at the tip of main deploys, so an older green run never replaces a newer deploy.
    expect(gate).toContain('git ls-remote');
    expect(gate).toContain('refs/heads/main');
    // It is the first step, and every step after it waits on it.
    expect(indexOfStep('id: gate')).toBe(0);
    for (const step of steps().slice(1)) expect(step).toMatch(/if: (always\(\) && )?steps\.gate\.outputs\.go == 'true'/);
  });

  it('checks out the exact commit ci tested', () => {
    expect(workflow).toMatch(/SHA: \$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/);
    const checkout = steps()[indexOfStep('actions/checkout@')] ?? '';
    expect(checkout).toMatch(/ref: \$\{\{ env\.SHA \}\}/);
    expect(checkout).toContain('persist-credentials: false');
  });

  it('installs as ci does', () => {
    for (const line of ['node-version: 24', 'cache: npm', 'run: npm ci']) {
      expect(workflow).toContain(line);
      expect(ci).toContain(line);
    }
  });

  it('applies migrations, then deploys with the sha, then reads the pool', () => {
    const migrations = indexOfStep('wrangler d1 migrations apply oars-pool --remote');
    const deploy = indexOfStep('wrangler deploy');
    const smoke = indexOfStep('https://pool.manyoars.com/v1/covenant');
    expect(migrations).toBeLessThan(deploy);
    expect(deploy).toBeLessThan(smoke);
    expect(indexOfStep('npm ci')).toBeLessThan(migrations);
    const deployStep = steps()[deploy] ?? '';
    // `--` after npm exec: without it npm takes wrangler's flags for its own (the --dry-run incident, docs/pool.md step 7).
    expect(deployStep).toMatch(/npm exec -- wrangler deploy /);
    expect(deployStep).toContain('--message');
    expect(deployStep).toContain('--tag "${SHA:0:12}"');
    expect(deployStep).toContain('--message "deploy $SHA"');
    // The custom domain is attached by every deploy (idempotent), so a plain deploy never drops it.
    expect(deployStep).toContain('--domain pool.manyoars.com');
    expect(steps()[migrations]).toMatch(/npm exec -- wrangler d1 migrations apply oars-pool --remote/);
    for (const step of [migrations, deploy]) expect(steps()[step]).toContain('working-directory: packages/pool');
  });

  it('opens nothing: no deposit flag and no secret write', () => {
    expect(workflow).not.toContain('COVENANT_VERSION');
    expect(workflow).not.toMatch(/wrangler secret/);
    expect(workflow).not.toMatch(/wrangler (rollback|delete)/);
  });

  it('reads the closed pool as docs/pool.md says it answers', () => {
    const smoke = steps()[indexOfStep('https://pool.manyoars.com/v1/covenant')] ?? '';
    // GET /v1/covenant answers with no sign-in: 200 {version: null, accepted: false} while deposits are closed.
    expect(smoke).toContain('--fail');
    expect(smoke).toContain('--retry');
    // The checks themselves, not just the words: a step that checks neither must fail this test.
    expect(smoke).toContain('a.accepted !== false');
    expect(smoke).toContain('!("version" in a)');
  });

  it('writes the sha, the version, the highest migration, and the smoke answer to the job summary', () => {
    const summary = steps()[indexOfStep('GITHUB_STEP_SUMMARY')] ?? '';
    expect(summary).toMatch(/if: always\(\) && steps\.gate\.outputs\.go == 'true'/);
    for (const needle of ['SHA', 'steps.deploy.outputs.version', 'steps.migrations.outputs.highest', 'steps.smoke.outputs.answer']) {
      expect(summary).toContain(needle);
    }
    // The summary is the last step, after the smoke read.
    expect(indexOfStep('GITHUB_STEP_SUMMARY')).toBe(steps().length - 1);
    expect(indexOfStep('GITHUB_STEP_SUMMARY')).toBeGreaterThan(indexOfStep('https://pool.manyoars.com/v1/covenant'));
  });

  it('pins every action to a commit, the same commit ci.yml pins', () => {
    const pins = (text: string): Map<string, string> => {
      const found = new Map<string, string>();
      for (const match of text.matchAll(/uses: ([\w./-]+)@(\S+) # (v[\d.]+)/g)) found.set(match[1] ?? '', [match[2], match[3]].join(' # '));
      return found;
    };
    const mine = pins(workflow);
    const theirs = pins(ci);
    expect(mine.size).toBeGreaterThan(0);
    // Every `uses:` carries a 40-hex pin and a version comment.
    expect(workflow.match(/uses: /g)).toHaveLength(workflow.match(/uses: [\w./-]+@[0-9a-f]{40} # v[\d.]+/g)?.length ?? -1);
    for (const [action, pin] of mine) expect(theirs.get(action), action).toBe(pin);
  });

  it('is bounded in time', () => {
    expect(workflow).toMatch(/timeout-minutes: \d+/);
  });
});

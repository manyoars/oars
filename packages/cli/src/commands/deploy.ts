import { randomUUID } from 'node:crypto';
import { apiClient, unwrap } from '../api.js';
import { CliError, ExitCode, type PartialDeploy } from '../errors.js';
import { stepKey, type JournalRecord } from '../journal.js';
import { resolveAuthToken } from '../session.js';
import { loadDeployInput, type DeployFlags } from './deploy-input.js';
import { listTemplates, STEP as TEMPLATES_STEP } from './templates.js';
import type { Outcome, RunDeps } from '../cli.js';

export interface DeployOptions extends DeployFlags {
  apiUrl: string;
  /** The command line as typed (without the node and script entries), for the rerun line. */
  argv: string[];
  /** False for `--no-start`: register and price, but make no deploy call. */
  start: boolean;
  /** `--idempotency-key`: the base of every step's key. A fresh UUID when absent. */
  idempotencyKey?: string;
}

const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const quote = (token: string): string => (SHELL_SAFE.test(token) ? token : `'${token.replaceAll("'", "'\\''")}'`);

/**
 * The command that resumes a failed deploy: the same arguments plus `--idempotency-key <base>`. Secret values are never
 * printed, so `--secret NAME=value` becomes `--secret-from-env NAME` (the developer exports NAME before the rerun).
 */
export const rerunCommand = (argv: string[], base: string): string => {
  const secretName = (entry: string): string => entry.split('=')[0] ?? '';
  const tokens: string[] = [];
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at] ?? '';
    if (arg === '--idempotency-key') {
      at += 1;
    } else if (arg === '--secret') {
      at += 1;
      tokens.push('--secret-from-env', secretName(argv[at] ?? ''));
    } else if (arg.startsWith('--secret=')) {
      tokens.push('--secret-from-env', secretName(arg.slice('--secret='.length)));
    } else if (!arg.startsWith('--idempotency-key=')) {
      tokens.push(arg);
    }
  }
  return ['oars', ...tokens, '--idempotency-key', base].map(quote).join(' ');
};

/** A failure after register is exit 9 whatever its own code: the workload exists, so the developer's next move is the rerun. */
const partialFailure = (error: unknown, step: string, partial: PartialDeploy): CliError => {
  const cause = error instanceof CliError ? error : new CliError(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`, ExitCode.UNEXPECTED, step);
  return new CliError(cause.message, ExitCode.PARTIAL, step, cause.problem, partial);
};

interface Stage {
  step: string;
  /** Makes the call and returns the HTTP status it answered with. */
  send: () => Promise<number>;
}

/**
 * The web deploy page's order: register, each price, deploy (design §3.1). Each call carries its own idempotency key
 * (`stepKey(base, step)`), so a rerun with the same base replays what finished and carries on. The first failed step stops
 * the sequence (exit 9) with the workload id, the rerun line, and the SDK key when this run minted it.
 */
export const deploy = async (deps: RunDeps, options: DeployOptions): Promise<Outcome> => {
  // Resolved once, and only when a step needs it: a deploy with a mistake in its flags fails before it asks for a login.
  let pending: Promise<string> | undefined;
  const authToken = (): Promise<string> => (pending ??= resolveAuthToken(deps, options.apiUrl));
  const input = await loadDeployInput(options, deps.env, async () => listTemplates(apiClient(deps, { apiUrl: options.apiUrl, step: TEMPLATES_STEP, token: await authToken() })));
  const token = await authToken();
  const base = options.idempotencyKey ?? randomUUID();
  const clientFor = (step: string) => apiClient(deps, { apiUrl: options.apiUrl, step, token });

  const prior = await deps.journal.read(base).catch(() => undefined);
  const progress: JournalRecord = { base, steps: prior?.steps ?? [] };
  if (prior !== undefined) {
    deps.io.stderr(`Resuming deploy ${base}: ${prior.steps.map((entry) => entry.step).join(', ') || 'nothing finished yet'} already done.\n`);
  }
  // The journal only tells the developer where the last run got to; the platform's replay is what makes the rerun correct, so
  // a journal that cannot be written must not lose the one-time SDK key.
  const note = async (step: string, status: number): Promise<void> => {
    progress.steps = [...progress.steps.filter((entry) => entry.step !== step), { step, status }];
    await deps.journal.write(progress).catch((error: unknown) => {
      deps.io.stderr(`Could not record progress in the journal: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  };

  const registerResult = await clientFor('register').POST('/agents/workloads', {
    params: { header: { 'Idempotency-Key': stepKey(base, 'register') } },
    body: input.request,
  });
  const workload = unwrap('register', registerResult);
  await note('register', registerResult.response.status);
  // A replayed registration carries no key: only the run that created the workload can show it.
  const partial: PartialDeploy = { workloadId: workload.id, ...(workload.sdkKey === undefined ? {} : { sdkKey: workload.sdkKey }), rerun: rerunCommand(options.argv, base) };

  const path = { workloadId: workload.id };
  const stages: Stage[] = [
    ...input.prices.map((price): Stage => {
      const step = `price:${price.priceRef}`;
      return {
        step,
        send: async () => {
          const result = await clientFor(step).POST('/billing/agents/{workloadId}/prices', { params: { path }, headers: { 'Idempotency-Key': stepKey(base, step) }, body: price });
          unwrap(step, result);
          return result.response.status;
        },
      };
    }),
    ...(options.start
      ? [
          {
            step: 'deploy',
            send: async () => {
              const result = await clientFor('deploy').POST('/agents/workloads/{workloadId}/deploy', { params: { path }, headers: { 'Idempotency-Key': stepKey(base, 'deploy') } });
              unwrap('deploy', result);
              return result.response.status;
            },
          },
        ]
      : []),
  ];
  for (const stage of stages) {
    let status: number;
    try {
      status = await stage.send();
    } catch (error) {
      throw partialFailure(error, stage.step, partial);
    }
    await note(stage.step, status);
  }
  await deps.journal.delete(base).catch(() => undefined);

  const prices = input.prices.map((price) => price.priceRef);
  const nextSteps = [`oars status ${workload.id}`, `oars test-charge ${workload.id}${prices[0] === undefined ? '' : ` --price ${prices[0]}`}`];
  const lines = [
    `${options.start ? 'Deployed' : 'Registered'} ${workload.name} (workload ${workload.id})`,
    ...(workload.sdkKey === undefined ? [] : [`SDK key (shown once; save it now): ${workload.sdkKey}`]),
    ...(prices.length === 0 ? [] : [`Prices: ${prices.join(', ')}`]),
    'Next:',
    ...nextSteps.map((step) => `  ${step}`),
  ];
  return {
    document: { ok: true, workloadId: workload.id, ...(workload.sdkKey === undefined ? {} : { sdkKey: workload.sdkKey }), prices, started: options.start, nextSteps },
    text: lines.join('\n'),
  };
};

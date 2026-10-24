import { apiClient, unwrap } from '../api.js';
import { resolveAuthToken } from '../session.js';
import type { Outcome, RunDeps } from '../cli.js';

export interface StatusOptions {
  apiUrl: string;
  workloadId: string;
}

const STEP = 'status';

/** The workload (`GET /agents/workloads/{id}`) and its billing mode (`GET /billing/agents/{id}/mode`, TEST until the creator goes live). */
export const status = async (deps: RunDeps, options: StatusOptions): Promise<Outcome> => {
  const client = apiClient(deps, { apiUrl: options.apiUrl, step: STEP, token: await resolveAuthToken(deps, options.apiUrl) });
  const params = { path: { workloadId: options.workloadId } };
  const workload = unwrap(STEP, await client.GET('/agents/workloads/{workloadId}', { params }));
  const { billingMode } = unwrap(STEP, await client.GET('/billing/agents/{workloadId}/mode', { params }));
  const { deployment } = workload;
  const lines = [
    `${workload.name} (${workload.id})`,
    `Workload: ${workload.status}${workload.suspended ? ' (suspended)' : ''}`,
    `Deployment: ${deployment.status} (${deployment.health}), desired ${deployment.desiredState}`,
    `Billing mode: ${billingMode}`,
  ];
  return { document: { ok: true, workload, billingMode }, text: lines.join('\n') };
};

// The self-scheduling recipe in skills/make-me-money/SKILL.md, extracted and run as written against a stub of the platform's
// workload routes. The stub refuses what t679's floor and the scoped key refuse, so the recipe is checked inside the limits the
// client CHANGELOG lists, not wider.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const ID = '3f1c2a9e-5b7d-4e8a-9c01-6d2b7a8e4f10';
const KEY = 'scoped-secret';

const skill = readFileSync(fileURLToPath(new URL('../../../skills/make-me-money/SKILL.md', import.meta.url)), 'utf8');
const recipe = /```js\r?\n([\s\S]*?)```/.exec(skill)?.[1] ?? '';

const view = {
  services: [
    { name: 'job', imageRepository: 'r/job', imageDigest: 'sha256:aa', port: 8080, healthPath: '/h', public: false, replicas: 1, cpuMillicores: 250, memoryMib: 256, env: [{ name: 'A', value: 'b' }], command: [], args: [], scheduleCron: '0 * * * *' },
    { name: 'web', imageRepository: 'r/web', imageDigest: 'sha256:bb', public: true, replicas: 2, cpuMillicores: 500, memoryMib: 512, env: [], command: [], args: [] },
  ],
};

interface Service {
  name?: unknown;
  scheduleCron?: unknown;
}

interface Patch {
  authorization: string | undefined;
  services: Service[];
}

const patches: Patch[] = [];
let server: Server;
let base = '';
let dir = '';
let script = '';

const readBody = async (request: IncomingMessage): Promise<string> => {
  request.setEncoding('utf8');
  let text = '';
  for await (const chunk of request) text += String(chunk);
  return text;
};

const servicesOf = (body: unknown): Service[] => {
  const services: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'services') : undefined;
  return Array.isArray(services) ? services.filter((entry): entry is Service => typeof entry === 'object' && entry !== null) : [];
};

const answer = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const send = (status: number, body: object): void => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  if (request.method === 'GET' && request.url === `/agents/workloads/${ID}`) {
    send(200, view);
  } else if (request.method === 'PATCH' && request.url === `/agents/workloads/${ID}/config`) {
    const services = servicesOf(JSON.parse(await readBody(request)));
    patches.push({ authorization: request.headers.authorization, services });
    const cron = services.find((service) => service.name === 'job')?.scheduleCron;
    // t679's floor: a schedule that fires every minute is under the five-minute minimum.
    if (cron === '* * * * *') send(400, { code: 'MANIFEST_INVALID', detail: 'scheduleCron fires more often than every 5 minutes' });
    else send(200, view);
  } else {
    send(404, { code: 'WORKLOAD_NOT_FOUND' });
  }
};

beforeAll(async () => {
  server = createServer((request, response) => {
    void answer(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`;
  dir = mkdtempSync(join(tmpdir(), 'oars-recipe-'));
  script = join(dir, 'reschedule.mjs');
  writeFileSync(script, recipe);
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const reschedule = async (cron: string): Promise<{ code: unknown; stderr: unknown }> => {
  const env = { ...process.env, OARS_API_URL: base, OARS_WORKLOAD_ID: ID, OARS_API_KEY: KEY };
  try {
    await run(process.execPath, [script, cron], { env });
    return { code: 0, stderr: '' };
  } catch (error) {
    return { code: Reflect.get(Object(error), 'code'), stderr: Reflect.get(Object(error), 'stderr') };
  }
};

describe('the self-scheduling recipe in the skill', () => {
  it('exists as a js block in the skill', () => {
    expect(recipe).toContain('/config');
  });

  it('patches only scheduleCron, with the scoped key, and resends every other field unchanged', async () => {
    patches.length = 0;
    expect(await reschedule('*/15 * * * *')).toEqual({ code: 0, stderr: '' });

    expect(patches).toHaveLength(1);
    expect(patches[0]?.authorization).toBe(`Bearer ${KEY}`);
    const [job, web] = patches[0]?.services ?? [];
    expect(job).toEqual({ name: 'job', imageRepository: 'r/job', port: 8080, healthPath: '/h', public: false, replicas: 1, cpuMillicores: 250, memoryMib: 256, env: [{ name: 'A', value: 'b' }], scheduleCron: '*/15 * * * *' });
    // A service with no schedule gets none: adding one is a 403 for a scoped key.
    expect(web).toEqual({ name: 'web', imageRepository: 'r/web', public: true, replicas: 2, cpuMillicores: 500, memoryMib: 512, env: [] });
  });

  it('reports the platform minimum-interval refusal and exits 1', async () => {
    const result = await reschedule('* * * * *');
    expect(result.code).toBe(1);
    expect(String(result.stderr)).toContain('400 MANIFEST_INVALID');
    expect(String(result.stderr)).toContain('more often than every 5 minutes');
  });
});

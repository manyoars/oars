// `oars pool enroll --hold-only`: the whole configuration a cloud VM needs to hold its deposit in its own private repository, printed as one env block, with no pool credential. The visibility check is injected, so no test
// reaches a network; the real check is tried against a stand-in `fetch`.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../cli.js';
import { harness, server, useServer, type Harness } from '../test-support.js';
import { githubVisibility, poolEnroll, type EnrollOptions, type Visibility } from './machine-enroll.js';
import { termsDigest } from './machine-hold.js';
import { loadTerms } from './exclusion.js';
import { machineOf } from './machine.js';
import { localSalt } from './store.js';
import { cleanup, stage, type Staged } from './test-support.js';

useServer();
afterEach(cleanup);

const OPTIONS: EnrollOptions = { holdOnly: true, hostClass: 'cloud', launcher: 'orchestrated', allowRepos: ['Acme/Widgets', 'acme/gadgets'] };
const PRIVATE: Visibility = () => Promise.resolve('private');

interface Scene {
  staged: Staged;
  h: Harness;
}

const scene = (terms: string | undefined): Scene => {
  const staged = stage();
  const file = join(staged.root, 'terms.txt');
  if (terms !== undefined) writeFileSync(file, terms);
  const h = harness({ OARS_EXCLUSION_TERMS: file });
  h.deps.sessions = staged.runtime;
  return { staged, h };
};

const blockOf = (text: string): { [name: string]: string } => {
  const found: { [name: string]: string } = {};
  const pattern = /^(OARS_[A-Z_]+)=(?:"((?:[^"\\]|\\.)*)"|(\S*))$/gmu;
  for (const match of text.matchAll(pattern)) found[match[1] ?? ''] = (match[2] ?? match[3] ?? '').replace(/\\(.)/gu, '$1');
  return found;
};

const hmac = (key: string, text: string): string => createHmac('sha256', key).update(text).digest('hex');

/** The call is refused with a message that matches, and with the usage exit code. */
const refusal = async (call: Promise<unknown>, message: RegExp): Promise<void> => {
  await expect(call).rejects.toThrow(message);
  await expect(call).rejects.toMatchObject({ exitCode: 2 });
};

describe('oars pool enroll --hold-only', () => {
  it('prints the whole env block: class, launcher, machine id, repositories, both derived salts, and the terms', async () => {
    const { staged, h } = scene('Zorblax\n\nquux corp\nzorblax\n');
    const asked: string[] = [];
    const { document, text } = await poolEnroll(h.deps, OPTIONS, (repo) => {
      asked.push(repo);
      return Promise.resolve('private');
    });
    const block = blockOf(text);
    const local = (await localSalt(staged.storeDir)).salt;
    expect(Object.keys(block).sort()).toEqual(['OARS_ALLOW_REPOS', 'OARS_EXCLUSION_TERMS_INLINE', 'OARS_HOST_CLASS', 'OARS_LAUNCHER', 'OARS_MACHINE', 'OARS_REPO_SALT', 'OARS_SESSION_SALT']);
    expect(block).toMatchObject({
      OARS_HOST_CLASS: 'cloud',
      OARS_LAUNCHER: 'orchestrated',
      OARS_ALLOW_REPOS: 'acme/widgets,acme/gadgets',
      OARS_REPO_SALT: hmac(local, 'repoKey/1'),
      OARS_SESSION_SALT: hmac(local, 'sessionId/1'),
      OARS_EXCLUSION_TERMS_INLINE: 'zorblax\nquux corp',
    });
    expect(block.OARS_MACHINE).toMatch(/^[0-9a-f]{16,}$/u);
    expect(asked).toEqual(['acme/widgets', 'acme/gadgets']);
    expect(document).toMatchObject({ ok: true, holdOnly: true, env: block });
  });

  it('the block is the configuration a machine reads: the same class, id, and list, and the digest of the terms it carries matches the digest of the trusted machine own file', async () => {
    const { staged, h } = scene('quux corp\nZorblax\n  \n');
    const env = blockOf((await poolEnroll(h.deps, OPTIONS, PRIVATE)).text);
    expect(machineOf(env)).toMatchObject({ hostClass: 'cloud', launcher: 'orchestrated', allowRepos: ['acme/widgets', 'acme/gadgets'], machine: env.OARS_MACHINE });
    const carried = join(staged.root, 'carried.txt');
    writeFileSync(carried, `${env.OARS_EXCLUSION_TERMS_INLINE ?? ''}\n`);
    const salt = env.OARS_SESSION_SALT ?? '';
    expect(termsDigest(salt, await loadTerms(carried))).toBe(termsDigest(salt, await loadTerms(join(staged.root, 'terms.txt'))));
  });

  it('mints a fresh machine id each time and keeps the salts the same for one store', async () => {
    const { h } = scene('zorblax\n');
    const first = blockOf((await poolEnroll(h.deps, OPTIONS, PRIVATE)).text);
    const second = blockOf((await poolEnroll(h.deps, OPTIONS, PRIVATE)).text);
    expect(second.OARS_MACHINE).not.toBe(first.OARS_MACHINE);
    expect(second.OARS_REPO_SALT).toBe(first.OARS_REPO_SALT);
    expect(second.OARS_SESSION_SALT).toBe(first.OARS_SESSION_SALT);
    expect(first.OARS_REPO_SALT).not.toBe(first.OARS_SESSION_SALT);
  });

  it('refuses a public repository, and a repository whose visibility the check could not read, and prints no block', async () => {
    const { h } = scene('zorblax\n');
    const sees: Visibility = (repo) => Promise.resolve(repo === 'acme/gadgets' ? 'public' : 'private');
    await refusal(poolEnroll(h.deps, OPTIONS, sees), /acme\/gadgets.*public/u);
    await refusal(poolEnroll(h.deps, OPTIONS, () => Promise.resolve('unknown')), /acme\/widgets.*could not/u);
  });

  it('needs no pool credential and writes nothing to the store beyond its salt', async () => {
    const { staged, h } = scene('zorblax\n');
    await poolEnroll(h.deps, OPTIONS, PRIVATE);
    expect(readdirSync(staged.storeDir)).toEqual(['salt']);
    expect(existsSync(join(staged.storeDir, 'pool-accounts.json'))).toBe(false);
    expect(h.out).toEqual([]);
  });

  it('refuses before anything is checked: an empty or missing term list, no repository, a name that is not owner/name, a class that is not a machine, a full enrollment', async () => {
    const asked: string[] = [];
    const watch: Visibility = (repo) => {
      asked.push(repo);
      return Promise.resolve('private');
    };
    const empty = scene('\n  \n');
    await refusal(poolEnroll(empty.h.deps, OPTIONS, watch), /exclusion terms/u);
    const missing = scene(undefined);
    await refusal(poolEnroll(missing.h.deps, OPTIONS, watch), /exclusion terms/u);
    const { h } = scene('zorblax\n');
    await refusal(poolEnroll(h.deps, { ...OPTIONS, allowRepos: [] }, watch), /--allow-repos/u);
    await refusal(poolEnroll(h.deps, { ...OPTIONS, allowRepos: ['not-a-repo'] }, watch), /owner\/name/u);
    await refusal(poolEnroll(h.deps, { ...OPTIONS, hostClass: 'local' }, watch), /--host-class/u);
    await refusal(poolEnroll(h.deps, { ...OPTIONS, hostClass: undefined }, watch), /--host-class/u);
    await refusal(poolEnroll(h.deps, { ...OPTIONS, launcher: 'by-hand' }, watch), /--launcher/u);
    await refusal(poolEnroll(h.deps, { ...OPTIONS, holdOnly: false }, watch), /--hold-only/u);
    expect(asked).toEqual([]);
  });
});

describe('the command', () => {
  it('runs through the CLI: the repository record is asked for with the token, and the block is printed as JSON', async () => {
    const { h } = scene('zorblax\n');
    h.deps.env.GH_TOKEN = 'a-test-token';
    const seen: (string | null)[] = [];
    server.use(
      http.get('https://api.github.com/repos/acme/widgets', ({ request }) => {
        seen.push(request.headers.get('authorization'));
        return HttpResponse.json({ private: true });
      }),
    );
    const code = await run(['pool', 'enroll', '--hold-only', '--host-class', 'cloud', '--launcher', 'scheduled', '--allow-repos', 'Acme/Widgets', '--json'], h.deps);
    expect(code).toBe(0);
    expect(seen).toEqual(['Bearer a-test-token']);
    expect(JSON.parse(h.out.join(''))).toMatchObject({ ok: true, holdOnly: true, hostClass: 'cloud', launcher: 'scheduled', allowRepos: ['acme/widgets'] });
  });

  it('refuses a public repository with the usage exit code and prints no block', async () => {
    const { h } = scene('zorblax\n');
    server.use(http.get('https://api.github.com/repos/acme/widgets', () => HttpResponse.json({ private: false })));
    const code = await run(['pool', 'enroll', '--hold-only', '--host-class', 'cloud', '--launcher', 'scheduled', '--allow-repos', 'acme/widgets'], h.deps);
    expect(code).toBe(2);
    expect(h.out.join('')).not.toContain('OARS_REPO_SALT');
    expect(h.err.join('')).toContain('acme/widgets is public');
  });
});

describe('githubVisibility', () => {
  const answering = (status: number, body: unknown, seen: { url?: string; authorization?: string | null }): typeof fetch => (input, init) => {
    seen.url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.authorization = new Headers(init?.headers).get('authorization');
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };

  it('reads private from the repository record, sending the token only to api.github.com', async () => {
    const seen: { url?: string; authorization?: string | null } = {};
    expect(await githubVisibility(answering(200, { private: true }, seen), 'a-token')('acme/widgets')).toBe('private');
    expect(seen).toEqual({ url: 'https://api.github.com/repos/acme/widgets', authorization: 'Bearer a-token' });
  });

  it('reads public, and anything it cannot read (a 404, an error, a record with no flag, a thrown fetch) as unknown', async () => {
    const seen: { url?: string; authorization?: string | null } = {};
    expect(await githubVisibility(answering(200, { private: false }, seen), undefined)('acme/widgets')).toBe('public');
    expect(seen.authorization).toBeNull();
    expect(await githubVisibility(answering(404, { message: 'Not Found' }, seen), undefined)('acme/widgets')).toBe('unknown');
    expect(await githubVisibility(answering(500, {}, seen), undefined)('acme/widgets')).toBe('unknown');
    expect(await githubVisibility(answering(200, { name: 'widgets' }, seen), undefined)('acme/widgets')).toBe('unknown');
    expect(await githubVisibility(() => Promise.reject(new Error('offline')), undefined)('acme/widgets')).toBe('unknown');
  });
});

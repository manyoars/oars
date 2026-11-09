// Layer 2 of a call's parameters: the names a call touched (file basenames, the project's directory names, environment variable names, flag values that are names, a custom agent's name), sent as the
// names they are with no floor, and what is dropped from them. Every name here is invented.
import { describe, expect, it } from 'vitest';
import { argNamesOf, type ArgName } from './call-shape.js';
import { captureSession } from './extract.js';
import { printOf, sessionsFrom, store, storedNames } from './pool-fixture.js';
import { bucketOf, skeletonOf, type SessionSkeleton, type WireGate } from './pool-wire.js';
import { CLOSED_ARG_VALUES } from './public-vocabulary.js';
import { makeRedactor } from './redact.js';

const redact = makeRedactor();
const line = (type: string, content: unknown, cwd = '/w'): string => JSON.stringify({ type, timestamp: '2026-06-10T00:00:00.000Z', cwd, message: { role: type, model: 'claude-opus-5-5', content } });
const call = (id: string, name: string, input: object, cwd = '/w'): string => line('assistant', [{ type: 'tool_use', id, name, input }], cwd);

const captured = (...lines: string[]) => captureSession({ text: [line('user', 'go'), ...lines].join('\n'), session: 's1', project: 'p', rev: 1, at: '', bytes: 0, redact });
const skeletonOfLines = (gate: WireGate, ...lines: string[]): SessionSkeleton => {
  const held = captured(...lines);
  const [only] = sessionsFrom(store({ sessions: [held.session], prompts: [], tools: held.tools }));
  const skeleton = only === undefined ? null : skeletonOf(only, '0123456789abcdef', storedNames, printOf, [], gate);
  if (skeleton === null) throw new Error('no skeleton');
  return skeleton;
};
const toolsOf = (skeleton: SessionSkeleton) => skeleton.transcripts[0]?.tools ?? [];
const names = (kind: ArgName['kind'], ...list: string[]): ArgName[] => list.map((name) => ({ kind, name }));

describe('name tokens of a call', () => {
  it('reads the file basename and the directory names below the root of a path value', () => {
    expect(argNamesOf('Read', { file_path: '/w/src/billing/ledger-core.ts', limit: 200 }, '/w', '/w', [], CLOSED_ARG_VALUES)).toEqual([...names('file', 'ledger-core.ts'), ...names('dir', 'billing', 'src')]);
    // A relative path is taken from the cwd, as its depth is.
    expect(argNamesOf('Read', { file_path: 'ui/button.tsx' }, '/w', '/w/packages/app', [], CLOSED_ARG_VALUES)).toEqual([...names('file', 'button.tsx'), ...names('dir', 'app', 'packages', 'ui')]);
    // A folder argument names a directory, never a file.
    expect(argNamesOf('Grep', { pattern: 'x', path: 'src/payments' }, '/w', '/w', [], CLOSED_ARG_VALUES)).toEqual(names('dir', 'payments', 'src'));
  });

  it('sends the basename of a path outside the root and none of the folders above it', () => {
    expect(argNamesOf('Read', { file_path: '/home/someone/notes/plan.md' }, '/w', '/w', [], CLOSED_ARG_VALUES)).toEqual(names('file', 'plan.md'));
    expect(argNamesOf('Read', { file_path: 'C:\\Users\\someone\\notes\\plan.md' }, 'C:\\w', 'C:\\w', [], CLOSED_ARG_VALUES)).toEqual(names('file', 'plan.md'));
    expect(argNamesOf('Read', { file_path: '../../../etc/app.conf' }, '/w', '/w/pkg', [], CLOSED_ARG_VALUES)).toEqual(names('file', 'app.conf'));
  });

  it('reads environment variable names from assignments, references, and an env object, never a value', () => {
    const words = (...texts: string[]) => texts.map((text) => ({ text, quoted: false }));
    const command = { before: words('PGHOST=db.internal', 'PORT=5432'), head: { text: 'pytest', quoted: false }, args: [...words('-k', 'test_checkout'), { text: 'echo $BUILD_ID and ${REGION}x', quoted: true }] };
    expect(argNamesOf('Bash', { command: 'x' }, '/w', '/w', [command], CLOSED_ARG_VALUES)).toEqual([...names('env', 'BUILD_ID', 'PGHOST', 'PORT', 'REGION'), ...names('flag', 'test_checkout')]);
    expect(argNamesOf('mcp__x__run', { env: { API_BASE: 'https://x', LOG_LEVEL: 'debug' } }, '/w', '/w', [], CLOSED_ARG_VALUES)).toEqual(names('env', 'API_BASE', 'LOG_LEVEL'));
  });

  it('reads a flag value that is a name, and not one that is text, a path, a number, or a variable', () => {
    const w = (text: string, quoted = false) => ({ text, quoted });
    const read = (...args: ReturnType<typeof w>[]) => argNamesOf('Bash', { command: 'x' }, '/w', '/w', [{ before: [], head: w('tool'), args }], CLOSED_ARG_VALUES);
    expect(read(w('-k'), w('test_login'), w('--project'), w('billing-web'), w('--region=eu_west'), w('--shard'), w('3'))).toEqual(names('flag', 'billing-web', 'eu_west', 'test_login'));
    expect(read(w('-m'), w('shipping'), w('--out'), w('dist/app.js'), w('--home'), w('$HOME'), w('--name'), w('two words', true))).toEqual(names('env', 'HOME'));
    // A short cluster and a joined value carry no flag name of their own.
    expect(read(w('-am'), w('shipping'), w('-ftest_x'))).toEqual([]);
  });

  it('reads a custom agent name, and not a built-in one', () => {
    expect(argNamesOf('Agent', { subagent_type: 'ledger-auditor', prompt: 'go' }, '/w', '/w', [], CLOSED_ARG_VALUES)).toEqual(names('agent', 'ledger-auditor'));
    expect(argNamesOf('Agent', { subagent_type: 'Explore', prompt: 'go' }, '/w', '/w', [], CLOSED_ARG_VALUES)).toEqual([]);
  });

  it('sends the names of a captured call on the wire, sorted and single, after the one gate', () => {
    const open: WireGate = { redact, terms: [] };
    const skeleton = skeletonOfLines(
      open,
      call('a', 'Read', { file_path: '/w/src/billing/ledger-core.ts' }),
      call('b', 'Read', { file_path: '/w/src/billing/ledger-core.ts' }),
      call('c', 'Bash', { command: 'PGHOST=db pytest -k test_checkout --junitxml report.xml && echo $BUILD_ID' }),
      call('d', 'Agent', { subagent_type: 'ledger-auditor', prompt: 'go', description: 'audit' }),
    );
    const [read, again, bash, agent] = toolsOf(skeleton);
    expect(read?.names).toEqual([...names('file', 'ledger-core.ts'), ...names('dir', 'billing', 'src')]);
    expect(again?.names).toEqual(read?.names);
    expect(bash?.names).toEqual([...names('env', 'BUILD_ID', 'PGHOST'), ...names('flag', 'report.xml', 'test_checkout')]);
    expect(agent?.names).toEqual(names('agent', 'ledger-auditor'));
  });
});

describe('what is dropped from the names', () => {
  const bytesOf = (skeleton: SessionSkeleton): string => JSON.stringify(skeleton);

  it('drops a name that holds an exclusion term, counts it, and keeps a control name of the same call', () => {
    const skeleton = skeletonOfLines({ redact, terms: ['globex'] }, call('a', 'Read', { file_path: '/w/src/globex-billing/plan.md' }));
    const [only] = toolsOf(skeleton);
    expect(only?.names).toEqual([...names('file', 'plan.md'), ...names('dir', 'src')]);
    expect(only?.namesDropped).toBe(bucketOf('count', 1));
    expect(bytesOf(skeleton)).not.toContain('globex');
  });

  it('drops a credential-shaped name, counts it, and keeps a control name of the same call', () => {
    const skeleton = skeletonOfLines({ redact, terms: [] }, call('a', 'Read', { file_path: '/w/src/AKIAABCDEFGHIJKLMNOP/plan.md' }));
    const [only] = toolsOf(skeleton);
    expect(only?.names).toEqual([...names('file', 'plan.md'), ...names('dir', 'src')]);
    expect(only?.namesDropped).toBe(bucketOf('count', 1));
    expect(bytesOf(skeleton)).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });

  it('sends no folder above the session root: the home folder is the operating system account name', () => {
    const skeleton = skeletonOfLines({ redact, terms: [] }, call('a', 'Read', { file_path: '/home/jsmith-acct/notes/plan.md' }), call('b', 'Read', { file_path: 'C:\\Users\\jsmith-acct\\notes\\plan.md' }), call('c', 'Read', { file_path: '/w/src/ledger.ts' }));
    const [outside, windows, inside] = toolsOf(skeleton);
    expect(outside?.names).toEqual(names('file', 'plan.md'));
    expect(windows?.names).toEqual(names('file', 'plan.md'));
    expect(inside?.names).toEqual([...names('file', 'ledger.ts'), ...names('dir', 'src')]);
    expect(bytesOf(skeleton)).not.toContain('jsmith-acct');
    expect(bytesOf(skeleton)).not.toContain('notes');
  });

  it('counts a name the wire shape refuses, and sends neither a count nor a name when nothing was dropped', () => {
    const skeleton = skeletonOfLines({ redact, terms: [] }, call('a', 'Read', { file_path: '/w/src/Q3 plan.md' }), call('b', 'Read', { file_path: '/w/src/plan.md' }));
    const [spaced, plain] = toolsOf(skeleton);
    expect(spaced?.names).toEqual(names('dir', 'src'));
    expect(spaced?.namesDropped).toBe(bucketOf('count', 1));
    expect(plain).not.toHaveProperty('namesDropped');
    expect(bytesOf(skeleton)).not.toContain('Q3 plan');
  });

  it('never reads the value of a credential-named flag as a name, in either spelling of the flag', () => {
    const skeleton = skeletonOfLines(
      { redact, terms: [] },
      call('a', 'Bash', { command: 'deploy --token opaquetokenone --region=eu_west' }),
      call('b', 'Bash', { command: 'deploy --token=opaquetokentwo --password hunterthree --api-key=keyfour --secret=sfive --client-secret sixsix --customer=globex' }),
    );
    const [spaced, joined] = toolsOf(skeleton);
    expect(spaced?.names).toEqual(names('flag', 'eu_west'));
    expect(joined?.names).toEqual(names('flag', 'globex'));
    for (const value of ['opaquetokenone', 'opaquetokentwo', 'hunterthree', 'keyfour', 'sfive', 'sixsix']) expect(bytesOf(skeleton)).not.toContain(value);
  });

  it('reads the next word only of a long flag or of a short flag that takes a name, never of another short flag', () => {
    const skeleton = skeletonOfLines(
      { redact, terms: [] },
      call('a', 'Bash', { command: 'sshpass -p hunter2 ssh box --project control_a' }),
      call('b', 'Bash', { command: 'docker login -u meuser -p hunter2 --project control_b' }),
      call('c', 'Bash', { command: 'echo -n hunter2 | base64 --wrap control_c' }),
      call('d', 'Bash', { command: 'grep -i invoice_total src --project control_d' }),
      call('e', 'Bash', { command: 'pytest -k test_control' }),
    );
    const [ssh, login, echo, grep, pytest] = toolsOf(skeleton);
    expect(ssh?.names).toEqual(names('flag', 'control_a'));
    expect(login?.names).toEqual(names('flag', 'control_b'));
    expect(echo?.names).toEqual(names('flag', 'control_c'));
    expect(grep?.names).toEqual(names('flag', 'control_d'));
    expect(pytest?.names).toEqual(names('flag', 'test_control'));
    for (const value of ['hunter2', 'invoice_total', 'meuser']) expect(bytesOf(skeleton)).not.toContain(value);
  });

  it('reads no flag value after a credential-named flag in the name read itself', () => {
    const w = (text: string) => ({ text, quoted: false });
    const read = (...args: ReturnType<typeof w>[]) => argNamesOf('Bash', { command: 'x' }, '/w', '/w', [{ before: [], head: w('tool'), args }], CLOSED_ARG_VALUES);
    expect(read(w('--token'), w('abc'), w('--api-key'), w('def'), w('--apikey=ghi'), w('--access-token'), w('jkl'), w('--passwd=mno'), w('--private-key'), w('pqr'))).toEqual([]);
    expect(read(w('--customer=globex'), w('--tokenizer'), w('bert'))).toEqual(names('flag', 'bert', 'globex'));
  });
});

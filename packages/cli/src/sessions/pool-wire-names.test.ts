// Layer 2 of a call's parameters: the names a call touched (file basenames, the project's directory names, environment variable names, flag values that are names, a custom agent's name), sent as the
// names they are with no floor, and what is dropped from them. Every name here is invented.
import { describe, expect, it } from 'vitest';
import { argNamesOf, type ArgName, type CommandWord } from './call-shape.js';
import { captureSession } from './extract.js';
import { printOf, sessionsFrom, store, storedNames } from './pool-fixture.js';
import { FIELD_ROWS } from './pool-outbox.js';
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
    // The tokenizer marks a word that is exactly a reference (`$BUILD_ID`, `"${REGION}"`) with the variable's name; a word that merely holds one, such as the quoted sentence here, carries none and reads nothing.
    const reference = (text: string, quoted: boolean, variable: string): CommandWord => ({ text, quoted, variable });
    const command = {
      before: words('PGHOST=db.internal', 'PORT=5432'),
      head: { text: 'pytest', quoted: false },
      args: [...words('-k', 'test_checkout'), reference('$BUILD_ID', false, 'BUILD_ID'), reference('${REGION}', true, 'REGION'), { text: 'echo $SENTENCE_ONLY', quoted: true }],
    };
    expect(argNamesOf('Bash', { command: 'x' }, '/w', '/w', [command], CLOSED_ARG_VALUES)).toEqual([...names('env', 'BUILD_ID', 'PGHOST', 'PORT', 'REGION'), ...names('flag', 'test_checkout')]);
    expect(argNamesOf('mcp__x__run', { env: { API_BASE: 'https://x', LOG_LEVEL: 'debug' } }, '/w', '/w', [], CLOSED_ARG_VALUES)).toEqual(names('env', 'API_BASE', 'LOG_LEVEL'));
  });

  it('reads a flag value that is a name, and not one that is text, a path, a number, or a variable', () => {
    const w = (text: string, quoted = false, variable?: string): CommandWord => (variable === undefined ? { text, quoted } : { text, quoted, variable });
    const read = (...args: CommandWord[]) => argNamesOf('Bash', { command: 'x' }, '/w', '/w', [{ before: [], head: w('tool'), args }], CLOSED_ARG_VALUES);
    expect(read(w('--project'), w('billing-web'), w('--region=eu_west'), w('--shard'), w('3'))).toEqual(names('flag', 'billing-web', 'eu_west'));
    // `-k` names a test selection on pytest, and reads nothing on another program.
    const readOn = (head: string, ...args: CommandWord[]) => argNamesOf('Bash', { command: 'x' }, '/w', '/w', [{ before: [], head: w(head), args }], CLOSED_ARG_VALUES);
    expect(readOn('pytest', w('-k'), w('test_login'))).toEqual(names('flag', 'test_login'));
    expect(readOn('PYTEST.EXE', w('-k'), w('test_login'))).toEqual(names('flag', 'test_login'));
    expect(readOn('tool', w('-k'), w('test_login'))).toEqual([]);
    expect(read(w('-m'), w('shipping'), w('--out'), w('dist/app.js'), w('--home'), w('$HOME', false, 'HOME'), w('--name'), w('two words', true))).toEqual(names('env', 'HOME'));
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

  it('masks a credential-shaped name at capture, so the stored record holds none, and the wire still counts it dropped', () => {
    const planted = call('a', 'Read', { file_path: '/w/src/AKIAABCDEFGHIJKLMNOP/plan.md' });
    const held = captured(planted);
    expect(JSON.stringify(held.tools)).not.toContain('AKIAABCDEFGHIJKLMNOP');
    const skeleton = skeletonOfLines({ redact, terms: [] }, planted);
    expect(toolsOf(skeleton)[0]?.namesDropped).toBe(bucketOf('count', 1));
    expect(bytesOf(skeleton)).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });

  it('sends a folder really named private as a name: the sentinel is not a refusal', () => {
    const skeleton = skeletonOfLines({ redact, terms: [] }, call('a', 'Read', { file_path: '/w/src/private/plan.md' }));
    const [only] = toolsOf(skeleton);
    expect(only?.names).toEqual([...names('file', 'plan.md'), ...names('dir', 'private', 'src')]);
    expect(only).not.toHaveProperty('namesDropped');
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

  it('sends no basename for a path that is exactly a home folder, and none of the folders of a path that starts with a variable', () => {
    const skeleton = skeletonOfLines(
      { redact, terms: [] },
      call('a', 'Read', { file_path: '/home/jsmith-acct' }),
      call('b', 'Read', { file_path: 'C:\\Users\\jsmith-acct' }),
      call('c', 'Read', { file_path: '/Users/jsmith-acct/' }),
      call('d', 'Read', { file_path: 'D:/Users/jsmith-acct' }),
      call('e', 'Read', { file_path: '$HOME/notes/plan.md' }),
      call('f', 'Read', { file_path: '%USERPROFILE%\\notes\\roadmap.md' }),
      call('g', 'Read', { file_path: '/home/jsmith-acct/notes.md' }),
      call('h', 'Read', { file_path: '/mnt/c/Users/jsmith-acct' }),
      call('i', 'Read', { file_path: '/mnt/d/Users/jsmith-acct/' }),
      call('j', 'Read', { file_path: '/c/Users/jsmith-acct' }),
      call('k', 'Read', { file_path: '/var/home/jsmith-acct' }),
      call('l', 'Read', { file_path: '\\\\wsl.localhost\\Ubuntu\\home\\jsmith-acct' }),
      call('m', 'Read', { file_path: '//wsl$/Ubuntu/home/jsmith-acct' }),
      call('n', 'Read', { file_path: '/export/home/jsmith-acct' }),
    );
    const [lower, windows, mac, drive, home, profile, below, wsl, wslSlash, gitBash, immutable, wslShare, wslDollar, exportHome] = toolsOf(skeleton);
    for (const folder of [lower, windows, mac, drive, wsl, wslSlash, gitBash, immutable, wslShare, wslDollar, exportHome]) expect(folder).not.toHaveProperty('names');
    expect(home?.names).toEqual(names('file', 'plan.md'));
    expect(profile?.names).toEqual(names('file', 'roadmap.md'));
    // A file in the home folder is a file: only the folder is the account name.
    expect(below?.names).toEqual(names('file', 'notes.md'));
    for (const value of ['jsmith-acct', '"name":"notes"', 'USERPROFILE', '"name":"$HOME"']) expect(bytesOf(skeleton)).not.toContain(value);
  });

  it('reads a PowerShell environment variable by its name, and not as the word env', () => {
    const skeleton = skeletonOfLines({ redact, terms: [] }, call('a', 'Bash', { command: 'Write-Output $env:API_REGION ${env:BUILD_ID} $Env:LOG_LEVEL $ENV:API_ZONE' }), call('b', 'Bash', { command: 'echo $HOME ${PORT}' }));
    const [shell, posix] = toolsOf(skeleton);
    expect(shell?.names).toEqual(names('env', 'API_REGION', 'API_ZONE', 'BUILD_ID', 'LOG_LEVEL'));
    expect(posix?.names).toEqual(names('env', 'HOME', 'PORT'));
  });

  it('counts a name the wire shape refuses, and sends neither a count nor a name when nothing was dropped', () => {
    const skeleton = skeletonOfLines({ redact, terms: [] }, call('a', 'Read', { file_path: '/w/src/Q3 plan.md' }), call('b', 'Read', { file_path: '/w/src/plan.md' }));
    const [spaced, plain] = toolsOf(skeleton);
    expect(spaced?.names).toEqual(names('dir', 'src'));
    expect(spaced?.namesDropped).toBe(bucketOf('count', 1));
    expect(plain).not.toHaveProperty('namesDropped');
    expect(bytesOf(skeleton)).not.toContain('Q3 plan');
  });

  it('drops a name whose first character is not a letter, a digit, or an underscore, and counts it, as the register says (.github)', () => {
    const skeleton = skeletonOfLines({ redact, terms: [] }, call('a', 'Read', { file_path: '/w/.github/workflows/ci.yml' }));
    const [only] = toolsOf(skeleton);
    expect(only?.names).toEqual([...names('file', 'ci.yml'), ...names('dir', 'workflows')]);
    expect(only?.namesDropped).toBe(bucketOf('count', 1));
    expect(bytesOf(skeleton)).not.toContain('.github');
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

  it('reads the next word of -k only on pytest, where it selects tests, and not on a program where it is a passphrase or a switch', () => {
    const skeleton = skeletonOfLines(
      { redact, terms: [] },
      call('a', 'Bash', { command: 'openssl enc -aes-256-cbc -k hunter5 -in notes.bin --project control_a' }),
      call('b', 'Bash', { command: 'curl -k stagingbox --project control_b' }),
      call('c', 'Bash', { command: 'du -k ledgerdir --project control_c' }),
      call('d', 'Bash', { command: 'pytest -k test_control' }),
      call('e', 'Bash', { command: 'python -m pytest -k test_module_control' }),
      call('f', 'Bash', { command: '/usr/bin/py.test -k test_path_control' }),
    );
    const [openssl, curl, du, pytest, module, path] = toolsOf(skeleton);
    expect(openssl?.names).toEqual(names('flag', 'control_a'));
    expect(curl?.names).toEqual(names('flag', 'control_b'));
    expect(du?.names).toEqual(names('flag', 'control_c'));
    expect(pytest?.names).toEqual(names('flag', 'test_control'));
    expect(module?.names).toEqual(names('flag', 'test_module_control'));
    expect(path?.names).toEqual(names('flag', 'test_path_control'));
    for (const value of ['hunter5', 'stagingbox', 'ledgerdir']) expect(bytesOf(skeleton)).not.toContain(value);
  });

  it('never reads the value of a prefixed credential flag, by its last word, in either separator', () => {
    const skeleton = skeletonOfLines(
      { redact, terms: [] },
      call('a', 'Bash', { command: 'deploy --db-password dbpassvalue --github-token ghtokenvalue --tokenizer bert_control' }),
      call('b', 'Bash', { command: 'deploy --mysql-password mysqlvalue --vault-token vaultvalue --db_passphrase phrasevalue --vendor-api-key vendorvalue --customer cust_control' }),
      call('c', 'Bash', { command: 'deploy --ssh_private_key sshvalue --aws-secret-access-key awsvalue --db-pwd pwdvalue --app_credentials credvalue --region eu_control' }),
    );
    const [first, second, third] = toolsOf(skeleton);
    expect(first?.names).toEqual(names('flag', 'bert_control'));
    expect(second?.names).toEqual(names('flag', 'cust_control'));
    expect(third?.names).toEqual(names('flag', 'eu_control'));
    for (const value of ['dbpassvalue', 'ghtokenvalue', 'mysqlvalue', 'vaultvalue', 'phrasevalue', 'vendorvalue', 'sshvalue', 'awsvalue', 'pwdvalue', 'credvalue']) expect(bytesOf(skeleton)).not.toContain(value);
  });

  it('never reads the value of a flag whose last word is pass, in either separator and either spelling, and still reads --bypass and --compass', () => {
    const skeleton = skeletonOfLines(
      { redact, terms: [] },
      call('a', 'Bash', { command: 'deploy --db-pass dbpassvalue --bypass bypass_control' }),
      call('b', 'Bash', { command: 'deploy --mysql_pass=joinedvalue --compass compass_control' }),
      call('c', 'Bash', { command: 'deploy --pass barevalue --DB-PASS upperpassvalue --region eu_control' }),
    );
    const [spaced, joined, bare] = toolsOf(skeleton);
    expect(spaced?.names).toEqual(names('flag', 'bypass_control'));
    expect(joined?.names).toEqual(names('flag', 'compass_control'));
    expect(bare?.names).toEqual(names('flag', 'eu_control'));
    for (const value of ['dbpassvalue', 'joinedvalue', 'barevalue', 'upperpassvalue']) expect(bytesOf(skeleton)).not.toContain(value);
  });

  it('never reads the value of a camelCase credential flag, and still reads a camelCase flag that is not one', () => {
    const skeleton = skeletonOfLines(
      { redact, terms: [] },
      call('a', 'Bash', { command: 'deploy --clientSecret opaquevalue1 --dbPassword opaquevalue2 --region eu_control' }),
      call('b', 'Bash', { command: 'deploy --githubToken opaquevalue3 --privateKey opaquevalue4 --tokenizerName bert_control' }),
      call('c', 'Bash', { command: 'deploy --secretKey opaquevalue5 --dbPass=opaquevalue6 --ApiKey opaquevalue7 --customerName cust_control' }),
    );
    const [first, second, third] = toolsOf(skeleton);
    expect(first?.names).toEqual(names('flag', 'eu_control'));
    expect(second?.names).toEqual(names('flag', 'bert_control'));
    expect(third?.names).toEqual(names('flag', 'cust_control'));
    for (let number = 1; number <= 7; number += 1) expect(bytesOf(skeleton)).not.toContain(`opaquevalue${String(number)}`);
  });

  it('never reads the value of a credential flag written without a separator or led by an acronym, or one that names a kind of key, and still reads a flag that only looks like one', () => {
    const skeleton = skeletonOfLines(
      { redact, terms: [] },
      call('a', 'Bash', { command: 'deploy --dbpassword opaquevalue1 --githubtoken opaquevalue2 --clientsecret opaquevalue3 --region eu_control' }),
      call('b', 'Bash', { command: 'deploy --mysqlpass opaquevalue4 --DBPassword opaquevalue5 --AWSSecret opaquevalue6 --customer cust_control' }),
      call('c', 'Bash', { command: 'deploy --encryption-key opaquevalue7 --signing-key opaquevalue8 --license-key opaquevalue9 --master-key opaquevalue10 --cookie opaquevalue11 --tokenizer bert_control' }),
      call('d', 'Bash', { command: 'deploy --shared-key opaquevalue12 --session_key opaquevalue13 --tokenizerName bert_camel --bypass bypass_control --sort-key created_control --primary-key id_control --key key_control' }),
    );
    const [first, second, third, fourth] = toolsOf(skeleton);
    expect(first?.names).toEqual(names('flag', 'eu_control'));
    expect(second?.names).toEqual(names('flag', 'cust_control'));
    expect(third?.names).toEqual(names('flag', 'bert_control'));
    expect(fourth?.names).toEqual(names('flag', 'bert_camel', 'bypass_control', 'created_control', 'id_control', 'key_control'));
    for (let number = 1; number <= 13; number += 1) expect(bytesOf(skeleton)).not.toContain(`opaquevalue${String(number)}`);
  });

  it('reads no variable name out of single-quoted text, which no shell expands, and still reads one outside single quotes', () => {
    const skeleton = skeletonOfLines(
      { redact, terms: [] },
      call('a', 'Bash', { command: "mysql --password 'abc$hunter2' --region eu_control" }),
      call('b', 'Bash', { command: "deploy --token 'x$opaquetoken' --customer cust_control" }),
      call('c', 'Bash', { command: "curl -u me:'abc$hunter4' https://example.test" }),
      call('d', 'Bash', { command: "git commit -m 'charge $customer_name twice'" }),
      call('e', 'Bash', { command: "awk '{print $account_id}' notes.txt" }),
      call('f', 'Bash', { command: 'deploy --region "$BUILD_ID"' }),
      call('g', 'Bash', { command: 'bash -c "mysql --password \'abc$hunter6\' --region eu_inner"' }),
      call('h', 'Bash', { command: 'curl --token $API_TOKEN x' }),
    );
    const [mysql, deploy, curl, commit, awk, control, inner, expanded] = toolsOf(skeleton);
    expect(mysql?.names).toEqual(names('flag', 'eu_control'));
    expect(deploy?.names).toEqual(names('flag', 'cust_control'));
    expect(curl?.names ?? []).toEqual([]);
    expect(commit?.names ?? []).toEqual([]);
    expect(awk?.names ?? []).toEqual([]);
    expect(control?.names).toEqual(names('env', 'BUILD_ID'));
    expect(inner?.names).toEqual(names('flag', 'eu_inner'));
    // A reference outside single quotes stays a name, even as the value of a credential flag: it is the variable's name, not its value.
    expect(expanded?.names).toEqual(names('env', 'API_TOKEN'));
    for (const value of ['hunter2', 'opaquetoken', 'hunter4', 'customer_name', 'account_id', 'hunter6']) expect(bytesOf(skeleton)).not.toContain(value);
    expect(bytesOf(skeleton)).toContain('BUILD_ID');
  });

  it('reads no variable name out of a dollar that is not an expansion: an escaped one, a doubled one, an ANSI-C string, and still reads a real one', () => {
    const skeleton = skeletonOfLines(
      { redact, terms: [] },
      call('a', 'Bash', { command: 'mysql --password abc\\$hunter2 --region eu_control' }),
      call('b', 'Bash', { command: 'mysql --password "abc\\$hunter3" --region eu_control' }),
      call('c', 'Bash', { command: 'deploy --token x\\$opaquetoken --customer cust_control' }),
      call('d', 'Bash', { command: 'git commit -m "charge \\$customer_name twice"' }),
      call('e', 'Bash', { command: 'deploy --region "$BUILD_ID"' }),
      call('f', 'Bash', { command: "mysql --password $'it\\'s $hunter7 and more' --region eu_ansi" }),
      call('g', 'Bash', { command: 'Write-Output "abc`$hunter8" --region eu_ps' }),
      call('h', 'Bash', { command: 'echo $$hunter9 --region eu_pid' }),
      call('i', 'Bash', { command: 'git commit -m $\'subject\\n$ansi_value\' --amend' }),
    );
    const [escaped, quoted, token, commit, control, ansi, backtick, doubled, plain] = toolsOf(skeleton);
    expect(escaped?.names).toEqual(names('flag', 'eu_control'));
    expect(quoted?.names).toEqual(names('flag', 'eu_control'));
    expect(token?.names).toEqual(names('flag', 'cust_control'));
    expect(commit?.names ?? []).toEqual([]);
    expect(control?.names).toEqual(names('env', 'BUILD_ID'));
    expect(ansi?.names).toEqual(names('flag', 'eu_ansi'));
    expect(backtick?.names).toEqual(names('flag', 'eu_ps'));
    expect(doubled?.names).toEqual(names('flag', 'eu_pid'));
    expect(plain?.names ?? []).toEqual([]);
    for (const value of ['hunter2', 'hunter3', 'opaquetoken', 'customer_name', 'hunter7', 'hunter8', 'hunter9', 'ansi_value']) expect(bytesOf(skeleton)).not.toContain(value);
    expect(bytesOf(skeleton)).toContain('BUILD_ID');
  });

  it('reads no variable name out of a dollar that sits against a quote: a locale string, and a dollar that opens or closes a double-quoted piece', () => {
    const skeleton = skeletonOfLines(
      { redact, terms: [] },
      call('a', 'Bash', { command: 'mysql --password $"hunter2" --region eu_control' }),
      call('b', 'Bash', { command: 'mysql --password abc$"hunter3" --region eu_control' }),
      call('c', 'Bash', { command: 'mysql --password abc"$"hunter4 --region eu_control' }),
      call('d', 'Bash', { command: 'mysql --password "abc$"hunter5 --region eu_control' }),
      call('e', 'Bash', { command: 'git commit -m $"charge customer_name twice"' }),
      call('f', 'Bash', { command: 'deploy --region "$BUILD_ID"' }),
      call('g', 'Bash', { command: 'deploy --region $BUILD_ID' }),
      call('h', 'Bash', { command: 'deploy --region ${BUILD_ID}' }),
      call('i', 'Bash', { command: 'mysql --password $" $hunter6" --region eu_control' }),
    );
    const [locale, joined, opened, closed, message, quoted, bare, braced, spaced] = toolsOf(skeleton);
    // A locale string is never read, even when its own text starts with a space and names a variable after it.
    for (const tool of [locale, joined, opened, closed, spaced]) expect(tool?.names).toEqual(names('flag', 'eu_control'));
    expect(message?.names ?? []).toEqual([]);
    for (const tool of [quoted, bare, braced]) expect(tool?.names).toEqual(names('env', 'BUILD_ID'));
    for (const value of ['hunter2', 'hunter3', 'hunter4', 'hunter5', 'hunter6', 'customer_name', 'charge']) expect(bytesOf(skeleton)).not.toContain(value);
  });

  it('reads no variable name out of single-quoted text inside a command substitution, in any shell, since a word is a reference only when it is exactly one', () => {
    const skeleton = skeletonOfLines(
      { redact, terms: [] },
      call('a', 'Bash', { command: `echo "$(mysql --password 'abc$hunter2')"` }),
      call('b', 'Bash', { command: `curl -H "X: $(vault read 'k$opaquetoken')" https://example.test` }),
      call('c', 'Bash', { command: 'echo "`mysql --password \'abc$hunter4\'`"' }),
      call('d', 'Bash', { command: `Write-Output "$(Get-Thing 'abc$hunter5')"` }),
      call('e', 'Bash', { command: `git commit -m "$(printf '%s' 'charge $customer_name twice')"` }),
      call('f', 'Bash', { command: 'deploy --region eu_control prefix-$PREFIXED_NAME ${PORT_DEFAULT:-8080} "a $SENTENCE_NAME b"' }),
      call('g', 'Bash', { command: 'deploy --region eu_control FOO_ASSIGNED=$ASSIGNED_VALUE' }),
    );
    const tools = toolsOf(skeleton);
    for (const tool of tools.slice(0, 5)) expect(tool.names ?? []).toEqual([]);
    expect(tools[5]?.names).toEqual(names('flag', 'eu_control'));
    expect(tools[6]?.names).toEqual(names('flag', 'eu_control'));
    for (const value of ['hunter2', 'opaquetoken', 'hunter4', 'hunter5', 'customer_name', 'PREFIXED_NAME', 'PORT_DEFAULT', 'SENTENCE_NAME', 'ASSIGNED_VALUE']) expect(bytesOf(skeleton)).not.toContain(value);
  });

  it('reads the name of every whole-word reference form, and of nothing else', () => {
    const forms = ['$BUILD_ID', '${BUILD_ID}', '"$BUILD_ID"', '"${BUILD_ID}"', '$env:BUILD_ID', '$ENV:BUILD_ID', '${env:BUILD_ID}', '$script:BUILD_ID', '$Global:BUILD_ID', '"${Script:BUILD_ID}"'];
    const skeleton = skeletonOfLines({ redact, terms: [] }, ...forms.map((form, at) => call(`r${String(at)}`, 'Bash', { command: `deploy --region ${form}` })));
    const tools = toolsOf(skeleton);
    expect(tools).toHaveLength(forms.length);
    for (const [at, form] of forms.entries()) expect(tools[at]?.names, form).toEqual(names('env', 'BUILD_ID'));
    // Not the scope word, and not a name taken from a longer word.
    for (const value of ['"name":"env"', '"name":"script"', '"name":"Global"', '"name":"Script"']) expect(bytesOf(skeleton)).not.toContain(value);
  });

  it('reads no name out of a percent-wrapped word: no POSIX shell and no PowerShell expands it, so it is a literal', () => {
    const skeleton = skeletonOfLines(
      { redact, terms: [] },
      call('a', 'Bash', { command: 'mysql --password %hunter2% --region eu_control' }),
      call('b', 'Bash', { command: 'mysql --password "%hunter2%" --region eu_control' }),
      call('c', 'Bash', { command: 'wp search-replace %site_name% acme' }),
      call('d', 'Bash', { command: 'deploy --region eu_control %BUILD_ID% "%BUILD_ID%"' }),
    );
    const tools = toolsOf(skeleton);
    for (const tool of [tools[0], tools[1], tools[3]]) expect(tool?.names).toEqual(names('flag', 'eu_control'));
    expect(tools[2]?.names ?? []).toEqual([]);
    for (const value of ['hunter2', 'site_name', 'BUILD_ID']) expect(bytesOf(skeleton)).not.toContain(value);
  });

  it('reads no name after a scope word that is an ordinary POSIX variable name, and still reads the three PowerShell scopes the form lists', () => {
    const skeleton = skeletonOfLines(
      { redact, terms: [] },
      call('a', 'Bash', { command: 'mysql --password $local:hunter2 --region eu_control' }),
      call('b', 'Bash', { command: 'curl -u $private:hunter3 https://example.test' }),
      call('c', 'Bash', { command: 'docker run -v $local:secret_mount img' }),
      call('d', 'Bash', { command: 'mysql --password ${using:hunter4} --region eu_control' }),
      call('e', 'Bash', { command: 'mysql --password $env:hunter5' }),
      call('f', 'Bash', { command: 'deploy --region $script:SCRIPT_REGION $global:GLOBAL_ZONE ${env:ENV_ZONE}' }),
    );
    const tools = toolsOf(skeleton);
    expect(tools[0]?.names).toEqual(names('flag', 'eu_control'));
    expect(tools[1]?.names ?? []).toEqual([]);
    expect(tools[2]?.names ?? []).toEqual([]);
    expect(tools[3]?.names).toEqual(names('flag', 'eu_control'));
    // `mysql --password $env:hunter5` still sends hunter5 as a variable name: `$env:` is a form the rule lists, and on a POSIX shell its text after the colon is read.
    expect(tools[4]?.names).toEqual(names('env', 'hunter5'));
    expect(tools[5]?.names).toEqual(names('env', 'ENV_ZONE', 'GLOBAL_ZONE', 'SCRIPT_REGION'));
    for (const value of ['hunter2', 'hunter3', 'hunter4', 'secret_mount', '"name":"local"', '"name":"private"', '"name":"using"']) expect(bytesOf(skeleton)).not.toContain(value);
  });

  it('keeps a command substitution inside double quotes in one word, so a quote inside it cannot flip the quote state and bare a single-quoted variable', () => {
    const skeleton = skeletonOfLines(
      { redact, terms: [] },
      call('a', 'Bash', { command: `echo "$(echo "it's" 'a $hunter2 b')"` }),
      call('b', 'Bash', { command: `echo "$(git log --format="it's" && git commit -m 'charge $customer_name twice')"` }),
      call('c', 'Bash', { command: 'echo "`echo "it\'s" \'a $hunter3 b\'`"' }),
      call('d', 'Bash', { command: `echo "$(echo "$(echo "it's")" 'x $hunter4 y')"` }),
      call('e', 'Bash', { command: `echo "\${x:-"it's"}" 'a $hunter5 b'` }),
    );
    for (const tool of toolsOf(skeleton)) expect(tool.names ?? []).toEqual([]);
    for (const value of ['hunter2', 'customer_name', 'hunter3', 'hunter4', 'hunter5']) expect(bytesOf(skeleton)).not.toContain(value);
  });

  it('reads a substitution that never closes as the text it is, and a command that opens thousands of them in bounded work', () => {
    const skeleton = skeletonOfLines(
      { redact, terms: [] },
      call('a', 'Bash', { command: `echo ${'"$('.repeat(50000)} ' $hunter2 '` }),
      call('b', 'Bash', { command: 'echo "`' + '"`'.repeat(50000) + ` ' $hunter3 '` }),
      // PowerShell's backtick escapes the dollar and is no opener: the flag after it is still read.
      call('c', 'Bash', { command: 'Write-Output "abc`$hunter4" --region eu_ps' }),
    );
    const tools = toolsOf(skeleton);
    expect(tools[2]?.names).toEqual(names('flag', 'eu_ps'));
    for (const value of ['hunter2', 'hunter3', 'hunter4']) expect(bytesOf(skeleton)).not.toContain(value);
  });

  it('reads a backslash pair as a pair, so the second backslash does not escape the quote after it', () => {
    const skeleton = skeletonOfLines(
      { redact, terms: [] },
      call('a', 'Bash', { command: String.raw`grep "C:\\" f && echo "it's" && git commit -m 'charge $customer_name twice'` }),
      call('b', 'Bash', { command: String.raw`echo "C:\\" "it's" ' $hunter2 '` }),
      call('c', 'Bash', { command: String.raw`echo a\\'b $hunter3 c'` }),
      call('d', 'Bash', { command: String.raw`echo "C:\\" "$BUILD_ID"` }),
    );
    const tools = toolsOf(skeleton);
    for (const tool of tools.slice(0, 3)) expect(tool.names ?? []).toEqual([]);
    for (const value of ['customer_name', 'hunter2', 'hunter3']) expect(bytesOf(skeleton)).not.toContain(value);
    // The control: the double-quoted reference after a pair is a real one.
    expect(tools[3]?.names).toEqual(names('env', 'BUILD_ID'));
  });

  it('reads no flag value after a credential-named flag in the name read itself', () => {
    const w = (text: string) => ({ text, quoted: false });
    const read = (...args: ReturnType<typeof w>[]) => argNamesOf('Bash', { command: 'x' }, '/w', '/w', [{ before: [], head: w('tool'), args }], CLOSED_ARG_VALUES);
    expect(read(w('--token'), w('abc'), w('--api-key'), w('def'), w('--apikey=ghi'), w('--access-token'), w('jkl'), w('--passwd=mno'), w('--private-key'), w('pqr'))).toEqual([]);
    expect(read(w('--customer=globex'), w('--tokenizer'), w('bert'))).toEqual(names('flag', 'bert', 'globex'));
  });

  it('says in the register row of name that a name token that fails is dropped and counted, never sent as private', () => {
    expect(FIELD_ROWS.name).toContain('a name token that fails is dropped and counted, never sent as `private`');
  });
});

// The rule for a variable reference: a word names a variable only when its raw source, quotes included, is exactly one reference (`$NAME`, `${NAME}`, or either in double quotes), so no quote, substitution, or longer word can join a
// fragment of text into a name. Every word below is built from two pieces (and a piece between them) of each kind, with the reference cut at every position, then set inside each wrapper that holds a command, so a form that reads a
// name it should not is a failing row here, not a new case to list.
describe('a variable reference inside a word', () => {
  interface PieceKind {
    kind: string;
    wrap: (text: string) => string;
  }
  const PIECE_KINDS: readonly PieceKind[] = [
    { kind: 'unquoted', wrap: (text) => text },
    { kind: 'single-quoted', wrap: (text) => `'${text}'` },
    { kind: 'double-quoted', wrap: (text) => `"${text}"` },
    { kind: 'ANSI-C', wrap: (text) => `$'${text}'` },
    { kind: 'locale', wrap: (text) => `$"${text}"` },
  ];
  const MIDDLES: readonly string[] = ['', '""', "''", '$""'];
  // A padded variant puts text on both sides of the reference, so a `$` sits at the start, the middle, and the end of a piece.
  const PADS: readonly (readonly [string, string])[] = [
    ['', ''],
    ['ab', '-z'],
  ];
  // Where the word sits. In a command substitution the word is an argument of its own command, so a whole reference there is a real one; inside double quotes, or glued to a backtick, it is part of a longer word.
  const WRAPPERS: readonly { kind: string; wrap: (word: string) => string; whole: boolean }[] = [
    { kind: 'no wrapper', wrap: (word) => word, whole: true },
    { kind: 'a command substitution', wrap: (word) => `$(cmd ${word})`, whole: true },
    { kind: 'backticks', wrap: (word) => `\`cmd ${word}\``, whole: false },
    { kind: 'a command substitution in double quotes', wrap: (word) => `"$(cmd ${word})"`, whole: false },
    { kind: 'backticks in double quotes', wrap: (word) => `"\`cmd ${word}\`"`, whole: false },
  ];
  const SECRET = 'hunter2';
  const ACCEPTED = new Set([`$${SECRET}`, `\${${SECRET}}`, `"$${SECRET}"`, `"\${${SECRET}}"`]);

  for (const wrapper of WRAPPERS) {
    for (const first of PIECE_KINDS) {
      for (const second of PIECE_KINDS) {
        it(`reads a variable only from a word that is exactly a reference, for ${first.kind} then ${second.kind} in ${wrapper.kind}`, () => {
          const words = new Set<string>();
          for (const template of [`$${SECRET}`, `\${${SECRET}}`]) {
            for (let split = 0; split <= template.length; split += 1) {
              for (const [pre, post] of PADS) for (const middle of MIDDLES) words.add(first.wrap(pre + template.slice(0, split)) + middle + second.wrap(template.slice(split) + post));
            }
          }
          const list = [...words];
          const skeleton = skeletonOfLines({ redact, terms: [] }, ...list.map((word, at) => call(`c${String(at)}`, 'Bash', { command: `mysql --region eu_control --password ${wrapper.wrap(word)}` })));
          const tools = toolsOf(skeleton);
          expect(tools).toHaveLength(list.length);
          list.forEach((word, at) => {
            const reads = wrapper.whole && ACCEPTED.has(word);
            expect(tools[at]?.names, word).toEqual(reads ? [...names('env', SECRET), ...names('flag', 'eu_control')] : names('flag', 'eu_control'));
            if (!reads) for (const part of [SECRET, 'hunt', 'er2']) expect(JSON.stringify(tools[at]), word).not.toContain(part);
          });
        });
      }
    }
  }
});

// The quote state of a command is what decides whether text is a bare word: single-quoted text that the reader takes for bare words turns `$hunter2` into a name. Every piece below can move that state when it is read wrongly, so each is
// set before a single-quoted planted reference, glued to it and apart from it, and a control reference after it must still be read.
describe('a piece that can move the quote state, before a single-quoted reference', () => {
  // `controlled: false` marks a piece after which the words of the command are not read at all: a group that closes (`$(...)` unquoted) ends the command, and the words after it start one whose head is the quoted target, which names no program.
  const MOVERS: readonly { kind: string; piece: string; controlled?: boolean }[] = [
    { kind: 'an apostrophe inside double quotes', piece: `"it's"` },
    { kind: 'an escaped double quote then an apostrophe inside double quotes', piece: String.raw`"say \"it's\""` },
    { kind: 'a backslash pair inside double quotes', piece: String.raw`"C:\\"` },
    { kind: 'a backslash pair outside quotes', piece: String.raw`C:\\` },
    { kind: 'a backslash pair before a quote', piece: String.raw`a\\'b'` },
    { kind: 'a backslash pair before a double-quoted piece', piece: String.raw`a\\"b"` },
    { kind: 'an escaped apostrophe outside quotes', piece: String.raw`it\'s` },
    { kind: 'an escaped double quote outside quotes', piece: String.raw`say\"hi` },
    { kind: 'an ANSI-C string holding an escaped apostrophe', piece: String.raw`$'it\'s'` },
    { kind: 'a command substitution holding quotes', piece: `$(echo "it's")`, controlled: false },
    { kind: 'a command substitution in double quotes holding quotes', piece: `"$(echo "it's")"` },
    { kind: 'a command substitution in double quotes holding a double quote inside single quotes', piece: `"$(echo 'a"b')"` },
    { kind: 'two nested command substitutions in double quotes', piece: `"$(echo "$(echo "it's")")"` },
    { kind: 'a backtick substitution holding quotes', piece: '`echo "it\'s"`' },
    { kind: 'a backtick substitution in double quotes holding quotes', piece: '"`echo "it\'s"`"' },
    { kind: 'a command substitution in double quotes holding a backslash pair', piece: String.raw`"$(echo "C:\\")"` },
    { kind: 'a parameter expansion in double quotes holding a double-quoted apostrophe', piece: `"\${x:-"it's"}"` },
    { kind: 'a parameter expansion in double quotes holding a substitution that holds quotes', piece: `"\${x:-"$(echo "it's")"}"` },
    { kind: 'an escaped dollar before a parenthesis in double quotes', piece: String.raw`"\$(it"` },
  ];
  const TARGETS: readonly string[] = [`' $hunter2 '`, `'$hunter2'`, `'a $hunter2 b'`];
  const SEPARATORS: readonly string[] = [' ', ''];

  for (const mover of MOVERS) {
    it(`reads no name out of a single-quoted reference after ${mover.kind}, and still reads a double-quoted reference after it`, () => {
      const commands = TARGETS.flatMap((target) => SEPARATORS.map((separator) => `mysql --region eu_control ${mover.piece}${separator}${target} "$BUILD_ID"`));
      const skeleton = skeletonOfLines({ redact, terms: [] }, ...commands.map((command, at) => call(`m${String(at)}`, 'Bash', { command })));
      const tools = toolsOf(skeleton);
      expect(tools).toHaveLength(commands.length);
      const expected = mover.controlled === false ? names('flag', 'eu_control') : [...names('env', 'BUILD_ID'), ...names('flag', 'eu_control')];
      for (const [at, command] of commands.entries()) expect(tools[at]?.names, command).toEqual(expected);
      expect(JSON.stringify(skeleton)).not.toContain('hunter2');
    });
  }
});

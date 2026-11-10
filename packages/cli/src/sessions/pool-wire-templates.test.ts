// Templates on the wire: each shell command as its program, subcommand, and flags, with every literal argument turned into a typed slot, and each edit as a shape from a closed list. Every literal below is invented.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { defaultConfigDir } from '../credentials.js';
import { DIFF_SHAPES, TEMPLATE_SLOTS, templatesOf, type CommandWord, type CommandWords } from './call-shape.js';
import { captureSession } from './extract.js';
import { printOf, sessionsFrom, store, storedNames } from './pool-fixture.js';
import { FIELD_ROWS } from './pool-outbox.js';
import { bucketOf, skeletonOf, type SessionSkeleton, type WireGate } from './pool-wire.js';
import { makeRedactor } from './redact.js';
import type { Harness } from './schema.js';

// Store safety: no test here reads or writes the operator's store, and the settings folder is a temp one, confirmed before anything runs.
beforeAll(() => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-templates-'));
  process.env.APPDATA = folder;
  process.env.XDG_CONFIG_HOME = folder;
  expect(defaultConfigDir(process.env, process.platform, '/nowhere')).toBe(folder);
});

const redact = makeRedactor();
const OPEN: WireGate = { redact, terms: [] };
const line = (type: string, content: unknown, cwd = '/w'): string => JSON.stringify({ type, timestamp: '2026-06-10T00:00:00.000Z', cwd, message: { role: type, model: 'claude-opus-5-5', content } });
const call = (id: string, name: string, input: object, cwd = '/w'): string => line('assistant', [{ type: 'tool_use', id, name, input }], cwd);
const capturedUnder = (harness: Harness, ...lines: string[]) => captureSession({ text: [line('user', 'go'), ...lines].join('\n'), session: 's1', project: 'p', rev: 1, at: '', bytes: 0, redact, harness });
const skeletonUnder = (harness: Harness, gate: WireGate, ...lines: string[]): SessionSkeleton => {
  const held = capturedUnder(harness, ...lines);
  const [only] = sessionsFrom(store({ sessions: [held.session], prompts: [], tools: held.tools }));
  const skeleton = only === undefined ? null : skeletonOf(only, '0123456789abcdef', storedNames, printOf, [], gate);
  if (skeleton === null) throw new Error('no skeleton');
  return skeleton;
};
const skeletonOfLines = (gate: WireGate, ...lines: string[]): SessionSkeleton => skeletonUnder('claude-code', gate, ...lines);
const toolsOf = (skeleton: SessionSkeleton) => skeleton.transcripts[0]?.tools ?? [];
const bash = (command: string, id = 'c1'): string => call(id, 'Bash', { command });
/** The templates a command goes as, through capture and the wire. */
const sent = (command: string, gate: WireGate = OPEN): string[] => toolsOf(skeletonOfLines(gate, bash(command)))[0]?.templates ?? [];

describe('the slots', () => {
  it('are a closed list', () => {
    expect(TEMPLATE_SLOTS).toEqual(['<text>', '<path>', '<ident>', '<num>', '<url>', '<var>', '<flag>']);
  });
  it('are described in the field list', () => {
    expect(FIELD_ROWS.templates).toContain('<path>');
    expect(FIELD_ROWS.templatesDropped).toContain('not sent');
  });
});

describe('a shell command as a template', () => {
  // Each literal is a distinctive string, written where the names layer sends none (a positional, a quoted text, a short flag's word, a URL), so the whole wire is searched for it.
  const FIXTURE: readonly { command: string; template: string; literals: string[] }[] = [
    { command: 'git commit -m "charge zq_customer_one twice"', template: 'git commit -m <text>', literals: ['zq_customer_one', 'charge'] },
    { command: 'pytest tests/test_zq_billing.py', template: 'pytest <path>', literals: ['zq_billing'] },
    { command: 'curl -s https://zq-host.example/v1/zq_orders', template: 'curl -s <text>', literals: ['zq-host', 'zq_orders'] },
    { command: 'grep -rn zq_symbol_name src', template: 'grep <flag> <ident> <ident>', literals: ['zq_symbol_name'] },
    { command: 'echo zq_plain_word 42', template: 'echo <ident> <num>', literals: ['zq_plain_word'] },
    { command: 'git log -n 5 zq_branch_name', template: 'git log -n <text> <ident>', literals: ['zq_branch_name'] },
    { command: 'cat zq_notes.md ./zq/dir/file.txt', template: 'cat <path> <path>', literals: ['zq_notes', 'file.txt'] },
    { command: 'npm run zq-build-target', template: 'npm run <ident>', literals: ['zq-build-target'] },
  ];
  for (const { command, template, literals } of FIXTURE) {
    it(`turns ${command} into ${template}, and none of its literals reaches the wire`, () => {
      const skeleton = skeletonOfLines(OPEN, bash(command));
      expect(toolsOf(skeleton)[0]?.templates).toEqual([template]);
      for (const literal of literals) expect(JSON.stringify(skeleton), literal).not.toContain(literal);
    });
  }

  it('keeps a public flag name and turns its value into a slot, joined or apart', () => {
    expect(sent('deploy-tool --limit 5 --name zq_name_value --output=zq_out_value --force')).toEqual(['deploy-tool --limit <num> --name <ident> --output=<ident> --force']);
    // A one-letter flag is kept as the step identity keeps it.
    expect(sent('deploy-tool -n 5')).toEqual(['deploy-tool -n <text>']);
  });

  it('types no word after a one-letter flag, since the names reader refuses to read it: it is text, except pytest -k', () => {
    // `-p` is a password on sshpass and `-n` a count on head; the template cannot tell, so no type of the word after either is sent.
    const skeleton = skeletonOfLines(OPEN, bash('sshpass -p zq_hunter_two ssh zq_host'));
    expect(toolsOf(skeleton)[0]?.templates).toEqual(['sshpass -p <text> <ident> <ident>']);
    expect(JSON.stringify(skeleton)).not.toContain('zq_hunter_two');
    expect(sent('sshpass -p 12345 ssh zq_host')).toEqual(['sshpass -p <text> <ident> <ident>']);
    expect(sent('deploy-tool -n zq_one_letter')).toEqual(['deploy-tool -n <text>']);
    expect(sent('curl -k https://zq.example/x')).toEqual(['curl -k <text>']);
    expect(sent('tail -n 3 zq_log')).toEqual(['tail -n <text> <ident>']);
    // The one closed list the names reader keeps: `-k` on pytest, however pytest is run. A number flag (`head -20`) and a cluster stay as they were.
    expect(sent('pytest -k zq_login tests')).toEqual(['pytest -k <ident> <ident>']);
    expect(sent('python -m pytest -k zq_login')).toEqual(['python -m <text> -k <ident>']);
    expect(sent('head -20 zq_log')).toEqual(['head <num> <ident>']);
    expect(sent('openssl enc -k zq_pass_two')).toEqual(['openssl <ident> -k <text>']);
  });

  it('spells no flag a program or a person made up: it is a flag slot, and its value is a slot', () => {
    // The step identity reads such a flag as `<literal>`; a template does the same, so a private script's flag name crosses nowhere.
    const skeleton = skeletonOfLines(OPEN, bash('node run.js --zq-private-flag zq_value_word --zq-joined=zq_joined_word'));
    expect(toolsOf(skeleton)[0]?.templates).toEqual(['node <path> <flag> <ident> <flag>']);
    for (const literal of ['zq-private-flag', 'zq-joined', 'zq_joined_word']) expect(JSON.stringify(toolsOf(skeleton)[0]?.templates), literal).not.toContain(literal);
  });

  it('turns a program given as a path into a path slot, and keeps a subcommand the program\'s own table lists', () => {
    expect(sent('/usr/local/bin/zq-tool run')).toEqual(['<path> <ident>']);
    expect(sent('./gradlew test --info')).toEqual(['<path> test --info']);
    expect(sent('C:\\tools\\zq.exe --version')).toEqual(['<path> --version']);
    expect(sent('git status')).toEqual(['git status']);
  });

  it('types a variable reference, a number, a URL, a path, an identifier, and any other text', () => {
    expect(sent('tool "$ZQ_ID" 42 -7 3.5 https://zq.example/x git://zq.example/o/r ~/zq ../zq ./zq a.py zq_ident "two words" "x=y"')).toEqual([
      'tool <var> <num> <num> <num> <url> <url> <path> <path> <path> <path> <ident> <text> <text>',
    ]);
  });

  it('turns a flag-like word it will not spell into a flag slot: an attached value, a cluster off the public list', () => {
    expect(sent('mysql -pzq_secret_word -Uzq_user')).toEqual(['mysql <flag> <flag>']);
    expect(sent('tool -qz')).toEqual(['tool <flag>']);
    expect(sent('git commit -am zq_msg')).toEqual(['git commit <flag> <ident>']);
  });

  it('is one template per command of a call, in order, and none for a command with no program', () => {
    expect(sent('cd zq_dir && git status | tail -n 3; echo "$ZQ_ID"')).toEqual(['cd <ident>', 'git status', 'tail -n <text>', 'echo <var>']);
    expect(sent('')).toEqual([]);
  });

  it('never makes a word after the command\'s opaque point a kept word, and sends a flag-shaped word alone', () => {
    // After the first single quote the reader may be inside literal text, so a word there is a slot, and a public flag name stays but never its value.
    expect(sent("echo 'a b' zq_after_quote --force zq_flag_value --limit=5")).toEqual(['echo <text> <text> --force <text> --limit=<text>']);
    expect(JSON.stringify(sent("echo 'a b' zq_after_quote --force zq_flag_value"))).not.toContain('zq_flag_value');
    // A subcommand the program lists is no kept word there either.
    expect(sent("echo 'a b' && git 'x' status")).toEqual(['echo <text>', '<text> <text> <text>']);
  });

  it('reads no template out of a call that is not a shell command', () => {
    const tool = toolsOf(skeletonOfLines(OPEN, call('r1', 'Read', { file_path: '/w/src/zq.ts' })))[0];
    expect(tool?.templates).toBeUndefined();
    expect(tool?.templatesDropped).toBeUndefined();
  });
});

describe('a template the gate refuses', () => {
  const words = (...texts: string[]): CommandWord[] => texts.map((text) => ({ text, quoted: false }));
  const command = (head: string, ...args: string[]): CommandWords => ({ before: [], head: { text: head, quoted: false }, args: words(...args) });

  it('is dropped whole and counted when its program or a flag holds an exclusion term, and the call\'s other templates stay', () => {
    const gate: WireGate = { redact, terms: ['zqcorp', 'verbose'] };
    const tool = toolsOf(skeletonOfLines(gate, bash('git status && zqcorp-deploy build && git log --verbose && ls -l')))[0];
    expect(tool?.templates).toEqual(['git status', 'ls -l']);
    expect(tool?.templatesDropped).toBe(bucketOf('count', 2));
    expect(JSON.stringify(tool)).not.toContain('zqcorp');
  });

  it('is dropped whole and counted when the redactor changes a kept word', () => {
    const key = 'AKIAIOSFODNN7EXAMPLE';
    expect(redact(key)).not.toBe(key);
    const tool = toolsOf(skeletonOfLines(OPEN, bash(`${key} run && git status`)))[0];
    expect(tool?.templates).toEqual(['git status']);
    expect(tool?.templatesDropped).toBe(bucketOf('count', 1));
    expect(JSON.stringify(tool)).not.toContain(key);
  });

  it('is dropped whole when a kept word is not a name, and a command that is all slots always stays', () => {
    const tool = toolsOf(skeletonOfLines(OPEN, bash('foo@bar run && ./x --y')))[0];
    expect(tool?.templates).toEqual(['<path> <flag>']);
    expect(tool?.templatesDropped).toBe(bucketOf('count', 1));
  });

  it('keeps no template and no count when a call sends none', () => {
    const tool = toolsOf(skeletonOfLines(OPEN, bash('git status')))[0];
    expect(tool?.templatesDropped).toBeUndefined();
  });

  it('reads a word that is already a slot or a flag as it is, for a hand-built command', () => {
    expect(templatesOf([command('git', 'status')], (text) => text)).toEqual(['git status']);
  });
});

describe('the value of a credential flag', () => {
  // A credential-named flag never yields its value: apart or joined, in any spelling the reader knows, the word after it is a text slot (or goes with a flag the template does not spell) and is on the wire nowhere, names included.
  const CREDENTIALS: readonly { command: string; template: string; value: string }[] = [
    { command: 'deploy-tool --token zq_token_apart', template: 'deploy-tool --token <text>', value: 'zq_token_apart' },
    { command: 'deploy-tool --token=zq_token_joined', template: 'deploy-tool --token=<text>', value: 'zq_token_joined' },
    // The tokenizer records the unquoted `--flag=` prefix, so the flag name is kept and its quoted value is the text slot; the value never crosses.
    { command: 'deploy-tool --token="zq_token_joined_quoted"', template: 'deploy-tool --token=<text>', value: 'zq_token_joined_quoted' },
    { command: 'deploy-tool --token 7391062', template: 'deploy-tool --token <text>', value: '7391062' },
    { command: 'deploy-tool --token https://zq.example/zq_token_url', template: 'deploy-tool --token <text>', value: 'zq_token_url' },
    { command: 'deploy-tool --db-password zq_password_apart', template: 'deploy-tool <flag> <text>', value: 'zq_password_apart' },
    { command: 'deploy-tool --db-password=zq_password_joined', template: 'deploy-tool <flag>', value: 'zq_password_joined' },
    { command: 'deploy-tool --clientSecret zq_secret_apart --apikey zq_apikey_apart', template: 'deploy-tool <flag> <text> <flag> <text>', value: 'zq_secret_apart' },
    { command: 'deploy-tool --api-key zq_api_key_apart', template: 'deploy-tool <flag> <text>', value: 'zq_api_key_apart' },
    { command: 'deploy-tool --token "zq token quoted"', template: 'deploy-tool --token <text>', value: 'zq token quoted' },
  ];
  for (const { command, template, value } of CREDENTIALS) {
    it(`sends ${command} as ${template} and the value nowhere`, () => {
      const skeleton = skeletonOfLines(OPEN, bash(command));
      expect(toolsOf(skeleton)[0]?.templates).toEqual([template]);
      expect(JSON.stringify(skeleton), value).not.toContain(value);
    });
  }

  it('reads a double-quoted value joined to an assignment or a long flag as it reads an unquoted one', () => {
    expect(sent('API_REGION="zq_eu" ./deploy.sh')).toEqual(['<path>']);
    expect(sent('deploy-tool --region="zq_eu_control" --limit="5"')).toEqual(['deploy-tool <flag> --limit=<num>']);
  });

  it('reads the value of a flag that is not a credential as a slot of its own shape', () => {
    expect(sent('deploy-tool --token zq_a --limit 5')).toEqual(['deploy-tool --token <text> --limit <num>']);
  });
});

describe('an edit as a diff shape', () => {
  // Each edit is an invented one whose text carries `zq` strings; the wire holds the shape's name and none of the text, in the fields or anywhere in the bytes.
  const edit = (old_string: string, new_string: string, id = 'e1'): string => call(id, 'Edit', { file_path: '/w/src/a.ts', old_string, new_string });
  const shapesOf = (...lines: string[]) => toolsOf(skeletonOfLines(OPEN, ...lines))[0]?.diffShape;
  const FIXTURE: readonly { shape: string; old: string; next: string }[] = [
    { shape: 'import-added', old: 'const zq_total = 1;', next: "import { zqWidget } from './zq_widget';\nconst zq_total = 1;" },
    { shape: 'import-removed', old: "import { zqWidget } from './zq_widget';\nconst zq_total = 1;", next: 'const zq_total = 1;' },
    { shape: 'identifier-renamed', old: 'const zqOldName = compute(zqOldName);', next: 'const zqNewName = compute(zqNewName);' },
    { shape: 'lines-added', old: 'function zq_run() {\n}', next: 'function zq_run() {\n  zq_call();\n}' },
    { shape: 'lines-removed', old: 'function zq_run() {\n  zq_call();\n}', next: 'function zq_run() {\n}' },
    { shape: 'lines-changed', old: 'return zq_total + 1;', next: 'return zq_total * 2;' },
    { shape: 'whitespace-only', old: 'if (zq_ok) {\n  zq_call();\n}', next: 'if (zq_ok)\n{ zq_call(); }' },
  ];
  for (const { shape, old, next } of FIXTURE) {
    it(`sends ${shape} for an edit that is only that, and none of the edited text`, () => {
      const skeleton = skeletonOfLines(OPEN, edit(old, next));
      expect(toolsOf(skeleton)[0]?.diffShape).toEqual([shape]);
      expect(JSON.stringify(skeleton)).not.toContain('zq');
    });
  }

  it('is a closed list, in this order', () => {
    expect(DIFF_SHAPES).toEqual(['import-added', 'import-removed', 'identifier-renamed', 'lines-added', 'lines-removed', 'lines-changed', 'whitespace-only', 'file-written']);
  });

  it('sends file-written for a write, whatever it wrote, and nothing of its content', () => {
    const skeleton = skeletonOfLines(OPEN, call('w1', 'Write', { file_path: '/w/src/b.ts', content: "import { zqWidget } from './zq_widget';\nexport const zq_secret_word = 1;\n" }));
    expect(toolsOf(skeleton)[0]?.diffShape).toEqual(['file-written']);
    expect(JSON.stringify(skeleton)).not.toContain('zq');
  });

  it('sends the union of a multi-edit\'s edits, in the list\'s order', () => {
    const edits = [
      { old_string: 'zqOldName();', new_string: 'zqNewName();' },
      { old_string: 'let zq_a = 1;', new_string: "import zq_dep from 'zq-dep';\nlet zq_a = 1;" },
      { old_string: 'zq_gone();\nzq_stay();', new_string: 'zq_stay();' },
    ];
    const skeleton = skeletonOfLines(OPEN, call('m1', 'MultiEdit', { file_path: '/w/src/a.ts', edits }));
    expect(toolsOf(skeleton)[0]?.diffShape).toEqual(['import-added', 'identifier-renamed', 'lines-removed']);
    expect(JSON.stringify(skeleton)).not.toContain('zq');
  });

  it('sends a changed line as changed, and a rename only when each name is replaced by its own new name throughout the line', () => {
    expect(shapesOf(edit('zq_a = zq_b + zq_c;', 'zq_x = zq_x + zq_c;'))).toEqual(['lines-changed']);
    expect(shapesOf(edit('zq_a = zq_b + zq_c;', 'zq_x = zq_y + zq_c;'))).toEqual(['identifier-renamed']);
    expect(shapesOf(edit('zq_a(1);', 'zq_b(2);'))).toEqual(['lines-changed']);
  });

  it('sends a rename beside an added line, and each import form as an import', () => {
    expect(shapesOf(edit('zqOld();\nkeep();', 'zqNew();\nkeep();\nzq_more();'))).toEqual(['identifier-renamed', 'lines-added']);
    for (const form of ["import zq from 'zq'", 'from zq import zq_b', "const zq = require('zq')", '#include <zq.h>', 'using Zq.Lib;', 'use zq::lib;']) {
      expect(shapesOf(edit('keep();', `${form}\nkeep();`)), form).toEqual(['import-added']);
    }
  });

  it('sends nothing for an edit that changes nothing, a call that is no edit, or a record with no text', () => {
    expect(shapesOf(edit('zq_same();', 'zq_same();'))).toBeUndefined();
    expect(shapesOf(bash('git status'))).toBeUndefined();
    expect(shapesOf(call('e2', 'Edit', { file_path: '/w/src/a.ts' }))).toBeUndefined();
    expect(shapesOf(call('m2', 'MultiEdit', { file_path: '/w/src/a.ts', edits: ['zq_not_an_edit', { old_string: 'zq_a();', new_string: 'zq_a();' }] }))).toBeUndefined();
    expect(shapesOf(call('m3', 'MultiEdit', { file_path: '/w/src/a.ts', edits: 'zq_text' }))).toBeUndefined();
  });

  it('is described in the field list', () => {
    expect(FIELD_ROWS.diffShape).toContain('import-added');
  });
});

// Memory check for `oars sessions deposit` and `oars sessions verify`. Builds a synthetic store in a temp folder, then runs both
// commands from the built CLI under a fixed `--max-old-space-size`, with no NODE_OPTIONS.
//
//   node scripts/sessions-heap.mjs check [--sessions 400] [--heap <MB>]   # the pass/fail check: `just sessions-heap`
//   node scripts/sessions-heap.mjs table [--sizes 400,800] [--heap 4096] # peak RSS of each command by store size (the docs table)
//   node scripts/sessions-heap.mjs minheap [--sizes 400,800]             # smallest --max-old-space-size at which each command passes
//   node scripts/sessions-heap.mjs phases [--sessions 800]               # heap kept after each phase, in one process
//   node scripts/sessions-heap.mjs keep [--sessions 5]                   # builds a store and leaves it, to look at the records
//   node scripts/sessions-heap.mjs pooldeposit [--sessions 2000] [--runs 2] [--heap 8192]  # `oars pool deposit` (the build, no --send) as a machine (OARS_HOST_CLASS, so no sign-in): peak RSS, smallest passing --max-old-space-size, and a digest of the outbox, per run; pair with --bin for a build from before a change
//   node scripts/sessions-heap.mjs refresh [--sessions 1430] [--heap 1024] [--least]  # the nightly's refresh (a no-op deposit) on a cell-heavy store under a fixed heap: pass/fail, peak RSS, and with --least the smallest passing heap (t1586)
//   node scripts/sessions-heap.mjs poolwrite [--cells 1190000] [--runs 3] # peak RSS of the pool's cells in a fresh process each: holding them, writing cells.jsonl, and `poolOf` (no store; a generated store has too few cells)
//
// Flags every mode takes:
//   --calls <n>         tool calls per prompt (default 14)
//   --chatter <n>       skeleton-only lines per call: text, thinking, attachment (default 5)
//   --bulk <n>          characters of a clean tool result (default 400)
//   --superseded off    leave the log clean for a no-op run, with no older copy of any record (default on; a recapture run ignores it)
//   --errors one|varied  every failed call raises KeyError, so the whole store shares one error signature (default one: the shape t1403 measured), or one of eight exception names (the first line of the result, so each is its own signature) by the failure's own count, a fixed set (varied)
//   --shape cells       spread the sessions over many harness versions, models, days, and file kinds, so the pool's cells grow as an operator's do (about 830 a session against 5; `refresh` takes it by default)
//   --bin <file>        run another build of the CLI (a copy of dist/ from before a change) instead of dist/bin.js, to compare two builds on one store (`phases` ignores it: it always measures dist/)
//
// Needs `npm run build -w packages/cli` first (it runs dist/bin.js, and refuses one older than src/sessions/store.ts unless `--bin` names the build). Nothing here touches the real store or ~/.claude: every run points
// APPDATA, XDG_CONFIG_HOME, HOME, USERPROFILE, and CLAUDE_CONFIG_DIR at a fresh folder under the OS temp folder, and refuses to go on
// when a path the CLI will use is not inside it.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cliRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * @param {string} name
 * @param {string} fallback
 */
const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
};

// `--bin <file>` runs another build of the CLI (a copy of dist/ from before a change), to compare two builds on one store.
const binArg = process.argv.indexOf('--bin');
const bin = binArg === -1 ? join(cliRoot, 'dist', 'bin.js') : resolve(process.argv[binArg + 1] ?? '');
// The default build must be newer than the store code it measures, or a stale `dist/` passes or fails for the wrong code. A named `--bin` is older on purpose.
if (binArg === -1) {
  if (!existsSync(bin)) throw new Error(`${bin} does not exist: run \`npm run build -w packages/cli\` first`);
  if (statSync(bin).mtimeMs < statSync(join(cliRoot, 'src', 'sessions', 'store.ts')).mtimeMs) throw new Error(`${bin} is older than src/sessions/store.ts: run \`npm run build -w packages/cli\` first`);
}
const NL = String.fromCharCode(10);
const PROJECT = 'bench-project';
const PROMPTS = 8;
// Characters of a clean tool result. The log keeps none of it, so it sizes the transcript on disk (the operator's: 1.8 MB each against 86 KB of log).
/** The exception names `--errors varied` cycles through: each is its own error signature. */
const ERRORS = ['KeyError', 'ValueError', 'TypeError', 'OSError', 'IndexError', 'AttributeError', 'RuntimeError', 'ImportError'];
const BULK = Number(arg('bulk', '400')) || 400;
/** Names in the long tail `--tools` adds (0: none). The `reads` mode takes 400 unless named. */
const TOOLS = Number(arg('tools', process.argv[2] === 'reads' ? '400' : '0'));
/** The models and file kinds `--shape cells` cycles through. */
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-fable-5-2'];
const EXTENSIONS = ['ts', 'tsx', 'js', 'py', 'go', 'rs', 'java', 'md', 'json', 'yaml', 'sql', 'css'];

/** @typedef {{ file_path?: string, old_string?: string, new_string?: string, command?: string, pattern?: string, skill?: string, url?: string, prompt?: string }} ToolInput */
/** @typedef {{ root: string, appdata: string, claude: string, projects: string, store: string, home: string }} Dirs */

/**
 * The folders one run uses, all under one temp folder.
 * @param {string} root
 * @returns {Dirs}
 */
const layout = (root) => ({
  root,
  appdata: join(root, 'appdata'),
  claude: join(root, 'claude'),
  projects: join(root, 'claude', 'projects', PROJECT),
  store: join(root, 'appdata', 'oars', 'sessions'),
  home: join(root, 'home'),
});

/** @param {Dirs} dirs */
const envOf = (dirs) => ({
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  APPDATA: dirs.appdata,
  XDG_CONFIG_HOME: dirs.appdata,
  HOME: dirs.home,
  USERPROFILE: dirs.home,
  CLAUDE_CONFIG_DIR: dirs.claude,
});

/**
 * Throws unless every path this run uses is inside the OS temp folder.
 * @param {Dirs} dirs
 */
const assertScratch = (dirs) => {
  const temp = resolve(tmpdir()) + sep;
  for (const path of [dirs.store, dirs.projects, dirs.home, dirs.claude]) {
    if (!resolve(path).startsWith(temp)) throw new Error(`${path} is outside ${temp}: refusing to run`);
  }
};

/**
 * @param {number} base
 * @param {number} seconds
 */
const iso = (base, seconds) => new Date(base + seconds * 1000).toISOString();

/**
 * @param {number} index
 * @returns {{ id: string, text: string }}
 *
 * One transcript: PROMPTS prompts, each followed by `--calls` (default 14) tool calls (every sixth fails). Every line is distinct, so nothing dedupes, and
 * a session is about 125 KB of log (49 MB at 400 sessions), against the operator's 86 KB (6,757 files made a 580 MB log): a little heavier per session.
 */
const transcript = (index) => {
  const id = `bench-${String(index).padStart(6, '0')}`;
  const chatter = Number(arg('chatter', '5'));
  const calls = Number(arg('calls', '14'));
  const varied = arg('errors', 'one') === 'varied';
  // `--shape cells` spreads the store over the frames and days a long-lived operator's store spans (many harness versions and models, two years of
  // days, a day per prompt, and varied file kinds), so the pool's cells grow with the sessions as the operator's do: the plain shape makes about 5
  // cells a session (4,000 at 800), the operator's store about 176 (1.19 million at 6,757).
  const cellHeavy = arg('shape', ['refresh', 'reads'].includes(process.argv[2] ?? '') ? 'cells' : 'plain') === 'cells';
  const base = cellHeavy ? Date.parse('2025-01-06T08:00:00Z') + (index % 700) * 86_400_000 : Date.parse('2026-01-05T08:00:00Z') + (index % 140) * 86_400_000;
  const version = cellHeavy ? `2.${String(index % 9)}.${String((index * 10) % 230)}` : '2.1.300';
  /** @param {number} p */
  const modelOf = (p) => (cellHeavy ? MODELS[(index + p) % MODELS.length] : 'claude-opus-5-5');
  /** @param {number} p @param {number} c */
  const extOf = (p, c) => (cellHeavy ? EXTENSIONS[(index + p * 3 + c) % EXTENSIONS.length] : 'ts');
  /** @type {string[]} */
  const lines = [];
  let clock = 0;
  let n = 0;
  /** @param {unknown} value */
  const line = (value) => lines.push(JSON.stringify(value));
  line({ type: 'attachment', uuid: `${id}-${String(n++)}`, parentUuid: null, timestamp: iso(base, clock), version, attachment: { type: 'environment', snapshot: { workingDirectory: '/work/app', platform: 'linux' } } });
  let parent = null;
  for (let p = 0; p < PROMPTS; p += 1) {
    clock = cellHeavy ? p * 86_400 + 60 : clock + 5;
    const prompt = `${id}-${String(n++)}`;
    line({ type: 'user', uuid: prompt, parentUuid: parent, isSidechain: false, timestamp: iso(base, clock), version, cwd: '/work/app', gitBranch: 'main', message: { role: 'user', content: `step ${String(p)} of ${id}: fix the failing build in /work/app/src/module-${String(index % 97)}.ts and explain what you changed` } });
    parent = prompt;
    for (let c = 0; c < calls; c += 1) {
      const toolId = `toolu_${id}_${String(p)}_${String(c)}`;
      const module = String((index + c) % 211);
      /** @type {[string, ToolInput][]} */
      const inputs = [
        ['Read', { file_path: `/work/app/src/module-${module}/file-${String(p)}-${String(c)}.${extOf(p, c)}` }],
        ['Edit', { file_path: `/work/app/src/module-${module}/file-${String(c)}.${extOf(p, c)}`, old_string: `old ${id} ${String(c)}`, new_string: `new ${id} ${String(c)}` }],
        ['Bash', { command: `cd /work/app && npm test -- --run src/module-${module} --id ${id}-${String(p)}-${String(c)} 2>&1 | tail -40 && git status --short && git diff --stat -- src/module-${module}` }],
        ['Grep', { pattern: `symbol${String((index * 7 + c) % 503)}` }],
        ['Bash', { command: `git add src/module-${module} && git commit -m "fix module ${module} step ${String(p)}-${String(c)}" && git log --oneline -3` }],
        ['Bash', { command: `rg -n "symbol${String(c)}" src/module-${module} | head -20; sed -n 1,40p src/module-${module}/file-${String(c)}.ts` }],
      ];
      // `--tools <n>` adds a long tail of named steps, a skill run and a web fetch out of n names each, so a version bucket holds many keys at one level, as an
      // operator's does (many skills, hosts, and commands); the substitution read compares every ordered pair of them at each boundary.
      if (TOOLS > 0) {
        const tail = (index * 13 + p * 7 + c * 3) % TOOLS;
        inputs.push(['Skill', { skill: `bench-skill-${String(tail)}` }], ['WebFetch', { url: `https://docs-${String((tail * 5 + 1) % TOOLS)}.example.org/page`, prompt: 'read it' }]);
      }
      const [name, input] = inputs[(index + p + c) % inputs.length] ?? ['Read', {}];
      clock += 3;
      const call = `${id}-${String(n++)}`;
      line({ type: 'assistant', uuid: call, parentUuid: parent, isSidechain: false, timestamp: iso(base, clock), version, requestedModel: modelOf(p), requestId: `req_${id}_${String(p)}_${String(c)}`, apiBlockIndex: 0, message: { role: 'assistant', model: modelOf(p), content: [{ type: 'tool_use', id: toolId, name, input }], usage: { input_tokens: 10, cache_creation_input_tokens: 200 + c, cache_read_input_tokens: 9000 + c * 40, output_tokens: 100 + c } } });
      parent = call;
      clock += 2;
      const failed = (index + p + c) % 6 === 5;
      const result = `${id}-${String(n++)}`;
      const content = failed
        ? varied
          ? // The signature is the first informative line, so the exception name leads the result: a Traceback line first would give every error one signature. Indexed by the failure's own count, since a call fails only when (index + p + c) % 6 is 5.
            `Exit code 1\n${ERRORS[Math.floor((index + p + c) / 6) % ERRORS.length]}: 'key-${String(index % 31)}'\nTraceback (most recent call last):\n  File "/work/app/src/module-${String(index % 97)}.py", line ${String(c + 10)}, in <module>`
          : `Exit code 1\nTraceback (most recent call last):\n  File "/work/app/src/module-${String(index % 97)}.py", line ${String(c + 10)}, in <module>\nKeyError: 'key-${String(index % 31)}'`
        : `ok ${id} ${'x'.repeat(BULK)}`;
      line({ type: 'user', uuid: result, parentUuid: parent, isSidechain: false, timestamp: iso(base, clock), version, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, is_error: failed, content }] } });
      parent = result;
      // Lines the skeleton lists and the log does not: the model's text, its thinking, and harness attachments make no tool or prompt row, but a
      // real transcript is mostly these (1.8 MB of transcript against 86 KB of log), and the skeleton holds one entry for each.
      for (let k = 0; k < chatter; k += 1) {
        clock += 1;
        const extra = `${id}-${String(n++)}`;
        const kind = (p + c + k) % 3;
        if (kind === 2) {
          line({ type: 'attachment', uuid: extra, parentUuid: parent, timestamp: iso(base, clock), version, attachment: { type: 'hook_success', hookName: 'PostToolUse', content: `ran ${id} ${String(p)}-${String(c)}-${String(k)}` } });
        } else {
          const block = kind === 0 ? { type: 'text', text: `I looked at ${id} step ${String(p)} call ${String(c)} part ${String(k)} and the next change is in src/module-${String(index % 97)}.ts` } : { type: 'thinking', thinking: `reasoning about ${id} ${String(p)}-${String(c)}-${String(k)}`, signature: 'sig' };
          line({ type: 'assistant', uuid: extra, parentUuid: parent, isSidechain: false, timestamp: iso(base, clock), version, requestedModel: modelOf(p), requestId: `req_${id}_${String(p)}_${String(c)}_${String(k)}`, apiBlockIndex: k + 1, message: { role: 'assistant', model: modelOf(p), content: [block], usage: { input_tokens: 10, cache_creation_input_tokens: 100 + k, cache_read_input_tokens: 9000 + k * 40, output_tokens: 50 + k } } });
        }
        parent = extra;
      }
    }
  }
  return { id, text: `${lines.join('\n')}\n` };
};

/**
 * @param {Dirs} dirs
 * @param {number} sessions
 */
const generate = (dirs, sessions) => {
  mkdirSync(dirs.projects, { recursive: true });
  mkdirSync(dirs.appdata, { recursive: true });
  mkdirSync(dirs.home, { recursive: true });
  for (let i = 0; i < sessions; i += 1) {
    const { id, text } = transcript(i);
    writeFileSync(join(dirs.projects, `${id}.jsonl`), text);
  }
};

/** @param {string} path */
const sizeMb = (path) => {
  try {
    return statSync(path).size / 1048576;
  } catch {
    return 0;
  }
};

/** @param {string} folder */
const folderMb = (folder) => readdirSync(folder).reduce((sum, name) => sum + sizeMb(join(folder, name)), 0);

/**
 * @param {Dirs} dirs
 * @param {number} heapMb
 * @param {string[]} args
 * @param {string} [preload]
 * @param {boolean} [recapture]
 * @param {{ [name: string]: string }} [extraEnv] added to the run's environment (a machine's `OARS_HOST_CLASS`)
 * @param {string[]} [nodeFlags] more node flags (the frame sampler's preload)
 * @param {string} [cli] the build to run, `bin` unless named
 *
 * Runs the built CLI under `--max-old-space-size=<heapMb>` (default heap when 0). With `--require` of a preload that prints the child's
 * peak RSS on exit, the figure reaches `peakMb`. With `recapture`, every file in `state.json` is first marked as captured by an older
 * version, as a CAPTURE_VERSION bump does, so a deposit reads and captures every transcript instead of skipping them all.
 */
const runCli = (dirs, heapMb, args, preload, recapture = false, extraEnv = {}, nodeFlags = [], cli = bin) => {
  assertScratch(dirs);
  // Each measured run starts from the stored form: a deposit compacts the log and moves the state, and a later run would see a clean one.
  if (existsSync(join(dirs.root, 'clean.jsonl'))) restore(dirs, recapture);
  // A run that died of memory leaves its lock behind (the next deposit would wait ten minutes for it to age out).
  rmSync(join(dirs.store, 'store.lock'), { force: true });
  const started = Date.now();
  const flags = [...(heapMb === 0 ? [] : [`--max-old-space-size=${String(heapMb)}`]), ...(preload === undefined ? [] : ['--require', preload]), ...nodeFlags];
  const child = spawnSync(process.execPath, [...flags, cli, ...args], { env: { ...envOf(dirs), ...extraEnv }, encoding: 'utf8', maxBuffer: 64 << 20, cwd: dirs.root });
  const peak = /PEAK_RSS_MB (\d+)/.exec(child.stderr)?.[1];
  return { code: child.status, seconds: (Date.now() - started) / 1000, peakMb: peak === undefined ? null : Number(peak), stdout: child.stdout, stderr: child.stderr, oom: /heap out of memory|FATAL ERROR/.test(child.stderr) };
};

const depositArgs = ['sessions', 'deposit', '--allow', PROJECT, '--json'];
const verifyArgs = ['sessions', 'verify'];
// The three measured runs: a deposit that skips every file (the operator's run: 12 captured, 6,757 unchanged), a deposit that captures every transcript
// (a CAPTURE_VERSION bump), and verify. The fourth element is the heap `check` gives each, in MB. At 400 sessions the new build's least heap is 104 and
// 120 MB in two runs for the recapture (the no-op 104, verify 248), and the old build's is 112 MB (one run; the no-op 168, verify 336). So the cap
// goes red on the old build for the no-op (168 against 136) and verify (336 against 288) only; the recapture passes on both builds, with a margin of 16 MB at the 120 MB figure.
// The fifth element is how many transcripts the deposit must report as captured: 0 for the no-op, and for a recapture the store's sessions (`check` fills
// it in), so a recapture that skipped every file fails instead of passing on its exit code. verify has none.
/** @type {[string, string[], boolean, number, 'none' | 'zero' | 'all'][]} */
const runs = [['deposit no-op', depositArgs, false, 136, 'zero'], ['deposit recapture', depositArgs, true, 136, 'all'], ['verify', verifyArgs, false, 288, 'none']];

/** @param {string} label */
const scratch = (label) => {
  const dirs = layout(mkdtempSync(join(tmpdir(), `oars-heap-${label}-`)));
  assertScratch(dirs);
  return dirs;
};

/**
 * A store of `sessions` transcripts: generated, then deposited once under a heap large enough for building it.
 * @param {Dirs} dirs
 * @param {number} sessions
 */
const build = (dirs, sessions) => {
  generate(dirs, sessions);
  // The first deposit leaves state.json, and any command after it would start a detached background sweep in this store; the recorded opt-out keeps one from racing the measured runs, which delete store.lock and rewrite the log.
  mkdirSync(dirs.store, { recursive: true });
  writeFileSync(join(dirs.store, 'schedule.json'), JSON.stringify({ schedule: 'off' }));
  // `reads` builds with this checkout's dist whatever `--bin` names: a build from before t1619 dies deriving the pool's reads of its own store, even under 8,192 MB.
  const made = process.argv[2] === 'reads' ? runCli(dirs, 8192, depositArgs, undefined, false, {}, [], join(cliRoot, 'dist', 'bin.js')) : runCli(dirs, 8192, depositArgs);
  if (made.code !== 0) throw new Error(`building the store failed (exit ${String(made.code)}): ${made.stderr.slice(-600)}`);
  // A pool that could not be built leaves the deposit's exit at 0 and says so in one stderr line: the store is still built, so it is shown and the run goes on.
  for (const said of made.stderr.split(NL).filter((line) => line.startsWith('oars: '))) console.log(`building the store: ${said.slice(0, 400)}`);
  copyFileSync(join(dirs.store, 'observations.jsonl'), join(dirs.root, 'clean.jsonl'));
  copyFileSync(join(dirs.store, 'state.json'), join(dirs.root, 'clean-state.json'));
  const clean = sizeMb(join(dirs.root, 'clean.jsonl'));
  console.log(`store shape: clean log ${clean.toFixed(0)} MB, skeletons ${folderMb(join(dirs.store, 'skeletons')).toFixed(0)} MB (${(folderMb(join(dirs.store, 'skeletons')) / clean).toFixed(2)} per log byte), transcripts ${folderMb(dirs.projects).toFixed(0)} MB`);
  restore(dirs, false);
  return sizeMb(join(dirs.store, 'observations.jsonl'));
};

/**
 * A recapture appends each session's records at a new rev and leaves the old ones in the log until the deposit's compaction, so the operator's store held
 * every record twice while its commands ran. This appends a copy of the whole log one rev lower, which is the same log with the old revs
 * superseded (the highest rev of each session is unchanged, so the store a reader sees is too). Turn it off with `--superseded off`.
 * @param {Dirs} dirs
 */
const supersede = (dirs) => {
  /** @param {string} line */
  const older = (line) => {
    const record = JSON.parse(line);
    return `${JSON.stringify({ ...record, rev: record.rev - 1 })}${NL}`;
  };
  const clean = join(dirs.root, 'clean.jsonl');
  const file = join(dirs.store, 'observations.jsonl');
  copyFileSync(clean, file);
  if (arg('superseded', 'on') === 'off') return;
  // Streamed in chunks: a 2,000-session log is over V8's longest string, so reading it whole (or joining its older copy) throws `Invalid string length`.
  const fd = openSync(clean, 'r');
  try {
    const chunk = Buffer.alloc(8 << 20);
    // A decoder, so a character split across two chunks is not cut.
    const decoder = new StringDecoder('utf8');
    let rest = '';
    for (let read = readSync(fd, chunk, 0, chunk.length, null); read > 0; read = readSync(fd, chunk, 0, chunk.length, null)) {
      const lines = (rest + decoder.write(chunk.subarray(0, read))).split(NL);
      rest = lines.pop() ?? '';
      appendFileSync(file, lines.filter((line) => line !== '').map(older).join(''));
    }
    // The last line has no newline after it when the log does not end in one; its older copy is written too.
    const last = rest + decoder.end();
    if (last !== '') appendFileSync(file, older(last));
  } finally {
    closeSync(fd);
  }
};

/**
 * Puts the store back to the form a measured run starts from. A no-op run (recapture false) sees the log with every record's older copy
 * appended and `state.json` as deposited, so a deposit skips every file. A recapture run sees the clean log and a `state.json` whose
 * files all carry the previous capture version, so a deposit reads every transcript and appends a new rev of each (the log then holds
 * every record twice until the compaction, as in the operator's recapture).
 * @param {Dirs} dirs
 * @param {boolean} recapture
 */
const restore = (dirs, recapture) => {
  const state = JSON.parse(readFileSync(join(dirs.root, 'clean-state.json'), 'utf8'));
  if (recapture) {
    for (const entry of Object.values(state.files)) entry.v = String(Number(entry.v) - 1);
    copyFileSync(join(dirs.root, 'clean.jsonl'), join(dirs.store, 'observations.jsonl'));
  } else {
    supersede(dirs);
  }
  writeFileSync(join(dirs.store, 'state.json'), JSON.stringify(state));
};

const peakPreload = () => {
  const file = join(mkdtempSync(join(tmpdir(), 'oars-heap-preload-')), 'peak.cjs');
  writeFileSync(file, "process.on('exit', () => { process.stderr.write(`\\nPEAK_RSS_MB ${String(Math.round(process.resourceUsage().maxRSS / 1024))}\\n`); });\n");
  return file;
};

/**
 * The `sessions` count of a deposit's `--json` document: the transcripts it parsed this run (the skipped ones are `unchanged`). Undefined when the
 * output is not that document, which `check` treats as a failure.
 * @param {string} stdout
 */
const capturedOf = (stdout) => {
  try {
    const sessions = JSON.parse(stdout).sessions;
    return typeof sessions === 'number' ? sessions : undefined;
  } catch {
    return undefined;
  }
};

/**
 * What a run reported: the transcripts it captured against the count its kind of run must capture (`zero` for the no-op, `all` for the recapture, nothing for
 * verify). Every table and bisect step goes through this, so a run that exits 0 but did the wrong work cannot pass for a measurement.
 * @param {{ code: number | null, oom: boolean, stdout: string }} ran
 * @param {'none' | 'zero' | 'all'} captured
 * @param {number} sessions
 */
const judge = (ran, captured, sessions) => {
  const got = captured === 'none' ? undefined : capturedOf(ran.stdout);
  const want = captured === 'all' ? sessions : 0;
  const finished = ran.code === 0 && !ran.oom;
  return { finished, ok: finished && (captured === 'none' || got === want), got, want };
};

/**
 * Throws when a run that exited 0 captured the wrong count: the `v` rewrite no longer forces a recapture, or a no-op recaptured, and the figures would be another run's.
 * @param {string} name
 * @param {ReturnType<typeof judge>} verdict
 */
const assertWork = (name, verdict) => {
  if (verdict.finished && !verdict.ok) throw new Error(`${name} exited 0 but captured ${String(verdict.got)} (wanted ${String(verdict.want)}): its figures are not that run's`);
};

/**
 * A deterministic pool of `count` distinct cells (a day or week of one motif, one frame bucket, one exposure), for the pool's write and `poolOf`: a generated store has about 4,000 cells, and the operator's has 1.19 million
 * (t1403's synthetic file of that size is 284 MB). Field values vary with the index, so the lines are about as long as a stored cell's and nothing repeats whole.
 * @param {number} count
 */
const syntheticCells = (count) => {
  const cells = [];
  for (let at = 0; at < count; at += 1) {
    const motif = at % 5003;
    const rest = Math.floor(at / 5003);
    cells.push({
      motifId: `${(motif * 2654435761 >>> 0).toString(16).padStart(8, '0')}${(motif * 40503 >>> 0).toString(16).padStart(8, '0')}${motif.toString(16).padStart(8, '0')}`,
      frameBucket: `claude-code/2.${String(rest % 40)}/claude-sonnet-${String(rest % 7)}`,
      grain: rest % 2 === 0 ? 'day' : 'week',
      day: `2026-${String(1 + (rest % 12)).padStart(2, '0')}-${String(1 + (rest % 28)).padStart(2, '0')}`,
      sessions: 1 + (at % 9),
      clusters: 1,
      ok: at % 11,
      failed: at % 5,
      tokens: at % 7 === 0 ? null : at * 37,
      tokenSessions: 1 + (at % 9),
      tokenPrompts: 3 + (at % 17),
      durationMs: at * 13,
      exposed: at % 3 === 0,
      exposure: ['unknown', 'shown', 'held'][at % 3],
    });
  }
  return cells;
};

const command = process.argv[2];

if (command === 'check') {
  const sessions = Number(arg('sessions', '400'));
  const dirs = scratch('check');
  console.log(`store: ${dirs.store}`);
  try {
    console.log(`built ${String(sessions)} sessions: log ${build(dirs, sessions).toFixed(1)} MB`);
    let failed = false;
    // `verify` may exit 4 under --strict only; plain verify exits 0, so any non-zero exit or out-of-memory is a failure.
    for (const [name, args, recapture, cap, captured] of runs) {
      const heap = Number(arg('heap', String(cap)));
      const ran = runCli(dirs, heap, args, undefined, recapture);
      const { ok, got, want } = judge(ran, captured, sessions);
      const note = captured === 'none' ? '' : `, captured ${String(got)} of ${String(sessions)} (wanted ${String(want)})`;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} under --max-old-space-size=${String(heap)}: exit ${String(ran.code)}, ${ran.seconds.toFixed(1)} s${note}${ok ? '' : `${NL}${ran.stderr.slice(0, 300)}`}`);
      failed ||= !ok;
    }
    process.exitCode = failed ? 1 : 0;
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
} else if (command === 'keep') {
  // Builds a store and leaves it, for looking at the records (`rm -r` the printed folder after).
  const dirs = scratch('keep');
  console.log(`store: ${dirs.store}
log ${build(dirs, Number(arg('sessions', '5'))).toFixed(1)} MB`);
} else if (command === 'table') {
  const heap = Number(arg('heap', '4096'));
  const preload = peakPreload();
  console.log('sessions | log MB | deposit no-op peak RSS MB | deposit recapture peak RSS MB | verify peak RSS MB');
  for (const sessions of arg('sizes', '400,800').split(',').map(Number)) {
    const dirs = scratch('table');
    try {
      const log = build(dirs, sessions);
      const cells = runs.map(([name, args, recapture, , captured]) => {
        const ran = runCli(dirs, heap, args, preload, recapture);
        assertWork(name, judge(ran, captured, sessions));
        return `${String(ran.peakMb)} (exit ${String(ran.code)}, ${ran.seconds.toFixed(0)} s)`;
      });
      console.log(`${String(sessions)} | ${log.toFixed(0)} | ${cells.join(' | ')}`);
    } finally {
      rmSync(dirs.root, { recursive: true, force: true });
    }
  }
  rmSync(join(preload, '..'), { recursive: true, force: true });
} else if (command === 'minheap') {
  // Bisects the heap in 8 MB steps between 24 MB (node alone needs about that) and 6 GB; the answer is the first size that exits 0.
  for (const sessions of arg('sizes', '400,800').split(',').map(Number)) {
    const dirs = scratch('minheap');
    try {
      const log = build(dirs, sessions);
      /**
       * @param {string} name
       * @param {string[]} args
       * @param {boolean} recapture
       * @param {'none' | 'zero' | 'all'} captured
       */
      const least = (name, args, recapture, captured) => {
        let low = 24;
        let high = 6144;
        while (high - low > 8) {
          const mid = Math.floor((low + high) / 16) * 8;
          const ran = runCli(dirs, mid, args, undefined, recapture);
          const verdict = judge(ran, captured, sessions);
          assertWork(name, verdict);
          if (verdict.ok) high = mid;
          else low = mid;
        }
        return high;
      };
      console.log(`${String(sessions)} sessions, log ${log.toFixed(0)} MB: ${runs.map(([name, args, recapture, , captured]) => `${name} ${String(least(name, args, recapture, captured))} MB`).join(', ')}`);
    } finally {
      rmSync(dirs.root, { recursive: true, force: true });
    }
  }
} else if (command === 'pooldeposit') {
  // `oars pool deposit` with no --send, as a machine: OARS_HOST_CLASS makes it build without a sign-in, and an exclusion terms file (one term no session holds) lets every session through the gates.
  // It reads the skeletons, scans the log, and writes one batch per session into the outbox. Each run starts from the store as built: what an earlier run wrote is removed, so the outbox is empty again.
  const sessions = Number(arg('sessions', '2000'));
  const runs = Number(arg('runs', '2'));
  const dirs = scratch('pooldeposit');
  const preload = peakPreload();
  const terms = join(dirs.root, 'terms.txt');
  writeFileSync(terms, `no-session-holds-this-term${NL}`);
  const machine = { OARS_HOST_CLASS: 'cloud', OARS_EXCLUSION_TERMS: terms, OARS_ALLOW_REPOS: 'bench/bench' };
  const poolArgs = ['pool', 'deposit', '--json'];
  try {
    const log = build(dirs, sessions);
    const skeletons = folderMb(join(dirs.store, 'skeletons'));
    console.log(`${String(sessions)} sessions: ${String(readdirSync(join(dirs.store, 'skeletons')).length)} skeleton files, ${skeletons.toFixed(0)} MB (mean ${((skeletons * 1024) / readdirSync(join(dirs.store, 'skeletons')).length).toFixed(0)} KB), log ${log.toFixed(0)} MB`);
    const before = new Set(readdirSync(dirs.store));
    const reset = () => {
      for (const name of readdirSync(dirs.store)) if (!before.has(name)) rmSync(join(dirs.store, name), { recursive: true, force: true });
    };
    /**
     * One run of the build; `ok` when it finished and batched every session.
     * @param {number} heapMb
     * @param {boolean} withPreload
     */
    const attempt = (heapMb, withPreload) => {
      reset();
      const ran = runCli(dirs, heapMb, poolArgs, withPreload ? preload : undefined, false, machine);
      let batched;
      try {
        batched = JSON.parse(ran.stdout).batched;
      } catch {
        batched = undefined;
      }
      return { ran, ok: ran.code === 0 && !ran.oom && batched === sessions, batched };
    };
    /** A digest of every file the build left in the outbox, by relative path and bytes: equal digests are equal batches. */
    const digest = () => {
      const hash = createHash('sha256');
      for (const name of readdirSync(join(dirs.store, 'pool-outbox'), { recursive: true, encoding: 'utf8' }).sort()) {
        const file = join(dirs.store, 'pool-outbox', name);
        if (statSync(file).isFile()) hash.update(name).update(readFileSync(file));
      }
      return hash.digest('hex').slice(0, 12);
    };
    const heap = Number(arg('heap', '8192'));
    for (let run = 1; run <= runs; run += 1) {
      const { ran, ok, batched } = attempt(heap, true);
      console.log(`run ${String(run)} under --max-old-space-size=${String(heap)}: ${ok ? 'ok' : 'FAILED'}, exit ${String(ran.code)}, batched ${String(batched)}, peak RSS ${String(ran.peakMb)} MB, ${ran.seconds.toFixed(1)} s${ok ? `, outbox digest ${digest()}` : `${NL}${ran.stderr.slice(0, 300)}`}`);
    }
    // The smallest heap that passes, in 8 MB steps between 24 MB and the heap above (the first size that exits 0 with every session batched).
    for (let run = 1; run <= runs; run += 1) {
      let low = 24;
      let high = heap;
      while (high - low > 8) {
        const mid = Math.floor((low + high) / 16) * 8;
        if (attempt(mid, false).ok) high = mid;
        else low = mid;
      }
      console.log(`smallest passing heap, run ${String(run)}: ${String(high)} MB`);
    }
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
    rmSync(join(preload, '..'), { recursive: true, force: true });
  }
} else if (command === 'phases') {
  const dirs = scratch('phases');
  console.log(`store: ${dirs.store}`);
  try {
    console.log(`log ${build(dirs, Number(arg('sessions', '800'))).toFixed(0)} MB`);
    // The no-op shape on the superseded log, then the recapture shape on the clean log with every file marked as captured by an older version.
    for (const shape of ['noop', 'recapture']) {
      restore(dirs, shape === 'recapture');
      const ran = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=8192', join(cliRoot, 'scripts', 'sessions-heap-phases.mjs'), dirs.store, dirs.claude, shape], { env: envOf(dirs), encoding: 'utf8', cwd: dirs.root, maxBuffer: 64 << 20 });
      console.log(`${shape}:
${ran.stdout}${ran.stderr.slice(-800)}`);
      if (ran.status !== 0) process.exitCode = 1;
    }
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
} else if (command === 'poolstep') {
  // One step of `poolwrite`, in this process, so its peak RSS is its own: `hold` builds the cells, `write` writes them as the pool does, `poolof` derives the pool from them.
  const dist = join(bin, '..', 'sessions');
  const step = arg('step', 'hold');
  const file = arg('file', '');
  const total = Number(arg('cells', '1190000'));
  const started = performance.now();
  const cells = syntheticCells(total);
  if (step === 'write') {
    const pool = await import(pathToFileURL(join(dist, 'pool.js')).href);
    if (typeof pool.writeCells === 'function') await pool.writeCells(file, cells);
    else {
      const { serializeCells } = await import(pathToFileURL(join(dist, 'cells.js')).href);
      const { writeAtomic } = await import(pathToFileURL(join(dist, 'store.js')).href);
      await writeAtomic(file, serializeCells(cells));
    }
  } else if (step === 'poolof') {
    const { poolOf } = await import(pathToFileURL(join(dist, 'cells.js')).href);
    const pool = poolOf({ cells, motifs: [] }, []);
    if (pool.cells.length !== total) throw new Error('poolOf changed the cells');
  } else if (step !== 'hold') throw new Error(`unknown step ${step}`);
  console.log(JSON.stringify({ step, cells: cells.length, peakMb: Math.round(process.resourceUsage().maxRSS / 1024), seconds: Number(((performance.now() - started) / 1000).toFixed(1)) }));
} else if (command === 'poolwrite') {
  const out = scratch('poolwrite');
  const total = arg('cells', '1190000');
  const file = join(out.root, 'cells.jsonl');
  try {
    console.log('step | peak RSS MB per run | seconds per run | cells.jsonl MB');
    for (const step of ['hold', 'write', 'poolof']) {
      const peaks = [];
      const seconds = [];
      let size = '';
      for (let run = 0; run < Number(arg('runs', '3')); run += 1) {
        const ran = spawnSync(process.execPath, ['--max-old-space-size=8192', fileURLToPath(import.meta.url), 'poolstep', '--step', step, '--cells', total, '--file', file, ...(binArg === -1 ? [] : ['--bin', bin])], { encoding: 'utf8', maxBuffer: 1 << 20 });
        if (ran.status !== 0) throw new Error(`${step} run ${String(run + 1)} exited ${String(ran.status)}: ${ran.stderr.slice(-400)}`);
        const row = JSON.parse(ran.stdout.trim().split(NL).pop() ?? '');
        peaks.push(row.peakMb);
        seconds.push(row.seconds);
        if (step === 'write') size = (statSync(file).size / 1048576).toFixed(0);
      }
      console.log(`${step} | ${peaks.join(' | ')} | ${seconds.join(' | ')} | ${size}`);
    }
  } finally {
    rmSync(out.root, { recursive: true, force: true });
  }
} else if (command === 'refresh' || command === 'reads') {
  // The nightly's refresh on a store whose pool holds as many cells as the operator's (t1586): a cell-heavy store (`--shape cells` unless named), then a no-op deposit (the scan, the
  // compaction, and `refresh`: the derive, the pool, and the index) under `--heap`. It fails unless the deposit exits 0 and writes the hook index. With `--least`, it also bisects the
  // smallest passing heap in 8 MB steps. Pair with `--bin` for a build from before a change.
  // 1,430 sessions make 1.19 million cells, the operator's count: main ran out of memory there under 1,024 MB, and the lean tallies finish in it.
  const sessions = Number(arg('sessions', '1430'));
  const heap = Number(arg('heap', '1024'));
  const dirs = scratch('refresh');
  const preload = peakPreload();
  try {
    const log = build(dirs, sessions);
    const cells = readFileSync(join(dirs.store, 'cells.jsonl'), 'utf8').split(NL).length - 1;
    console.log(`${String(sessions)} sessions: log ${log.toFixed(0)} MB, ${String(cells)} cells (${(cells / sessions).toFixed(0)} a session)`);
    const index = join(dirs.store, 'hook-index.json');
    /**
     * @param {number} heapMb
     * @param {string | undefined} withPreload
     */
    const attempt = (heapMb, withPreload) => {
      rmSync(index, { force: true });
      // `reads` measures the derivation of the pool's reads (t1619): the build's deposit wrote this pool's reads file, and a run that finds it reads it instead of deriving.
      if (command === 'reads') rmSync(join(dirs.store, 'reads'), { recursive: true, force: true });
      const frames = join(dirs.root, 'frames.json');
      rmSync(frames, { force: true });
      // `reads` also asks V8 for its collections (the most live heap after a full one is the peak heap below) and samples the live heap by allocating frame (`sessions-heap-frames.cjs`), so a run that dies of memory names the frames holding it.
      const reading = command === 'reads' && withPreload !== undefined;
      const traced = runCli(dirs, heapMb, depositArgs, withPreload, false, reading ? { OARS_HEAP_FRAMES: frames } : {}, reading ? ['--trace-gc', '--require', join(cliRoot, 'scripts', 'sessions-heap-frames.cjs')] : []);
      const gcLine = /^\[\d+:0x[0-9a-f]+\]/;
      const stdoutLines = traced.stdout.split(NL);
      // After a full collection only: a scavenge's figure still holds the old generation's garbage.
      const peakHeapMb = Math.max(0, ...stdoutLines.flatMap((line) => (gcLine.test(line) && line.includes('Mark-Compact') ? [Number(/-> ([\d.]+) \(/.exec(line)?.[1] ?? 0)] : [])));
      /** @type {{ liveMb: number, top: { frame: string, mb: number }[], callersOfTop: string[] } | undefined} */
      const sampled = existsSync(frames) ? JSON.parse(readFileSync(frames, 'utf8').trim().split(NL).pop() ?? '') : undefined;
      const ran = { ...traced, stdout: stdoutLines.filter((line) => !gcLine.test(line)).join(NL), peakHeapMb: Math.round(peakHeapMb), frames: sampled };
      // A pool that fails to build costs the deposit only a stderr line, so `reads` also asks for the reads file the run derived.
      const derived = command !== 'reads' || (existsSync(join(dirs.store, 'reads')) && readdirSync(join(dirs.store, 'reads')).some((name) => name.endsWith('.jsonl')));
      return { ran, ok: judge(ran, 'zero', sessions).ok && existsSync(index) && derived };
    };
    const { ran, ok } = attempt(heap, preload);
    const heapNote = command === 'reads' ? `, peak live heap ${String(ran.peakHeapMb)} MB` : '';
    // The last sample before the end: on a death of memory, what held the heap as it died.
    const frameNote = ok || ran.frames === undefined ? '' : `${NL}  live heap by allocating frame, last sample (${String(ran.frames.liveMb)} MB sampled): ${ran.frames.top.map(({ frame, mb }) => `${frame} ${String(mb)} MB`).join(', ')}${NL}  called from: ${ran.frames.callersOfTop.join(' < ')}`;
    console.log(`refresh under --max-old-space-size=${String(heap)}: ${ok ? 'ok' : 'FAILED'}, exit ${String(ran.code)}${ran.oom ? ' (out of memory)' : ''}, peak RSS ${String(ran.peakMb)} MB${heapNote}, ${ran.seconds.toFixed(1)} s${frameNote}`);
    if (!ok) process.exitCode = 1;
    if (process.argv.includes('--least')) {
      let low = 24;
      let high = Math.max(heap, 6144);
      while (high - low > 8) {
        const mid = Math.floor((low + high) / 16) * 8;
        if (attempt(mid, undefined).ok) high = mid;
        else low = mid;
      }
      console.log(`smallest passing heap: ${String(high)} MB (${((high * 1024) / cells).toFixed(2)} KB a cell)`);
    }
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
    rmSync(join(preload, '..'), { recursive: true, force: true });
  }
} else {
  console.error('usage: sessions-heap.mjs check|table|minheap|phases|keep|poolwrite|refresh|reads');
  process.exitCode = 2;
}

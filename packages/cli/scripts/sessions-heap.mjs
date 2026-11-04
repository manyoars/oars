// Memory check for `oars sessions deposit` and `oars sessions verify` (t808). Builds a synthetic store in a temp folder, then runs both
// commands from the built CLI under a fixed `--max-old-space-size`, with no NODE_OPTIONS.
//
//   node scripts/sessions-heap.mjs check [--sessions 400] [--heap <MB>]   # the pass/fail check: `just sessions-heap`
//   node scripts/sessions-heap.mjs table [--sizes 400,800] [--heap 4096] # peak RSS of each command by store size (the docs table)
//   node scripts/sessions-heap.mjs minheap [--sizes 400,800]             # smallest --max-old-space-size at which each command passes
//   node scripts/sessions-heap.mjs phases [--sessions 800]               # heap kept after each phase, in one process
//   node scripts/sessions-heap.mjs keep [--sessions 5]                   # builds a store and leaves it, to look at the records
//
// Flags every mode takes:
//   --calls <n>         tool calls per prompt (default 14)
//   --chatter <n>       skeleton-only lines per call: text, thinking, attachment (default 5)
//   --bulk <n>          characters of a clean tool result (default 400)
//   --superseded off    leave the log clean for a no-op run, with no older copy of any record (default on; a recapture run ignores it)
//   --bin <file>        run another build of the CLI (a copy of dist/ from before a change) instead of dist/bin.js, to compare two builds on one store (`phases` ignores it: it always measures dist/)
//
// Needs `npm run build -w packages/cli` first (it runs dist/bin.js, and refuses one older than src/sessions/store.ts unless `--bin` names the build). Nothing here touches the real store or ~/.claude: every run points
// APPDATA, XDG_CONFIG_HOME, HOME, USERPROFILE, and CLAUDE_CONFIG_DIR at a fresh folder under the OS temp folder, and refuses to go on
// when a path the CLI will use is not inside it.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const BULK = Number(arg('bulk', '400')) || 400;

/** @typedef {{ file_path?: string, old_string?: string, new_string?: string, command?: string, pattern?: string }} ToolInput */
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
  const base = Date.parse('2026-01-05T08:00:00Z') + (index % 140) * 86_400_000;
  /** @type {string[]} */
  const lines = [];
  let clock = 0;
  let n = 0;
  /** @param {unknown} value */
  const line = (value) => lines.push(JSON.stringify(value));
  line({ type: 'attachment', uuid: `${id}-${String(n++)}`, parentUuid: null, timestamp: iso(base, clock), version: '2.1.300', attachment: { type: 'environment', snapshot: { workingDirectory: '/work/app', platform: 'linux' } } });
  let parent = null;
  for (let p = 0; p < PROMPTS; p += 1) {
    clock += 5;
    const prompt = `${id}-${String(n++)}`;
    line({ type: 'user', uuid: prompt, parentUuid: parent, isSidechain: false, timestamp: iso(base, clock), version: '2.1.300', cwd: '/work/app', gitBranch: 'main', message: { role: 'user', content: `step ${String(p)} of ${id}: fix the failing build in /work/app/src/module-${String(index % 97)}.ts and explain what you changed` } });
    parent = prompt;
    for (let c = 0; c < calls; c += 1) {
      const toolId = `toolu_${id}_${String(p)}_${String(c)}`;
      const module = String((index + c) % 211);
      /** @type {[string, ToolInput][]} */
      const inputs = [
        ['Read', { file_path: `/work/app/src/module-${module}/file-${String(p)}-${String(c)}.ts` }],
        ['Edit', { file_path: `/work/app/src/module-${module}/file-${String(c)}.ts`, old_string: `old ${id} ${String(c)}`, new_string: `new ${id} ${String(c)}` }],
        ['Bash', { command: `cd /work/app && npm test -- --run src/module-${module} --id ${id}-${String(p)}-${String(c)} 2>&1 | tail -40 && git status --short && git diff --stat -- src/module-${module}` }],
        ['Grep', { pattern: `symbol${String((index * 7 + c) % 503)}` }],
        ['Bash', { command: `git add src/module-${module} && git commit -m "fix module ${module} step ${String(p)}-${String(c)}" && git log --oneline -3` }],
        ['Bash', { command: `rg -n "symbol${String(c)}" src/module-${module} | head -20; sed -n 1,40p src/module-${module}/file-${String(c)}.ts` }],
      ];
      const [name, input] = inputs[(index + p + c) % inputs.length] ?? ['Read', {}];
      clock += 3;
      const call = `${id}-${String(n++)}`;
      line({ type: 'assistant', uuid: call, parentUuid: parent, isSidechain: false, timestamp: iso(base, clock), version: '2.1.300', requestedModel: 'claude-opus-5-5', requestId: `req_${id}_${String(p)}_${String(c)}`, apiBlockIndex: 0, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: toolId, name, input }], usage: { input_tokens: 10, cache_creation_input_tokens: 200 + c, cache_read_input_tokens: 9000 + c * 40, output_tokens: 100 + c } } });
      parent = call;
      clock += 2;
      const failed = (index + p + c) % 6 === 5;
      const result = `${id}-${String(n++)}`;
      const content = failed
        ? `Exit code 1\nTraceback (most recent call last):\n  File "/work/app/src/module-${String(index % 97)}.py", line ${String(c + 10)}, in <module>\nKeyError: 'key-${String(index % 31)}'`
        : `ok ${id} ${'x'.repeat(BULK)}`;
      line({ type: 'user', uuid: result, parentUuid: parent, isSidechain: false, timestamp: iso(base, clock), version: '2.1.300', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, is_error: failed, content }] } });
      parent = result;
      // Lines the skeleton lists and the log does not: the model's text, its thinking, and harness attachments make no tool or prompt row, but a
      // real transcript is mostly these (1.8 MB of transcript against 86 KB of log), and the skeleton holds one entry for each.
      for (let k = 0; k < chatter; k += 1) {
        clock += 1;
        const extra = `${id}-${String(n++)}`;
        const kind = (p + c + k) % 3;
        if (kind === 2) {
          line({ type: 'attachment', uuid: extra, parentUuid: parent, timestamp: iso(base, clock), version: '2.1.300', attachment: { type: 'hook_success', hookName: 'PostToolUse', content: `ran ${id} ${String(p)}-${String(c)}-${String(k)}` } });
        } else {
          const block = kind === 0 ? { type: 'text', text: `I looked at ${id} step ${String(p)} call ${String(c)} part ${String(k)} and the next change is in src/module-${String(index % 97)}.ts` } : { type: 'thinking', thinking: `reasoning about ${id} ${String(p)}-${String(c)}-${String(k)}`, signature: 'sig' };
          line({ type: 'assistant', uuid: extra, parentUuid: parent, isSidechain: false, timestamp: iso(base, clock), version: '2.1.300', requestedModel: 'claude-opus-5-5', requestId: `req_${id}_${String(p)}_${String(c)}_${String(k)}`, apiBlockIndex: k + 1, message: { role: 'assistant', model: 'claude-opus-5-5', content: [block], usage: { input_tokens: 10, cache_creation_input_tokens: 100 + k, cache_read_input_tokens: 9000 + k * 40, output_tokens: 50 + k } } });
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
 *
 * Runs the built CLI under `--max-old-space-size=<heapMb>` (default heap when 0). With `--require` of a preload that prints the child's
 * peak RSS on exit, the figure reaches `peakMb`. With `recapture`, every file in `state.json` is first marked as captured by an older
 * version, as a CAPTURE_VERSION bump does, so a deposit reads and captures every transcript instead of skipping them all.
 */
const runCli = (dirs, heapMb, args, preload, recapture = false) => {
  assertScratch(dirs);
  // Each measured run starts from the stored form: a deposit compacts the log and moves the state, and a later run would see a clean one.
  if (existsSync(join(dirs.root, 'clean.jsonl'))) restore(dirs, recapture);
  // A run that died of memory leaves its lock behind (the next deposit would wait ten minutes for it to age out).
  rmSync(join(dirs.store, 'store.lock'), { force: true });
  const started = Date.now();
  const flags = [...(heapMb === 0 ? [] : [`--max-old-space-size=${String(heapMb)}`]), ...(preload === undefined ? [] : ['--require', preload])];
  const child = spawnSync(process.execPath, [...flags, bin, ...args], { env: envOf(dirs), encoding: 'utf8', maxBuffer: 64 << 20, cwd: dirs.root });
  const peak = /PEAK_RSS_MB (\d+)/.exec(child.stderr)?.[1];
  return { code: child.status, seconds: (Date.now() - started) / 1000, peakMb: peak === undefined ? null : Number(peak), stdout: child.stdout, stderr: child.stderr, oom: /heap out of memory|FATAL ERROR/.test(child.stderr) };
};

const depositArgs = ['sessions', 'deposit', '--allow', PROJECT, '--json'];
const verifyArgs = ['sessions', 'verify'];
// The three measured runs: a deposit that skips every file (the t784 run: 12 captured, 6,757 unchanged), a deposit that captures every transcript
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
  const made = runCli(dirs, 8192, depositArgs);
  if (made.code !== 0) throw new Error(`building the store failed (exit ${String(made.code)}): ${made.stderr.slice(-600)}`);
  copyFileSync(join(dirs.store, 'observations.jsonl'), join(dirs.root, 'clean.jsonl'));
  copyFileSync(join(dirs.store, 'state.json'), join(dirs.root, 'clean-state.json'));
  const clean = sizeMb(join(dirs.root, 'clean.jsonl'));
  console.log(`store shape: clean log ${clean.toFixed(0)} MB, skeletons ${folderMb(join(dirs.store, 'skeletons')).toFixed(0)} MB (${(folderMb(join(dirs.store, 'skeletons')) / clean).toFixed(2)} per log byte), transcripts ${folderMb(dirs.projects).toFixed(0)} MB`);
  restore(dirs, false);
  return sizeMb(join(dirs.store, 'observations.jsonl'));
};

/**
 * A recapture appends each session's records at a new rev and leaves the old ones in the log until the deposit's compaction, so t784's store held
 * every record twice while its commands ran. This appends a copy of the whole log one rev lower, which is the same log with the old revs
 * superseded (the highest rev of each session is unchanged, so the store a reader sees is too). Turn it off with `--superseded off`.
 * @param {Dirs} dirs
 */
const supersede = (dirs) => {
  const clean = join(dirs.root, 'clean.jsonl');
  const file = join(dirs.store, 'observations.jsonl');
  if (arg('superseded', 'on') === 'off') return copyFileSync(clean, file);
  const log = readFileSync(clean, 'utf8');
  const older = log
    .split(NL)
    .filter((line) => line !== '')
    .map((line) => {
      const record = JSON.parse(line);
      return JSON.stringify({ ...record, rev: record.rev - 1 });
    })
    .join(NL);
  writeFileSync(file, `${log}${older}${NL}`);
};

/**
 * Puts the store back to the form a measured run starts from. A no-op run (recapture false) sees the log with every record's older copy
 * appended and `state.json` as deposited, so a deposit skips every file. A recapture run sees the clean log and a `state.json` whose
 * files all carry the previous capture version, so a deposit reads every transcript and appends a new rev of each (the log then holds
 * every record twice until the compaction, as in t784's recapture).
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
} else {
  console.error('usage: sessions-heap.mjs check|table|minheap|phases|keep');
  process.exitCode = 2;
}

// The prompt `intervention` bucket (t882, docs/sessions-store.md "Prompt intervention"): what the next human prompt did to the work of this one. These rows run the rule over built records, so each
// bucket and each limit the doc states has a row; `intervention-harness.test.ts` runs the same scenarios through each harness's own adapter.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveSession } from './derive.js';
import { captureSession, emptyUsage } from './extract.js';
import { makeRedactor } from './redact.js';
import { CAPTURE_VERSION, EXTRACTOR_VERSION, PROMPT_INTERVENTIONS, type PromptIntervention, type ErrorLineObservation, type ShellSegment, type StepObservation, type ToolObservation, type ToolStatus, type UserPromptObservation } from './schema.js';
import { FIXTURES } from './test-support.js';

const redact = makeRedactor();
const head = captureSession({ text: readFileSync(join(FIXTURES, 'proj', 'errors-a.jsonl'), 'utf8'), session: 's', project: 'p', rev: 1, at: '', bytes: 0, redact }).session;

interface Call {
  prompt: number | null;
  tool: string;
  status?: ToolStatus;
  target?: string | null;
  segments?: ShellSegment[];
  commits?: Array<string | null>;
  steps?: StepObservation[];
  side?: boolean;
  cv?: string;
}

const edit = (prompt: number, target = 'hash-a', status: ToolStatus = 'ok'): Call => ({ prompt, tool: 'Edit', target, status });
const shell = (prompt: number, run: string, status: ToolStatus = 'ok'): Call => ({ prompt, tool: 'Bash', target: run, status, segments: [{ run, read: true }] });
const commit = (prompt: number): Call => ({ ...shell(prompt, 'git commit'), commits: ['abc1234'] });
/** A shell call captured before CAPTURE 6: no segments. */
const older = (prompt: number): Call => ({ prompt, tool: 'Bash', target: 'git', status: 'ok' });
const resetHard = (prompt: number): Call => ({
  ...shell(prompt, 'git reset'),
  steps: [{ n: 0, seg: 0, action: 'shell.exec', native: 'Bash', identity: { program: 'git', sub: 'reset', flags: ['--hard'] }, status: 'ok', cost: { tokens: null, durationMs: null }, parent: null, edges: [], frameId: 'f' }],
});

const derived = (heads: readonly string[], calls: readonly Call[], failures: readonly { prompt: number; line: string }[] = []) => {
  const tools = calls.map((call, n): ToolObservation => ({
    kind: 'tool', cv: call.cv ?? CAPTURE_VERSION, sid: null, session: 's', rev: 1, parent: 's', agentType: null, n, ts: null, tool: call.tool, status: call.status ?? 'ok', target: call.target ?? null, targetBase: null,
    keys: [], durationMs: null, toolUseId: `c${String(n)}`, harnessVersion: null, side: call.side ?? false, prompt: call.prompt,
    ...(call.segments === undefined ? {} : { segments: call.segments }), ...(call.commits === undefined ? {} : { commits: call.commits }), ...(call.steps === undefined ? {} : { steps: call.steps }),
  }));
  const errorLines = failures.map((failure, n): ErrorLineObservation => ({
    kind: 'error-line', cv: CAPTURE_VERSION, sid: null, session: 's', rev: 1, toolUseId: `e${String(n)}`, tool: 'Edit', line: failure.line, ts: null, harnessVersion: null, side: false, prompt: failure.prompt, after: 0,
  }));
  const prompts = heads.map((text, index): UserPromptObservation => ({
    kind: 'user-prompt', cv: CAPTURE_VERSION, sid: null, session: 's', rev: 1, index, ts: null, wallSec: null, head: text, thinking: 0, turns: 0, model: 'm', efforts: [], skills: [], usage: emptyUsage(), promptFingerprint: null,
  }));
  return deriveSession({ session: head, prompts, tools, errorLines }, redact).prompts.map((prompt) => prompt.intervention);
};

const REJECTED = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).";

describe('the closed list', () => {
  it('names the six buckets, and the extractor that writes them is version 14', () => {
    expect(PROMPT_INTERVENTIONS).toEqual(['none', 'after-error', 'redo', 'revert', 'user-stop', 'unknown']);
    expect(Number(EXTRACTOR_VERSION)).toBeGreaterThanOrEqual(14);
  });
});

describe('none', () => {
  it('is a prompt followed by a prompt that touches none of its work', () => {
    expect(derived(['one', 'two'], [edit(0), edit(1, 'hash-b')])).toEqual(['none', 'unknown']);
  });

  it('is a prompt with no call at all, followed by another', () => {
    expect(derived(['why is the sky blue', 'thanks'], [])).toEqual(['none', 'unknown']);
  });

  it('is silence, not approval: a later edit of the path three prompts on is not the very next prompt', () => {
    expect(derived(['a', 'b', 'c'], [edit(0), edit(2)])).toEqual(['none', 'none', 'unknown']);
  });
});

describe('after-error', () => {
  it('is a prompt whose last call failed', () => {
    expect(derived(['a', 'b'], [shell(0, 'npm test', 'error')])).toEqual(['after-error', 'unknown']);
  });

  it('reads the last call in call order, so a failure the agent got past does not count', () => {
    expect(derived(['a', 'b'], [shell(0, 'npm test', 'error'), edit(0)])).toEqual(['none', 'unknown']);
    expect(derived(['a', 'b'], [edit(0), shell(0, 'npm test', 'error')])[0]).toBe('after-error');
  });

  it('does not read a sidechain call, or a call of another prompt, as the last call', () => {
    expect(derived(['a', 'b'], [edit(0), { ...shell(0, 'npm test', 'error'), side: true }])[0]).toBe('none');
    expect(derived(['a', 'b'], [edit(0), shell(1, 'npm test', 'error')])[0]).toBe('none');
  });

  it('does not read a call with no result as a failure', () => {
    expect(derived(['a', 'b'], [shell(0, 'npm test', 'none')])[0]).toBe('none');
  });
});

describe('redo', () => {
  it('is a prompt whose path the very next prompt edits again', () => {
    expect(derived(['a', 'b'], [edit(0), edit(1)])).toEqual(['redo', 'unknown']);
  });

  it('marks each prompt of a chain but the last', () => {
    expect(derived(['a', 'b', 'c'], [edit(0), edit(1), edit(2)])).toEqual(['redo', 'redo', 'unknown']);
  });

  it('ends at a commit between the two edits, wherever it falls', () => {
    expect(derived(['a', 'b'], [edit(0), commit(0), edit(1)])[0]).toBe('none');
    expect(derived(['a', 'b'], [edit(0), commit(1), edit(1)])[0]).toBe('none');
  });

  it('needs both edits to have worked, and to be of the same path', () => {
    expect(derived(['a', 'b'], [edit(0, 'hash-a', 'error'), edit(1)])[0]).toBe('after-error');
    expect(derived(['a', 'b'], [edit(0), edit(1, 'hash-a', 'error')])[0]).toBe('none');
    expect(derived(['a', 'b'], [edit(0), edit(1, 'hash-b')])[0]).toBe('none');
  });

  it('is not an edit of the same prompt twice', () => {
    expect(derived(['a', 'b'], [edit(0), edit(0)])[0]).toBe('none');
  });

  it('is the next prompt only: an edit two prompts on is the older redo signal and no bucket', () => {
    expect(derived(['a', 'b', 'c'], [edit(0), edit(2)])[0]).toBe('none');
  });

  it('wins over an error in the prompt\'s last call', () => {
    expect(derived(['a', 'b'], [edit(0), shell(0, 'npm test', 'error'), edit(1)])[0]).toBe('redo');
  });
});

describe('revert', () => {
  it.each(['git revert abc1234', 'git revert HEAD', 'git restore', 'git checkout', 'git checkout .'])('is a prompt whose edit the next prompt undoes with `%s`', (run) => {
    expect(derived(['a', 'b'], [edit(0), shell(1, run)])).toEqual(['revert', 'unknown']);
  });

  it('reads `git reset --hard` from the step, since a segment keeps no flag', () => {
    expect(derived(['a', 'b'], [edit(0), resetHard(1)])[0]).toBe('revert');
    expect(derived(['a', 'b'], [edit(0), shell(1, 'git reset HEAD~1')])[0]).toBe('none');
  });

  it('reads an undo behind another command of the same call', () => {
    expect(derived(['a', 'b'], [edit(0), { prompt: 1, tool: 'Bash', target: 'cd', status: 'ok', segments: [{ run: 'cd x', read: true }, { run: 'git revert HEAD', read: true }] }])[0]).toBe('revert');
  });

  it.each(['revert that', 'Undo the last change', 'please roll back', 'Rollback the edit', 'REVERT it'])('is a prompt whose edit the next prompt asks to undo: %s', (text) => {
    expect(derived(['a', text], [edit(0)])[0]).toBe('revert');
  });

  it.each(['reverting is not what I asked', 'why did you undo it', 'now revert'])('does not read a head that only mentions the word later: %s', (text) => {
    expect(derived(['a', text], [edit(0)])[0]).toBe('none');
  });

  it('needs an edit of the prompt: an undo of nothing is not an undo of its work', () => {
    expect(derived(['a', 'b'], [shell(0, 'ls'), shell(1, 'git revert HEAD')])[0]).toBe('none');
    expect(derived(['a', 'undo that'], [edit(0, 'hash-a', 'error')])[0]).toBe('after-error');
  });

  it('needs the undo to have run: a failed git call is not one', () => {
    expect(derived(['a', 'b'], [edit(0), shell(1, 'git revert HEAD', 'error')])[0]).toBe('none');
  });

  it('does not read stash, clean, a checkout of a branch, or a revision, which the segment names or drops', () => {
    for (const run of ['git stash', 'git clean', 'git checkout main', 'git checkout abc1234', 'git log']) {
      expect(derived(['a', 'b'], [edit(0), shell(1, run)])[0]).toBe('none');
    }
  });

  it('does not read an undo in a prompt later than the next', () => {
    expect(derived(['a', 'b', 'c'], [edit(0), shell(2, 'git revert HEAD')])[0]).toBe('none');
  });

  it('wins over a redo and an error', () => {
    expect(derived(['a', 'b'], [edit(0), shell(0, 'npm test', 'error'), edit(1), shell(1, 'git revert HEAD')])[0]).toBe('revert');
  });
});

describe('user-stop', () => {
  it('is a prompt the user rejected a call of', () => {
    expect(derived(['a', 'b'], [edit(0, 'hash-a', 'error')], [{ prompt: 0, line: REJECTED }])).toEqual(['user-stop', 'unknown']);
  });

  it('is a prompt the user interrupted: the next record is the marker, which reads unknown itself', () => {
    expect(derived(['a', '[Request interrupted by user]', 'c'], [edit(0)])).toEqual(['user-stop', 'unknown', 'unknown']);
  });

  it('wins over after-error: a rejected call settles as an error, and it is the last call of the prompt', () => {
    expect(derived(['a', 'b'], [shell(0, 'npm test', 'error'), edit(0, 'hash-a', 'error')], [{ prompt: 0, line: REJECTED }])).toEqual(['user-stop', 'unknown']);
    expect(derived(['a', 'b'], [edit(0, 'hash-a', 'error')])).toEqual(['after-error', 'unknown']);
  });

  it('wins over redo and revert: the next prompt repeats the edit or asks for the undo, and the stop still reads first', () => {
    expect(derived(['a', 'b'], [edit(0), edit(1)], [{ prompt: 0, line: REJECTED }])[0]).toBe('user-stop');
    expect(derived(['a', 'undo that'], [edit(0)], [{ prompt: 0, line: REJECTED }])[0]).toBe('user-stop');
    expect(derived(['a', '[Request interrupted by user]', 'b'], [edit(0), edit(2)])[0]).toBe('user-stop');
  });

  it('is not a policy denial: that is the permission rules, not the human, so the failed call reads after-error', () => {
    expect(derived(['a', 'b'], [edit(0, 'hash-a', 'error')], [{ prompt: 0, line: 'Permission to use Edit has been denied.' }])[0]).toBe('after-error');
  });
});

describe('unknown', () => {
  it('is the last prompt of a transcript, whatever it did', () => {
    expect(derived(['only'], [edit(0), shell(0, 'npm test', 'error')])).toEqual(['unknown']);
    expect(derived([], [])).toEqual([]);
  });

  it('is a rejected prompt that is the last of its transcript: the last prompt reads unknown before a stop is looked at', () => {
    expect(derived(['a'], [edit(0, 'hash-a', 'error')], [{ prompt: 0, line: REJECTED }])).toEqual(['unknown']);
  });

  it('is the interrupt marker\'s own record', () => {
    expect(derived(['a', '[Request interrupted by user for tool use]', 'c'], [])[1]).toBe('unknown');
  });

  it('is a prompt followed by a shell call captured before segments, when no bucket matched: it could have been an undo', () => {
    expect(derived(['a', 'b'], [edit(0), older(1)])[0]).toBe('unknown');
  });

  it('is not unknown when a bucket matched anyway: a positive record stands over an unreadable one', () => {
    expect(derived(['a', 'b'], [edit(0), older(1), edit(1)])[0]).toBe('redo');
    expect(derived(['a', 'b'], [shell(0, 'npm test', 'error'), older(1)])[0]).toBe('after-error');
  });
});

/** A Claude Code transcript where the first prompt edits a file and the second runs `command`, captured and derived: the segment is what `captureSession` makes of a real command line, not a built record. */
const fromCommandLine = (command: string): PromptIntervention | undefined => {
  const at = (second: number): string => `2026-06-01T10:00:${String(second).padStart(2, '0')}.000Z`;
  const lines = [
    { type: 'user', timestamp: at(1), message: { role: 'user', content: 'add a field' } },
    { type: 'assistant', timestamp: at(2), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/work/app/src/a.ts', old_string: 'a', new_string: 'b' } }] } },
    { type: 'user', timestamp: at(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'ok' }] } },
    { type: 'user', timestamp: at(4), message: { role: 'user', content: 'now this' } },
    { type: 'assistant', timestamp: at(5), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command } }] } },
    { type: 'user', timestamp: at(6), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', is_error: false, content: 'ok' }] } },
  ];
  const text = lines.map((line) => JSON.stringify(line)).join('\n');
  const capture = captureSession({ text, session: 's', project: 'p', rev: 1, at: '2026-06-01T00:00:00Z', bytes: text.length, redact });
  return deriveSession(capture, redact).prompts[0]?.intervention;
};

const checkoutStep = (prompt: number, flags: string[], cv?: string, target?: 'path' | 'word'): Call => ({
  ...shell(prompt, 'git checkout'),
  ...(cv === undefined ? {} : { cv }),
  steps: [{ n: 0, seg: 0, action: 'shell.exec', native: 'Bash', identity: { program: 'git', sub: 'checkout', flags, ...(target === undefined ? {} : { target }) }, status: 'ok', cost: { tokens: null, durationMs: null }, parent: null, edges: [], frameId: 'f' }],
});

describe('a checkout captured before CAPTURE 23 keeps its old reading', () => {
  it('reads a bare checkout with no flag as revert, a branch switch included: the step has no target to say otherwise', () => {
    expect(derived(['a', 'b'], [edit(0), checkoutStep(1, [], '20')])[0]).toBe('revert');
  });

  it('reads an unlisted flag as none, as it did', () => {
    expect(derived(['a', 'b'], [edit(0), checkoutStep(1, ['<literal>'], '20')])[0]).toBe('none');
  });

  it('reads the target class from CAPTURE 23: word is none, path is revert even beside an unlisted flag', () => {
    expect(derived(['a', 'b'], [edit(0), checkoutStep(1, [], '23', 'word')])[0]).toBe('none');
    expect(derived(['a', 'b'], [edit(0), checkoutStep(1, ['<literal>'], '23', 'path')])[0]).toBe('revert');
  });
});

describe('a git undo read from a real command line', () => {
  it.each(['git revert --abort', 'git revert --continue', 'git revert --quit'])('`%s` ends a revert in progress and undoes no work: none', (command) => {
    expect(fromCommandLine(command)).toBe('none');
  });

  it.each(['git revert HEAD', 'git revert --no-edit abc1234', 'git revert -n HEAD~2', 'git restore src/a.ts', 'git checkout .', 'git checkout -- src/a.ts', 'git checkout -f'])('`%s` undoes the edit: revert', (command) => {
    expect(fromCommandLine(command)).toBe('revert');
  });

  // The segment drops a flag, so `git checkout -b feature/x` and `git checkout -` leave the bare pair that `git checkout -- <path>` leaves; the step's flags tell them apart (`<literal>` for `-`, `-b` for a create). Any other flag off the public list is also `<literal>` and reads `none`; a path-only flag (`--ours`, `--patch`) is a path from CAPTURE 23.
  it.each(['git checkout -', 'git checkout -b feature/x', 'git checkout -B feature/x', 'git checkout --detach'])('`%s` moves to a branch and undoes no work: none', (command) => {
    expect(fromCommandLine(command)).toBe('none');
  });

  // CAPTURE 23 keeps the target class: `--` or a path-only flag proves a path; a dropped word (a slash, quotes) with no proof is a `word`, which is never an undo.
  it.each(['git checkout -- src/a.ts', 'git checkout --ours src/a.ts', 'git checkout --theirs -- src/a.ts', 'git checkout --patch src/a.ts', 'git checkout --patch', 'git checkout -p src/a.ts'])('`%s` names a path: revert', (command) => {
    expect(fromCommandLine(command)).toBe('revert');
  });

  it.each(['git checkout feature/x', 'git checkout origin/main', 'git checkout "main"', 'git checkout "fix-1"', 'git checkout -f feature/x'])('`%s` names a branch or a path the line cannot tell apart: none', (command) => {
    expect(fromCommandLine(command)).toBe('none');
  });

  it('reads a checkout of a plain branch name as none, since the segment keeps the name', () => {
    expect(fromCommandLine('git checkout main')).toBe('none');
  });
});

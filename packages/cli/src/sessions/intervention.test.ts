// The prompt `intervention` bucket (t882, docs/sessions-store.md "Prompt intervention"): what the next human prompt did to the work of this one. These rows run the rule over built records, so each
// bucket and each limit the doc states has a row; `intervention-harness.test.ts` runs the same scenarios through each harness's own adapter.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveSession } from './derive.js';
import { captureSession, emptyUsage } from './extract.js';
import { makeRedactor } from './redact.js';
import { CAPTURE_VERSION, EXTRACTOR_VERSION, PROMPT_INTERVENTIONS, type ErrorLineObservation, type ShellSegment, type StepObservation, type ToolObservation, type ToolStatus, type UserPromptObservation } from './schema.js';
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
    kind: 'tool', cv: CAPTURE_VERSION, sid: null, session: 's', rev: 1, parent: 's', agentType: null, n, ts: null, tool: call.tool, status: call.status ?? 'ok', target: call.target ?? null, targetBase: null,
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
  it('names the five buckets, and the extractor that writes them is version 13', () => {
    expect(PROMPT_INTERVENTIONS).toEqual(['none', 'after-error', 'redo', 'revert', 'unknown']);
    expect(Number(EXTRACTOR_VERSION)).toBeGreaterThanOrEqual(13);
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

describe('unknown', () => {
  it('is the last prompt of a transcript, whatever it did', () => {
    expect(derived(['only'], [edit(0), shell(0, 'npm test', 'error')])).toEqual(['unknown']);
    expect(derived([], [])).toEqual([]);
  });

  it('is a prompt the user rejected a call of, or interrupted: a stop has no word in the list', () => {
    expect(derived(['a', 'b'], [edit(0, 'hash-a', 'error')], [{ prompt: 0, line: REJECTED }])).toEqual(['unknown', 'unknown']);
    expect(derived(['a', '[Request interrupted by user]', 'c'], [edit(0)])).toEqual(['unknown', 'unknown', 'unknown']);
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

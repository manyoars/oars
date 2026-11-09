// A file in a form its reader fully knows but with no turn in it (a launch-and-quit session: only the harness's own head records) is empty, not unreadable.
// `unreadable` stays for a file with a record of no known kind. One head-only file per harness that has such a form, through `sessionsVerify`.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionsVerify } from './command.js';
import { chatHeadOnly } from './vscode-copilot.js';
import { eventHeadOnly } from './copilot.js';
import { rolloutHeadOnly } from './codex.js';
import { piHeadOnly } from './pi.js';
import { outcomeOf } from './harness-files.js';
import { addProject, cleanup, copilotEvent, NOW, ocUser, OTLP_BASE, piEntry, piHeader, rolloutLine, stage, stageCodex, stageCopilot, stageOpencode, stagePi, stageVscode } from './test-support.js';

afterEach(cleanup);

const A = 'aaaa1111-1111-4111-8111-111111111111';
const B = 'bbbb2222-2222-4222-8222-222222222222';
const C = 'cccc3333-3333-4333-8333-333333333333';
const T = (second: number): string => `2026-06-01T10:00:${String(second).padStart(2, '0')}.000Z`;
const WORK = '/work/app';
const MOVED = [{ record: 'turn', speaker: 'person', body: 'fix the build', at: 1 }];

const verify = async (staged: ReturnType<typeof stage>, roots: { [name: string]: string }) => {
  const runtime = { ...staged.runtime, sourceRoots: roots };
  return (await sessionsVerify({ sessions: runtime, install: undefined, now: () => NOW }, { session: undefined })).report.harnessFiles;
};

describe('outcomeOf with a head-only file', () => {
  it('is empty when the reader says the file holds only head records, whatever its size', () => {
    expect(outcomeOf({ size: 10, records: 0, headOnly: true })).toBe('empty');
  });
  it('stays unreadable when the file holds a record of no known kind, or the reader says nothing', () => {
    expect(outcomeOf({ size: 10, records: 0, headOnly: false })).toBe('unreadable');
    expect(outcomeOf({ size: 10, records: 0 })).toBe('unreadable');
  });
  it('does not turn a failed read or a yielding file into empty', () => {
    expect(outcomeOf({ size: 10, records: undefined, headOnly: true })).toBe('unreadable');
    expect(outcomeOf({ size: 10, records: 2, headOnly: true })).toBe('yielded');
  });
});

describe('the readers say what a head-only file is', () => {
  it('Codex: session_meta and turn_context alone', () => {
    const line = (type: string): string => JSON.stringify({ type, payload: {} });
    expect(rolloutHeadOnly(`${line('session_meta')}\n${line('turn_context')}\n`)).toBe(true);
    expect(rolloutHeadOnly(`${line('session_meta')}\n${line('turn_context')}\n${line('mystery')}\n`)).toBe(false);
    expect(rolloutHeadOnly('')).toBe(false);
  });
  it('Copilot: session records alone', () => {
    expect(eventHeadOnly(`${JSON.stringify({ type: 'session.start', data: {} })}\n`)).toBe(true);
    expect(eventHeadOnly(`${JSON.stringify({ type: 'session.start', data: {} })}\n${JSON.stringify({ type: 'speech.said', data: {} })}\n`)).toBe(false);
    expect(eventHeadOnly('')).toBe(false);
  });
  it('Pi: the session header alone', () => {
    expect(piHeadOnly(`${JSON.stringify({ type: 'session', id: 'x' })}\n`)).toBe(true);
    expect(piHeadOnly(`${JSON.stringify({ type: 'session', id: 'x' })}\n${JSON.stringify({ type: 'note' })}\n`)).toBe(false);
    expect(piHeadOnly('')).toBe(false);
  });
  it('VS Code Copilot Chat: a session object with an empty request list', () => {
    expect(chatHeadOnly({ version: 3, requests: [] })).toBe(true);
    expect(chatHeadOnly({ version: 3, turns: [{}] })).toBe(false);
    expect(chatHeadOnly({ version: 3, requests: [{}] })).toBe(false);
  });
});

describe('sessionsVerify, a head-only file is not unreadable', () => {
  it('Claude Code: a summary-only and a snapshot-only transcript are empty; a moved one is unreadable', async () => {
    const staged = stage();
    rmSync(join(staged.projectsRoot, 'proj'), { recursive: true });
    addProject(staged, 'p', 'good', [JSON.stringify({ type: 'user', uuid: 'u', timestamp: T(0), message: { role: 'user', content: 'hi' } })]);
    addProject(staged, 'p', 'summary', [JSON.stringify({ type: 'summary', summary: 'earlier work', leafUuid: 'x' })]);
    addProject(staged, 'p', 'snapshot', [JSON.stringify({ type: 'file-history-snapshot', messageId: 'm', snapshot: {}, isSnapshotUpdate: false })]);
    addProject(staged, 'p', 'moved', [JSON.stringify(MOVED[0])]);
    // A head record beside a record of no known kind is still unreadable.
    addProject(staged, 'p', 'mixed', [JSON.stringify({ type: 'summary', summary: 's', leafUuid: 'x' }), JSON.stringify(MOVED[0])]);
    expect((await verify(staged, {}))['claude-code']).toEqual({ seen: 3, yielded: 1, unreadable: 2 });
  });

  it('Codex: a session_meta and turn_context rollout is empty; a moved one is unreadable', async () => {
    const staged = stage();
    rmSync(join(staged.projectsRoot, 'proj'), { recursive: true });
    mkdirSync(staged.projectsRoot, { recursive: true });
    const meta = (id: string): unknown => rolloutLine(T(0), 'session_meta', { session_id: id, id, timestamp: T(0), cwd: WORK, originator: 'codex_cli_rs', cli_version: '0.50.0' });
    const home = stageCodex(staged.root, [
      { id: A, lines: [meta(A), rolloutLine(T(2), 'event_msg', { type: 'user_message', message: 'fix the build' })] },
      { id: B, lines: [meta(B), rolloutLine(T(1), 'turn_context', { model: 'gpt-5-codex', cwd: WORK })] },
      { id: C, lines: [meta(C), ...MOVED] },
    ]);
    expect((await verify(staged, { codex: home })).codex).toEqual({ seen: 2, yielded: 1, unreadable: 1 });
  });

  it('Copilot: a session.start-only log is empty; a moved one is unreadable', async () => {
    const staged = stage();
    rmSync(join(staged.projectsRoot, 'proj'), { recursive: true });
    mkdirSync(staged.projectsRoot, { recursive: true });
    const start = (id: string): unknown => copilotEvent(T(0), 'session.start', { sessionId: id, copilotVersion: '1.0.105', producer: 'copilot-agent', selectedModel: 'm', startTime: T(0), version: 1, context: { cwd: WORK } });
    const home = stageCopilot(staged.root, [
      { id: A, lines: [start(A), copilotEvent(T(1), 'user.message', { content: 'fix the build' })] },
      { id: B, lines: [start(B)] },
      { id: C, lines: MOVED },
    ]);
    expect((await verify(staged, { copilot: home })).copilot).toEqual({ seen: 2, yielded: 1, unreadable: 1 });
  });

  it('Pi: a header-only session is empty; a moved one is unreadable', async () => {
    const staged = stage();
    rmSync(join(staged.projectsRoot, 'proj'), { recursive: true });
    mkdirSync(staged.projectsRoot, { recursive: true });
    const home = stagePi(staged.root, [
      { id: A, cwd: WORK, lines: [piHeader({ id: A, cwd: WORK }), piEntry('message', 'e1', null, T(1), { message: { role: 'user', content: 'fix the build', timestamp: OTLP_BASE } })] },
      { id: B, cwd: WORK, lines: [piHeader({ id: B, cwd: WORK })] },
      { id: C, cwd: WORK, lines: [piHeader({ id: C, cwd: WORK }), ...MOVED] },
    ]);
    expect((await verify(staged, { pi: join(home, 'sessions') })).pi).toEqual({ seen: 2, yielded: 1, unreadable: 1 });
  });

  it('VS Code Copilot Chat: a session with no requests is empty; a moved one is unreadable', async () => {
    const staged = stage();
    rmSync(join(staged.projectsRoot, 'proj'), { recursive: true });
    mkdirSync(staged.projectsRoot, { recursive: true });
    const request = { requestId: 'r1', message: { text: 'fix the build', parts: [] }, variableData: { variables: [] }, response: [{ value: 'done' }], timestamp: OTLP_BASE, responseTimestamp: OTLP_BASE + 1, modelId: 'copilot/m' };
    const home = stageVscode(staged.root, [
      { id: A, hash: 'h1', workspace: { folder: `file://${WORK}` }, data: { version: 3, sessionId: A, creationDate: OTLP_BASE, requests: [request] } },
      { id: B, hash: 'h2', workspace: { folder: `file://${WORK}` }, data: { version: 3, sessionId: B, creationDate: OTLP_BASE, requests: [] } },
      { id: C, hash: 'h3', workspace: { folder: `file://${WORK}` }, data: { version: 3, sessionId: C, creationDate: OTLP_BASE, turns: MOVED } },
    ]);
    expect((await verify(staged, { 'vscode-copilot': home }))['vscode-copilot']).toEqual({ seen: 2, yielded: 1, unreadable: 1 });
  });
});

// Fix round 2 (Item 9): the head kinds each reader's own format defines and reads as carrying no turn.
describe('the readers name every head kind their format defines', () => {
  it('Codex: injected context, token_count, and turn_aborted are head; an unknown payload type is not', () => {
    const rec = (type: string, payload: object): string => JSON.stringify({ type, payload });
    const meta = rec('session_meta', {});
    expect(rolloutHeadOnly(`${meta}\n${rec('response_item', { type: 'message', role: 'user' })}\n`)).toBe(true);
    expect(rolloutHeadOnly(`${meta}\n${rec('event_msg', { type: 'token_count' })}\n${rec('event_msg', { type: 'turn_aborted' })}\n`)).toBe(true);
    // An assistant message is a turn the reader does not read from a `response_item`: a rollout whose turns moved there is unreadable, not empty.
    expect(rolloutHeadOnly(`${meta}\n${rec('response_item', { type: 'message', role: 'assistant' })}\n`)).toBe(false);
    expect(rolloutHeadOnly(`${meta}\n${rec('event_msg', { type: 'mystery' })}\n`)).toBe(false);
    expect(rolloutHeadOnly(`${meta}\n${rec('response_item', { type: 'mystery' })}\n`)).toBe(false);
    expect(rolloutHeadOnly(`${meta}\n${rec('event_msg', {})}\n`)).toBe(false);
  });
  it('Copilot: the journal link, usage checkpoint, error, and abort records are head', () => {
    const rec = (type: string): string => JSON.stringify({ type, data: {} });
    for (const type of ['session.journal_link', 'session.usage_checkpoint', 'session.error', 'abort']) expect(eventHeadOnly(`${rec('session.start')}\n${rec(type)}\n`)).toBe(true);
    expect(eventHeadOnly(`${rec('session.start')}\n${rec('session.mystery')}\n`)).toBe(false);
  });
  it('Pi: the ten non-turn entry kinds are head beside the header', () => {
    const rec = (type: string): string => JSON.stringify({ type });
    for (const type of ['model_change', 'thinking_level_change', 'usage', 'compaction', 'branch_summary', 'custom', 'custom_message', 'context_edit', 'label', 'session_info']) expect(piHeadOnly(`${rec('session')}\n${rec(type)}\n`)).toBe(true);
    expect(piHeadOnly(`${rec('session')}\n${rec('mystery')}\n`)).toBe(false);
  });
});

describe('sessionsVerify, more head-only forms are empty', () => {
  it('Claude Code: permission-mode, attachment, and system with a snapshot are empty; an unknown kind beside them is unreadable', async () => {
    const staged = stage();
    rmSync(join(staged.projectsRoot, 'proj'), { recursive: true });
    addProject(staged, 'p', 'good', [JSON.stringify({ type: 'user', uuid: 'u', timestamp: T(0), message: { role: 'user', content: 'hi' } })]);
    addProject(staged, 'p', 'mode', [JSON.stringify({ type: 'permission-mode', permissionMode: 'default' }), JSON.stringify({ type: 'file-history-snapshot', messageId: 'm', snapshot: {}, isSnapshotUpdate: false })]);
    addProject(staged, 'p', 'attach', [JSON.stringify({ type: 'attachment', attachment: { type: 'hook_success' } })]);
    addProject(staged, 'p', 'system', [JSON.stringify({ type: 'system', subtype: 'informational', content: 'x' })]);
    addProject(staged, 'p', 'moved', [JSON.stringify({ type: 'permission-mode', permissionMode: 'default' }), JSON.stringify(MOVED[0])]);
    expect((await verify(staged, {}))['claude-code']).toEqual({ seen: 2, yielded: 1, unreadable: 1 });
  });

  it('Codex: injected context and token_count after the head are empty; an unknown payload is unreadable', async () => {
    const staged = stage();
    rmSync(join(staged.projectsRoot, 'proj'), { recursive: true });
    mkdirSync(staged.projectsRoot, { recursive: true });
    const meta = (id: string): unknown => rolloutLine(T(0), 'session_meta', { session_id: id, id, timestamp: T(0), cwd: WORK, originator: 'codex_cli_rs', cli_version: '0.50.0' });
    const home = stageCodex(staged.root, [
      { id: A, lines: [meta(A), rolloutLine(T(2), 'event_msg', { type: 'user_message', message: 'fix the build' })] },
      { id: B, lines: [meta(B), rolloutLine(T(1), 'response_item', { type: 'message', role: 'user', content: [] }), rolloutLine(T(2), 'event_msg', { type: 'token_count', info: null }), rolloutLine(T(3), 'event_msg', { type: 'turn_aborted', reason: 'replaced' })] },
      { id: C, lines: [meta(C), rolloutLine(T(1), 'event_msg', { type: 'mystery' })] },
    ]);
    expect((await verify(staged, { codex: home })).codex).toEqual({ seen: 2, yielded: 1, unreadable: 1 });
  });

  it('Copilot: session.start then session.error is empty; an unknown record is unreadable', async () => {
    const staged = stage();
    rmSync(join(staged.projectsRoot, 'proj'), { recursive: true });
    mkdirSync(staged.projectsRoot, { recursive: true });
    const start = (id: string): unknown => copilotEvent(T(0), 'session.start', { sessionId: id, copilotVersion: '1.0.105', producer: 'copilot-agent', selectedModel: 'm', startTime: T(0), version: 1, context: { cwd: WORK } });
    const home = stageCopilot(staged.root, [
      { id: A, lines: [start(A), copilotEvent(T(1), 'user.message', { content: 'fix the build' })] },
      { id: B, lines: [start(B), copilotEvent(T(1), 'session.error', { message: 'boom' })] },
      { id: C, lines: [start(C), copilotEvent(T(1), 'session.mystery', {})] },
    ]);
    expect((await verify(staged, { copilot: home })).copilot).toEqual({ seen: 2, yielded: 1, unreadable: 1 });
  });

  it('Pi: a header plus model_change is empty; a header plus an unknown entry is unreadable', async () => {
    const staged = stage();
    rmSync(join(staged.projectsRoot, 'proj'), { recursive: true });
    mkdirSync(staged.projectsRoot, { recursive: true });
    const home = stagePi(staged.root, [
      { id: A, cwd: WORK, lines: [piHeader({ id: A, cwd: WORK }), piEntry('message', 'e1', null, T(1), { message: { role: 'user', content: 'fix the build', timestamp: OTLP_BASE } })] },
      { id: B, cwd: WORK, lines: [piHeader({ id: B, cwd: WORK }), piEntry('model_change', 'e1', null, T(1), { provider: 'x', modelId: 'm' })] },
      { id: C, cwd: WORK, lines: [piHeader({ id: C, cwd: WORK }), piEntry('mystery', 'e1', null, T(1))] },
    ]);
    expect((await verify(staged, { pi: join(home, 'sessions') })).pi).toEqual({ seen: 2, yielded: 1, unreadable: 1 });
  });
});

describe('sessionsVerify, an OpenCode session of rows that carry no turn', () => {
  it('a session holding only a location-switched row is empty; one holding a row of no known type is unreadable', async () => {
    const staged = stage();
    rmSync(join(staged.projectsRoot, 'proj'), { recursive: true });
    mkdirSync(staged.projectsRoot, { recursive: true });
    const row = (id: string, type: string, data: object) => ({ id, type, seq: 1, created: OTLP_BASE + 1, data });
    const opencode = await stageOpencode(staged.root, [
      { id: 'ses_good', directory: WORK, created: OTLP_BASE, updated: OTLP_BASE + 9, messages: [ocUser('m1', 1, OTLP_BASE + 1, 'fix the build')] },
      { id: 'ses_switch', directory: WORK, created: OTLP_BASE, updated: OTLP_BASE + 9, messages: [row('m2', 'location-switched', { location: { directory: WORK }, previous: { location: { directory: '/work/old' } } })] },
      { id: 'ses_moved', directory: WORK, created: OTLP_BASE, updated: OTLP_BASE + 9, messages: [row('m3', 'note', { body: 'fix the build' })] },
    ]);
    expect((await verify(staged, { opencode })).opencode).toEqual({ seen: 2, yielded: 1, unreadable: 1 });
  });
});

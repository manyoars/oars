// One file that yields and one in a changed record shape for every harness the store reads, run through `sessionsVerify`: all three counts per harness.
// Every store is built under the test's own temp folder; no real harness store is opened.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionsVerify } from './command.js';
import { SOURCES } from './sources.js';
import {
  cleanup,
  copilotEvent,
  geminiHead,
  grokUpdate,
  NOW,
  ocAssistant,
  ocUser,
  OTLP_BASE,
  otlpRequest,
  otlpSpan,
  piEntry,
  piHeader,
  stage,
  stageCopilot,
  stageCursor,
  stageGemini,
  stageGrok,
  stageOpencode,
  stageOtel,
  stagePi,
  stageVscode,
} from './test-support.js';

afterEach(cleanup);

const A = 'aaaa1111-1111-4111-8111-111111111111';
const B = 'bbbb2222-2222-4222-8222-222222222222';
const C = 'cccc3333-3333-4333-8333-333333333333';
const T = (second: number): string => `2026-06-01T10:00:${String(second).padStart(2, '0')}.000Z`;
const MS = (second: number): number => OTLP_BASE + second * 1000;
const WORK = '/work/app';
// A line that parses as JSON but has none of the keys any reader looks for: the same file after a vendor renamed its record fields.
const MOVED = [{ record: 'turn', speaker: 'person', body: 'fix the build', at: 1 }];

describe('sessionsVerify, one yielding and one moved-shape file per harness', () => {
  it('counts each harness on its own, and prints counts and harness names only', async () => {
    const staged = stage();
    rmSync(join(staged.projectsRoot, 'proj'), { recursive: true });
    mkdirSync(staged.projectsRoot, { recursive: true });
    const { root } = staged;

    const cursor = await stageCursor(root, [
      { id: 'good', createdAt: MS(0), lastUpdatedAt: MS(9), bubbles: [{ type: 1, text: 'fix the build' }, { type: 2, text: 'done' }] },
      { id: 'moved', createdAt: MS(0), lastUpdatedAt: MS(9), bubbles: [{ type: 1, text: 'fix the build' }, { type: 2, text: 'done' }] },
    ]);
    // The second composer keeps its header, but its message records now name the speaker under another key.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(cursor, 'globalStorage', 'state.vscdb'));
    db.exec(`update cursorDiskKV set value = replace(replace(value, '"type":', '"speaker":'), '"text":', '"body":') where key like 'bubbleId:moved:%'`);
    db.close();
    const copilot = stageCopilot(root, [
      {
        id: A,
        lines: [
          copilotEvent(T(0), 'session.start', { sessionId: A, copilotVersion: '1.0.105', producer: 'copilot-agent', selectedModel: 'claude-sonnet-4.5', startTime: T(0), version: 1, context: { cwd: WORK } }),
          copilotEvent(T(1), 'user.message', { content: 'fix the build' }),
          copilotEvent(T(2), 'assistant.message', { messageId: 'm2', content: 'done', model: 'claude-sonnet-4.5' }),
        ],
      },
      { id: B, lines: MOVED },
    ]);
    const gemini = stageGemini(root, [
      {
        id: A,
        projectRoot: WORK,
        lines: [geminiHead(A), { id: 'u1', timestamp: T(1), type: 'user', content: [{ text: 'fix the build' }] }, { id: 'g2', timestamp: T(2), type: 'gemini', content: 'done', model: 'gemini-2.5-pro' }],
      },
      // The reader keeps a file it cannot parse a line of; one whose records name no message type it knows is skipped as a chat that holds nothing, as a head-only file is, so it is not seen.
      { id: B, slug: 'moved', projectRoot: WORK, lines: `${JSON.stringify(geminiHead(B))}
{"id":"u1","type":"user","content":[{"text":
` },
      { id: C, slug: 'skipped', projectRoot: WORK, lines: [geminiHead(C), { id: 'u1', timestamp: T(1), type: 'human', content: [{ text: 'fix the build' }] }] },
    ]);
    const grok = stageGrok(root, [
      {
        id: A,
        cwd: WORK,
        updates: [
          grokUpdate(MS(1) / 1000, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'fix the build' } }),
          grokUpdate(MS(2) / 1000, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }),
        ],
      },
      { id: B, cwd: '/work/moved', updates: MOVED },
    ]);
    const opencode = await stageOpencode(root, [
      { id: 'ses_good', directory: WORK, created: MS(0), updated: MS(9), messages: [ocUser('m1', 1, MS(1), 'fix the build'), ocAssistant('m2', 2, MS(2), [{ type: 'text', text: 'done' }])] },
      { id: 'ses_moved', directory: WORK, created: MS(0), updated: MS(9), messages: [{ id: 'm3', type: 'note', seq: 1, created: MS(1), data: { speaker: 'person', body: 'fix the build' } }] },
    ]);
    const pi = stagePi(root, [
      {
        id: A,
        cwd: WORK,
        lines: [
          piHeader({ id: A, cwd: WORK }),
          piEntry('message', 'e1', null, T(1), { message: { role: 'user', content: 'fix the build', timestamp: MS(1) } }),
          piEntry('message', 'e2', 'e1', T(2), { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], model: 'claude-sonnet-4-5', stopReason: 'stop', timestamp: MS(2) } }),
        ],
      },
      { id: B, cwd: '/work/moved', lines: [piHeader({ id: B, cwd: '/work/moved' }), ...MOVED] },
    ]);
    const vscode = stageVscode(root, [
      {
        id: A,
        hash: 'h1',
        workspace: { folder: `file://${WORK}` },
        data: {
          version: 3,
          sessionId: A,
          creationDate: MS(0),
          requests: [{ requestId: 'r1', message: { text: 'fix the build', parts: [] }, variableData: { variables: [] }, response: [{ value: 'done' }], timestamp: MS(1), responseTimestamp: MS(2), modelId: 'copilot/claude-sonnet-4.5' }],
        },
      },
      { id: B, hash: 'h2', workspace: { folder: 'file:///work/moved' }, data: { version: 3, sessionId: B, creationDate: MS(0), turns: MOVED } },
    ]);
    const span = (trace: string, attrs: { [key: string]: unknown }): object => otlpSpan({ trace, id: '0000000000000001', name: 'invoke_agent support', start: 0, end: 10, attrs });
    const otel = stageOtel(root, [
      { name: 'good.jsonl', lines: [otlpRequest([span('a'.repeat(32), { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'support', 'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: 'fix the build' }] }] })])] },
      // The agent span is there, but its input messages are in a shape the reader does not know (renamed `role` and `parts`).
      { name: 'moved.jsonl', lines: [otlpRequest([span('b'.repeat(32), { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'support', 'gen_ai.input.messages': [{ who: 'user', text: 'fix the build' }] })])] },
    ]);

    const runtime = { ...staged.runtime, cursorRoot: cursor, sourceRoots: { copilot, gemini, grok, opencode, pi: join(pi, 'sessions'), 'vscode-copilot': vscode, otel } };
    const verified = await sessionsVerify({ sessions: runtime, install: undefined, now: () => NOW }, { session: undefined });
    const counts = verified.report.harnessFiles;
    for (const harness of ['copilot', 'gemini', 'grok', 'opencode', 'pi', 'vscode-copilot', 'otel']) {
      expect({ harness, counts: counts[harness] }).toEqual({ harness, counts: { seen: 2, yielded: 1, unreadable: 1 } });
    }
    expect(counts['cursor']).toEqual({ seen: 2, yielded: 1, unreadable: 1 });
    expect(Object.keys(counts).sort()).toEqual(SOURCES.map((source) => source.harness).filter((harness) => harness !== 'codex').sort());
    for (const counted of Object.values(counts)) expect(counted.seen).toBe(counted.yielded + counted.unreadable);
    expect(verified.document).toMatchObject({ harnessFiles: counts });

    // Counts and harness names only: no path, session id, or content reaches the text.
    for (const secret of [root, A, B, C, 'fix the build', 'ses_good', 'ses_moved', WORK, 'moved']) expect(verified.text).not.toContain(secret);
    expect(JSON.stringify(verified.document)).not.toContain('fix the build');
  });
});

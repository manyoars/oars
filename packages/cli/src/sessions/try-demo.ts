// The bundled demo behind `oars sessions try`. EVERYTHING HERE IS MADE UP: three invented Claude Code sessions in an invented project
// (`/work/demo`), written so the same two errors recur. No line comes from a real session, a real person, or a real repository, and no
// number `try` prints from it describes anyone's work. The sessions are lines of the same shape Claude Code writes, so the demo runs the
// real deposit, recall, books, and hook code and not a canned answer.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { slugOf } from './allow.js';

/** The invented working directory the demo sessions claim; no such folder is read. Resolved, because a folder's name is its path's slug on this platform. */
export const DEMO_CWD = resolve('/work/demo');
/** The folder Claude Code would name for `DEMO_CWD` under `~/.claude/projects`. */
export const DEMO_FOLDER = slugOf(DEMO_CWD);
/** An error the three demo sessions all hit, as a stranger would paste it. */
export const DEMO_ERROR = 'unexpected EOF while looking for matching quote';

const SHELL_ERROR = `Exit code 2\nbash: -c: line 1: ${DEMO_ERROR}\n`;
const WRITE_ERROR = 'File has not been read yet. Read it first before writing to it.';

interface Turn {
  tool: string;
  input: { [key: string]: string };
  result: string;
  isError: boolean;
}

interface DemoSession {
  id: string;
  day: string;
  prompt: string;
  turns: Turn[];
}

const shell = (command: string, result: string, isError = false): Turn => ({ tool: 'Bash', input: { command }, result, isError });
const read = (file: string): Turn => ({ tool: 'Read', input: { file_path: file }, result: 'file contents', isError: false });
const edit = (file: string, result: string, isError = false): Turn => ({ tool: 'Write', input: { file_path: file, content: 'echo ok' }, result, isError });

const SESSIONS: DemoSession[] = [
  {
    id: 'demo-0001',
    day: '2026-10-06',
    prompt: 'fix the failing build in /work/demo/src/main.ts',
    turns: [read('/work/demo/src/main.ts'), shell("echo 'it's broken", SHELL_ERROR, true), edit('/work/demo/fix.sh', WRITE_ERROR, true), read('/work/demo/fix.sh'), edit('/work/demo/fix.sh', 'ok'), shell('npm test', 'all passed')],
  },
  {
    id: 'demo-0002',
    day: '2026-10-13',
    prompt: 'add a test for the parser in /work/demo/src/parse.ts',
    turns: [read('/work/demo/src/parse.ts'), shell("git commit -m 'add parser test", SHELL_ERROR, true), shell('git commit -m "add parser test"', 'committed'), shell('npm test', 'all passed')],
  },
  {
    id: 'demo-0003',
    day: '2026-10-20',
    prompt: 'why is the deploy script slow',
    turns: [read('/work/demo/deploy.sh'), edit('/work/demo/deploy.sh', WRITE_ERROR, true), read('/work/demo/deploy.sh'), shell("echo 'timing", SHELL_ERROR, true)],
  },
];

const stamp = (day: string, second: number): string => `${day}T10:${String(Math.floor(second / 60)).padStart(2, '0')}:${String(second % 60).padStart(2, '0')}.000Z`;

/** One session as the JSON lines Claude Code writes: a prompt, then per turn an assistant tool call and the user line that carries its result. */
const linesOf = (session: DemoSession): string[] => {
  let at = 0;
  let parent: string | null = null;
  const next = (): { uuid: string; time: string; parentUuid: string | null } => {
    at += 3;
    const uuid = `${session.id}-${String(at).padStart(4, '0')}`;
    const line = { uuid, time: stamp(session.day, at), parentUuid: parent };
    parent = uuid;
    return line;
  };
  const common = { isSidechain: false, version: '2.1.300' };
  const first = next();
  const lines: object[] = [{ type: 'user', ...common, uuid: first.uuid, parentUuid: null, timestamp: first.time, cwd: DEMO_CWD, gitBranch: 'main', message: { role: 'user', content: session.prompt } }];
  session.turns.forEach((turn, index) => {
    const call = next();
    const result = next();
    const id = `t${String(index + 1)}`;
    lines.push({
      type: 'assistant',
      ...common,
      uuid: call.uuid,
      parentUuid: call.parentUuid,
      timestamp: call.time,
      requestedModel: 'claude-opus-5-5',
      requestId: `req_${session.id}_${String(index + 1)}`,
      apiBlockIndex: 0,
      message: {
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'tool_use', id, name: turn.tool, input: turn.input }],
        usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 9000, output_tokens: 80 },
      },
    });
    lines.push({
      type: 'user',
      ...common,
      uuid: result.uuid,
      parentUuid: result.parentUuid,
      timestamp: result.time,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: turn.isError, content: turn.result }] },
    });
  });
  return lines.map((line) => JSON.stringify(line));
};

/** Writes the demo sessions under `<projectsRoot>/<DEMO_FOLDER>/`, the layout Claude Code uses. */
export const writeDemoSessions = async (projectsRoot: string): Promise<void> => {
  const folder = join(projectsRoot, DEMO_FOLDER);
  await mkdir(folder, { recursive: true });
  await Promise.all(SESSIONS.map((session) => writeFile(join(folder, `${session.id}.jsonl`), `${linesOf(session).join('\n')}\n`)));
};

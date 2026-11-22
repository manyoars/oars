// The failed command a Codex PostToolUse hook cannot see: the hook's `tool_response` is the command's output text with no exit code (the `Process exited with code N` line is only in the
// model-facing header the rollout records), so a failure is read from the rollout at `transcript_path`. PostToolUse fires on every call, so the read is the rollout's last
// `TAIL_BYTES` (transcript-tail.ts) and never the file: a rollout is a long session's whole record, and a hook that read it would cost every call.
import { tailOf } from './transcript-tail.js';

type Obj = { [key: string]: unknown };
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

// The two spellings of a finished command's exit line, and the line the header ends at. This is the one definition: codex.ts (the reader) and codex-hook.ts (the recorder) import it, so a call is
// a failure to the recorder exactly when it is one to the push. It lives here because this file is light enough for the hook bin to load.
export const EXIT_LINE = /^(?:Exit code: |Process exited with code )(-?\d+)\s*$/m;
export const OUTPUT_MARK = /(?:^|\n)Output:\n?/;

/** A `function_call_output` body: a bare string, or an array of `{type: input_text, text}` items (the same two forms codex.ts reads). */
const bodyOf = (raw: unknown): string => {
  if (!Array.isArray(raw)) return str(raw) ?? '';
  return raw.map((item) => (isObj(item) ? (str(item.text) ?? '') : '')).filter((text) => text !== '').join('\n');
};

/**
 * The failure text of a finished command, in the form the hooks read a Claude Code failure (`Exit code N`, then what the command printed); undefined for a zero exit and for a body
 * with no exit line (a call that is still running, an MCP call, a call that failed before it ran). A negative code is no exit status, so the message stands alone then.
 */
export const failureOfOutput = (body: string): string | undefined => {
  const mark = OUTPUT_MARK.exec(body);
  if (mark === null) return undefined;
  const code = EXIT_LINE.exec(body.slice(0, mark.index))?.[1];
  if (code === undefined || Number(code) === 0) return undefined;
  const printed = body.slice(mark.index + mark[0].length);
  return Number(code) < 0 && printed.trim() !== '' ? printed : `Exit code ${code}\n${printed}`;
};

/**
 * The failure of the call `callId` named, from the tail of the rollout at `file`. The newest `function_call_output` with that `call_id` decides; no such line in the tail (the call is older
 * than the tail, the rollout is not there, or the id is not a Codex call id) is no failure, because a recall for a call that did not fail is worse than none.
 */
export const callFailureOf = async (file: string | undefined, callId: string | undefined): Promise<string | undefined> => {
  if (file === undefined || callId === undefined) return undefined;
  let tail: string;
  try {
    tail = await tailOf(file);
  } catch {
    return undefined;
  }
  const lines = tail.split('\n');
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const line = lines[at] ?? '';
    // A cheap test first: only the line that names this call is worth a parse, and the tail's cut first line never names it whole.
    if (!line.includes(callId)) continue;
    try {
      const entry: unknown = JSON.parse(line);
      const payload = isObj(entry) && entry.type === 'response_item' ? entry.payload : undefined;
      if (isObj(payload) && payload.type === 'function_call_output' && payload.call_id === callId) return failureOfOutput(bodyOf(payload.output));
    } catch {
      // A line that is not JSON.
    }
  }
  return undefined;
};

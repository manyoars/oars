import { describe, expect, it } from 'vitest';
import { captureSession, errorCodeOf } from './extract.js';
import { projectErrorCode } from './projection.js';
import { makeRedactor } from './redact.js';
import { ERROR_CODES, HTTP_STATUSES } from './schema.js';

const line = (value: object): string => JSON.stringify(value);

/** One prompt, one call, one failed result with the given text. `none` leaves the result out. */
const failedCall = (name: string, result: string, isError = true) => {
  const text = [
    line({ type: 'user', timestamp: '2026-05-29T04:30:00Z', message: { role: 'user', content: 'p' } }),
    line({ type: 'assistant', timestamp: '2026-05-29T04:30:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name, input: { command: 'make' } }] } }),
    ...(result === 'none' ? [] : [line({ type: 'user', timestamp: '2026-05-29T04:30:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', is_error: isError, content: result }] } })]),
  ].join('\n');
  const [tool] = captureSession({ text, session: 's', project: 'p', rev: 1, at: 'x', bytes: 1, redact: makeRedactor([]) }).tools;
  return tool;
};

describe('errorCode classes of a failed call', () => {
  it.each([
    ['exit 0 on a result the harness flagged', 'Exit code 0\nsomething', '0'],
    ['exit 1', 'Exit code 1\nmake: *** [all] Error 1', '1'],
    ['exit 2', 'Exit code 2\nusage: tool', '2'],
    ['exit 126, not executable', 'Exit code 126\npermission denied', '126'],
    ['exit 127, not found', 'Exit code 127\nbash: acme-deploy: command not found', '127'],
    ['exit 130, a signal', 'Exit code 130', 'signal'],
    ['exit 137, a kill', 'Exit code 137\nKilled', 'signal'],
    ['exit 192, the last signal', 'Exit code 192', 'signal'],
    ['exit 193, past the signals', 'Exit code 193', 'other'],
    ['exit 255, an ssh failure or a spawn that never ran', 'Exit code 255', 'other'],
    ['exit 1 with a colon', 'Exit code: 1\nfailed', '1'],
    ['exit 128, not a signal', 'Exit code 128', 'other'],
    ['exit 3', 'Exit code 3', 'other'],
    ['exit 125', 'Exit code 125', 'other'],
    ['exit -1, a harness that has none to report', 'Exit code -1\nfailed to spawn', 'other'],
    ['HTTP 404', 'Request failed with status code 404', '404'],
    ['HTTP 429', 'Error: HTTP 429 Too Many Requests', '429'],
    ['HTTP 529', 'API Error: status 529 overloaded', '529'],
    ['HTTP 418, outside the list', 'Request failed with status code 418', 'other'],
    ['HTTP 301, not an error status', 'Request failed with status code 301', 'other'],
    ['a rejected call', "The user doesn't want to proceed with this tool use. The tool use was rejected.", 'user-rejected'],
    ['a declined Codex shell call', 'exec command rejected by user', 'user-rejected'],
    ['a declined Codex patch', 'patch rejected by user', 'user-rejected'],
    ['a Gemini call the user cancelled', '[Operation Cancelled] User cancelled tool execution.', 'user-rejected'],
    ['output that only mentions a rejection', 'make: exec command rejected by user in the log', 'other'],
    ['an interrupted call', '[Request interrupted by user for tool use]', 'interrupted'],
    ['a denied permission', 'Permission to use Bash with command rm -rf has been denied.', 'permission-denied'],
    ['an input validation failure', '<tool_use_error>InputValidationError: Read failed due to the following issue: missing parameter</tool_use_error>', 'input-validation'],
    ['any other tool use error', '<tool_use_error>File does not exist.</tool_use_error>', 'tool-use-error'],
    ['a timeout', 'Command timed out after 120s', 'timeout'],
    ['text that names nothing', 'something went wrong in AcmeBilling', 'other'],
  ])('%s', (_name, text, expected) => {
    expect(errorCodeOf(text)).toBe(expected);
  });

  it('stores the class on the call that failed, and nothing on a call that did not', () => {
    expect(failedCall('Bash', 'Exit code 127\nbash: acme-deploy: command not found')?.errorCode).toBe('127');
    expect(failedCall('WebFetch', 'Request failed with status code 503')?.errorCode).toBe('503');
    expect(failedCall('Bash', 'all good', false)).not.toHaveProperty('errorCode');
    expect(failedCall('Bash', 'none')).not.toHaveProperty('errorCode');
  });

  it('stores other for a failed call of a harness that reports no exit code and no class', () => {
    expect(failedCall('Bash', 'the build broke')?.errorCode).toBe('other');
  });

  it('reads an exit code only from the first line, so a number in the output is not one', () => {
    expect(errorCodeOf('make failed\nExit code 127 was printed by a wrapper')).toBe('other');
  });

  it('never carries error text into the value: every class is a member of the closed list', () => {
    const planted = 'AcmeBilling /home/alicesmith/secret-project sk-live-abc123';
    const inputs = [`Exit code 1\n${planted}`, `Request failed with status code 404 ${planted}`, `<tool_use_error>${planted}</tool_use_error>`, planted, `Exit code 99999999999999999999 ${planted}`];
    for (const text of inputs) {
      const code = errorCodeOf(text);
      expect(ERROR_CODES.has(code)).toBe(true);
      expect(code).not.toMatch(/Acme|alicesmith|sk-live/);
    }
    for (const status of HTTP_STATUSES) expect(errorCodeOf(`status code ${status}`)).toBe(status);
  });
});

describe('projectErrorCode', () => {
  it.each([...ERROR_CODES])('keeps the class %s', (code) => {
    expect(projectErrorCode(code)).toBe(code);
  });

  it('projects anything else, a missing value, or planted text to other', () => {
    expect(projectErrorCode(undefined)).toBe('other');
    expect(projectErrorCode('Exit code 1 AcmeBilling')).toBe('other');
    expect(projectErrorCode('418')).toBe('other');
    expect(projectErrorCode('constructor')).toBe('other');
    expect(projectErrorCode('__proto__')).toBe('other');
  });
});

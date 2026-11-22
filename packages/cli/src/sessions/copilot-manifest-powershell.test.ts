// The manifest's `powershell` command, run under a real `pwsh` against a stub `oars-hook` that echoes its stdin: Windows PowerShell decodes a piped UTF-8 payload in the console's
// code page unless the command sets the encodings, and `modifiedTransformedPrompt` replaces the model-facing prompt, so a mangled prompt would reach the model. A shell that is not installed is not run.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
/** The PowerShells a Copilot `powershell` command can run under: PowerShell 7 (`pwsh`) and, on Windows, Windows PowerShell 5.1, whose console encodings are the OEM code page. */
const SHELLS = ['pwsh', 'powershell'] as const;
const probe = (shell: string, script: string): boolean => spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' }).status === 0;
const installed = SHELLS.filter((shell) => (shell === 'powershell' ? process.platform === 'win32' : true) && probe(shell, 'exit 0'));

const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
});

const powershellOf = (event: string): string => {
  const manifest: unknown = JSON.parse(readFileSync(join(root, 'com.github.copilot/hooks/hooks.json'), 'utf8'));
  const hooks: unknown = typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'hooks') : undefined;
  const entries: unknown = typeof hooks === 'object' && hooks !== null ? Reflect.get(hooks, event) : undefined;
  const entry: unknown = Array.isArray(entries) ? entries[0] : undefined;
  const command: unknown = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'powershell') : undefined;
  if (typeof command !== 'string') throw new Error(`no powershell command for ${event}`);
  return command;
};

/** Which launcher the stub `oars-hook` is: the `.cmd` shim alone, or with the `.ps1` shim npm writes beside it on Windows, which PowerShell resolves first. */
type Launcher = 'cmd' | 'npm';

/** A folder holding an `oars-hook` that writes its stdin bytes back unchanged, in the platform's own launcher kind (a `.cmd` on Windows, a script elsewhere; `npm` adds the `.ps1`, shaped like npm's `$input | & node ... $args`). */
const stubFolder = (launcher: Launcher = 'cmd'): string => {
  // The long form: a runner's temp dir comes back from `tmpdir()` as an 8.3 short path (`RUNNER~1`), while PowerShell's `Get-Command` reports the long one.
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'oars-ps-stub-')));
  made.push(folder);
  const echo = join(folder, 'echo.mjs');
  writeFileSync(echo, 'const chunks = [];\nfor await (const chunk of process.stdin) chunks.push(chunk);\nprocess.stdout.write(Buffer.concat(chunks));\n');
  if (process.platform === 'win32') {
    writeFileSync(join(folder, 'oars-hook.cmd'), `@echo off\r\n"${process.execPath}" "${echo}" %*\r\n`);
    if (launcher === 'npm') writeFileSync(join(folder, 'oars-hook.ps1'), `$input | & "${process.execPath}" "${echo}" $args\r\nexit $LASTEXITCODE\r\n`);
  } else {
    const script = join(folder, 'oars-hook');
    writeFileSync(script, `#!/bin/sh\nexec "${process.execPath}" "${echo}" "$@"\n`);
    chmodSync(script, 0o755);
  }
  return folder;
};

const runPowershell = (shell: string, command: string, stdin: Buffer, folder: string, policy = 'Bypass'): Promise<{ stdout: Buffer; code: number | null }> =>
  new Promise((resolve, reject) => {
    const env = { ...process.env, PATH: `${folder}${delimiter}${process.env.PATH ?? ''}` };
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', ...(process.platform === 'win32' ? ['-ExecutionPolicy', policy] : []), '-Command', command], { env, stdio: ['pipe', 'pipe', 'ignore'], timeout: 60_000 });
    const out: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      out.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout: Buffer.concat(out), code });
    });
    child.stdin.end(stdin);
  });

describe.each(installed)('the manifest powershell command under %s', (shell) => {
  it('hands a non-ASCII userPromptTransformed payload to oars-hook byte for byte (curly quotes, an accent, an emoji)', async () => {
    const payload = JSON.stringify({ sessionId: 's', cwd: 'work/app', prompt: 'raw', transformedPrompt: 'say “hello” to René \u{1F680} — café' });
    const { stdout, code } = await runPowershell(shell, powershellOf('userPromptTransformed'), Buffer.from(payload, 'utf8'), stubFolder());
    expect(code).toBe(0);
    // PowerShell ends a string it pipes to a native command with a newline; the JSON reader ignores it.
    expect(stdout.toString('utf8').replace(/\r?\n$/, '')).toBe(payload);
  });

  // npm writes `oars-hook`, `oars-hook.cmd`, and `oars-hook.ps1` on Windows, and PowerShell runs the `.ps1`, so the `.cmd` case above never exercises the path a Copilot user's shell takes.
  // `Bypass` keeps this case about encoding; what the default policy does to the shim is a separate question (the report).
  it.runIf(process.platform === 'win32')('hands the same payload through the npm-style oars-hook.ps1 shim, the one PowerShell resolves first', async () => {
    const folder = stubFolder('npm');
    const resolved = await runPowershell(shell, '(Get-Command oars-hook).Source', Buffer.alloc(0), folder);
    expect(resolved.stdout.toString('utf8').trim()).toBe(join(folder, 'oars-hook.ps1'));
    const payload = JSON.stringify({ sessionId: 's', cwd: 'work/app', prompt: 'raw', transformedPrompt: 'say “hello” to René \u{1F680} — café' });
    const { stdout, code } = await runPowershell(shell, powershellOf('userPromptTransformed'), Buffer.from(payload, 'utf8'), folder);
    expect(code).toBe(0);
    expect(stdout.toString('utf8').replace(/\r?\n$/, '')).toBe(payload);
  });

  // Starting the child from a DBCS console encoding (936) must not corrupt the payload: it fails without the command's `[Console]::InputEncoding` statement (6 failures with it removed, this case among them).
  it.runIf(process.platform === 'win32')('keeps the payload byte for byte when the child starts from a DBCS console encoding (code page 936)', async () => {
    const payload = JSON.stringify({ sessionId: 's', cwd: 'work/app', prompt: 'raw', transformedPrompt: 'say “hello” to René \u{1F680} — café' });
    const command = `[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(936); ${powershellOf('userPromptTransformed')}`;
    const { stdout, code } = await runPowershell(shell, command, Buffer.from(payload, 'utf8'), stubFolder('npm'));
    expect(code).toBe(0);
    expect(stdout.toString('utf8').replace(/\r?\n$/, '')).toBe(payload);
  });

  // Windows PowerShell 5.1 ships with the Restricted policy, which refuses the `.ps1` shim. Copilot logs a hook that exits with anything but 0 or 2 and carries on (hooks reference, "Exit codes for command hooks"),
  // and this manifest registers no preToolUse hook, so the hook fails open: no recall, no block. Exit 2 would be read as additionalContext on PostToolUseFailure, so the code must not be 2.
  it.runIf(shell === 'powershell' && process.platform === 'win32')('fails open when the execution policy refuses the oars-hook.ps1 shim: exit 1, nothing on stdout, never exit 2', async () => {
    const { stdout, code } = await runPowershell(shell, powershellOf('PostToolUseFailure'), Buffer.from('{}', 'utf8'), stubFolder('npm'), 'Restricted');
    expect(code).toBe(1);
    expect(stdout.length).toBe(0);
  });

  it('does nothing and prints nothing when oars-hook is not on the PATH', async () => {
    // Only where the machine itself has no oars-hook: a developer machine with the real one installed cannot show the guard.
    if (!probe(shell, 'if (Get-Command oars-hook -ErrorAction SilentlyContinue) { exit 1 }')) return;
    const { stdout, code } = await runPowershell(shell, powershellOf('SessionStart'), Buffer.from('{}', 'utf8'), mkdtempSync(join(tmpdir(), 'oars-ps-empty-')));
    expect(code).toBe(0);
    expect(stdout.length).toBe(0);
  });
});

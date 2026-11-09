// What followed a failed call is descriptive: a later edit that itself failed wrote nothing, so it is not an edit that followed, though the call still shows in `next`.
import { describe, expect, it } from 'vitest';
import type { CanonicalAction } from './actions.js';
import { recoveryCallsOf, type Followed } from './recovery-calls.js';

const call = (action: CanonicalAction, status: Followed['status'] = 'ok', over: Partial<Followed> = {}): Followed => ({ side: false, prompt: 0, status, steps: [{ action }], ...over });

describe('recoveryCallsOf', () => {
  it('reads no edit after a failure when the only edit also failed, and keeps the call in the list of what followed', () => {
    const calls = [call('shell.exec', 'error'), call('file.read'), call('file.edit', 'error')];
    expect(recoveryCallsOf(calls, 0)).toEqual({ next: ['file.read', 'file.edit'], editFollowed: false });
  });

  it('still reads an edit after a failure when the edit came back clean', () => {
    const calls = [call('shell.exec', 'error'), call('file.read'), call('file.edit')];
    expect(recoveryCallsOf(calls, 0)).toEqual({ next: ['file.read', 'file.edit'], editFollowed: true });
  });

  it('reads an edit after a failure when a failed edit is followed by a clean write', () => {
    const calls = [call('shell.exec', 'error'), call('file.edit', 'error'), call('file.write')];
    expect(recoveryCallsOf(calls, 0)).toEqual({ next: ['file.edit', 'file.write'], editFollowed: true });
  });

  it('counts an edit whose result was not recorded, because nothing says it failed', () => {
    const calls = [call('shell.exec', 'error'), call('file.write', 'none'), call('file.edit', 'other')];
    expect(recoveryCallsOf(calls, 0)).toEqual({ next: ['file.write', 'file.edit'], editFollowed: true });
  });

  it('reads no edit when every edit in the window failed, for a skeleton call as well as a stored one', () => {
    const calls = [call('shell.exec', 'error'), call('file.edit', 'error'), call('file.write', 'error'), call('file.search')];
    expect(recoveryCallsOf(calls, 0)?.editFollowed).toBe(false);
  });

  it('is null for a call that did not fail', () => {
    expect(recoveryCallsOf([call('file.edit'), call('file.edit', 'error')], 0)).toBeNull();
    expect(recoveryCallsOf([call('file.edit')], 3)).toBeNull();
  });
});

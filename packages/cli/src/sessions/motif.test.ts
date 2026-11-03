import { describe, expect, it } from 'vitest';
import { motifsOf, namedId, shapeId, stepsOfCall, MOTIF_LENGTHS, motifName, type WindowStep } from './motif.js';
import type { StepObservation, ToolObservation } from './schema.js';

const call = (over: Partial<ToolObservation>): ToolObservation => ({
  kind: 'tool',
  cv: '7',
  sid: 'aaaaaaaa',
  session: 's',
  rev: 1,
  parent: 's',
  agentType: null,
  n: 0,
  ts: null,
  tool: 'Read',
  status: 'ok',
  target: 'hash-under-salt-a',
  targetBase: 'repo',
  keys: [],
  durationMs: 5,
  toolUseId: null,
  harnessVersion: null,
  side: false,
  prompt: 0,
  ...over,
});

const captured = (over: Pick<StepObservation, 'action' | 'native' | 'n' | 'seg' | 'frameId'> & Partial<StepObservation>): StepObservation => ({ identity: null, status: 'ok', cost: { tokens: null, durationMs: null }, parent: null, edges: [], ...over });

const step = (action: WindowStep['action'], identity: WindowStep['identity'] = null): WindowStep => ({ action, identity });

describe('motif IDs', () => {
  it('joins the same shape from two differently salted accounts, in two frames', () => {
    const steps = (sid: string, target: string, frameId: string) =>
      [call({ sid, target, steps: [captured({ n: 0, seg: 0, action: 'file.read', native: 'Read', frameId })] }), call({ sid, target, n: 1, tool: 'Edit', steps: [captured({ n: 1, seg: 0, action: 'file.edit', native: 'Edit', frameId })] })].flatMap((tool) =>
        stepsOfCall(tool, 'claude-code'),
      );
    const one = steps('aaaaaaaa', 'hash-under-salt-a', 'frame-one');
    const two = steps('bbbbbbbb', 'hash-under-salt-b', 'frame-two');
    expect(shapeId(one)).toBe(shapeId(two));
    expect(namedId(one)).toBe(namedId(two));
  });

  it('tells two identities apart at named only', () => {
    const one = [step('shell.exec', { program: 'git', sub: 'status', flags: [] }), step('file.edit')];
    const two = [step('shell.exec', { program: 'npm', sub: 'test', flags: [] }), step('file.edit')];
    expect(shapeId(one)).toBe(shapeId(two));
    expect(namedId(one)).not.toBe(namedId(two));
  });

  it('reads an identity by content, whatever order its fields were written in', () => {
    expect(namedId([step('mcp.call', { server: 'a', tool: 'b' })])).toBe(namedId([step('mcp.call', { tool: 'b', server: 'a' })]));
  });

  it('does not mistake a level for the other, or a longer shape for a shorter one', () => {
    const steps = [step('file.read'), step('file.edit')];
    expect(shapeId(steps)).not.toBe(namedId(steps));
    expect(shapeId(steps)).not.toBe(shapeId([...steps, step('file.edit')]));
    expect(shapeId(steps)).not.toBe(shapeId([step('file.edit'), step('file.read')]));
  });
});

describe('stepsOfCall', () => {
  it('takes the action a record captured', () => {
    expect(stepsOfCall(call({ steps: [captured({ n: 0, seg: 0, action: 'file.write', native: 'Read', frameId: 'f' })] }), 'claude-code')).toEqual([{ action: 'file.write', identity: null, status: 'ok', tokens: 0, durationMs: 5 }]);
  });

  it('reads a record captured before steps existed through the same action table, under its own harness', () => {
    expect(stepsOfCall(call({ tool: 'Bash' }), 'claude-code')[0]?.action).toBe('shell.exec');
    expect(stepsOfCall(call({ tool: 'not-a-tool' }), 'claude-code')[0]?.action).toBe('other');
  });

  it('reads identity, status, and cost per segment when capture states them, and counts a call duration once', () => {
    const steps = [
      captured({ n: 0, seg: 0, action: 'shell.exec', native: 'Bash', frameId: 'f', identity: { program: 'git', sub: null, flags: [] }, status: 'ok', cost: { tokens: 7, durationMs: null } }),
      captured({ n: 0, seg: 1, action: 'shell.exec', native: 'Bash', frameId: 'f', identity: { program: 'npm', sub: null, flags: [] }, status: 'error' }),
    ];
    expect(stepsOfCall(call({ tool: 'Bash', status: 'error', steps }), 'claude-code')).toEqual([
      { action: 'shell.exec', identity: { program: 'git', sub: null, flags: [] }, status: 'ok', tokens: 7, durationMs: 5 },
      { action: 'shell.exec', identity: { program: 'npm', sub: null, flags: [] }, status: 'error', tokens: 0, durationMs: 0 },
    ]);
  });

  it('prefers a duration capture stated on the step', () => {
    const steps = [captured({ n: 0, seg: 0, action: 'shell.exec', native: 'Bash', frameId: 'f', cost: { tokens: 1, durationMs: 9 } })];
    expect(stepsOfCall(call({ steps }), 'claude-code')[0]?.durationMs).toBe(9);
  });

  it('counts no duration for a call with none', () => {
    expect(stepsOfCall(call({ durationMs: null }), 'claude-code')[0]?.durationMs).toBe(0);
  });
});

describe('motifsOf', () => {
  const line = [step('file.read'), step('file.search'), step('file.edit'), step('shell.exec'), step('file.read')];

  it('reads a window of each length at both levels', () => {
    const windows = motifsOf(line);
    // Lengths 1, 2, 3, and 4 over five steps: 5 + 4 + 3 + 2 windows, each at two levels.
    expect(MOTIF_LENGTHS).toEqual([1, 2, 3, 4]);
    expect(windows).toHaveLength(28);
    expect(windows.filter((window) => window.motif.level === 'shape')).toHaveLength(14);
    expect(windows.filter((window) => window.motif.steps.length === 4)).toHaveLength(4);
    expect(windows.some((window) => window.motif.steps.length > 4)).toBe(false);
  });

  it('places each window by its first step, so a caller can add up what it covers', () => {
    const windows = motifsOf(line).filter((window) => window.motif.level === 'shape' && window.motif.steps.length === 2);
    expect(windows.map((window) => window.start)).toEqual([0, 1, 2, 3]);
  });

  it('returns one motif object per ID, so a line repeats a shape cheaply', () => {
    const windows = motifsOf([step('file.read'), step('file.read')]).filter((window) => window.motif.level === 'shape' && window.motif.steps.length === 1);
    expect(windows[0]?.motif).toBe(windows[1]?.motif);
  });

  it('holds only actions on a shape motif, and names each in public vocabulary', () => {
    const [shape, named] = motifsOf([step('shell.exec', { program: 'git', sub: 'status', flags: ['short'] })]);
    expect(shape?.motif.steps).toEqual([{ action: 'shell.exec', identity: null }]);
    expect(named?.motif.steps).toEqual([{ action: 'shell.exec', identity: { program: 'git', sub: 'status', flags: ['short'] } }]);
    expect(shape !== undefined && motifName(shape.motif)).toBe('shell.exec');
    expect(named !== undefined && motifName(named.motif)).toBe('shell.exec[flags=short program=git sub=status]');
  });

  it('names a step with no identity by its action alone, even at named', () => {
    const named = motifsOf([step('file.read'), step('file.edit')]).find((window) => window.motif.level === 'named' && window.motif.steps.length === 2);
    expect(named !== undefined && motifName(named.motif)).toBe('file.read>file.edit');
  });

  it('names a missing identity field by leaving it out', () => {
    const named = motifsOf([step('shell.exec', { program: 'git', sub: null })]).find((window) => window.motif.level === 'named');
    expect(named !== undefined && motifName(named.motif)).toBe('shell.exec[program=git]');
  });
});

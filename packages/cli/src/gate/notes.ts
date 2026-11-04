// What the hook may say about a row, decided from the policy and the registry reading. A note is a fact in a fixed line; a block is the same fact as a label on a deny. Every
// line comes from `LINE_TABLE`, so the id a row records is one of a closed few and the words are reviewed in one place. The hook never allows or rewrites a call, so nothing
// here can: a decision is only a line to show, or a label to deny with.
import type { Policy } from './policy.js';
import type { Arm, LineId } from './record.js';
import { DAY_MS } from './registry-state.js';

/** The facts a decision reads: what the registry answered, when the name was first published, and whether this session has already had a sight of the name with a reading (`noted`). */
export interface LineFacts {
  state: 'found' | 'not-found';
  created: string | null;
  noted: boolean;
}

export interface Decision {
  arm: Arm;
  lineId: LineId;
  kind: 'block' | 'note' | 'none';
  text: string | null;
}

/** The only words the hook ever shows. Each states what the registry said and nothing about what to do. */
export const LINE_TABLE: Readonly<Record<Exclude<LineId, 'none'>, string>> = {
  'young-name-note': 'Registry note: {name} was first published {age} ago in the registry your package manager uses.',
  'not-found-note': 'Registry note: {name} was not found in the registry your package manager uses.',
  'not-found-block': 'Blocked by your gate policy: {name} was not found in the registry your package manager uses.',
};

const ageText = (days: number): string => (days < 1 ? 'less than a day' : days === 1 ? '1 day' : `${String(days)} days`);

export const lineText = (id: LineId, name: string, days: number): string => (id === 'none' ? '' : LINE_TABLE[id].replace('{name}', name).replace('{age}', ageText(days)));

const NONE: Decision = { arm: 'none', lineId: 'none', kind: 'none', text: null };

/** A note that would show, held back when the draw falls inside the share. The draw is spent on a note only. */
const note = (policy: Policy, lineId: Exclude<LineId, 'none' | 'not-found-block'>, name: string, days: number, random: () => number): Decision =>
  random() < policy.holdbackPercent / 100 ? { arm: 'held', lineId, kind: 'none', text: null } : { arm: 'shown', lineId, kind: 'note', text: lineText(lineId, name, days) };

/** Silent unless a class fires. A block is for a name the registry answered as not found, only when the policy says `block`, and is never held back. */
export const decide = (policy: Policy, facts: LineFacts | undefined, now: number, random: () => number, name: string): Decision => {
  if (facts === undefined) return NONE;
  if (facts.state === 'not-found') {
    const action = policy.classes['not-found'];
    if (action === 'block') return { arm: 'none', lineId: 'not-found-block', kind: 'block', text: lineText('not-found-block', name, 0) };
    return action === 'warn' && !facts.noted ? note(policy, 'not-found-note', name, 0, random) : NONE;
  }
  if (policy.classes['young-name'] !== 'warn' || facts.created === null || facts.noted) return NONE;
  const days = (now - Date.parse(facts.created)) / DAY_MS;
  return days >= 0 && days < policy.youngDays ? note(policy, 'young-name-note', name, Math.floor(days), random) : NONE;
};

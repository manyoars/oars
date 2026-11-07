// The wire carries what the next human prompt did to a prompt's work (t882, Item 3): one member of a closed list per prompt, or nothing when the stored prompt predates the signal. It is an outcome row,
// not a grade; no prompt text, head, or path crosses. The proof is a canonical-bytes round trip of the built skeleton (written as the bytes the outbox hashes, parsed as the server parses them, and equal);
// section 17 rule 7 of the direction conclusion (local store re-derived under the new wire, zero unparseable) is extractor-13.test.ts.
import { describe, expect, it } from 'vitest';
import { canonicalBytes } from './pool-outbox.js';
import { frame, printOf, prompt, session, sessionsFrom, store, storedNames } from './pool-fixture.js';
import { FIELD_LIST_VERSION, OPTIONAL, parseSkeleton, skeletonOf, type SessionSkeleton } from './pool-wire.js';
import { PROMPT_INTERVENTIONS, type PromptIntervention } from './schema.js';

const framed = frame({ shell: 'bash' });

const skeletonWith = (values: readonly (PromptIntervention | undefined)[]): SessionSkeleton => {
  const prompts = values.map((intervention, index) => prompt('s1', index, { frame: framed, ...(intervention === undefined ? {} : { intervention }), head: 'SECRET HEAD TEXT' }));
  const [only] = sessionsFrom(store({ sessions: [session('s1', { frame: framed })], prompts }));
  const built = only === undefined ? null : skeletonOf(only, '0123456789abcdef', storedNames, printOf);
  if (built === null) throw new Error('no skeleton');
  return built;
};

const promptsOf = (skeleton: SessionSkeleton): SessionSkeleton['transcripts'][number]['prompts'] => skeleton.transcripts[0]?.prompts ?? [];

describe('intervention on the wire', () => {
  it('moves the field list to 6, and names the field as optional on a prompt', () => {
    expect(FIELD_LIST_VERSION).toBe(6);
    expect(OPTIONAL.prompt).toContain('intervention');
  });

  it('carries each member of the closed list as stored', () => {
    const skeleton = skeletonWith([...PROMPT_INTERVENTIONS]);
    expect(promptsOf(skeleton).map((entry) => entry.intervention)).toEqual([...PROMPT_INTERVENTIONS]);
  });

  it('leaves the field off a prompt stored before the signal, so absent means not computed and unknown means computed', () => {
    const skeleton = skeletonWith([undefined, 'unknown']);
    expect(promptsOf(skeleton)[0]).not.toHaveProperty('intervention');
    expect(promptsOf(skeleton)[1]?.intervention).toBe('unknown');
  });

  it('carries only the bucket: no head, text, or path of the prompt', () => {
    const bytes = canonicalBytes(skeletonWith(['revert']));
    expect(bytes).not.toContain('SECRET');
    expect(bytes).toContain('"intervention":"revert"');
  });

  describe('through the parser', () => {
    it('round-trips the canonical bytes: built, written, parsed, and equal', () => {
      const built = skeletonWith(['redo', undefined, 'after-error', 'none', 'revert', 'user-stop', 'unknown']);
      const result = parseSkeleton(JSON.parse(canonicalBytes(built)));
      if (!result.ok) throw new Error(`refused ${result.field}: ${result.reason}`);
      expect(result.skeleton).toEqual(built);
      expect(result.extensions).toEqual([]);
      expect(canonicalBytes(result.skeleton)).toBe(canonicalBytes(built));
    });

    it('reads a prompt that sends none as one with none', () => {
      const result = parseSkeleton(JSON.parse(canonicalBytes(skeletonWith([undefined]))));
      if (!result.ok) throw new Error(`refused ${result.field}`);
      expect(promptsOf(result.skeleton)[0]).not.toHaveProperty('intervention');
    });

    it('reads a value off the list as other and keeps what was sent in the bag', () => {
      const sent = skeletonWith(['none']);
      Reflect.set(promptsOf(sent)[0] ?? {}, 'intervention', 'celebrated');
      const result = parseSkeleton(sent);
      if (!result.ok) throw new Error(`refused ${result.field}`);
      expect(promptsOf(result.skeleton)[0]?.intervention).toBe('other');
      expect(result.extensions).toContainEqual({ at: 'transcripts[0].prompts[0].intervention', kind: 'value', value: 'celebrated' });
    });

    it('accepts a literal beside other and puts it in the bag at its path', () => {
      const sent = skeletonWith(['none']);
      Reflect.set(promptsOf(sent)[0] ?? {}, 'intervention', 'other');
      Reflect.set(promptsOf(sent)[0] ?? {}, 'interventionLiteral', 'x');
      const result = parseSkeleton(sent);
      if (!result.ok) throw new Error(`refused ${result.field}: ${result.reason}`);
      expect(promptsOf(result.skeleton)[0]?.intervention).toBe('other');
      expect(result.extensions).toContainEqual({ at: 'transcripts[0].prompts[0].interventionLiteral', kind: 'literal', value: 'x' });
    });

    it('refuses a value that is not text', () => {
      const sent = skeletonWith(['none']);
      Reflect.set(promptsOf(sent)[0] ?? {}, 'intervention', 7);
      expect(parseSkeleton(sent)).toMatchObject({ ok: false, field: 'transcripts[0].prompts[0].intervention' });
    });
  });
});

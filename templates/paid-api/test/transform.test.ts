import { describe, expect, it } from 'vitest';
import { transform } from '../src/transform.js';

describe('transform', () => {
  it('counts words and sentences, estimates reading time and builds a slug', () => {
    expect(transform('Hello, brave new world! Is this thing on? Yes.')).toEqual({
      words: 9,
      sentences: 3,
      readingTimeSeconds: 3,
      slug: 'hello-brave-new-world-is-this-thing-on-yes',
    });
  });

  it('counts text with no closing punctuation as one sentence', () => {
    expect(transform('no full stop here')).toMatchObject({ words: 4, sentences: 1 });
  });

  it('answers zeros and an empty slug for blank text', () => {
    expect(transform('  \n ')).toEqual({ words: 0, sentences: 0, readingTimeSeconds: 0, slug: '' });
  });

  it('reads at 200 words a minute', () => {
    expect(transform('word '.repeat(400)).readingTimeSeconds).toBe(120);
  });

  it('strips accents and symbols from the slug and caps it at 60 characters', () => {
    expect(transform('Crème brûlée & Café!').slug).toBe('creme-brulee-cafe');
    expect(transform('a'.repeat(100)).slug).toHaveLength(60);
  });

  it('is deterministic', () => {
    expect(transform('Same text. Same answer.')).toEqual(transform('Same text. Same answer.'));
  });
});

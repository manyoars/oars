// The handler to replace: what this API sells. It is deterministic, so the whole test-mode loop needs no third-party key.
// Swap the body for an LLM call or a PDF summarizer; keep the signature, and charge only through withCredits (src/billing.ts).
export interface TransformResult {
  words: number;
  sentences: number;
  readingTimeSeconds: number;
  slug: string;
}

const WORDS_PER_MINUTE = 200;
const SLUG_MAX_LENGTH = 60;

export const transform = (text: string): TransformResult => {
  const words = text.split(/\s+/).filter((word) => word !== '').length;
  const closed = text.split(/[.!?]+(?:\s|$)/).filter((sentence) => sentence.trim() !== '').length;
  const slug = text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/, '');
  return { words, sentences: closed, readingTimeSeconds: Math.ceil((words * 60) / WORDS_PER_MINUTE), slug };
};

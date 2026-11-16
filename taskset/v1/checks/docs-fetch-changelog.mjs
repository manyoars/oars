// docs-fetch-changelog: one line per major 13..18, each naming the breaking change the release notes list. Pinned facts, from the
// GitHub release notes: 13 sends token objects to renderers; 14 removes the old renderer; 15 moves HTML escaping into renderers;
// 16 removes the CJS build and sets Node 20 as the minimum; 17 changes list and checkbox tokens; 18 trims trailing blank
// lines from block tokens and moves to TypeScript 6. Each line must hold a term only its release's change has. No prose is graded.
// Wrong neighbors: six plausible but invented lines; six vague guesses ("the renderer API changed", "async parsing changed").
import { answer, check, expect } from './_shared.mjs';

// One term that only that release's note holds, per major: "renderer", "async", "list", "ESM" and "TypeScript" fit more than one
// release, or fit a guess that never read the notes, so none stands alone.
const FAMILIES = new Map([
  [13, /token.*render|render.*token|object|positional|param|space token/i],
  [14, /use ?new ?renderer|(old|legacy) renderer|renderer.*(remov|drop|delet)|(remov|drop|delet).*renderer|async.*throw|throw.*async|async: ?false/i],
  [15, /escap.*renderer|renderer.*escap|escap.*tokeniz|tokeniz.*escap/i],
  [16, /cjs|commonjs|common js|node(\.?js)?( version| v)?\D{0,30}20|esm.?only|umd|min\.js|marked\.min|minif/i],
  [17, /checkbox|list ?item|loose|paragraph|text token/i],
  [18, /trailing|blank line|typescript\D{0,30}\b6\b/i],
]);
// Round 2 (t1371) widened each family with the release notes' own words (GitHub releases v13.0.0 to v18.0.0): 13 also holds the
// space token and the one-object-instead-of-positional-parameters form of the same change; 14 the async: false throw; 15 the
// tokenizers; 16 the ESM and UMD bundles, minification, and Node 20; 17 the loose-list paragraph and text tokens; 18 TypeScript 6.
// "token" alone no longer counts for 13: "the tokenizer API changed" is a guess.

await check('docs-fetch-changelog', async (run) => {
  const found = new Map();
  for (const line of answer(run, 'answers/marked-upgrade.md').split('\n')) {
    const match = /^\s*(?:[-*]\s*)?v?(\d+)(?:\.0\.0)?\s*:\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const major = Number(match[1]);
    expect(!found.has(major), `two lines for ${major}`);
    found.set(major, match[2]);
  }
  for (const [major, family] of FAMILIES) {
    expect(found.has(major), `no line for ${major}`);
    const text = found.get(major);
    expect(text.length >= 12 && family.test(text), `the line for ${major} does not name its release's breaking change: ${JSON.stringify(text.slice(0, 80))}`);
  }
  expect(found.size === FAMILIES.size, `lines for ${[...found.keys()].join(', ')}; want 13 to 18 only`);
  return 'six majors, each naming its breaking change';
});

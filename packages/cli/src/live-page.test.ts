import { describe, expect, it } from 'vitest';
import { describePage } from './live-page.js';

describe('describePage', () => {
  it('names the title and the URL path only', () => {
    const named = describePage('Terms and Conditions', 'http://localhost:8180/realms/aor/login-actions/required-action?execution=TERMS&session_code=abc&user_code=ABCD-EFGH#frag');
    expect(named).toBe('page "Terms and Conditions" at /realms/aor/login-actions/required-action');
    expect(named).not.toMatch(/session_code|user_code|execution|ABCD|frag/);
  });

  it('does not throw on a URL it cannot parse', () => {
    expect(describePage('', 'about:blank?x=1')).toBe('page "" at blank');
    expect(describePage('Blank', 'not a url?secret=1')).toBe('page "Blank" at (unparsable URL)');
  });
});

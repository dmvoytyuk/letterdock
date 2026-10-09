import { describe, expect, it } from 'vitest';
import { showsForget } from '../../src/renderer/src/lib/contactPopoverRules';

describe('contact popover rules', () => {
  it('hides "Remove from suggestions" for own addresses only', () => {
    expect(showsForget({ isOwn: true })).toBe(false);
    expect(showsForget({ isOwn: false })).toBe(true);
    expect(showsForget(null)).toBe(true);
  });
});

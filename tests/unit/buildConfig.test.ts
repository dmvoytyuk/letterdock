import { describe, expect, it } from 'vitest';
import { APP_ID, DEV_APP_ID, resolveAppUserModelId } from '../../src/main/buildConfig';

describe('resolveAppUserModelId', () => {
  it('uses the production id when packaged', () => {
    expect(resolveAppUserModelId(true)).toBe('app.letterdock');
    expect(resolveAppUserModelId(true)).toBe(APP_ID);
  });

  it('uses a separate dev id when not packaged', () => {
    expect(resolveAppUserModelId(false)).toBe('app.letterdock.dev');
    expect(DEV_APP_ID).not.toBe(APP_ID);
  });
});

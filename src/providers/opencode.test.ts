import { describe, it, expect } from 'vitest';

import { resolveOpenCodeEnv } from './opencode.js';

describe('resolveOpenCodeEnv (per-group OpenCode model selection)', () => {
  const globalEnv = {
    OPENCODE_PROVIDER: 'deepseek',
    OPENCODE_MODEL: 'deepseek/deepseek-v4-flash',
    OPENCODE_SMALL_MODEL: 'deepseek/deepseek-v4-flash',
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/v1',
  };

  it('falls back entirely to global host env when the group has no opencode block', () => {
    expect(resolveOpenCodeEnv(undefined, globalEnv)).toEqual(globalEnv);
  });

  it('lets a group override just the model, inheriting provider + baseURL (Pro vs Flash)', () => {
    const env = resolveOpenCodeEnv({ model: 'deepseek/deepseek-v4-pro' }, globalEnv);
    expect(env.OPENCODE_MODEL).toBe('deepseek/deepseek-v4-pro');
    expect(env.OPENCODE_PROVIDER).toBe('deepseek');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/v1');
  });

  it('lets a group run a completely different provider (Kimi) alongside the global default', () => {
    const env = resolveOpenCodeEnv(
      { provider: 'moonshot', model: 'moonshot/kimi-k2', baseURL: 'https://api.moonshot.cn/v1' },
      globalEnv,
    );
    expect(env).toMatchObject({
      OPENCODE_PROVIDER: 'moonshot',
      OPENCODE_MODEL: 'moonshot/kimi-k2',
      ANTHROPIC_BASE_URL: 'https://api.moonshot.cn/v1',
    });
  });

  it('omits keys set neither per-group nor globally', () => {
    expect(resolveOpenCodeEnv({ model: 'x/y' }, {})).toEqual({ OPENCODE_MODEL: 'x/y' });
  });

  it('per-group smallModel override is independent of the main model', () => {
    const env = resolveOpenCodeEnv(
      { model: 'deepseek/deepseek-v4-pro', smallModel: 'deepseek/deepseek-v4-flash' },
      globalEnv,
    );
    expect(env.OPENCODE_MODEL).toBe('deepseek/deepseek-v4-pro');
    expect(env.OPENCODE_SMALL_MODEL).toBe('deepseek/deepseek-v4-flash');
  });
});

/**
 * Host-side container config for the `opencode` provider.
 *
 * OpenCode's `opencode serve` process stores state under XDG_DATA_HOME, which
 * we pin to a per-session host directory mounted at /opencode-xdg. The
 * OPENCODE_* env vars tell the CLI which provider/model to use at runtime
 * (read on the host, injected into the container). NO_PROXY / no_proxy are
 * merged with host values so the in-container OpenCode client can talk to
 * 127.0.0.1 even when HTTPS_PROXY is set by OneCLI.
 */
import fs from 'fs';
import path from 'path';

import { readContainerConfig, type OpenCodeGroupConfig } from '../container-config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

/**
 * Resolve the OpenCode model env for one agent group. A per-group
 * `container.json` `opencode` block overrides the global host env (set via the
 * systemd unit) **per field** — so a group can override just the model (e.g.
 * DeepSeek Pro vs Flash) or swap providers entirely (Kimi, Qwen). Unset fields
 * fall back to the global value, letting different groups run different models
 * at the same time.
 *
 * Caveat: when overriding to a *different* provider, set `baseURL` in the same
 * block — otherwise it falls back to the global ANTHROPIC_BASE_URL, which
 * belongs to the default provider.
 */
export function resolveOpenCodeEnv(
  group: OpenCodeGroupConfig | undefined,
  hostEnv: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  const provider = group?.provider ?? hostEnv.OPENCODE_PROVIDER;
  const model = group?.model ?? hostEnv.OPENCODE_MODEL;
  const smallModel = group?.smallModel ?? hostEnv.OPENCODE_SMALL_MODEL;
  const baseURL = group?.baseURL ?? hostEnv.ANTHROPIC_BASE_URL;
  if (provider) env.OPENCODE_PROVIDER = provider;
  if (model) env.OPENCODE_MODEL = model;
  if (smallModel) env.OPENCODE_SMALL_MODEL = smallModel;
  if (baseURL) env.ANTHROPIC_BASE_URL = baseURL;
  return env;
}

function mergeNoProxy(current: string | undefined, additions: string): string {
  if (!current?.trim()) return additions;
  const parts = new Set(
    current
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) {
    const trimmed = addition.trim();
    if (trimmed) parts.add(trimmed);
  }
  return [...parts].join(',');
}

registerProviderContainerConfig('opencode', (ctx) => {
  const opencodeDir = path.join(ctx.sessionDir, 'opencode-xdg');
  fs.mkdirSync(opencodeDir, { recursive: true });

  // Per-group model selection: container.json `opencode` block overrides the
  // global host env per-field; unset fields fall back to the global value.
  const group = getAgentGroup(ctx.agentGroupId);
  const groupOpencode = group ? readContainerConfig(group.folder).opencode : undefined;

  const env: Record<string, string> = {
    XDG_DATA_HOME: '/opencode-xdg',
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, '127.0.0.1,localhost'),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, '127.0.0.1,localhost'),
    ...resolveOpenCodeEnv(groupOpencode, ctx.hostEnv),
  };

  return {
    mounts: [{ hostPath: opencodeDir, containerPath: '/opencode-xdg', readonly: false }],
    env,
  };
});

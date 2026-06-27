/**
 * Switchable model catalog (opencode provider).
 *
 * Every opencode session is configured with ALL providers listed here, so the
 * model can be changed per-prompt at runtime (via the `/model` command, which
 * sets `session_state.active_model`) WITHOUT respawning the container —
 * OpenCode's prompt API takes a per-message `model: {providerID, modelID}`.
 *
 * `PROVIDER_CATALOG` feeds the opencode config (enabled providers + their
 * baseURL + registered model ids). `MODEL_PRESETS` is the user-facing `/model`
 * vocabulary. Both live here so they can't drift apart.
 */
export interface ProviderCatalogEntry {
  /** Provider API base URL (the OneCLI proxy injects the real key at runtime). */
  baseURL: string;
  /** Model ids to register for this provider (bare, no `provider/` prefix). */
  models: string[];
  /**
   * When true, opencode authenticates this provider via OAuth creds in
   * auth.json (the host writes them from the Claude Max subscription) instead
   * of a `placeholder` API key + OneCLI proxy. So Anthropic runs on the Max
   * plan, not a metered API key. OAuth providers must route DIRECT (NOT through
   * the OneCLI proxy) — see container-runner NO_PROXY.
   */
  oauth?: boolean;
}

export const PROVIDER_CATALOG: Record<string, ProviderCatalogEntry> = {
  deepseek: {
    baseURL: 'https://api.deepseek.com/v1',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'],
  },
  anthropic: {
    baseURL: 'https://api.anthropic.com/v1',
    models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    oauth: true,
  },
};

export interface ModelPreset {
  label: string;
  /** Full `provider/modelID` id. */
  model: string;
}

/** User-facing `/model <name>` presets. */
export const MODEL_PRESETS: Record<string, ModelPreset> = {
  'deepseek-pro': { label: 'DeepSeek V4 Pro', model: 'deepseek/deepseek-v4-pro' },
  'deepseek-flash': { label: 'DeepSeek V4 Flash', model: 'deepseek/deepseek-v4-flash' },
  opus: { label: 'Claude Opus 4.8', model: 'anthropic/claude-opus-4-8' },
  sonnet: { label: 'Claude Sonnet 4.6', model: 'anthropic/claude-sonnet-4-6' },
  haiku: { label: 'Claude Haiku 4.5', model: 'anthropic/claude-haiku-4-5-20251001' },
};

const MODEL_ALIASES: Record<string, string> = {
  // bare "deepseek" / "ds" keep meaning the Pro model (the default)
  deepseek: 'deepseek-pro',
  ds: 'deepseek-pro',
  pro: 'deepseek-pro',
  flash: 'deepseek-flash',
  'ds-flash': 'deepseek-flash',
  claude: 'opus',
  'claude-opus': 'opus',
  'claude-sonnet': 'sonnet',
};

export interface ResolvedPreset extends ModelPreset {
  key: string;
}

/** Resolve a `/model` argument (name or alias) to a preset, or undefined. */
export function resolvePreset(name: string): ResolvedPreset | undefined {
  const k0 = name.trim().toLowerCase();
  const k = MODEL_ALIASES[k0] ?? k0;
  const p = MODEL_PRESETS[k];
  return p ? { key: k, ...p } : undefined;
}

/** Friendly label for a full `provider/modelID` id (falls back to the id). */
export function labelForModel(model: string | undefined): string {
  if (!model) return 'default';
  for (const p of Object.values(MODEL_PRESETS)) {
    if (p.model === model) return p.label;
  }
  return model;
}

/** Bullet list of the available presets, for `/model status` and errors. */
export function presetList(): string {
  return Object.entries(MODEL_PRESETS)
    .map(([k, p]) => `• ${k} — ${p.label}`)
    .join('\n');
}

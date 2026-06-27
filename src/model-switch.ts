/**
 * Host-side `/model` handler — switches a session between DeepSeek (opencode
 * provider) and Claude (claude provider) models from chat.
 *
 * Unlike the opencode-only per-prompt override, this crosses the *provider*
 * boundary: DeepSeek runs on the `opencode` provider, Claude runs on the
 * `claude` provider (the official Claude Code client, on the user's Max
 * subscription — reliable, unlike routing a subscription token through
 * opencode which Anthropic rate-limits). Switching providers requires a
 * container respawn, so this handler:
 *
 *   1. stops the running container (if any),
 *   2. flips `sessions.agent_provider`,
 *   3. writes the per-session `active_model` into outbound.db `session_state`
 *      (safe — the container is stopped, so there is no concurrent writer),
 *   4. replies with a confirmation.
 *
 * The next inbound message wakes a fresh container on the new provider, which
 * reads `active_model` at startup and passes it to the provider's query.
 *
 * Continuation is keyed per-provider in session_state, so switching back and
 * forth resumes each provider's own thread; switching opus↔sonnet (same
 * `claude` provider) keeps the conversation, only the model changes.
 */
import { killContainer } from './container-runner.js';
import { updateSession } from './db/sessions.js';
import { log } from './log.js';
import { openOutboundDbRw } from './session-manager.js';
import type { Session } from './types.js';

interface ModelTarget {
  /** Host provider name (resolveProviderName precedence target). */
  provider: 'opencode' | 'claude';
  /**
   * Value stored in session_state.active_model and passed to the provider's
   * query. opencode → `provider/modelID`; claude → a Claude Code model alias.
   */
  activeModel: string;
  label: string;
}

/** User-facing `/model <name>` presets. Mirrors the container model-catalog. */
const PRESETS: Record<string, ModelTarget> = {
  'deepseek-pro': { provider: 'opencode', activeModel: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  'deepseek-flash': { provider: 'opencode', activeModel: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  // Use EXPLICIT model ids, not aliases: Claude Code 2.1.116's `opus` alias
  // resolves to claude-opus-4-7 (the latest when that CLI shipped), so the
  // alias would silently give 4.7. The explicit id `claude-opus-4-8` is served
  // fine by the API (verified). Bump these when newer versions land.
  opus: { provider: 'claude', activeModel: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  sonnet: { provider: 'claude', activeModel: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  haiku: { provider: 'claude', activeModel: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
};

const ALIASES: Record<string, string> = {
  deepseek: 'deepseek-pro',
  ds: 'deepseek-pro',
  pro: 'deepseek-pro',
  flash: 'deepseek-flash',
  'ds-flash': 'deepseek-flash',
  claude: 'opus',
  'claude-opus': 'opus',
  'claude-sonnet': 'sonnet',
  'claude-haiku': 'haiku',
};

function resolvePreset(arg: string): { key: string; target: ModelTarget } | undefined {
  const k0 = arg.trim().toLowerCase();
  const k = ALIASES[k0] ?? k0;
  const target = PRESETS[k];
  return target ? { key: k, target } : undefined;
}

function presetList(): string {
  return Object.entries(PRESETS)
    .map(([k, p]) => `• ${k} — ${p.label}`)
    .join('\n');
}

function labelFor(activeModel: string | undefined, provider: string): string {
  if (activeModel) {
    for (const p of Object.values(PRESETS)) {
      if (p.activeModel === activeModel) return p.label;
    }
    return activeModel;
  }
  // No explicit model set — show the provider default.
  return provider === 'claude' ? 'Claude (default)' : 'DeepSeek V4 Pro (default)';
}

function readActiveModel(agentGroupId: string, sessionId: string): string | undefined {
  try {
    const db = openOutboundDbRw(agentGroupId, sessionId);
    try {
      const row = db.prepare("SELECT value FROM session_state WHERE key = 'active_model'").get() as
        | { value: string }
        | undefined;
      return row?.value;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

interface DeliveryAddr {
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
}

function reply(agentGroupId: string, sessionId: string, addr: DeliveryAddr, text: string): void {
  const db = openOutboundDbRw(agentGroupId, sessionId);
  try {
    db.prepare(
      `INSERT OR IGNORE INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, thread_id, content)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_out), datetime('now'), 'chat', ?, ?, ?, ?)`,
    ).run(
      `model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      addr.platformId,
      addr.channelType,
      addr.threadId,
      JSON.stringify({ text }),
    );
  } finally {
    db.close();
  }
}

/**
 * Handle a `/model` command on the host. The command is admin-gated before
 * reaching here (see command-gate). `arg` is everything after `/model`.
 */
export function handleModelCommand(session: Session, addr: DeliveryAddr, arg: string): void {
  const agentGroupId = session.agent_group_id;
  const sessionId = session.id;
  const trimmed = arg.trim();

  // Status / list
  if (trimmed === '' || trimmed.toLowerCase() === 'status') {
    const current = readActiveModel(agentGroupId, sessionId);
    const provider = session.agent_provider ?? '(group default)';
    const label = labelFor(current, session.agent_provider ?? '');
    reply(
      agentGroupId,
      sessionId,
      addr,
      `Current model: ${label}\n\nAvailable:\n${presetList()}\n\nSwitch with /model <name>.`,
    );
    log.info('Model status requested', { sessionId, provider, current });
    return;
  }

  const resolved = resolvePreset(trimmed);
  if (!resolved) {
    reply(agentGroupId, sessionId, addr, `Unknown model "${trimmed}". Available:\n${presetList()}`);
    return;
  }

  const { target } = resolved;

  // Stop the running container BEFORE touching outbound.db / the provider so
  // there is no concurrent writer (stopContainer blocks via `docker stop`).
  try {
    killContainer(sessionId, 'model switch');
  } catch (err) {
    log.warn('killContainer during model switch failed (continuing)', { sessionId, err });
  }

  // Flip the provider for this session (central DB, host-owned).
  updateSession(sessionId, { agent_provider: target.provider });

  // Persist the chosen model into outbound.db session_state — the fresh
  // container reads it at startup (getActiveModel) and passes it to the query.
  try {
    const db = openOutboundDbRw(agentGroupId, sessionId);
    try {
      db.prepare(
        `INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES ('active_model', ?, datetime('now'))`,
      ).run(target.activeModel);
    } finally {
      db.close();
    }
  } catch (err) {
    log.warn('Failed to persist active_model during model switch', { sessionId, err });
  }

  reply(agentGroupId, sessionId, addr, `✅ Now using ${target.label}. It takes effect on your next message.`);
  log.info('Model switched', { sessionId, provider: target.provider, model: target.activeModel });
}

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

const HOST_CREDENTIALS = path.join(process.env.HOME ?? '/root', '.claude', '.credentials.json');
const REFRESH_URL = 'https://platform.claude.com/v1/oauth/token';
// Refresh proactively when the token expires within this window.
const REFRESH_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

function agentClaudeDir(agentGroupId: string): string {
  return path.join(DATA_DIR, 'v2-sessions', agentGroupId, '.claude-shared');
}

/**
 * Read + optionally refresh the host OAuth token, then write it into the
 * agent group's .claude-shared dir so running containers pick up fresh creds.
 *
 * Returns true if credentials were written, false if the host credentials
 * file doesn't exist or has no usable token.
 */
export async function syncAgentCredentials(agentGroupId: string): Promise<boolean> {
  if (!fs.existsSync(HOST_CREDENTIALS)) return false;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(HOST_CREDENTIALS, 'utf8'));
  } catch {
    return false;
  }

  let tokenData = (raw.claudeAiOauth ?? raw.claudeAiOauthToken) as Record<string, unknown> | undefined;
  if (!tokenData) return false;

  const expiresAt = typeof tokenData.expiresAt === 'number' ? tokenData.expiresAt : 0;
  if (tokenData.refreshToken && expiresAt && expiresAt < Date.now() + REFRESH_WINDOW_MS) {
    try {
      const res = await fetch(REFRESH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: tokenData.refreshToken }),
      });
      if (res.ok) {
        const refreshed = (await res.json()) as Record<string, unknown>;
        tokenData = { ...tokenData, ...refreshed };
        const updated = { claudeAiOauth: tokenData, claudeAiOauthToken: tokenData };
        fs.writeFileSync(HOST_CREDENTIALS, JSON.stringify(updated));
        log.info('Refreshed Claude OAuth token', { agentGroupId });
      }
    } catch (e) {
      log.warn('Token refresh failed', { agentGroupId, error: String(e) });
    }
  }

  const dest = agentClaudeDir(agentGroupId);
  fs.mkdirSync(dest, { recursive: true });
  const normalized = { claudeAiOauth: tokenData, claudeAiOauthToken: tokenData };
  fs.writeFileSync(path.join(dest, '.credentials.json'), JSON.stringify(normalized));
  return true;
}

/**
 * Returns true if the agent group's .claude-shared/.credentials.json exists
 * and its token expires within REFRESH_WINDOW_MS (or is already expired).
 */
export function agentCredentialsNeedRefresh(agentGroupId: string): boolean {
  const dest = path.join(agentClaudeDir(agentGroupId), '.credentials.json');
  if (!fs.existsSync(dest)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(dest, 'utf8'));
    const tok = (raw.claudeAiOauth ?? raw.claudeAiOauthToken) as Record<string, unknown> | undefined;
    const expiresAt = typeof tok?.expiresAt === 'number' ? tok.expiresAt : 0;
    return expiresAt > 0 && expiresAt < Date.now() + REFRESH_WINDOW_MS;
  } catch {
    return false;
  }
}

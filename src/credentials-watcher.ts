import fs from 'fs';
import path from 'path';

import { syncAgentCredentials } from './credentials.js';
import { getAllAgentGroups } from './db/agent-groups.js';
import { log } from './log.js';

const HOST_CREDENTIALS = path.join(process.env.HOME ?? '/root', '.claude', '.credentials.json');
const CREDENTIALS_DIR = path.dirname(HOST_CREDENTIALS);
const CREDENTIALS_BASENAME = path.basename(HOST_CREDENTIALS);
const DEBOUNCE_MS = 300;

let watcher: fs.FSWatcher | null = null;
let pending: NodeJS.Timeout | null = null;

async function syncAll(): Promise<void> {
  const groups = getAllAgentGroups();
  for (const g of groups) {
    try {
      await syncAgentCredentials(g.id);
    } catch (err) {
      log.warn('Credentials watcher sync failed', { agentGroupId: g.id, error: String(err) });
    }
  }
  log.info('Credentials watcher pushed fresh token', { agentGroups: groups.length });
}

export function startCredentialsWatcher(): void {
  if (watcher) return;
  if (!fs.existsSync(CREDENTIALS_DIR)) {
    log.warn('Credentials watcher: parent dir missing, watcher not started', { path: CREDENTIALS_DIR });
    return;
  }
  // Watch the parent directory rather than the file itself. `/login` (and most
  // credential rotators) write to a temp file then atomically rename over the
  // target, which changes the inode. fs.watch(file) follows the original
  // inode and goes deaf after the first rename — fs.watch(dir) sees the
  // rename entry and stays attached across rotations.
  watcher = fs.watch(CREDENTIALS_DIR, (_eventType, filename) => {
    if (filename !== CREDENTIALS_BASENAME) return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      syncAll().catch((err) => log.warn('Credentials watcher syncAll threw', { error: String(err) }));
    }, DEBOUNCE_MS);
  });
  watcher.on('error', (err) => log.warn('Credentials watcher error', { error: String(err) }));
  log.info('Credentials watcher started', { path: HOST_CREDENTIALS, watching: CREDENTIALS_DIR });
}

export function stopCredentialsWatcher(): void {
  if (pending) {
    clearTimeout(pending);
    pending = null;
  }
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}

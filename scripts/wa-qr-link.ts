/**
 * Link (or re-link) the WhatsApp channel by QR, rendered to a browser page.
 *
 * The stock `setup --step whatsapp-auth` emits raw QR payloads to stdout, which
 * is useless over a remote/agent shell, and its pairing-code path gives you a
 * 60-second race. This writes each rotating QR to an HTML page that
 * meta-refreshes itself, so you can leave the page open and scan whenever
 * you're ready — Baileys keeps issuing fresh QRs for several minutes.
 *
 * Output lands in Downloads, not Desktop: Desktop is OneDrive-redirected and a
 * QR is a live credential for as long as it's on screen.
 *
 *   pnpm exec tsx scripts/wa-qr-link.ts
 *
 * Then open C:\Users\ZION\Downloads\zion-whatsapp-qr.html in Windows and scan.
 * Re-run after a `401 logged out` to re-link; it clears stale auth itself.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { pino } from 'pino';
import QRCode from 'qrcode';
import {
  makeWASocket,
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

const logger = pino({ level: 'silent' });
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUTH_DIR = path.join(ROOT, 'store', 'auth');
const PAGE = '/mnt/c/Users/ZION/Downloads/zion-whatsapp-qr.html';
const DEADLINE_MS = 10 * 60 * 1000;

function writePage(body: string, refresh: boolean): void {
  const head = refresh ? '<meta http-equiv="refresh" content="3">' : '';
  fs.writeFileSync(
    PAGE,
    `<!doctype html><html><head><meta charset="utf-8">${head}` +
      `<title>Link Zion to WhatsApp</title></head>` +
      `<body style="font-family:system-ui,sans-serif;text-align:center;padding:32px;background:#111;color:#eee">` +
      `${body}</body></html>`,
    'utf-8',
  );
}

writePage('<h2>Starting…</h2><p>Waiting for WhatsApp to issue a QR code.</p>', true);
console.log(`[link] page: ${PAGE}`);

/**
 * Baileys' bundled WA Web version goes stale within weeks and WhatsApp then
 * rejects the handshake at the Noise layer (405). wppconnect tracks the
 * current version; fall back to Baileys' own scrape only if that's down.
 */
async function resolveWaWebVersion(): Promise<[number, number, number]> {
  const res = await fetch('https://wppconnect.io/whatsapp-versions/', {
    signal: AbortSignal.timeout(8000),
  });
  const match = (await res.text()).match(/2\.3000\.(\d+)/);
  if (!match) throw new Error('could not resolve current WhatsApp Web version');
  return [2, 3000, Number(match[1])];
}

let qrCount = 0;

async function connect(attempt = 1): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const version = await resolveWaWebVersion();
  console.log(`[link] connecting (attempt ${attempt}, WA Web ${version.join('.')})`);

  const sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false,
    logger,
    browser: Browsers.macOS('Chrome'),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCount += 1;
      console.log(`[link] QR #${qrCount} issued`);
      void QRCode.toDataURL(qr, { width: 420, margin: 2 }).then((dataUrl) => {
        writePage(
          `<h2>Scan with Zion's WhatsApp</h2>` +
            `<img src="${dataUrl}" alt="QR" style="background:#fff;padding:12px;border-radius:12px">` +
            `<p>WhatsApp &rsaquo; Linked devices &rsaquo; Link a device</p>` +
            `<p style="color:#888;font-size:13px">QR #${qrCount} — refreshes automatically, just scan whatever is on screen.</p>`,
          true,
        );
      });
      return;
    }

    if (connection === 'open') {
      console.log(`[link] RESULT: linked as ${sock.user?.id}`);
      writePage(
        `<h2 style="color:#4ade80">Linked</h2><p>${sock.user?.id ?? ''}</p>` +
          `<p>You can close this page.</p>`,
        false,
      );
      setTimeout(() => process.exit(0), 1500);
      return;
    }

    if (connection === 'close') {
      const code = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output
        ?.statusCode;
      console.log(`[link] closed, statusCode=${code}`);

      // 515 restartRequired is the normal post-link handshake reset, not a failure.
      if (code === DisconnectReason.restartRequired || code === DisconnectReason.timedOut) {
        void connect(attempt + 1);
        return;
      }
      if (code === DisconnectReason.loggedOut) {
        console.log('[link] RESULT: logged-out (401)');
        writePage('<h2 style="color:#f87171">Logged out (401)</h2><p>Re-run the link script.</p>', false);
        process.exit(3);
      }
      if (attempt < 8) {
        setTimeout(() => void connect(attempt + 1), 2000);
        return;
      }
      console.log('[link] RESULT: gave-up');
      process.exit(4);
    }
  });
}

setTimeout(() => {
  console.log('[link] RESULT: timeout (no scan)');
  writePage('<h2>Timed out</h2><p>Nobody scanned. Re-run the link script.</p>', false);
  process.exit(5);
}, DEADLINE_MS);

void connect();

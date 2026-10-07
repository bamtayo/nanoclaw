import { describe, expect, it } from 'bun:test';

import {
  MAX_HTML_SENDS,
  SEND_WINDOW_MS,
  evaluateSend,
  pruneAttempts,
} from './bulk-send-guard.js';

const T0 = 1_000_000_000_000;
const smallHtml = '<td style="x">hi</td>';
const bigHtml = '<td>x</td>'.repeat(4000); // ~40KB — a normal rich newsletter

describe('evaluateSend', () => {
  it('ignores non-send tools', () => {
    expect(evaluateSend('Bash', { command: 'ls' }, T0, []).block).toBe(false);
  });

  it('ignores plain-text sends (no htmlBody)', () => {
    const v = evaluateSend('mcp__gmail__send_email', { to: ['a@x.com'], body: 'hello' }, T0, []);
    expect(v).toEqual({ block: false, record: false });
  });

  it('allows a single small HTML send and records it', () => {
    const v = evaluateSend('mcp__gmail__send_email', { htmlBody: smallHtml }, T0, []);
    expect(v.block).toBe(false);
    expect(v.record).toBe(true);
  });

  it('allows a single large rich email (size is NOT a gate — only rate is)', () => {
    const v = evaluateSend('send_email', { htmlBody: bigHtml }, T0, []);
    expect(v.block).toBe(false); // a 40KB one-off newsletter must go through
    expect(v.record).toBe(true);
  });

  it('a large body is still subject to the rate limit ((MAX+1)th in window blocked)', () => {
    const recent = Array.from({ length: MAX_HTML_SENDS }, (_, n) => T0 - (n + 1) * 1000);
    expect(evaluateSend('send_email', { htmlBody: bigHtml }, T0, recent).block).toBe(true);
  });

  it('blocks the (MAX+1)th small HTML send inside the window (the bulk-loop case)', () => {
    const recent = Array.from({ length: MAX_HTML_SENDS }, (_, n) => T0 - (n + 1) * 1000);
    const v = evaluateSend('mcp__gmail__send_email', { htmlBody: smallHtml }, T0, recent);
    expect(v.block).toBe(true);
    expect(v.reason).toContain('inline');
    // Records the blocked attempt so continued hammering can't drain the window.
    expect(v.record).toBe(true);
  });

  it('a continuous burst is hard-capped at MAX_HTML_SENDS (blocked attempts keep the window hot)', () => {
    let recent: number[] = [];
    let allowed = 0;
    let t = T0;
    for (let n = 0; n < 40; n++) {
      t += 25_000; // 25s apart, ~17 min total — spans multiple windows
      recent = pruneAttempts(recent, t);
      const v = evaluateSend('send_email', { htmlBody: smallHtml }, t, recent);
      if (!v.block) allowed++;
      if (v.record) recent.push(t);
    }
    expect(allowed).toBe(MAX_HTML_SENDS); // exactly 3 leak, not one-per-window
  });

  it('allows again once earlier sends age out of the window', () => {
    const recent = [T0 - SEND_WINDOW_MS - 1, T0 - SEND_WINDOW_MS - 2, T0 - SEND_WINDOW_MS - 3];
    const v = evaluateSend('mcp__gmail__send_email', { htmlBody: smallHtml }, T0, recent);
    expect(v.block).toBe(false); // all three are outside the window
  });

  it('permits legitimate separate batches: 3 at 08:00, 3 at 14:00', () => {
    const morning = [T0, T0 + 1000, T0 + 2000];
    // 6 hours later, the morning batch is well outside the window
    const afternoon = T0 + 6 * 60 * 60 * 1000;
    const pruned = pruneAttempts([...morning], afternoon);
    expect(pruned.length).toBe(0);
    expect(evaluateSend('send_email', { htmlBody: smallHtml }, afternoon, pruned).block).toBe(false);
  });

  it('exactly MAX_HTML_SENDS allowed, one more blocked', () => {
    let sends: number[] = [];
    for (let n = 0; n < MAX_HTML_SENDS; n++) {
      const v = evaluateSend('send_email', { htmlBody: smallHtml }, T0 + n, sends);
      expect(v.block).toBe(false);
      if (v.record) sends.push(T0 + n);
    }
    expect(evaluateSend('send_email', { htmlBody: smallHtml }, T0 + MAX_HTML_SENDS, sends).block).toBe(true);
  });
});

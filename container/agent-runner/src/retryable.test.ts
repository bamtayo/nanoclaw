import { describe, expect, it, beforeEach, afterEach } from 'bun:test';

import { isRetryableFailure } from './retryable.js';

describe('isRetryableFailure', () => {
  it('retries the failures that actually took down 2026-09-01', () => {
    // Verbatim from nanoclaw-v2-gabriel-1788269465241.log
    expect(isRetryableFailure(new Error('API Error: Unable to connect to API (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)'))).toBe(true);
  });

  it('retries transport-level failures', () => {
    for (const m of [
      'fetch failed',
      'socket hang up',
      'connect ECONNREFUSED 127.0.0.1:443',
      'getaddrinfo ENOTFOUND api.anthropic.com',
      'request timed out',
      'API Error: 529 overloaded_error',
      '503 Service Unavailable',
    ]) {
      expect(isRetryableFailure(new Error(m)), m).toBe(true);
    }
  });

  it('does NOT retry failures that will repeat forever', () => {
    for (const m of [
      'Prompt is too long',
      'context window exceeded',
      '401 Unauthorized',
      'invalid_api_key',
      'Your credit balance is too low',
      'rate_limit_error',
      '400 invalid_request_error',
    ]) {
      expect(isRetryableFailure(new Error(m)), m).toBe(false);
    }
  });

  it('lets a terminal reason win even when it mentions a transport code', () => {
    // A quota message that happens to name a 503 must not be retried for hours.
    expect(isRetryableFailure(new Error('quota exceeded (upstream returned 503)'))).toBe(false);
  });

  it('treats an empty or unknown failure as non-retryable', () => {
    expect(isRetryableFailure(undefined)).toBe(false);
    expect(isRetryableFailure(new Error('something went sideways'))).toBe(false);
  });
});

// ---- wiring: processQuery must report the failure, not swallow it ----
import { initTestSessionDb, closeSessionDb } from './db/connection.js';
import { markProcessing } from './db/messages-in.js';
import { processQuery } from './poll-loop.js';
import type { ProviderEvent } from './providers/types.js';

const ROUTING = { platformId: 'gchat:spaces/X', channelType: 'gchat', threadId: null, inReplyTo: null };

/** A query whose stream yields the given events and then closes — no result. */
function fakeQuery(events: ProviderEvent[]) {
  return {
    events: (async function* () {
      for (const e of events) yield e;
    })(),
    push: () => {},
    end: () => {},
  } as unknown as Parameters<typeof processQuery>[0];
}

describe('processQuery failure reporting', () => {
  beforeEach(() => initTestSessionDb());
  afterEach(() => closeSessionDb());

  it('reports a retryable failure when the stream ends with a transport error and no result', async () => {
    markProcessing(['t1']);
    const res = await processQuery(
      fakeQuery([
        { type: 'init', continuation: 'c1' },
        { type: 'error', message: 'API Error: Unable to connect to API (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)', retryable: true },
      ] as ProviderEvent[]),
      ROUTING,
      ['t1'],
      'mock',
      true,
    );
    expect(res.failure?.retryable).toBe(true);
  });

  it('reports NOT retryable for a quota error, so the schedule moves on', async () => {
    markProcessing(['t2']);
    const res = await processQuery(
      fakeQuery([
        { type: 'init', continuation: 'c2' },
        { type: 'error', message: 'rate_limit_error', retryable: false, classification: 'quota' },
      ] as ProviderEvent[]),
      ROUTING,
      ['t2'],
      'mock',
      true,
    );
    expect(res.failure?.retryable).toBe(false);
  });

  it('reports no failure at all when a result arrived', async () => {
    markProcessing(['t3']);
    const res = await processQuery(
      fakeQuery([
        { type: 'init', continuation: 'c3' },
        { type: 'error', message: 'fetch failed', retryable: true }, // recovered by the SDK
        { type: 'result', text: 'Done.', final: true },
      ] as ProviderEvent[]),
      ROUTING,
      ['t3'],
      'mock',
      true,
    );
    expect(res.failure).toBeUndefined();
  });
});

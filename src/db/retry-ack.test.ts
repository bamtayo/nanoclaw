import { describe, expect, it } from 'vitest';

import { connectivityBackoffSec, syncProcessingAcks } from './session-db.js';
import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from './schema.js';
import Database from 'better-sqlite3';

function dbs() {
  const inDb = new Database(':memory:');
  inDb.exec(INBOUND_SCHEMA);
  const outDb = new Database(':memory:');
  outDb.exec(OUTBOUND_SCHEMA);
  return { inDb, outDb };
}
function addTask(inDb: Database.Database, id: string, tries = 0) {
  inDb
    .prepare(
      `INSERT INTO messages_in (id, seq, timestamp, status, tries, process_after, recurrence, kind, content, series_id)
       VALUES (?, 2, datetime('now'), 'pending', ?, datetime('now','-1 minute'), '0 14 * * 1-5', 'task', '{}', ?)`,
    )
    .run(id, tries, id);
}
const ack = (outDb: Database.Database, id: string, status: string) =>
  outDb
    .prepare(
      "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, datetime('now'))",
    )
    .run(id, status);
const row = (inDb: Database.Database, id: string) =>
  inDb.prepare('SELECT status, tries, process_after FROM messages_in WHERE id = ?').get(id) as {
    status: string;
    tries: number;
    process_after: string;
  };

describe('retry acks', () => {
  it('reschedules instead of completing, so the recurrence is not advanced', () => {
    const { inDb, outDb } = dbs();
    addTask(inDb, 'task-1');
    ack(outDb, 'task-1', 'retry');

    syncProcessingAcks(inDb, outDb);

    const r = row(inDb, 'task-1');
    expect(r.status).toBe('pending'); // NOT completed — handleRecurrence must not advance it
    expect(r.tries).toBe(1);
    expect(new Date(r.process_after + 'Z').getTime()).toBeGreaterThan(Date.now());
  });

  it('clears the retry ack so a later container can claim the message again', () => {
    const { inDb, outDb } = dbs();
    addTask(inDb, 'task-1');
    ack(outDb, 'task-1', 'retry');

    syncProcessingAcks(inDb, outDb);

    const left = outDb.prepare('SELECT COUNT(*) n FROM processing_ack WHERE message_id = ?').get('task-1') as {
      n: number;
    };
    expect(left.n).toBe(0);
  });

  it('gives up as failed, not completed, once retries are exhausted', () => {
    const { inDb, outDb } = dbs();
    addTask(inDb, 'task-1', 16);
    ack(outDb, 'task-1', 'retry');

    syncProcessingAcks(inDb, outDb);

    expect(row(inDb, 'task-1').status).toBe('failed');
  });

  it('still completes ordinary completed acks', () => {
    const { inDb, outDb } = dbs();
    addTask(inDb, 'task-1');
    ack(outDb, 'task-1', 'completed');

    syncProcessingAcks(inDb, outDb);

    expect(row(inDb, 'task-1').status).toBe('completed');
  });

  it('backs off slowly enough to outlast a real outage, and caps', () => {
    expect(connectivityBackoffSec(0)).toBe(60);
    expect(connectivityBackoffSec(3)).toBe(480);
    expect(connectivityBackoffSec(10)).toBe(600); // capped
    // Total patience must exceed the 45-minute outage that lost two reports.
    const total = Array.from({ length: 16 }, (_, i) => connectivityBackoffSec(i)).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(45 * 60);
  });
});

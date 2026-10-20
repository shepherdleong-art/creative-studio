import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { applyFilmRework } from '../lib/final-edit/reassembled/rework.ts';

// Empty DB deliberately has no task tables: malformed requests must be rejected
// before any query or job creation. RegExp.test would otherwise coerce undefined.
const db = new Database(':memory:');
try {
  for (const raw of ['{}', '{"requestId":null}', '{"requestId":123456789}', '{"requestId":{}}', '{"requestId":"short"}', 'null', '[]']) {
    const command = { ...JSON.parse(raw), type: 'generate_image' as const, expectedRevision: 0 };
    await assert.rejects(applyFilmRework(db, '', '', '', command, 'agent'), { code: 'film_rework_invalid', status: 400 });
  }
  console.log('PASS missing/non-string request identity rejected before database access');
} finally { db.close(); }

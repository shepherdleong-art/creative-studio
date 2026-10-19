import path from 'node:path';
import Database from 'better-sqlite3';
import { checkBatchProductionReadiness } from '../lib/batch-production/readiness.ts';

const root = process.argv[2];
if (!root) throw new Error('worker root is required');

const db = new Database(path.join(root, 'workbench.db'));
db.pragma('foreign_keys = ON');
try {
  await checkBatchProductionReadiness({
    db,
    backupRoot: path.join(root, 'backups'),
    lockDatabasePath: path.join(root, 'schema-upgrade.lock.db'),
    auditFilePath: path.join(root, 'schema-upgrades.jsonl'),
  });
} finally {
  db.close();
}

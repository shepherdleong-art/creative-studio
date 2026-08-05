import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createValidatedSchemaUpgradeBackup } from '../lib/schema-upgrade/backup.ts';
import { listSchemaUpgradeRecoveryCandidates } from '../lib/schema-upgrade/recovery.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-schema-recovery-'));

try {
  const databasePath = path.join(root, 'workbench.db');
  const db = new Database(databasePath);
  db.exec(`CREATE TABLE legacy_data (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.prepare(`INSERT INTO legacy_data (id, value) VALUES (?, ?)`).run('legacy-1', '保留内容');
  const backupRoot = path.join(root, 'backups');
  const backup = await createValidatedSchemaUpgradeBackup({
    db,
    backupRoot,
    scope: 'batch-production',
    sourceVersions: [],
    targetVersion: 1,
    now: new Date('2026-08-01T14:00:00.000Z'),
  });
  db.close();

  const verified = await listSchemaUpgradeRecoveryCandidates({
    backupRoot,
    scope: 'batch-production',
  });
  assert.equal(verified.length, 1);
  assert.equal(verified[0]?.verification, 'verified');
  assert.equal(verified[0]?.backupId, path.basename(backup.directory));
  assert.equal('directory' in (verified[0] ?? {}), false, '恢复接口不得暴露本机绝对路径');
  assert.equal(verified[0]?.databaseSha256, backup.manifest.sha256);

  fs.appendFileSync(path.join(backup.directory, 'workbench.db'), 'tampered');
  const tampered = await listSchemaUpgradeRecoveryCandidates({
    backupRoot,
    scope: 'batch-production',
  });
  assert.equal(tampered[0]?.verification, 'invalid');
  if (tampered[0]?.verification === 'invalid') {
    assert.equal(tampered[0].code, 'size_mismatch');
  }

  console.log('schema upgrade recovery tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

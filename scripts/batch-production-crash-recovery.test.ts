import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { checkBatchProductionReadiness } from '../lib/batch-production/readiness.ts';
import { readSchemaUpgradeAudit } from '../lib/schema-upgrade/audit.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-crash-'));

try {
  const databasePath = path.join(root, 'workbench.db');
  const setupDb = new Database(databasePath);
  setupDb.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE large_legacy_payload (id TEXT PRIMARY KEY, payload BLOB NOT NULL);
    INSERT INTO projects (id, name) VALUES ('project-1', '崩溃演练项目');
    INSERT INTO large_legacy_payload (id, payload) VALUES ('payload-1', zeroblob(67108864));
  `);
  setupDb.close();

  const workerPath = fileURLToPath(new URL('./batch-production-readiness-worker.ts', import.meta.url));
  const worker = spawn(process.execPath, [workerPath, root], { stdio: ['ignore', 'ignore', 'pipe'] });
  const auditFilePath = path.join(root, 'schema-upgrades.jsonl');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(auditFilePath) && fs.readFileSync(auditFilePath, 'utf8').includes('"event":"started"')) break;
    if (worker.exitCode !== null) throw new Error('readiness worker exited before crash injection');
    await delay(2);
  }
  assert.ok(fs.existsSync(auditFilePath), 'worker 必须先持久记录升级开始');
  const backupRoot = path.join(root, 'backups');
  while (Date.now() < deadline) {
    if (
      fs.existsSync(backupRoot)
      && fs.readdirSync(backupRoot).some((name) => name.startsWith('.pre-'))
    ) break;
    if (worker.exitCode !== null) throw new Error('readiness worker exited before backup crash injection');
    await delay(2);
  }
  assert.ok(
    fs.existsSync(backupRoot)
    && fs.readdirSync(backupRoot).some((name) => name.startsWith('.pre-')),
    '必须在 Online Backup 已开始写暂存目录后注入崩溃',
  );
  worker.kill('SIGKILL');
  await new Promise<void>((resolve, reject) => {
    worker.once('exit', () => resolve());
    worker.once('error', reject);
  });

  const beforeRecovery = await readSchemaUpgradeAudit(auditFilePath);
  assert.ok(beforeRecovery.some(({ event }) => event === 'started'));
  assert.equal(beforeRecovery.some(({ event }) => event === 'finished'), false);

  const recoveryDb = new Database(databasePath);
  recoveryDb.pragma('foreign_keys = ON');
  const recovered = await checkBatchProductionReadiness({
    db: recoveryDb,
    backupRoot,
    lockDatabasePath: path.join(root, 'schema-upgrade.lock.db'),
    auditFilePath,
  });
  assert.equal(recovered.available, true);
  assert.ok(recoveryDb.prepare(`SELECT 1 FROM batch_productions LIMIT 1`).get() === undefined);
  assert.equal(
    (recoveryDb.prepare(`SELECT length(payload) AS bytes FROM large_legacy_payload`).get() as { bytes: number }).bytes,
    67_108_864,
  );
  recoveryDb.close();

  const afterRecovery = await readSchemaUpgradeAudit(auditFilePath);
  assert.ok(afterRecovery.some(({ event }) => event === 'interrupted_recovered'));
  const backupEntries = fs.readdirSync(backupRoot);
  assert.equal(backupEntries.some((name) => name.startsWith('.pre-')), false, '中断遗留的备份暂存目录必须被清理');

  console.log('batch production crash recovery tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

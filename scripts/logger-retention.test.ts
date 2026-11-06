import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-logger-retention-'));
const previousEnv = { ...process.env };
const {
  appendBoundedWorkbenchLog,
  cleanupBoundedWorkbenchLogs,
  workbenchLogRetention,
} = await import('../lib/logger.ts');

try {
  const directory = path.join(root, 'storage', 'logs');
  const journalDirectory = path.join(root, 'storage', 'execution-journal');
  fs.mkdirSync(journalDirectory, { recursive: true });
  fs.writeFileSync(path.join(journalDirectory, 'receipt.jsonl'), 'do-not-delete');
  const retention = {
    retentionDays: 30,
    maxFileBytes: 2_048,
    maxTotalBytes: 5_120,
    maxFiles: 4,
  };
  assert.deepEqual(workbenchLogRetention({
    CREATIVE_STUDIO_LOG_RETENTION_DAYS: '14',
    CREATIVE_STUDIO_LOG_MAX_FILE_BYTES: '4096',
    CREATIVE_STUDIO_LOG_MAX_TOTAL_BYTES: '16384',
    CREATIVE_STUDIO_LOG_MAX_FILES: '8',
  }), { retentionDays: 14, maxFileBytes: 4096, maxTotalBytes: 16384, maxFiles: 8 });
  const defaults = workbenchLogRetention({});
  assert.ok(defaults.retentionDays > 0 && defaults.maxFileBytes > 0 && defaults.maxTotalBytes > 0 && defaults.maxFiles > 0);

  for (let index = 0; index < 20; index += 1) {
    appendBoundedWorkbenchLog(directory, `${'x'.repeat(600)}-${index}`, retention, new Date('2026-11-02T04:00:00.000Z'));
  }
  const rotated = fs.readdirSync(directory).filter((name) => name.startsWith('workbench-'));
  assert.ok(rotated.length > 1, '活动文件达到上限后也必须轮转');
  assert.ok(rotated.length <= retention.maxFiles);
  const bytes = rotated.reduce((sum, name) => sum + fs.statSync(path.join(directory, name)).size, 0);
  assert.ok(bytes <= retention.maxTotalBytes, `普通日志总字节必须有界，实际 ${bytes}`);
  assert.ok(rotated.every((name) => fs.statSync(path.join(directory, name)).size <= retention.maxFileBytes));

  const active = rotated.find((name) => /^workbench-\d{4}-\d{2}-\d{2}\.log$/.test(name));
  assert.ok(active, '轮转后必须保留当前活动文件');
  fs.utimesSync(path.join(directory, active!), new Date('2020-01-01'), new Date('2020-01-01'));
  cleanupBoundedWorkbenchLogs(directory, { ...retention, retentionDays: 1 }, new Date('2026-11-02T04:00:00.000Z'));
  assert.equal(fs.existsSync(path.join(directory, active!)), false, '过期活动文件同样可清理');
  assert.equal(fs.readFileSync(path.join(journalDirectory, 'receipt.jsonl'), 'utf8'), 'do-not-delete', '普通日志清理绝不能触碰 execution journal');

  console.log('PASS: configurable bounded active-file rotation and isolated log retention');
} finally {
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}

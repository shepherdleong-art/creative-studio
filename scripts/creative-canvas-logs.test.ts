import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// 日志落盘到 dataRoot()/storage/logs，而 lib/data-root.ts 在加载时就固定数据根：
// 先建临时数据根再动态导入，避免写进仓库自己的 storage/logs。
process.env.CREATIVE_STUDIO_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-canvas-logs-'));
const { CREATIVE_CANVAS_MIGRATIONS } = await import('../lib/creative-canvas/schema.ts');
const { createCanvas } = await import('../lib/creative-canvas/repository.ts');
const { getCanvasLogs, writeCanvasLog } = await import('../lib/creative-canvas/logs.ts');
const { claimCanvasTasks, updateCanvasTaskGuarded, updateCanvasTaskUnGuarded } = await import('../lib/creative-canvas/tasks.ts');
const { sanitizeMessage } = await import('../lib/log-sanitize.ts');
const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
for (const migration of CREATIVE_CANVAS_MIGRATIONS) db.exec(migration.sql);
const canvas = createCanvas(db, { name: '日志测试' });
const other = createCanvas(db, { name: '另一画布' });
const at = '2026-10-06T00:00:00.000Z';
db.prepare(`INSERT INTO creative_canvas_tasks
  (id, canvasId, nodeId, nodeEpoch, mediaKind, phase, createdAt, updatedAt)
  VALUES (?, ?, 'node-1', 0, 'image', 'queued', ?, ?)`).run('task-1', canvas.id, at, at);
const historical = getCanvasLogs(db, canvas.id);
assert.equal(historical.length, 1);
assert.match(historical[0].message, /历史任务状态/);
const claimed = claimCanvasTasks({ db, workerId: 'worker', now: () => new Date(at) });
assert.equal(claimed.length, 1);
const guard = { workerId: 'worker', fence: claimed[0].fence };
const update = (patch: Parameters<typeof updateCanvasTaskGuarded>[1]['patch']) =>
  updateCanvasTaskGuarded(db, { taskId: 'task-1', guard, patch, now: () => new Date(at) });
update({ phase: 'submitting' });
update({ phase: 'polling', providerTaskId: 'remote-123' });
const beforeHeartbeat = getCanvasLogs(db, canvas.id).length;
update({ pollCount: 1, lastPolledAt: at });
assert.equal(getCanvasLogs(db, canvas.id).length, beforeHeartbeat, '正常轮询不刷日志');
assert.equal(updateCanvasTaskGuarded(db, {
  taskId: 'task-1', guard: { ...guard, fence: -1 }, patch: { phase: 'failed' },
}), false);
assert.equal(getCanvasLogs(db, canvas.id).length, beforeHeartbeat, '旧租约不留虚假日志');
const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
update({ phase: 'download_failed', errorCode: 'download_error',
  errorMessage: `下载异常 ${secret} https://bucket.example/x?q-signature=private-secret&token=hidden` });
let logs = getCanvasLogs(db, canvas.id, { jobId: 'task-1' });
assert.equal(logs.at(-1)?.level, 'error');
assert.match(logs.at(-1)!.message, /download_error/);
assert.match(logs.at(-1)!.message, /remote-123/);
assert.ok(!JSON.stringify(logs).includes(secret));
assert.ok(!JSON.stringify(logs).includes('private-secret'));
assert.deepEqual(getCanvasLogs(db, other.id, { jobId: 'task-1' }), [], '任务筛选不可越过画布范围');
assert.equal(getCanvasLogs(db, canvas.id, { limit: 2 }).length, 2);
assert.equal(getCanvasLogs(db, canvas.id, { limit: NaN }).length, logs.length);
updateCanvasTaskUnGuarded(db, 'task-1', { phase: 'polling', errorCode: null, errorMessage: null, updatedAt: at });
logs = getCanvasLogs(db, canvas.id);
assert.equal(logs.at(-1)?.level, 'info');
assert.ok(logs.some((entry) => entry.level === 'error'), '恢复后仍保留错误');
assert.match(logs.at(-1)!.message, /查询生成进度/);
const persisted = db.prepare('SELECT message FROM creative_canvas_logs').all();
assert.ok(!JSON.stringify(persisted).includes(secret), '落库前必须脱敏');
const file = path.join(process.env.CREATIVE_STUDIO_DATA_ROOT!, 'storage', 'logs', 'canvas-2026-10-06.log');
assert.ok(!fs.readFileSync(file, 'utf8').includes(secret), '文件日志同样脱敏');
assert.ok(!sanitizeMessage('api_key="short-secret" Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456').includes('short-secret'));
db.prepare(`INSERT INTO creative_canvas_tasks
  (id, canvasId, nodeId, nodeEpoch, mediaKind, phase, errorCode, errorMessage, createdAt, updatedAt)
  VALUES ('legacy-failed', ?, 'old-node', 0, 'image', 'download_failed', 'old_error', '旧下载错误', ?, ?)`)
  .run(canvas.id, at, at);
updateCanvasTaskUnGuarded(db, 'legacy-failed', { phase: 'polling', errorCode: null, errorMessage: null, updatedAt: at });
const recoveredLegacy = getCanvasLogs(db, canvas.id, { jobId: 'legacy-failed' });
assert.equal(recoveredLegacy.length, 2);
assert.match(recoveredLegacy[0].message, /历史任务状态.*旧下载错误/);
assert.match(recoveredLegacy[1].message, /查询生成进度/);
db.prepare('DELETE FROM creative_canvases WHERE id = ?').run(canvas.id);
assert.deepEqual(getCanvasLogs(db, canvas.id), [], '删除画布级联清理日志');
writeCanvasLog(db, { canvasId: other.id, message: '无任务的启动失败', level: 'error' });
assert.equal(getCanvasLogs(db, other.id)[0].jobId, null);
db.close();
console.log('creative-canvas-logs: passed');

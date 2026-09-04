import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationScript = path.join(repoRoot, 'scripts', 'migrate-portable-data.mjs');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-portable-migration-'));

try {
  const oldRoot = path.join(fixtureRoot, '创意工作台-0.5.2-免安装版');
  const newRoot = path.join(fixtureRoot, '创意工作台-0.6.0-免安装版');
  const oldStorage = path.join(oldRoot, 'storage');
  const newStorage = path.join(newRoot, 'storage');
  const oldDbPath = path.join(oldRoot, 'data', 'workbench.db');

  fs.mkdirSync(path.dirname(oldDbPath), { recursive: true });
  fs.mkdirSync(path.join(oldStorage, 'processed', 'inputs'), { recursive: true });
  fs.mkdirSync(path.join(oldStorage, 'videos'), { recursive: true });
  fs.mkdirSync(path.join(oldStorage, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(oldStorage, 'run'), { recursive: true });
  fs.mkdirSync(newRoot, { recursive: true });
  fs.writeFileSync(path.join(oldStorage, 'processed', 'inputs', 'thumb.png'), 'image');
  fs.writeFileSync(path.join(oldStorage, 'videos', 'clip.mp4'), 'video');
  fs.writeFileSync(path.join(oldStorage, 'logs', 'old.log'), 'do not migrate');
  fs.writeFileSync(path.join(oldStorage, 'run', 'stack.json'), '{"stale":true}');

  const oldImagePath = path.join(oldStorage, 'processed', 'inputs', 'thumb.png');
  const oldVideoPath = path.join(oldStorage, 'videos', 'clip.mp4');
  const sourceDb = new Database(oldDbPath);
  sourceDb.pragma('journal_mode = WAL');
  sourceDb.exec(`
    CREATE TABLE image_assets (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      originalPath TEXT,
      processedPath TEXT
    );
    CREATE TABLE video_jobs (
      id TEXT PRIMARY KEY,
      localVideoPath TEXT
    );
    CREATE TABLE job_logs (
      id TEXT PRIMARY KEY,
      message TEXT NOT NULL
    );
  `);
  sourceDb.prepare(`
    INSERT INTO image_assets (id, path, originalPath, processedPath)
    VALUES ('image-1', ?, ?, ?)
  `).run(oldImagePath, oldImagePath, oldImagePath);
  sourceDb.prepare(`
    INSERT INTO video_jobs (id, localVideoPath)
    VALUES ('video-1', ?)
  `).run(oldVideoPath);
  sourceDb.prepare(`INSERT INTO job_logs (id, message) VALUES ('log-1', 'old diagnostic log')`).run();
  sourceDb.close();

  const result = spawnSync(
    process.execPath,
    [migrationScript, '--old-root', oldRoot, '--new-root', newRoot],
    { encoding: 'utf8', timeout: 120_000 },
  );
  assert.equal(result.status, 0, `迁移命令应成功：\n${result.stdout}\n${result.stderr}`);

  const migratedImage = path.join(newStorage, 'processed', 'inputs', 'thumb.png');
  const migratedVideo = path.join(newStorage, 'videos', 'clip.mp4');
  assert.equal(fs.readFileSync(migratedImage, 'utf8'), 'image');
  assert.equal(fs.readFileSync(migratedVideo, 'utf8'), 'video');
  assert.ok(!fs.existsSync(path.join(newStorage, 'logs')), '旧日志不得迁移');
  assert.ok(!fs.existsSync(path.join(newStorage, 'run')), '旧运行状态不得迁移');

  const migratedDbPath = path.join(newRoot, 'data', 'workbench.db');
  const migratedDb = new Database(migratedDbPath, { readonly: true });
  assert.equal(migratedDb.pragma('quick_check', { simple: true }), 'ok');
  const imageRow = migratedDb.prepare(`
    SELECT path, originalPath, processedPath FROM image_assets WHERE id = 'image-1'
  `).get();
  const videoRow = migratedDb.prepare(`
    SELECT localVideoPath FROM video_jobs WHERE id = 'video-1'
  `).get();
  const migratedLogCount = migratedDb.prepare(`SELECT COUNT(*) AS count FROM job_logs`).get().count;
  migratedDb.close();
  assert.deepEqual(imageRow, {
    path: migratedImage,
    originalPath: migratedImage,
    processedPath: migratedImage,
  });
  assert.deepEqual(videoRow, { localVideoPath: migratedVideo });
  assert.equal(migratedLogCount, 0, '旧数据库中的 job_logs 也不得迁移');

  assert.equal(fs.readFileSync(oldImagePath, 'utf8'), 'image', '迁移不得修改旧版本目录');
  const unchangedOldDb = new Database(oldDbPath, { readonly: true });
  assert.equal(unchangedOldDb.prepare(`SELECT COUNT(*) AS count FROM job_logs`).get().count, 1, '旧库日志不得被删除');
  unchangedOldDb.close();
  assert.ok(
    fs.readdirSync(newRoot).some((name) => name.startsWith('迁移报告-') && name.endsWith('.json')),
    '迁移成功后必须留下可核对的审计报告',
  );
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('portable data migration behavior test passed');

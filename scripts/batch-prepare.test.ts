import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runFfmpeg } from '../lib/ffmpeg.ts';

// dataRoot 必须指向独立测试根,并在动态导入依赖模块前设置
const externalDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-prepare-root-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = externalDataRoot;

const mediaCatalog = await import('../lib/batch-production/media-catalog.ts');
const schemaModule = await import('../lib/batch-production/schema.ts');
const prepareModule = await import('../lib/batch-production/prepare.ts');

function createLegacyDatabase(root: string, name: string): Database.Database {
  const db = new Database(path.join(root, name));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE shot_sets (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      name TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE script_drafts (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'gemini',
      model TEXT,
      inputSnapshot TEXT NOT NULL,
      outputJson TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE TABLE video_jobs (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      shotSetId TEXT,
      sourceImageId TEXT NOT NULL,
      providerId TEXT NOT NULL,
      model TEXT NOT NULL,
      templateId TEXT,
      prompt TEXT NOT NULL,
      durationSec INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'pending',
      remoteVideoUrl TEXT,
      localVideoPath TEXT,
      filename TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      maxAttempts INTEGER NOT NULL DEFAULT 1,
      errorMessage TEXT,
      startedAt TEXT,
      finishedAt TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (shotSetId) REFERENCES shot_sets(id) ON DELETE SET NULL
    );
    INSERT INTO projects (id, name) VALUES ('project-1', '项目一');
    INSERT INTO projects (id, name) VALUES ('project-2', '项目二');
    INSERT INTO shot_sets (id, projectId, name, createdAt) VALUES ('ss-1', 'project-1', '分镜组A', '2026-08-02T00:00:00.000Z');
    INSERT INTO shot_sets (id, projectId, name, createdAt) VALUES ('ss-2', 'project-2', '分镜组B', '2026-08-02T00:00:00.000Z');
  `);
  return db;
}

function insertDraft(db: Database.Database, id: string, projectId: string, outputJson: string): void {
  db.prepare(`
    INSERT INTO script_drafts (id, projectId, inputSnapshot, outputJson, createdAt)
    VALUES (?, ?, '{}', ?, '2026-08-02T09:00:00.000Z')
  `).run(id, projectId, outputJson);
}

function validV2Script(title: string, narration: string[], shotSetId: string): string {
  return JSON.stringify({
    version: 2,
    title,
    shotSetId,
    targetDurationSec: 30,
    coverTitleParts: { primary: `主:${title}`, secondary: '副标题' },
    segments: narration.map((n) => ({ narration: n, subtitle: n })),
    fullScript: narration.join('\n'),
  });
}

function insertVideoJob(db: Database.Database, id: string, projectId: string, shotSetId: string, status: string, localVideoPath: string | null): void {
  db.prepare(`
    INSERT INTO video_jobs (id, projectId, shotSetId, sourceImageId, providerId, model, prompt, durationSec, status, localVideoPath, filename)
    VALUES (?, ?, ?, 'img-1', 'provider-1', 'model-a', 'prompt', 5, ?, ?, 'clip.mp4')
  `).run(id, projectId, shotSetId, status, localVideoPath);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-prepare-'));

try {
  const dbRoot = path.join(root, 'db');
  fs.mkdirSync(dbRoot, { recursive: true });
  const db = createLegacyDatabase(dbRoot, 'workbench.db');

  const migrated = await schemaModule.ensureBatchSchemaReady({
    db,
    backupRoot: path.join(dbRoot, 'backups'),
    now: () => new Date('2026-08-02T08:00:00.000Z'),
  });
  assert.equal(migrated.state, 'ready');

  // 第 3 步有效脚本 + 第 4 步成功视频(project-1)
  insertDraft(db, 'draft-a', 'project-1', validV2Script('口播A', ['第一段'], 'ss-1'));
  insertDraft(db, 'draft-bad', 'project-1', '{not json');
  insertDraft(db, 'draft-p2', 'project-2', validV2Script('项目二脚本', ['项目二正文'], 'ss-2'));
  const videosDir = path.join(mediaCatalog.storageRootOf(), 'videos');
  fs.mkdirSync(videosDir, { recursive: true });
  const videoFile = path.join(videosDir, 'module4-a.mp4');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=red:duration=0.3:size=64x64:rate=12',
    '-pix_fmt', 'yuv420p', '-y', videoFile,
  ]);
  insertVideoJob(db, 'video-job-1', 'project-1', 'ss-1', 'succeeded', 'videos/module4-a.mp4');
  insertVideoJob(db, 'video-job-p2', 'project-2', 'ss-2', 'succeeded', 'videos/module4-a.mp4');
  insertVideoJob(db, 'video-job-pending', 'project-1', 'ss-1', 'queued', 'videos/module4-a.mp4');
  // 产物文件已缺失的成功任务(应产生 warning,不阻塞)
  insertVideoJob(db, 'video-job-missing-file', 'project-1', 'ss-1', 'succeeded', 'videos/gone.mp4');

  // --- 从业务入口进入:脚本和素材自动出现在批量准备区 ---
  const preparation = await prepareModule.prepareBatchProductionInputs(db, 'project-1');
  assert.equal(preparation.project.id, 'project-1');

  // 脚本:只有项目 1 的有效草稿;无效草稿跳过;项目 2 的脚本不出现
  assert.deepEqual(preparation.scripts.map(({ title }) => title), ['口播A'], '有效脚本自动进入准备区');
  assert.ok(preparation.scripts[0]?.shotSetId === 'ss-1', '脚本保留分镜组归属');
  assert.ok(preparation.scripts[0]?.coverTitle, '脚本带结构化封面标题');
  assert.match(preparation.scripts[0]?.contentRevision ?? '', /^[a-f0-9]{64}$/, '脚本带内容修订身份');

  // 素材:成功视频自动登记;失败任务不阻塞但给出 warning
  assert.equal(preparation.assets.length, 1, '成功视频自动登记为素材');
  assert.equal(preparation.assets[0]?.status, 'online');
  const module4Source = preparation.assets[0]?.sources.find(({ sourceKind }) => sourceKind === 'module4');
  assert.ok(module4Source, '素材带模块 4 来源');
  assert.equal(module4Source?.health, 'healthy');
  assert.equal((module4Source?.location as { videoJobId: string }).videoJobId, 'video-job-1');
  assert.equal(
    preparation.warnings.some((warning) => warning.includes('video-job-missing-file')),
    true,
    '产物缺失的成功任务登记失败必须给出 warning,不阻塞整体',
  );
  assert.equal(
    preparation.warnings.some((warning) => warning.includes('video-job-pending')),
    false,
    '未成功任务不进入登记流程,不产生 warning',
  );

  // 项目隔离:project-2 的入口只看到自己的数据
  const preparationP2 = await prepareModule.prepareBatchProductionInputs(db, 'project-2');
  assert.deepEqual(preparationP2.scripts.map(({ title }) => title), ['项目二脚本']);
  assert.equal(preparationP2.assets.length, 1, 'project-2 只登记自己的成功视频');
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM batch_assets WHERE projectId = 'project-1'`).get() as { n: number }).n,
    1,
    'project-2 的登记不得污染 project-1 的素材',
  );

  // 再次进入:幂等,不产生重复来源
  const again = await prepareModule.prepareBatchProductionInputs(db, 'project-1');
  assert.equal(again.assets.length, 1, '重复进入准备区不新增素材身份');
  assert.equal(
    mediaCatalog.listAssetSources(db, again.assets[0]!.id).filter(({ sourceKind }) => sourceKind === 'module4').length,
    1,
    '重复进入准备区不新增来源行',
  );

  // 不存在的项目
  await assert.rejects(
    () => prepareModule.prepareBatchProductionInputs(db, 'no-such-project'),
    /项目不存在/,
    '不存在的项目必须报错(API 层转 404)',
  );

  db.close();
  console.log('batch prepare tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(externalDataRoot, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import {
  listAssetSources,
  registerLinkedSource,
  registerManagedCopy,
  registerModule4Video,
  verifyAssetSources,
} from '../lib/batch-production/media-catalog.ts';
import { getAsset, listProjectAssets } from '../lib/batch-production/assets.ts';

function createLegacyDatabase(root: string, name: string): { db: Database.Database; databasePath: string } {
  const databasePath = path.join(root, name);
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    INSERT INTO projects (id, name) VALUES ('project-1', '项目一');
    INSERT INTO projects (id, name) VALUES ('project-2', '项目二');
  `);
  return { db, databasePath };
}

function makeVideoFile(root: string, name: string, content: Buffer): string {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-media-catalog-'));

try {
  const dbRoot = path.join(root, 'db');
  fs.mkdirSync(dbRoot, { recursive: true });
  const { db } = createLegacyDatabase(dbRoot, 'workbench.db');

  const migrated = await ensureBatchSchemaReady({
    db,
    backupRoot: path.join(dbRoot, 'backups'),
    now: () => new Date('2026-08-02T08:00:00.000Z'),
  });
  assert.equal(migrated.state, 'ready');

  // --- 结构:来源表 ---
  const sourceColumns = db.prepare(`PRAGMA table_info(batch_asset_sources)`).all() as Array<{
    name: string; notnull: number; pk: number;
  }>;
  const sourceNames = new Map(sourceColumns.map((c) => [c.name, c]));
  for (const name of ['id', 'assetId', 'sourceKind', 'locationJson', 'health', 'createdAt']) {
    assert.ok(sourceNames.has(name), `batch_asset_sources 缺少列 ${name}`);
  }
  const sourceForeignKeys = db.prepare(`PRAGMA foreign_key_list(batch_asset_sources)`).all() as Array<{
    table: string; from: string; to: string; on_delete: string;
  }>;
  assert.ok(sourceForeignKeys.some((fk) => (
    fk.table === 'batch_assets' && fk.from === 'assetId' && fk.to === 'id' && fk.on_delete.toUpperCase() === 'CASCADE'
  )), '来源表缺少指向素材的级联外键');

  // --- 素材文件准备 ---
  const videosDir = path.join(root, 'videos');
  fs.mkdirSync(path.join(videosDir, 'copies'), { recursive: true });
  const videoA = makeVideoFile(videosDir, 'clip-a.mp4', Buffer.from('module4-video-content-a', 'utf8'));
  const videoACopy = makeVideoFile(videosDir, 'copies/clip-a-copy.mp4', Buffer.from('module4-video-content-a', 'utf8'));
  const differentVideo = makeVideoFile(videosDir, 'clip-b.mp4', Buffer.from('totally-different-content', 'utf8'));
  const managedRoot = path.join(root, 'managed');
  fs.mkdirSync(managedRoot, { recursive: true });

  // --- 场景 1:同一完整内容通过模块 4 与链接两种来源加入,只有一份素材身份 ---
  const module4AssetId = await registerModule4Video(db, 'project-1', {
    videoJobId: 'video-job-1',
    shotSetId: 'ss-1',
    filename: 'clip-a.mp4',
    localVideoPath: videoA,
    now: () => new Date('2026-08-02T09:00:00.000Z'),
  });
  assert.ok(module4AssetId);
  const linkedAssetId = await registerLinkedSource(db, 'project-1', {
    filePath: videoACopy,
    displayName: '相机原文件副本',
    now: () => new Date('2026-08-02T09:05:00.000Z'),
  });
  assert.equal(linkedAssetId, module4AssetId, '同一内容指纹一致时必须复用同一素材身份');
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM batch_assets`).get() as { n: number }).n, 1);

  const sources = listAssetSources(db, module4AssetId);
  assert.equal(sources.length, 2, '素材身份下必须记录两个来源');
  assert.ok(sources.some(({ sourceKind }) => sourceKind === 'module4'), '模块 4 来源已登记');
  assert.ok(sources.some(({ sourceKind }) => sourceKind === 'linked'), '链接来源已登记');

  // --- 场景 2:同名但内容不同的文件不得冒充旧素材 ---
  const otherAssetId = await registerModule4Video(db, 'project-1', {
    videoJobId: 'video-job-2',
    shotSetId: 'ss-1',
    filename: 'clip-a.mp4',
    localVideoPath: differentVideo,
    now: () => new Date('2026-08-02T09:10:00.000Z'),
  });
  assert.notEqual(otherAssetId, module4AssetId, '同名但内容不同的文件必须是新素材');
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM batch_assets`).get() as { n: number }).n, 2);

  // --- 场景 3:项目隔离:项目 2 登记同一文件,是项目 2 自己的素材 ---
  const project2AssetId = await registerModule4Video(db, 'project-2', {
    videoJobId: 'video-job-3',
    shotSetId: 'ss-9',
    filename: 'clip-a.mp4',
    localVideoPath: videoA,
    now: () => new Date('2026-08-02T09:15:00.000Z'),
  });
  assert.notEqual(project2AssetId, module4AssetId, '同一文件进入另一个项目必须建立项目自己的素材');
  assert.equal(listProjectAssets(db, 'project-1').length, 2);
  assert.equal(listProjectAssets(db, 'project-2').length, 1);

  // --- 场景 4:链接素材登记绝不删除用户原文件 ---
  assert.ok(fs.existsSync(videoACopy), '登记链接素材不得删除用户原文件');
  assert.ok(fs.existsSync(videoA), '登记模块 4 素材不得删除来源文件');

  // --- 场景 5:来源健康:文件被移走后标记离线,素材仍保留 ---
  const movedAway = path.join(videosDir, 'gone', 'clip-a.mp4');
  fs.mkdirSync(path.join(videosDir, 'gone'), { recursive: true });
  fs.renameSync(videoA, movedAway);
  await verifyAssetSources(db, module4AssetId);
  const sourcesAfterMove = listAssetSources(db, module4AssetId);
  assert.ok(sourcesAfterMove.some((s) => s.sourceKind === 'module4' && s.health === 'offline'), '模块 4 来源移走后标记离线');
  assert.ok(sourcesAfterMove.some((s) => s.sourceKind === 'linked' && s.health === 'healthy'), '链接来源仍可用,素材总体可用');
  const assetAfterMove = getAsset(db, 'project-1', module4AssetId);
  assert.ok(assetAfterMove, '来源离线不得删除素材身份');
  // 放回后恢复
  fs.renameSync(movedAway, videoA);
  await verifyAssetSources(db, module4AssetId);
  assert.ok(
    listAssetSources(db, module4AssetId).some((s) => s.sourceKind === 'module4' && s.health === 'healthy'),
    '来源恢复后重新标记可用',
  );

  // --- 场景 6:托管复制:源文件不动,受管副本进入项目数据根 ---
  const managedAssetId = await registerManagedCopy(db, 'project-1', {
    sourcePath: videoACopy,
    managedRoot,
    now: () => new Date('2026-08-02T09:30:00.000Z'),
  });
  assert.equal(managedAssetId, module4AssetId, '托管副本内容一致时只增加来源,不重复建素材');
  assert.ok(fs.existsSync(videoACopy), '托管复制不得移动或删除源文件');
  const managedSources = listAssetSources(db, module4AssetId).filter(({ sourceKind }) => sourceKind === 'managed');
  assert.equal(managedSources.length, 1);
  const managedLocation = managedSources[0]!.locationJson as unknown as { relativePath: string };
  assert.ok(fs.existsSync(path.join(managedRoot, managedLocation.relativePath)), '托管副本写入受控目录');
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM batch_assets`).get() as { n: number }).n,
    3,
    '托管复制不得新增素材身份(两个项目共三份素材保持不变)',
  );

  db.close();
  console.log('batch media catalog tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

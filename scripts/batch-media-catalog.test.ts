import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runFfmpeg } from '../lib/ffmpeg.ts';

// dataRoot() 在模块首次加载时解析:必须先设置 CREATIVE_STUDIO_DATA_ROOT,
// 再动态导入依赖 dataRoot 的模块,保证“数据根与 cwd 不同”的行为被真实测试。
const externalDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-data-root-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = externalDataRoot;

const mediaCatalog = await import('../lib/batch-production/media-catalog.ts');
const schemaModule = await import('../lib/batch-production/schema.ts');
const assetsModule = await import('../lib/batch-production/assets.ts');

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

function insertVideoJob(
  db: Database.Database,
  id: string,
  projectId: string,
  shotSetId: string | null,
  status: string,
  localVideoPath: string | null,
  filename = 'clip.mp4',
  durationSec = 5,
): void {
  db.prepare(`
    INSERT INTO video_jobs (id, projectId, shotSetId, sourceImageId, providerId, model, prompt, durationSec, status, localVideoPath, filename)
    VALUES (?, ?, ?, 'img-1', 'provider-1', 'model-a', 'prompt', ?, ?, ?, ?)
  `).run(id, projectId, shotSetId, durationSec, status, localVideoPath, filename);
}

function writeVideo(dir: string, name: string, content: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  const fixture = videoFixtures.get(content);
  if (fixture) fs.copyFileSync(fixture, filePath);
  else fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-media-catalog-'));
const fixtureRoot = path.join(root, 'fixtures');
fs.mkdirSync(fixtureRoot, { recursive: true });
const fixtureA = path.join(fixtureRoot, 'a.mp4');
const fixtureP2 = path.join(fixtureRoot, 'p2.mp4');
const fixtureDifferent = path.join(fixtureRoot, 'different.mp4');
await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=red:duration=0.3:size=64x64:rate=12', '-pix_fmt', 'yuv420p', '-y', fixtureA]);
await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=blue:duration=0.3:size=64x64:rate=12', '-pix_fmt', 'yuv420p', '-y', fixtureP2]);
await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=green:duration=0.3:size=64x64:rate=12', '-pix_fmt', 'yuv420p', '-y', fixtureDifferent]);
const videoFixtures = new Map([
  ['module4-content-a', fixtureA],
  ['module4-content-p2', fixtureP2],
  ['different-content', fixtureDifferent],
]);

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

  // dataRoot 与 cwd 不同的前提已由文件顶部 env 设置保证
  assert.notEqual(mediaCatalog.storageRootOf(), path.join(process.cwd(), 'storage'), 'dataRoot 必须指向独立测试根');

  // --- 模块 4 产物文件(放在 dataRoot()/storage 受控目录) ---
  const storageVideos = path.join(mediaCatalog.storageRootOf(), 'videos');
  const module4File = writeVideo(storageVideos, 'module4-a.mp4', 'module4-content-a');
  insertVideoJob(db, 'video-job-1', 'project-1', 'ss-1', 'succeeded', 'videos/module4-a.mp4', 'module4-a.mp4', 30);

  // --- 测试 7:module4 拒绝场景 ---
  // 不存在的任务
  await assert.rejects(
    () => mediaCatalog.registerModule4Video(db, { videoJobId: 'no-such-job' }),
    /不存在/,
    '不存在的视频任务必须拒绝',
  );
  // 未成功任务
  insertVideoJob(db, 'video-job-pending', 'project-1', 'ss-1', 'queued', 'videos/module4-a.mp4');
  await assert.rejects(
    () => mediaCatalog.registerModule4Video(db, { videoJobId: 'video-job-pending' }),
    /尚未成功/,
    '未成功的视频任务不得登记为素材',
  );
  // 没有产物路径
  insertVideoJob(db, 'video-job-no-path', 'project-1', 'ss-1', 'succeeded', null);
  await assert.rejects(
    () => mediaCatalog.registerModule4Video(db, { videoJobId: 'video-job-no-path' }),
    /没有产物/,
    '无产物路径的视频任务必须拒绝',
  );
  // 伪造路径(产物文件不存在)
  insertVideoJob(db, 'video-job-fake', 'project-1', 'ss-1', 'succeeded', 'videos/does-not-exist.mp4');
  await assert.rejects(
    () => mediaCatalog.registerModule4Video(db, { videoJobId: 'video-job-fake' }),
    /不存在|安全/,
    '伪造产物路径必须拒绝',
  );
  // 越界路径
  insertVideoJob(db, 'video-job-escape', 'project-1', 'ss-1', 'succeeded', '../outside.mp4');
  await assert.rejects(
    () => mediaCatalog.registerModule4Video(db, { videoJobId: 'video-job-escape' }),
    /不安全|越界/,
    '越界路径必须拒绝',
  );
  // 非白名单扩展名
  const exeFile = writeVideo(storageVideos, 'evil.exe', 'not-a-video');
  insertVideoJob(db, 'video-job-exe', 'project-1', 'ss-1', 'succeeded', path.basename(exeFile));
  await assert.rejects(
    () => mediaCatalog.registerModule4Video(db, { videoJobId: 'video-job-exe' }),
    /仅支持/,
    '非视频扩展名必须拒绝',
  );
  // 空分镜归属不得作为模块 4 素材进入项目库
  insertVideoJob(db, 'video-job-no-shot-set', 'project-1', null, 'succeeded', 'videos/module4-a.mp4');
  await assert.rejects(
    () => mediaCatalog.registerModule4Video(db, { videoJobId: 'video-job-no-shot-set' }),
    /分镜组/,
    '没有 shotSetId 的成功任务必须拒绝',
  );
  // video_jobs 的 projectId 与 shot_sets.projectId 不一致时不得登记
  insertVideoJob(db, 'video-job-cross-shot-set', 'project-1', 'ss-2', 'succeeded', 'videos/module4-a.mp4');
  await assert.rejects(
    () => mediaCatalog.registerModule4Video(db, { videoJobId: 'video-job-cross-shot-set' }),
    /分镜组.*项目|项目.*分镜组/,
    '跨项目分镜组不得登记',
  );
  // 只有扩展名像视频、实际容器损坏的文件不得登记
  writeVideo(storageVideos, 'not-video.mp4', 'plain-text-container');
  insertVideoJob(db, 'video-job-bad-container', 'project-1', 'ss-1', 'succeeded', 'videos/not-video.mp4');
  await assert.rejects(
    () => mediaCatalog.registerModule4Video(db, { videoJobId: 'video-job-bad-container' }),
    /视频|容器|读取/,
    '伪造扩展名的非视频文件必须拒绝',
  );
  // 跨项目隔离:project-2 的任务登记为 project-2 的素材,不出现在 project-1
  writeVideo(storageVideos, 'module4-p2.mp4', 'module4-content-p2');
  insertVideoJob(db, 'video-job-p2', 'project-2', 'ss-2', 'succeeded', 'videos/module4-p2.mp4');
  const p2 = await mediaCatalog.registerModule4Video(db, { videoJobId: 'video-job-p2' });
  assert.equal(p2.projectId, 'project-2');
  assert.equal(assetsModule.listProjectAssets(db, 'project-1').length, 0, '跨项目素材不得泄漏');

  // 正常登记
  const first = await mediaCatalog.registerModule4Video(db, { videoJobId: 'video-job-1' });
  assert.equal(first.projectId, 'project-1');

  // --- 测试 2:相同 module4 来源重复登记保持幂等 ---
  await mediaCatalog.registerModule4Video(db, { videoJobId: 'video-job-1' });
  await mediaCatalog.registerModule4Video(db, { videoJobId: 'video-job-1' });
  const module4Sources = mediaCatalog.listAssetSources(db, first.assetId).filter(({ sourceKind }) => sourceKind === 'module4');
  assert.equal(module4Sources.length, 1, '同一模块 4 产物重复登记不得产生重复来源');
  assert.equal(assetsModule.listProjectAssets(db, 'project-1').length, 1);

  // --- 测试 3:同一内容的多种来源只生成一个素材身份 ---
  const userDir = path.join(root, 'user');
  const userFile = writeVideo(userDir, 'camera-a.mp4', 'module4-content-a');
  const linkedId = await mediaCatalog.registerLinkedSource(db, 'project-1', { filePath: userFile, displayName: '相机原片' });
  assert.equal(linkedId, first.assetId, '链接来源与模块 4 内容一致时必须复用同一素材身份');
  const managedId = await mediaCatalog.registerManagedCopy(db, 'project-1', { sourcePath: userFile });
  assert.equal(managedId, first.assetId, '托管副本内容一致时必须复用同一素材身份');
  assert.equal(assetsModule.listProjectAssets(db, 'project-1').length, 1, '三种来源只生成一个素材身份');
  const allSources = mediaCatalog.listAssetSources(db, first.assetId);
  assert.deepEqual(
    allSources.map(({ sourceKind }) => sourceKind).sort(),
    ['linked', 'managed', 'module4'],
    '同一素材记录三种来源',
  );

  // --- 测试 2:相同 linked/managed 来源重复登记保持幂等 ---
  await mediaCatalog.registerLinkedSource(db, 'project-1', { filePath: userFile });
  await mediaCatalog.registerManagedCopy(db, 'project-1', { sourcePath: userFile });
  assert.equal(
    mediaCatalog.listAssetSources(db, first.assetId).filter(({ sourceKind }) => sourceKind === 'linked').length,
    1,
    '同一链接来源重复登记不得新增行',
  );
  assert.equal(
    mediaCatalog.listAssetSources(db, first.assetId).filter(({ sourceKind }) => sourceKind === 'managed').length,
    1,
    '同一托管来源重复登记不得新增行',
  );

  // --- 测试 4:新来源不污染主记录 ---
  const mainRecord = assetsModule.getAsset(db, 'project-1', first.assetId);
  assert.equal(mainRecord?.sourceKind, 'managed', '记录级 sourceKind 保持首个来源(module4→managed)');
  const mainLocation = mainRecord?.locationJson as unknown as { kind: string; videoJobId: string };
  assert.equal(mainLocation.kind, 'module4', '记录级 locationJson 保持首个来源的模块 4 定位');
  assert.equal(mainLocation.videoJobId, 'video-job-1', '后登记的 linked 来源不得覆盖主位置');

  // --- 测试 5:来源离线与聚合状态 ---
  const archivedUserFile = path.join(userDir, 'gone', 'camera-a.mp4');
  fs.mkdirSync(path.dirname(archivedUserFile), { recursive: true });
  fs.renameSync(userFile, archivedUserFile);
  fs.unlinkSync(module4File); // 模块 4 产物消失
  await mediaCatalog.verifyAssetSources(db, first.assetId);
  assert.equal(
    (db.prepare(`SELECT status FROM batch_assets WHERE id = ?`).get(first.assetId) as { status: string }).status,
    'online',
    '模块4与链接离线但托管来源仍可用时,素材保持可用',
  );
  // 再删托管副本:全部来源离线 → 不可用
  const managedRelativePath = (mediaCatalog.listAssetSources(db, first.assetId)
    .find(({ sourceKind }) => sourceKind === 'managed')!.locationJson as { relativePath: string }).relativePath;
  const managedPath = path.join(externalDataRoot, managedRelativePath);
  fs.unlinkSync(managedPath);
  await mediaCatalog.verifyAssetSources(db, first.assetId);
  assert.equal(
    (db.prepare(`SELECT status FROM batch_assets WHERE id = ?`).get(first.assetId) as { status: string }).status,
    'offline',
    '所有来源离线后主素材必须变为不可用',
  );
  // 恢复模块 4 产物:任一来源恢复 → 可用
  writeVideo(path.dirname(module4File), path.basename(module4File), 'module4-content-a');
  fs.renameSync(archivedUserFile, userFile);
  await mediaCatalog.verifyAssetSources(db, first.assetId);
  assert.equal(
    (db.prepare(`SELECT status FROM batch_assets WHERE id = ?`).get(first.assetId) as { status: string }).status,
    'online',
    '任一来源恢复后主素材重新可用',
  );

  // --- 测试 6:linked 重新定位:相同内容成功,不同内容拒绝 ---
  const relocated = writeVideo(userDir, 'camera-a-relocated.mp4', 'module4-content-a');
  const originalLinkedSourceId = mediaCatalog.listAssetSources(db, first.assetId)
    .find(({ sourceKind }) => sourceKind === 'linked')!.id;
  await mediaCatalog.relocateLinkedSource(db, 'project-1', first.assetId, {
    sourceId: originalLinkedSourceId,
    newFilePath: relocated,
  });
  const linkedAfter = mediaCatalog.listAssetSources(db, first.assetId).find(({ sourceKind }) => sourceKind === 'linked');
  assert.equal((linkedAfter?.locationJson as { kind: string; absolutePath: string }).absolutePath, path.resolve(relocated));
  assert.equal(linkedAfter?.health, 'healthy', '内容一致的重新定位恢复 healthy');
  const wrongContent = writeVideo(userDir, 'camera-wrong.mp4', 'different-content');
  await assert.rejects(
    () => mediaCatalog.relocateLinkedSource(db, 'project-1', first.assetId, {
      sourceId: originalLinkedSourceId,
      newFilePath: wrongContent,
    }),
    /不能静默替换/,
    '内容不同的重新定位必须拒绝,不得静默替换',
  );
  assert.equal(
    (mediaCatalog.listAssetSources(db, first.assetId).find(({ sourceKind }) => sourceKind === 'linked')?.locationJson as { absolutePath: string }).absolutePath,
    path.resolve(relocated),
    '拒绝后链接位置保持不变',
  );
  assert.ok(fs.existsSync(wrongContent), '拒绝替换时用户新文件不被删除');

  // 同一素材有多个链接来源时，只更新用户选中的来源
  const secondLinkedPath = writeVideo(userDir, 'camera-a-second.mp4', 'module4-content-a');
  await mediaCatalog.registerLinkedSource(db, 'project-1', { filePath: secondLinkedPath });
  const linkedBeforeTargetedRelink = mediaCatalog.listAssetSources(db, first.assetId)
    .filter(({ sourceKind }) => sourceKind === 'linked');
  assert.equal(linkedBeforeTargetedRelink.length, 2);
  const sourceToRelink = linkedBeforeTargetedRelink.find(({ locationJson }) => (
    (locationJson as { absolutePath: string }).absolutePath === path.resolve(secondLinkedPath)
  ));
  assert.ok(sourceToRelink);
  const targetedPath = writeVideo(userDir, 'camera-a-targeted.mp4', 'module4-content-a');
  await mediaCatalog.relocateLinkedSource(db, 'project-1', first.assetId, {
    sourceId: sourceToRelink.id,
    newFilePath: targetedPath,
  });
  const linkedAfterTargetedRelink = mediaCatalog.listAssetSources(db, first.assetId)
    .filter(({ sourceKind }) => sourceKind === 'linked');
  assert.equal(linkedAfterTargetedRelink.length, 2, '定向重新定位不得覆盖或删除其他链接来源');
  assert.ok(linkedAfterTargetedRelink.some(({ locationJson }) => (
    (locationJson as { absolutePath: string }).absolutePath === path.resolve(relocated)
  )), '未选中的链接来源保持原位置');
  assert.ok(linkedAfterTargetedRelink.some(({ locationJson }) => (
    (locationJson as { absolutePath: string }).absolutePath === path.resolve(targetedPath)
  )), '选中的链接来源更新到新位置');

  // --- 测试 8:托管目标已存在但内容不一致时不能静默复用 ---
  const managedRelative = mediaCatalog.listAssetSources(db, first.assetId)
    .find(({ sourceKind }) => sourceKind === 'managed')!.locationJson as { relativePath: string };
  const managedTarget = path.join(externalDataRoot, managedRelative.relativePath);
  fs.writeFileSync(managedTarget, 'tampered-content', 'utf8'); // 篡改托管副本
  await assert.rejects(
    () => mediaCatalog.registerManagedCopy(db, 'project-1', { sourcePath: userFile }),
    /内容不一致/,
    '托管目标已存在但内容不一致时必须拒绝复用',
  );

  // --- 测试 1 关键断言:托管副本在 CREATIVE_STUDIO_DATA_ROOT 下仍为 healthy ---
  fs.copyFileSync(fixtureA, managedTarget); // 恢复托管副本原内容
  await mediaCatalog.verifyAssetSources(db, first.assetId);
  assert.equal(
    mediaCatalog.listAssetSources(db, first.assetId).find(({ sourceKind }) => sourceKind === 'managed')?.health,
    'healthy',
    'dataRoot 与 cwd 不同时,按相对 dataRoot 路径核验的托管副本必须为 healthy',
  );
  // 托管文件确实在 dataRoot 受控目录,不在 cwd
  assert.ok(managedTarget.startsWith(externalDataRoot), '托管副本必须落在 dataRoot 受控目录');

  // 已发布 v10 的来源 JSON 没有 kind；升级后的读取必须保持兼容，不能把真实文件误判离线
  const legacyFile = writeVideo(userDir, 'legacy-v10.mp4', 'module4-content-p2');
  const legacyFingerprint = await mediaCatalog.computeFileSha256(legacyFile);
  const legacyLocation = { absolutePath: legacyFile, displayName: 'legacy-v10.mp4' };
  const legacyAssetId = assetsModule.createAsset(db, {
    projectId: 'project-1',
    sourceKind: 'linked',
    locationJson: legacyLocation,
    contentFingerprint: `sha256:${legacyFingerprint}`,
    mediaKind: 'video',
  });
  db.prepare(`
    INSERT INTO batch_asset_sources (id, assetId, sourceKind, locationJson, health, createdAt)
    VALUES ('legacy-source', ?, 'linked', ?, 'healthy', '2026-08-02T12:00:00.000Z')
  `).run(legacyAssetId, JSON.stringify(legacyLocation));
  await mediaCatalog.verifyAssetSources(db, legacyAssetId);
  assert.equal(
    mediaCatalog.listAssetSources(db, legacyAssetId)[0]?.health,
    'healthy',
    'v10 无 kind 的旧来源仍须按 sourceKind 兼容解析',
  );

  // v10 托管来源只保存相对旧 managedRoot 的路径；旧约定的 managedRoot
  // 是 dataRoot()/storage/batch-media，升级后仍须从该根恢复定位。
  const legacyManagedRelative = path.join('project-1', `${legacyFingerprint.slice(0, 16)}.mp4`);
  const legacyManagedFile = path.join(externalDataRoot, 'storage', 'batch-media', legacyManagedRelative);
  fs.mkdirSync(path.dirname(legacyManagedFile), { recursive: true });
  fs.copyFileSync(legacyFile, legacyManagedFile);
  db.prepare(`
    INSERT INTO batch_asset_sources (id, assetId, sourceKind, locationJson, health, createdAt)
    VALUES ('legacy-managed-source', ?, 'managed', ?, 'healthy', '2026-08-02T12:01:00.000Z')
  `).run(legacyAssetId, JSON.stringify({ relativePath: legacyManagedRelative }));
  await mediaCatalog.verifyAssetSources(db, legacyAssetId);
  assert.equal(
    mediaCatalog.listAssetSources(db, legacyAssetId).find(({ id }) => id === 'legacy-managed-source')?.health,
    'healthy',
    'v10 托管来源必须按旧 managedRoot 兼容定位，不能升级后误判离线',
  );

  db.close();
  console.log('batch media catalog tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(externalDataRoot, { recursive: true, force: true });
}

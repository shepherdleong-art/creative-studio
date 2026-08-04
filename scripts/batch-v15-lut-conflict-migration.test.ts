// scripts/batch-v15-lut-conflict-migration.test.ts
//
// 回归:v15 迁移必须先确定规范 LUT 身份、重映射引用、再删除重复、最后归一化指纹。
// 数据只在应用到 v14 之后插入(模拟真实旧库),再执行 v15:
// - 同项目同时存在裸 64 位 hex 与 sha256:hex 的同内容 LUT(两条都被历史快照引用);
// - 代理缓存项引用其中一条;proxy_generate 任务指向该缓存项。
// 迁移后:重复项被删除、所有引用重映射到规范身份、指纹归一化、色彩快照完整、
// 既有任务指向稳定的 batch_proxy_requests 且外键检查通过。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BATCH_SCHEMA_MIGRATIONS } from '../lib/batch-production/schema.ts';

function createLegacyDatabase(root: string, name: string): Database.Database {
  const db = new Database(path.join(root, name));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO projects (id, name) VALUES ('project-1', '项目一');
  `);
  return db;
}

function applyMigrationsUpTo(db: Database.Database, upToExclusive: number): void {
  db.exec(`
    CREATE TABLE batch_schema_migrations (
      version INTEGER PRIMARY KEY,
      appliedAt TEXT NOT NULL
    )
  `);
  for (const migration of BATCH_SCHEMA_MIGRATIONS) {
    if (migration.version >= upToExclusive) break;
    db.exec(migration.sql);
    db.prepare(`INSERT INTO batch_schema_migrations (version, appliedAt) VALUES (?, ?)`)
      .run(migration.version, '2026-08-01T00:00:00.000Z');
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-v15-conflict-'));

try {
  const dbRoot = path.join(root, 'db');
  fs.mkdirSync(dbRoot, { recursive: true });
  const db = createLegacyDatabase(dbRoot, 'workbench.db');

  // 1. 只应用到 v14(真实旧库状态)
  applyMigrationsUpTo(db, 15);

  const hex = 'ab'.repeat(32);
  // 2. 裸 hex 与带前缀的同内容 LUT:创建时间相同(都被历史快照引用)、active/archived 混合。
  //    规范身份 tie-break:引用数相同 → 创建时间相同 → active 优先 → 规范 = lut-raw。
  db.prepare(`
    INSERT INTO batch_luts (id, projectId, contentFingerprint, displayName, relativePath, fileSizeBytes, verifiedAt, status, createdAt, updatedAt)
    VALUES ('lut-raw', 'project-1', ?, 'raw.cube', 'storage/luts/project-1/raw.cube', 10, ?, 'active', ?, ?)
  `).run(hex, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
  db.prepare(`
    INSERT INTO batch_luts (id, projectId, contentFingerprint, displayName, relativePath, fileSizeBytes, verifiedAt, status, createdAt, updatedAt)
    VALUES ('lut-prefixed', 'project-1', ?, 'prefixed.cube', 'storage/luts/project-1/prefixed.cube', 10, ?, 'archived', ?, ?)
  `).run(`sha256:${hex}`, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');

  db.prepare(`
    INSERT INTO batch_productions (id, projectId, name, createdAt, updatedAt, status, currentVersionId, progressJson)
    VALUES ('b1', 'project-1', '冲突迁移批次', '2026-08-01T07:00:00.000Z', '2026-08-01T10:00:00.000Z', 'running', 'v2', '{}')
  `).run();
  for (const versionId of ['v1', 'v2']) {
    db.prepare(`
      INSERT INTO batch_production_versions (id, batchId, versionNumber, copyCount, defaultsJson, inputState, frozenAt, createdAt)
      VALUES (?, 'b1', ?, 1, '{}', 'frozen', ?, ?)
    `).run(
      versionId,
      versionId === 'v1' ? 1 : 2,
      versionId === 'v1' ? '2026-08-01T08:00:00.000Z' : '2026-08-01T09:00:00.000Z',
      versionId === 'v1' ? '2026-08-01T08:00:00.000Z' : '2026-08-01T09:00:00.000Z',
    );
  }
  db.prepare(`
    INSERT INTO batch_assets (id, projectId, sourceKind, locationJson, contentFingerprint, mediaKind, status, createdAt, updatedAt)
    VALUES ('a1', 'project-1', 'linked', '{}', 'sha256:aa', 'video', 'online', 't', 't')
  `).run();
  db.prepare(`
    INSERT INTO batch_asset_analysis (id, assetId, analyzerVersion, providerId, model, status, analyzedAt, createdAt)
    VALUES ('an1', 'a1', 'v', 'p', 'm', 'ready', 't', 't')
  `).run();

  // 3. 两条 LUT 分别被历史快照引用(不同批次版本)
  db.prepare(`
    INSERT INTO batch_asset_pool_items (id, batchVersionId, assetId, analysisId, colorJson, createdAt)
    VALUES ('pool-1', 'v1', 'a1', 'an1', '{"lutId":"lut-raw"}', '2026-08-01T08:00:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO batch_asset_pool_items (id, batchVersionId, assetId, analysisId, colorJson, createdAt)
    VALUES ('pool-2', 'v2', 'a1', 'an1', '{"lutId":"lut-prefixed"}', '2026-08-01T09:00:00.000Z')
  `).run();

  // 4. 代理缓存项引用 lut-prefixed,并存在指向该 cache 的 proxy_generate 任务
  db.prepare(`
    INSERT INTO batch_proxy_cache_items (id, proxyKey, projectId, assetId, profileVersion, colorJson, relativePath, status, mediaJson, fileSizeBytes, checksum, pendingDeleteAt, createdAt, updatedAt)
    VALUES ('cache-1', 'sha256:key-1', 'project-1', 'a1', 'proxy-v1', '{"lutId":"lut-prefixed"}', 'storage/cache/proxies/project-1/a1/key.mp4', 'pending', '{}', 0, NULL, NULL, '2026-08-01T09:30:00.000Z', '2026-08-01T09:30:00.000Z')
  `).run();
  db.prepare(`
    INSERT INTO batch_tasks (id, projectId, batchId, workType, targetKind, targetId, status, requestKey, expectedState, progressJson, attemptCount, createdAt, updatedAt)
    VALUES ('task-1', 'project-1', 'b1', 'proxy_generate', 'proxy_request', 'cache-1', 'succeeded', 'proxy_generate:project-1:sha256:key-1', 'running', '{}', 1, '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z')
  `).run();

  // 4b. 历史版本回溯边界：currentVersion 切换后素材被移除，旧任务仍应归属旧版本。
  db.exec(`
    INSERT INTO batch_productions
      (id, projectId, name, createdAt, updatedAt, status, currentVersionId, progressJson)
    VALUES
      ('b-removed', 'project-1', '当前版已移除素材', '2026-08-01T07:00:00.000Z', '2026-08-01T09:00:00.000Z', 'draft', 'vr2', '{}');
    INSERT INTO batch_production_versions
      (id, batchId, versionNumber, copyCount, defaultsJson, inputState, frozenAt, createdAt)
    VALUES
      ('vr1', 'b-removed', 1, 1, '{}', 'frozen', '2026-08-01T08:00:00.000Z', '2026-08-01T08:00:00.000Z'),
      ('vr2', 'b-removed', 2, 1, '{}', 'draft', NULL, '2026-08-01T09:00:00.000Z');
    INSERT INTO batch_assets
      (id, projectId, sourceKind, locationJson, contentFingerprint, mediaKind, status, createdAt, updatedAt)
    VALUES
      ('a-removed', 'project-1', 'linked', '{}', 'sha256:removed', 'video', 'online', '2026-08-01T07:30:00.000Z', '2026-08-01T07:30:00.000Z');
    INSERT INTO batch_asset_analysis
      (id, assetId, analyzerVersion, providerId, model, status, analyzedAt, createdAt)
    VALUES
      ('an-removed', 'a-removed', 'v', 'p', 'm', 'ready', '2026-08-01T07:40:00.000Z', '2026-08-01T07:40:00.000Z');
    INSERT INTO batch_asset_pool_items
      (id, batchVersionId, assetId, analysisId, colorJson, createdAt)
    VALUES
      ('pool-removed', 'vr1', 'a-removed', 'an-removed', '{"lutId":null}', '2026-08-01T08:00:00.000Z');
    INSERT INTO batch_proxy_cache_items
      (id, proxyKey, projectId, assetId, profileVersion, colorJson, relativePath, status, mediaJson, fileSizeBytes, checksum, pendingDeleteAt, createdAt, updatedAt)
    VALUES
      ('cache-removed', 'sha256:key-removed', 'project-1', 'a-removed', 'proxy-v1', '{"lutId":null}', 'storage/cache/proxies/project-1/a-removed/key.mp4', 'ready', '{}', 1, 'sha256:cache', NULL, '2026-08-01T08:20:00.000Z', '2026-08-01T08:20:00.000Z');
    INSERT INTO batch_tasks
      (id, projectId, batchId, workType, targetKind, targetId, status, requestKey, expectedState, progressJson, attemptCount, createdAt, updatedAt)
    VALUES
      ('task-removed', 'project-1', 'b-removed', 'proxy_generate', 'proxy_request', 'cache-removed', 'succeeded', 'proxy_generate:project-1:sha256:key-removed', 'running', '{}', 1, '2026-08-01T08:30:00.000Z', '2026-08-01T08:30:00.000Z');
  `);

  // 4c. currentVersion 仍含同素材但 LUT 已变化，旧 cache 必须归属旧 LUT 版本。
  const otherHex = 'cd'.repeat(32);
  db.prepare(`
    INSERT INTO batch_luts
      (id, projectId, contentFingerprint, displayName, relativePath, fileSizeBytes, verifiedAt, status, createdAt, updatedAt)
    VALUES ('lut-other', 'project-1', ?, 'other.cube', 'storage/luts/project-1/other.cube', 10,
            '2026-08-01T00:00:00.000Z', 'active', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
  `).run(otherHex);
  db.exec(`
    INSERT INTO batch_productions
      (id, projectId, name, createdAt, updatedAt, status, currentVersionId, progressJson)
    VALUES
      ('b-lut-change', 'project-1', '当前版已更换 LUT', '2026-08-01T07:00:00.000Z', '2026-08-01T09:00:00.000Z', 'draft', 'vl2', '{}');
    INSERT INTO batch_production_versions
      (id, batchId, versionNumber, copyCount, defaultsJson, inputState, frozenAt, createdAt)
    VALUES
      ('vl1', 'b-lut-change', 1, 1, '{}', 'frozen', '2026-08-01T08:00:00.000Z', '2026-08-01T08:00:00.000Z'),
      ('vl2', 'b-lut-change', 2, 1, '{}', 'draft', NULL, '2026-08-01T09:00:00.000Z');
    INSERT INTO batch_assets
      (id, projectId, sourceKind, locationJson, contentFingerprint, mediaKind, status, createdAt, updatedAt)
    VALUES
      ('a-lut-change', 'project-1', 'linked', '{}', 'sha256:lut-change', 'video', 'online', '2026-08-01T07:30:00.000Z', '2026-08-01T07:30:00.000Z');
    INSERT INTO batch_asset_analysis
      (id, assetId, analyzerVersion, providerId, model, status, analyzedAt, createdAt)
    VALUES
      ('an-lut-change', 'a-lut-change', 'v', 'p', 'm', 'ready', '2026-08-01T07:40:00.000Z', '2026-08-01T07:40:00.000Z');
    INSERT INTO batch_asset_pool_items
      (id, batchVersionId, assetId, analysisId, colorJson, createdAt)
    VALUES
      ('pool-lut-old', 'vl1', 'a-lut-change', 'an-lut-change', '{"lutId":"lut-raw"}', '2026-08-01T08:00:00.000Z'),
      ('pool-lut-new', 'vl2', 'a-lut-change', 'an-lut-change', '{"lutId":"lut-other"}', '2026-08-01T09:00:00.000Z');
    INSERT INTO batch_proxy_cache_items
      (id, proxyKey, projectId, assetId, profileVersion, colorJson, relativePath, status, mediaJson, fileSizeBytes, checksum, pendingDeleteAt, createdAt, updatedAt)
    VALUES
      ('cache-lut-old', 'sha256:key-lut-old', 'project-1', 'a-lut-change', 'proxy-v1', '{"lutId":"lut-prefixed"}', 'storage/cache/proxies/project-1/a-lut-change/key.mp4', 'ready', '{}', 1, 'sha256:cache', NULL, '2026-08-01T08:20:00.000Z', '2026-08-01T08:20:00.000Z');
    INSERT INTO batch_tasks
      (id, projectId, batchId, workType, targetKind, targetId, status, requestKey, expectedState, progressJson, attemptCount, createdAt, updatedAt)
    VALUES
      ('task-lut-old', 'project-1', 'b-lut-change', 'proxy_generate', 'proxy_request', 'cache-lut-old', 'succeeded', 'proxy_generate:project-1:sha256:key-lut-old', 'running', '{}', 1, '2026-08-01T08:30:00.000Z', '2026-08-01T08:30:00.000Z');
  `);

  // 4d. 无任何兼容历史版本的异常 v14 任务不能阻塞升级；保留历史并安全隔离。
  db.exec(`
    INSERT INTO batch_productions
      (id, projectId, name, createdAt, updatedAt, status, currentVersionId, progressJson)
    VALUES
      ('b-unresolved', 'project-1', '异常历史任务', '2026-08-01T07:00:00.000Z', '2026-08-01T09:00:00.000Z', 'draft', 'vu1', '{}');
    INSERT INTO batch_production_versions
      (id, batchId, versionNumber, copyCount, defaultsJson, inputState, frozenAt, createdAt)
    VALUES
      ('vu1', 'b-unresolved', 1, 1, '{}', 'draft', NULL, '2026-08-01T08:00:00.000Z');
    INSERT INTO batch_assets
      (id, projectId, sourceKind, locationJson, contentFingerprint, mediaKind, status, createdAt, updatedAt)
    VALUES
      ('a-unresolved', 'project-1', 'linked', '{}', 'sha256:unresolved', 'video', 'online', '2026-08-01T07:30:00.000Z', '2026-08-01T07:30:00.000Z');
    INSERT INTO batch_proxy_cache_items
      (id, proxyKey, projectId, assetId, profileVersion, colorJson, relativePath, status, mediaJson, fileSizeBytes, checksum, pendingDeleteAt, createdAt, updatedAt)
    VALUES
      ('cache-unresolved', 'sha256:key-unresolved', 'project-1', 'a-unresolved', 'proxy-v1', '{"lutId":null}', 'storage/cache/proxies/project-1/a-unresolved/key.mp4', 'pending', '{}', 0, NULL, NULL, '2026-08-01T08:20:00.000Z', '2026-08-01T08:20:00.000Z');
    INSERT INTO batch_tasks
      (id, projectId, batchId, workType, targetKind, targetId, status, requestKey, expectedState, progressJson, attemptCount, createdAt, updatedAt)
    VALUES
      ('task-unresolved', 'project-1', 'b-unresolved', 'proxy_generate', 'proxy_request', 'cache-unresolved', 'running', 'proxy_generate:project-1:sha256:key-unresolved', 'running', '{}', 1, '2026-08-01T08:30:00.000Z', '2026-08-01T08:30:00.000Z');
    INSERT INTO batch_task_attempts
      (id, taskId, attemptNumber, status, progressJson, startedAt, createdAt)
    VALUES
      ('attempt-unresolved', 'task-unresolved', 1, 'running', '{}', '2026-08-01T08:30:00.000Z', '2026-08-01T08:30:00.000Z');
  `);

  // 5. 执行 v15(与 applyMigration 同一事务语义:SQL + 外键检查 + 版本记账)
  const v15 = BATCH_SCHEMA_MIGRATIONS.find(({ version }) => version === 15)!;
  assert.doesNotThrow(() => {
    db.transaction(() => {
      db.exec(v15.sql);
      const violations = db.pragma('foreign_key_check') as unknown[];
      assert.equal(violations.length, 0, 'v15 迁移后外键检查必须通过');
      db.prepare(`INSERT INTO batch_schema_migrations (version, appliedAt) VALUES (15, '2026-08-01T01:00:00.000Z')`).run();
    }).immediate();
  }, 'v15 迁移不能在 UPDATE 归一化阶段撞 UNIQUE(projectId, contentFingerprint)');

  // 6. 规范身份:只保留一条(引用数相同 → 创建时间相同 → active 优先),指纹已归一化
  const luts = db.prepare(`SELECT id, contentFingerprint, status FROM batch_luts ORDER BY id`).all() as Array<{
    id: string;
    contentFingerprint: string;
    status: string;
  }>;
  assert.equal(luts.length, 2, '冲突内容应去重，同时保留另一份不同内容 LUT');
  const canonicalLut = luts.find(({ id }) => id === 'lut-raw');
  assert.ok(canonicalLut, '引用数与创建时间相同时,active 的原始身份必须胜出');
  assert.equal(canonicalLut.contentFingerprint, `sha256:${hex}`, '指纹必须归一化为 sha256:<hex>');
  assert.equal(canonicalLut.status, 'active');
  assert.ok(!luts.some(({ id }) => id === 'lut-prefixed'), '同内容的 prefixed 重复身份必须被删除');
  assert.ok(luts.some(({ id }) => id === 'lut-other'), '不同内容 LUT 不得被误删');

  // 7. 素材池引用全部重映射到规范身份,快照完整(含真实指纹,无空指纹)
  for (const poolId of ['pool-1', 'pool-2']) {
    const row = db.prepare(`SELECT colorJson FROM batch_asset_pool_items WHERE id = ?`).get(poolId) as { colorJson: string };
    const parsed = JSON.parse(row.colorJson) as Record<string, unknown>;
    assert.equal(parsed.lutId, 'lut-raw', `素材池 ${poolId} 的 lutId 必须重映射到规范身份`);
    assert.equal(parsed.lutFingerprint, `sha256:${hex}`, `素材池 ${poolId} 必须持有完整 LUT 指纹(非空)`);
    assert.equal(parsed.colorPipelineVersion, 'color-v1');
    assert.equal(parsed.interpolation, 'trilinear');
    assert.equal(parsed.outputContract, 'sdr-v1');
  }

  // 8. 代理缓存项同样重映射 + 完整快照
  const cacheRow = db.prepare(`SELECT colorJson FROM batch_proxy_cache_items WHERE id = 'cache-1'`).get() as { colorJson: string };
  assert.equal(JSON.parse(cacheRow.colorJson).lutId, 'lut-raw', '代理缓存项的 lutId 必须重映射到规范身份');
  assert.equal(JSON.parse(cacheRow.colorJson).lutFingerprint, `sha256:${hex}`);

  // 9. 既有 proxy_generate 任务必须指向稳定请求,请求引用规范缓存
  const taskRow = db.prepare(`SELECT targetId, requestKey FROM batch_tasks WHERE id = 'task-1'`).get() as {
    targetId: string;
    requestKey: string | null;
  };
  assert.notEqual(taskRow.targetId, 'cache-1', 'targetId 不能继续指向可删除的 cache 行');
  assert.equal(
    taskRow.requestKey,
    `proxy_generate:project-1:${taskRow.targetId}`,
    '迁移任务的 requestKey 必须与运行时稳定 requestId 身份一致',
  );
  const request = db.prepare(`SELECT * FROM batch_proxy_requests WHERE id = ?`).get(taskRow.targetId) as {
    id: string;
    projectId: string;
    batchId: string;
    batchVersionId: string;
    assetId: string;
    currentCacheItemId: string | null;
    colorJson: string;
    status: string;
  } | undefined;
  assert.ok(request, '任务的目标必须是迁移建立的真实请求');
  assert.equal(request.projectId, 'project-1');
  assert.equal(request.batchId, 'b1');
  assert.equal(request.batchVersionId, 'v2', '相同色彩身份的多个历史版本应归属任务创建时最新版本');
  assert.equal(request.assetId, 'a1');
  assert.equal(request.currentCacheItemId, 'cache-1', '请求必须引用被迁移的缓存行');
  assert.equal(JSON.parse(request.colorJson).lutId, 'lut-raw');
  assert.equal(request.status, 'ready', 'succeeded 任务对应请求必须收敛为 ready');

  // 10. currentVersion 切换后的历史谱系必须按素材池和完整色彩身份恢复。
  const removedRequest = db.prepare(`
    SELECT r.batchVersionId
    FROM batch_tasks t JOIN batch_proxy_requests r ON r.id = t.targetId
    WHERE t.id = 'task-removed'
  `).get() as { batchVersionId: string };
  assert.equal(removedRequest.batchVersionId, 'vr1', '当前版本移除素材后，旧任务仍必须归属含该素材的历史版本');

  const oldLutRequest = db.prepare(`
    SELECT r.batchVersionId, r.colorJson
    FROM batch_tasks t JOIN batch_proxy_requests r ON r.id = t.targetId
    WHERE t.id = 'task-lut-old'
  `).get() as { batchVersionId: string; colorJson: string };
  assert.equal(oldLutRequest.batchVersionId, 'vl1', '当前版本更换 LUT 后，旧 cache 不能错误归属新 LUT 版本');
  assert.equal(JSON.parse(oldLutRequest.colorJson).lutId, 'lut-raw');

  const isolatedTask = db.prepare(`
    SELECT status, targetKind, requestKey, expectedState
    FROM batch_tasks WHERE id = 'task-unresolved'
  `).get() as { status: string; targetKind: string; requestKey: string | null; expectedState: string };
  assert.deepEqual(isolatedTask, {
    status: 'cancelled',
    targetKind: 'legacy_proxy_cache',
    requestKey: null,
    expectedState: 'stopped',
  }, '无法安全回溯的异常旧任务必须保留历史但隔离取消');
  const { getBatchTask } = await import('../lib/batch-production/tasks.ts');
  assert.equal(
    getBatchTask(db, 'project-1', 'task-unresolved')?.targetKind,
    'legacy_proxy_cache',
    '领域读取类型必须能准确表达只读的 cancelled legacy 隔离目标',
  );
  const isolatedAttempt = db.prepare(`
    SELECT status, errorCode, finishedAt FROM batch_task_attempts WHERE id = 'attempt-unresolved'
  `).get() as { status: string; errorCode: string | null; finishedAt: string | null };
  assert.equal(isolatedAttempt.status, 'interrupted');
  assert.equal(isolatedAttempt.errorCode, 'legacy_proxy_lineage_unresolved');
  assert.ok(isolatedAttempt.finishedAt, '隔离运行中 attempt 时必须落结束时间');
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM batch_proxy_requests WHERE batchId = 'b-unresolved'`).get() as { n: number }).n,
    0,
    '无法回溯时不得伪造错误版本的代理请求',
  );

  // 11. 走完整 schema 路径：v15 已应用，当前版本会继续追加后续迁移并完成全量校验。
  const schemaModule = await import('../lib/batch-production/schema.ts');
  const revalidate = await schemaModule.ensureBatchSchemaReady({
    db,
    backupRoot: path.join(dbRoot, 'backups'),
    now: () => new Date('2026-08-02T00:00:00.000Z'),
  });
  assert.equal(revalidate.state, 'ready', 'v15 旧库必须继续升级到当前 schema 并通过完整校验');
  assert.deepEqual(revalidate.appliedVersions, [16, 17, 18], '完整升级路径必须依次应用 Phase E v16、分析请求 v17 与供应商作用域 v18');
  assert.equal(
    (db.prepare(`SELECT MAX(version) AS version FROM batch_schema_migrations`).get() as { version: number }).version,
    schemaModule.BATCH_SCHEMA_MIGRATIONS.at(-1)?.version,
    '完整校验路径必须升级到当前最新版本',
  );

  db.close();
  console.log('batch-v15-lut-conflict-migration tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

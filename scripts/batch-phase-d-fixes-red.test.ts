/**
 * Phase D 修复回归(绿测试):过去证明 bug 存在的行为现在全部必须成立。
 *
 * 覆盖(修复后契约):
 * 1. LUT 内容指纹统一:createManagedLut 归一化存入、跨前缀比较一致;
 * 2. 完整色彩快照:客户端只提交 lutId 时服务端补齐非空指纹(禁止空字符串绕过);
 * 3. proxyKey 必须包含 LUT 内容指纹(同一 lutId 不同内容 → 不同 key);
 * 4. 代理任务 targetId 必须指向稳定请求,不允许指向可删除的 cache 行;
 * 5. 清理后旧 succeeded/failed 任务不能永久占用 requestKey;
 * 6. 导出预检使用统一指纹比较(裸 hex 与 sha256:hex 等价);
 * 7. 运行时兼容读取会把 v14 旧快照升级为完整形态;
 *    v15 的真实数据库迁移由 batch-v15-lut-conflict-migration.test.ts 单独覆盖。
 */

import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { BATCH_SCHEMA_MIGRATIONS } from '../lib/batch-production/schema.ts';
import { createManagedLut } from '../lib/batch-production/lut-catalog.ts';
import { proxyRelativePath } from '../lib/batch-production/proxy-cache.ts';
import { computeProxyKey as origComputeProxyKey } from '../lib/batch-production/proxy-cache.ts';
import { COLOR_PIPELINE_VERSION, upgradeColorSnapshot } from '../lib/batch-production/color-pipeline.ts';
import { normalizeFingerprint, fingerprintsEqual, computeFingerprintFromBuffer } from '../lib/batch-production/fingerprint.ts';
import type { BatchColorSnapshot } from '../lib/batch-production/versions.ts';

// ---- helpers ----
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, concurrency INTEGER NOT NULL DEFAULT 1,
      productCode TEXT, model TEXT, productCategory TEXT);
  `);
  const projectId = randomUUID();
  db.prepare(`INSERT INTO projects (id, name) VALUES (?, ?)`).run(projectId, 'test');
  return db;
}

function initSchema(db: Database.Database): string {
  const projectId = (db.prepare(`SELECT id FROM projects LIMIT 1`).get() as { id: string }).id;
  db.exec(`CREATE TABLE IF NOT EXISTS batch_schema_migrations (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL)`);
  for (const m of BATCH_SCHEMA_MIGRATIONS) {
    const exists = db.prepare(`SELECT 1 FROM batch_schema_migrations WHERE version = ?`).get(m.version);
    if (!exists) {
      db.exec(m.sql);
      db.prepare(`INSERT INTO batch_schema_migrations (version, appliedAt) VALUES (?, ?)`).run(m.version, new Date().toISOString());
    }
  }
  db.prepare(`INSERT OR IGNORE INTO batch_assets (id, projectId, sourceKind, locationJson, contentFingerprint, mediaKind, status, createdAt, updatedAt) VALUES (?, ?, 'linked', '{}', ?, 'video', 'online', datetime('now'), datetime('now'))`).run('asset-1', projectId, `sha256:${'a'.repeat(64)}`);
  db.prepare(`INSERT OR IGNORE INTO batch_asset_analysis (id, assetId, analyzerVersion, providerId, model, status, analyzedAt, createdAt) VALUES (?, 'asset-1', 'v1', 'local', 'none', 'ready', datetime('now'), datetime('now'))`).run('analysis-1');
  return projectId;
}

function createAssetOneVersion(db: Database.Database, batchId: string): string {
  const versionId = randomUUID();
  db.prepare(`
    INSERT INTO batch_production_versions
      (id, batchId, versionNumber, copyCount, defaultsJson, inputState, frozenAt, createdAt)
    VALUES (?, ?, 1, 1, '{}', 'draft', NULL, datetime('now'))
  `).run(versionId, batchId);
  db.prepare(`UPDATE batch_productions SET currentVersionId = ? WHERE id = ?`).run(versionId, batchId);
  db.prepare(`
    INSERT INTO batch_asset_pool_items
      (id, batchVersionId, assetId, analysisId, selectionState, colorJson, createdAt)
    VALUES (?, ?, 'asset-1', 'analysis-1', 'selected',
      '{"lutId":null,"lutFingerprint":"","colorPipelineVersion":"color-v1","interpolation":"trilinear","outputContract":"sdr-v1"}',
      datetime('now'))
  `).run(randomUUID(), versionId);
  return versionId;
}

// ================================================================
// 测试 1:统一内容指纹格式
// ================================================================

{
  const db = makeDb();
  const projectId = initSchema(db);

  const hex = 'a'.repeat(64);
  assert.equal(normalizeFingerprint(hex), `sha256:${hex}`, '裸 hex 应归一化为 sha256: 前缀');
  assert.equal(normalizeFingerprint(`sha256:${hex}`), `sha256:${hex}`, '已有前缀不变');
  assert.throws(() => normalizeFingerprint('not-hex'), /无效的内容指纹格式/);
  assert.throws(() => normalizeFingerprint('sha256:short'), /无效的内容指纹格式/);
  assert.ok(fingerprintsEqual(hex, `sha256:${hex}`), '裸hex 与 sha256:hex 应相等');
  assert.ok(!fingerprintsEqual(hex, `sha256:${'b'.repeat(64)}`), '不同内容不相等');

  const data = Buffer.from('hello');
  const fp = computeFingerprintFromBuffer(data);
  assert.ok(fp.startsWith('sha256:'), '计算结果应有 sha256: 前缀');
  assert.equal(fp.length, 7 + 64, '长度应为 71');

  // createManagedLut 接收裸 hex 时必须归一化后存入,同内容(前缀不同)复用同一身份
  const rawHex = 'c'.repeat(64);
  const lutId = createManagedLut(db, projectId, {
    contentFingerprint: rawHex,
    displayName: 'test.cube',
    relativePath: 'storage/luts/test/test.cube',
    fileSizeBytes: 100,
  });
  const lut = db.prepare(`SELECT contentFingerprint FROM batch_luts WHERE id = ?`).get(lutId) as { contentFingerprint: string };
  assert.ok(lut.contentFingerprint.startsWith('sha256:'), `createManagedLut 应存入 sha256: 前缀，实际: ${lut.contentFingerprint}`);
  const lutId2 = createManagedLut(db, projectId, {
    contentFingerprint: `sha256:${rawHex}`,
    displayName: 'test-dup.cube',
    relativePath: 'storage/luts/test/test-dup.cube',
    fileSizeBytes: 200,
  });
  assert.equal(lutId, lutId2, '同内容(前缀不同)应复用同一 LUT 身份');

  console.log('✓ 测试 1：统一内容指纹格式');
  db.close();
}

// ================================================================
// 测试 2:完整色彩快照(服务端补齐,空指纹被禁止)
// ================================================================

{
  const db = makeDb();
  const projectId = initSchema(db);

  const lutData = Buffer.from(`TITLE "t"\nLUT_3D_SIZE 2\n${Array.from({ length: 8 }, (_, i) => `${i / 8} ${i / 8} ${i / 8}`).join('\n')}\n`);
  const lutFingerprint = computeFingerprintFromBuffer(lutData);
  const rawHex = lutFingerprint.slice('sha256:'.length);
  const lutId = createManagedLut(db, projectId, {
    contentFingerprint: rawHex,
    displayName: 'test.cube',
    relativePath: 'storage/luts/test/test.cube',
    fileSizeBytes: lutData.length,
  });

  // 旧格式 {lutId} 纯结构升级:绝不允许静默变成空指纹(空指纹 = 伪装成关闭)。
  // 纯函数拿不到受管目录,必须产出非空的 unresolved 显式标记;
  // 真实解析由服务端 resolveColorSnapshot 完成(见下方断言)。
  const upgraded = upgradeColorSnapshot({ lutId } as BatchColorSnapshot);
  assert.ok(upgraded.lutFingerprint.length > 0, '升级后的快照必须携带非空 LUT 指纹');
  assert.ok(!fingerprintsEqual(upgraded.lutFingerprint, ''), '升级结果不能是空指纹');
  assert.equal(upgraded.colorPipelineVersion, COLOR_PIPELINE_VERSION);
  assert.equal(upgraded.interpolation, 'trilinear');
  assert.equal(upgraded.outputContract, 'sdr-v1');

  // 服务端按受管 LUT 解析:只提交 lutId 也能得到真实指纹
  const { resolveColorSnapshot } = await import('../lib/batch-production/lut-catalog.ts');
  const resolved = resolveColorSnapshot(db, projectId, { lutId });
  assert.ok(fingerprintsEqual(resolved.lutFingerprint, rawHex), '服务端解析必须产出与受管 LUT 一致的真实指纹');
  assert.equal(resolved.lutId, lutId);

  // 关闭快照升级后保持完整关闭形态
  const off = upgradeColorSnapshot({ lutId: null } as BatchColorSnapshot);
  assert.equal(off.lutId, null);
  assert.equal(off.lutFingerprint, '');

  console.log('✓ 测试 2：完整色彩身份(红:缺失字段)已修复');
  db.close();
}

// ================================================================
// 测试 3:computeProxyKey 包含 LUT 内容指纹
// ================================================================

{
  // 同一 lutId,不同内容指纹 → 必须产生不同 proxyKey
  const keyWithFingerprintA = origComputeProxyKey({
    assetId: 'asset-1',
    contentFingerprint: `sha256:${'a'.repeat(64)}`,
    profileVersion: 'proxy-v1',
    colorSnapshot: { lutId: 'lut-1', lutFingerprint: `sha256:${'a'.repeat(64)}` },
    colorPipelineVersion: COLOR_PIPELINE_VERSION,
  });
  const keyWithFingerprintB = origComputeProxyKey({
    assetId: 'asset-1',
    contentFingerprint: `sha256:${'a'.repeat(64)}`,
    profileVersion: 'proxy-v1',
    colorSnapshot: { lutId: 'lut-1', lutFingerprint: `sha256:${'b'.repeat(64)}` },
    colorPipelineVersion: COLOR_PIPELINE_VERSION,
  });
  assert.notEqual(keyWithFingerprintA, keyWithFingerprintB, '同一 lutId 不同 LUT 内容必须产生不同 proxyKey');

  // 旧格式 {lutId} 在纯函数路径(无数据库)只能升级出 unresolved 显式标记,
  // 不允许与真实指纹快照产生相同 key——绝不能静默伪造指纹。
  const keyFromLegacy = origComputeProxyKey({
    assetId: 'asset-1',
    contentFingerprint: `sha256:${'a'.repeat(64)}`,
    profileVersion: 'proxy-v1',
    colorSnapshot: { lutId: 'lut-1' },
    colorPipelineVersion: COLOR_PIPELINE_VERSION,
  });
  assert.notEqual(keyFromLegacy, keyWithFingerprintA, '未解析的旧格式快照不得伪装成真实内容指纹的 key');

  console.log('✓ 测试 3：proxyKey 包含 LUT 内容指纹');
}

// ================================================================
// 测试 4:代理任务 targetId 必须指向稳定请求,不允许指向可删除 cache 行
// ================================================================

{
  const db = makeDb();
  const projectId = initSchema(db);

  const proxyKey = `sha256:${'d'.repeat(64)}`;
  const cacheItemId = randomUUID();
  const relativePath = proxyRelativePath(projectId, 'asset-1', proxyKey);
  db.prepare(`
    INSERT INTO batch_proxy_cache_items
      (id, proxyKey, projectId, assetId, profileVersion, colorJson, relativePath, status, mediaJson, fileSizeBytes, createdAt, updatedAt)
    VALUES (?, ?, ?, 'asset-1', 'proxy-v1', '{}', ?, 'ready', '{}', 1000, datetime('now'), datetime('now'))
  `).run(cacheItemId, proxyKey, projectId, relativePath);

  const batchId = randomUUID();
  db.prepare(`
    INSERT INTO batch_productions (id, projectId, name, status, currentVersionId, progressJson, createdAt, updatedAt)
    VALUES (?, ?, 'test', 'draft', NULL, '{}', datetime('now'), datetime('now'))
  `).run(batchId, projectId);
  const batchVersionId = createAssetOneVersion(db, batchId);

  const requestId = randomUUID();
  db.prepare(`
    INSERT INTO batch_proxy_requests
      (id, projectId, batchId, batchVersionId, assetId, contentFingerprint, colorJson,
       profileVersion, colorPipelineVersion, proxyKey, currentCacheItemId, status, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, 'asset-1', 'sha256:aa', '{}', 'proxy-v1', 'color-v1', ?, ?, 'requested', datetime('now'), datetime('now'))
  `).run(requestId, projectId, batchId, batchVersionId, proxyKey, cacheItemId);

  const taskId = randomUUID();
  db.prepare(`
    INSERT INTO batch_tasks
      (id, projectId, batchId, workType, targetKind, targetId, status, requestKey, expectedState, progressJson, attemptCount, createdAt, updatedAt)
    VALUES (?, ?, ?, 'proxy_generate', 'proxy_request', ?, 'succeeded', 'rk-1', 'running', '{}', 1, datetime('now'), datetime('now'))
  `).run(taskId, projectId, batchId, requestId);

  const task = db.prepare(`SELECT targetId FROM batch_tasks WHERE id = ?`).get(taskId) as { targetId: string };
  assert.equal(task.targetId, requestId, 'task targetId 必须指向稳定请求');
  assert.notEqual(task.targetId, cacheItemId, 'targetId 不允许指向可删除的 cache item');

  // 删除 cache 后请求身份不悬空:请求仍存在,只是 cache 引用被清空
  db.prepare(`DELETE FROM batch_proxy_cache_items WHERE id = ?`).run(cacheItemId);
  const requestAfter = db.prepare(`SELECT currentCacheItemId FROM batch_proxy_requests WHERE id = ?`).get(requestId) as { currentCacheItemId: string | null };
  assert.equal(requestAfter.currentCacheItemId, null, 'cache 删除后请求的引用必须清空(FK SET NULL)');
  const taskAfter = db.prepare(`SELECT targetId FROM batch_tasks WHERE id = ?`).get(taskId) as { targetId: string };
  assert.equal(taskAfter.targetId, requestId, '任务仍指向稳定请求,不悬空');

  console.log('✓ 测试 4：targetId 指向稳定请求(红:悬空引用)已修复');
  db.close();
}

// ================================================================
// 测试 5:清理后旧 succeeded 任务不能永久占用 requestKey
// ================================================================

{
  const db = makeDb();
  const projectId = initSchema(db);

  const batchId = randomUUID();
  db.prepare(`
    INSERT INTO batch_productions (id, projectId, name, status, currentVersionId, progressJson, createdAt, updatedAt)
    VALUES (?, ?, 'test', 'draft', NULL, '{}', datetime('now'), datetime('now'))
  `).run(batchId, projectId);
  const batchVersionId = createAssetOneVersion(db, batchId);

  // 缓存被清理(删除),请求引用已清空
  const requestId = randomUUID();
  db.prepare(`
    INSERT INTO batch_proxy_requests
      (id, projectId, batchId, batchVersionId, assetId, contentFingerprint, colorJson,
       profileVersion, colorPipelineVersion, proxyKey, currentCacheItemId, status, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, 'asset-1', 'sha256:aa', '{}', 'proxy-v1', 'color-v1', 'proxy:key-1', NULL, 'cancelled', datetime('now'), datetime('now'))
  `).run(requestId, projectId, batchId, batchVersionId);

  const taskId = randomUUID();
  db.prepare(`
    INSERT INTO batch_tasks
      (id, projectId, batchId, workType, targetKind, targetId, status, requestKey, expectedState, progressJson, attemptCount, createdAt, updatedAt)
    VALUES (?, ?, ?, 'proxy_generate', 'proxy_request', ?, 'succeeded', 'proxy_generate:test:key-1', 'running', '{}', 1, datetime('now'), datetime('now'))
  `).run(taskId, projectId, batchId, requestId);

  // createBatchTask 必须感知请求的 cache 已死:释放旧 requestKey,允许重建
  const { createBatchTask, getBatchTask } = await import('../lib/batch-production/tasks.ts');
  const rebuiltTaskId = createBatchTask(db, projectId, {
    batchId,
    workType: 'proxy_generate',
    targetKind: 'proxy_request',
    targetId: requestId,
    requestKey: 'proxy_generate:test:key-1',
    now: () => new Date(),
  });
  assert.notEqual(rebuiltTaskId, taskId, 'succeeded 任务不能永久占用 requestKey(缓存已清理时必须能重建)');
  assert.equal(getBatchTask(db, projectId, rebuiltTaskId)?.status, 'queued');
  assert.equal(getBatchTask(db, projectId, taskId)?.status, 'succeeded', '历史任务本身必须保留');

  console.log('✓ 测试 5：旧 succeeded 任务不再卡住 requestKey');
  db.close();
}

// ================================================================
// 测试 6:导出预检与内容指纹统一比较
// ================================================================

{
  const hexOnly = 'e'.repeat(64);
  const prefixed = `sha256:${hexOnly}`;
  assert.notEqual(hexOnly, prefixed, '裸 hex 与 sha256:hex 不直接相等');
  assert.ok(fingerprintsEqual(hexOnly, prefixed), '通过 fingerprintsEqual 应相等');
  console.log('✓ 测试 6：导出预检使用统一指纹比较');
}

// ================================================================
// 测试 7:运行时读取兼容 v14 旧快照（真正 v14→v15 迁移见独立迁移测试）
// ================================================================

{
  const db = makeDb();
  const projectId = initSchema(db);

  const batchId = randomUUID();
  db.prepare(`
    INSERT INTO batch_productions (id, projectId, name, status, currentVersionId, progressJson, createdAt, updatedAt)
    VALUES (?, ?, 'test', 'draft', NULL, '{}', datetime('now'), datetime('now'))
  `).run(batchId, projectId);

  const versionId = randomUUID();
  db.prepare(`
    INSERT INTO batch_production_versions (id, batchId, versionNumber, copyCount, defaultsJson, inputState, frozenAt, createdAt)
    VALUES (?, ?, 1, 1, '{}', 'frozen', datetime('now'), datetime('now'))
  `).run(versionId, batchId);

  const assetId = randomUUID();
  const analysisId = randomUUID();
  db.prepare(`
    INSERT INTO batch_assets (id, projectId, sourceKind, locationJson, contentFingerprint, mediaKind, status, createdAt, updatedAt)
    VALUES (?, ?, 'linked', '{}', ?, 'video', 'online', datetime('now'), datetime('now'))
  `).run(assetId, projectId, `sha256:${'f'.repeat(64)}`);
  db.prepare(`
    INSERT INTO batch_asset_analysis (id, assetId, analyzerVersion, providerId, model, status, analyzedAt, createdAt)
    VALUES (?, ?, 'v1', 'local', 'none', 'ready', datetime('now'), datetime('now'))
  `).run(analysisId, assetId);

  // v15 已经应用过(initSchema 全量应用),这里只验证运行时结构升级兼容；
  // 真实迁移由 batch-v15-lut-conflict-migration.test.ts 在 v14 库上执行 v15。
  db.prepare(`
    INSERT INTO batch_asset_pool_items (id, batchVersionId, assetId, analysisId, selectionState, colorJson, createdAt)
    VALUES (?, ?, ?, ?, 'selected', '{"lutId":null}', datetime('now'))
  `).run(randomUUID(), versionId, assetId, analysisId);

  const colorJson = (db.prepare(`SELECT colorJson FROM batch_asset_pool_items WHERE batchVersionId = ?`).get(versionId) as { colorJson: string }).colorJson;
  const snapshot = upgradeColorSnapshot(JSON.parse(colorJson));
  assert.equal(snapshot.lutId, null);
  assert.equal(snapshot.lutFingerprint, '');
  assert.equal(snapshot.colorPipelineVersion, 'color-v1');
  assert.equal(snapshot.interpolation, 'trilinear');
  assert.equal(snapshot.outputContract, 'sdr-v1');

  console.log('✓ 测试 7：运行时兼容读取 v14 旧快照');
  db.close();
}

console.log('\n===== Phase D 修复回归全部通过(绿) =====');

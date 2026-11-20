// node scripts/batch-export-layout.test.ts — export newly allocated/derived v2 outputs without opening the editor.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { register } from 'node:module';
import Database from 'better-sqlite3';
import { createPackagingLayoutFixture } from './packaging-layout-fixture.ts';
import type { resolvePackagingAutoLayout as Resolver } from '../lib/media-core/packaging-auto-layout-service.ts';

register('./typescript-extension-loader.mjs', import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-export-layout-'));
const envBefore = { ...process.env };
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_PACKAGING_DIR = createPackagingLayoutFixture(root);
const { BATCH_SCHEMA_MIGRATIONS } = await import('../lib/batch-production/schema.ts');
const { createAsset, createAnalysisVersion } = await import('../lib/batch-production/assets.ts');
const { computeFingerprintFromFile } = await import('../lib/batch-production/fingerprint.ts');
const { createOutputPlansForSnapshot, createOutputVersion } = await import('../lib/batch-production/plans.ts');
const { createBatchProduction, createBatchProductionVersion, addAssetToPool } = await import('../lib/batch-production/versions.ts');
const { createProjectScript, snapshotScriptIntoBatch } = await import('../lib/batch-production/scripts.ts');
const { persistBatchAllocation, persistOutputReallocation } = await import('../lib/batch-production/allocation-store.ts');
const { orchestrateBatchExport, fullRenderRequestKeyForCurrentContract } = await import('../lib/batch-production/export-orchestrator.ts');
const { packagingAutoLayoutInputHash } = await import('../lib/media-core/packaging-auto-layout-service.ts');
const { materializePackagingLayoutBundle, readPackagingLayoutBundle } = await import('../lib/media-core/packaging-layout-manifest.ts');

const projectId = 'project';
const databases: Database.Database[] = [];
async function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, productName TEXT,
    sellingPointsJson TEXT, productCode TEXT NOT NULL DEFAULT '', exportDirName TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL DEFAULT '', storeCode TEXT NOT NULL DEFAULT '', productSubmodel TEXT NOT NULL DEFAULT '',
    productionType TEXT NOT NULL DEFAULT '', editorName TEXT NOT NULL DEFAULT '', namingDate TEXT NOT NULL DEFAULT '', currentExportIdentityId TEXT);
    INSERT INTO projects (id,name) VALUES ('project','布局导出');
    CREATE TABLE batch_schema_migrations (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL);`);
  for (const migration of BATCH_SCHEMA_MIGRATIONS) {
    db.exec(migration.sql);
    db.prepare('INSERT INTO batch_schema_migrations VALUES (?,?)').run(migration.version, new Date().toISOString());
  }
  const batchId = createBatchProduction(db, projectId, '测试批次');
  const batchVersionId = createBatchProductionVersion(db, batchId, { copyCount: 1 });
  const scriptId = createProjectScript(db, projectId, { sourceKind: 'script_draft', sourceId: 'script',
    title: '稳定标题', bodyText: JSON.stringify({ segments: [{ id: 'segment', text: '正文', startUs: 0, endUs: 4_000_000 }] }), sourceVersion: 'v1' });
  const snapshotId = snapshotScriptIntoBatch(db, batchVersionId, { scriptId, copyCount: 1 });
  const [planId] = createOutputPlansForSnapshot(db, batchVersionId, snapshotId);
  const sourcePath = path.join(root, `${batchId}.mp4`);
  fs.writeFileSync(sourcePath, 'source-media-fixture');
  const fingerprint = await computeFingerprintFromFile(sourcePath);
  const assetId = createAsset(db, { projectId, sourceKind: 'linked', locationJson: { kind: 'linked', absolutePath: sourcePath }, contentFingerprint: fingerprint, mediaKind: 'video' });
  db.prepare(`INSERT INTO batch_asset_sources (id,assetId,sourceKind,locationJson,health,createdAt)
    VALUES (?,?,'linked',?,'healthy',?)`).run(randomUUID(), assetId, JSON.stringify({ kind: 'linked', absolutePath: sourcePath }), new Date().toISOString());
  const analysisId = createAnalysisVersion(db, { assetId, analyzerVersion: 'fixture', providerId: 'fixture', model: 'fixture',
    analysisJson: { durationUs: 8_000_000, usableRanges: [{ startUs: 0, endUs: 8_000_000, qualityScore: 1 }] } });
  addAssetToPool(db, batchVersionId, { assetId, analysisId });
  db.prepare(`UPDATE batch_production_versions SET inputState='frozen', frozenAt=? WHERE id=?`).run(new Date().toISOString(), batchVersionId);
  db.prepare(`UPDATE batch_productions SET status='running', controlState='running', currentVersionId=? WHERE id=?`).run(batchVersionId, batchId);
  const allocated = persistBatchAllocation(db, projectId, batchVersionId, { seed: 'layout-test' });
  const outputVersionId = allocated.outputVersionIds[planId];
  assert.ok(outputVersionId, JSON.stringify(allocated.result));
  const read = (id = outputVersionId) => JSON.parse((db.prepare('SELECT arrangementJson FROM batch_output_versions WHERE id=?').get(id) as { arrangementJson: string }).arrangementJson);
  const save = (value: ReturnType<typeof read>, id = outputVersionId) => db.prepare('UPDATE batch_output_versions SET arrangementJson=? WHERE id=?').run(JSON.stringify(value), id);
  const approve = (id = outputVersionId) => {
    const value = read(id);
    value.productionReady = true;
    value.narration = { ...value.narration, productionReady: true, durationUs: 3_000_000 };
    value.review = { decision: 'approved', reviewedAt: '2026-11-17' };
    save(value, id);
  };
  approve();
  const tasks = () => (db.prepare(`SELECT COUNT(*) AS n FROM batch_tasks WHERE workType='render'`).get() as { n: number }).n;
  return { db, batchId, batchVersionId, planId, outputVersionId, read, save, approve, tasks };
}
let calls = 0;
const resolveLayout: typeof Resolver = async input => {
  calls += 1;
  const { manifest } = await materializePackagingLayoutBundle(input);
  return { schemaVersion: 1, status: 'resolved', inputHash: packagingAutoLayoutInputHash(input), runtimeBundleVersion: 2,
    geometryManifestHash: manifest.geometryManifestHash, outputWidth: input.outputWidth, outputHeight: input.outputHeight,
    elements: {}, validation: { frameCount: 24, digest: 'fixture' } };
};
const exportOne = (f: Awaited<ReturnType<typeof fixture>>, resolver: typeof Resolver = resolveLayout) =>
  orchestrateBatchExport(f.db, projectId, f.batchId, [f.planId], { wakeScheduler: () => {}, resolveLayout: resolver });

try {
  const first = await fixture();
  const before = first.read();
  assert.equal(before.packaging.layoutRuntimeBundleVersion, 2);
  assert.equal(before.packaging.layoutResolution, undefined);
  let observedDuration = 0;
  const queued = await exportOne(first, async input => { observedDuration = input.totalSec; return resolveLayout(input); });
  assert.equal(queued.items[0].status, 'render_queued', JSON.stringify(queued.items));
  assert.equal(observedDuration, 3.833333, 'layout uses production narration duration and the renderer’s microsecond cover constant');
  const after = first.read();
  assert.equal(after.packaging.layoutResolution.status, 'resolved');
  const { layoutResolution, ...unchangedPackaging } = after.packaging;
  assert.deepEqual({ ...after, packaging: unchangedPackaging }, before, 'derived cache must preserve review, revision, undo and all authored fields');
  assert.equal((first.db.prepare('SELECT requestKey FROM batch_tasks WHERE id=?').get(queued.items[0].taskId) as { requestKey: string }).requestKey,
    fullRenderRequestKeyForCurrentContract(first.db, first.outputVersionId));
  const callsBefore = calls;
  assert.equal((await exportOne(first)).items[0].taskId, queued.items[0].taskId);
  assert.equal(calls, callsBefore, 'valid layout and queued task must be reused');
  assert.equal(first.tasks(), 1);

  const derived = persistOutputReallocation(first.db, projectId, first.batchVersionId, first.planId, '换一批', { seed: 'derived' });
  const derivedId = derived.outputVersionIds[first.planId];
  first.approve(derivedId);
  assert.equal(first.read(derivedId).packaging.layoutResolution.status, 'stale');
  assert.equal((await exportOne(first)).items[0].status, 'render_queued');
  assert.equal(first.read(derivedId).packaging.layoutResolution.status, 'resolved');
  assert.equal(calls, callsBefore + 1);
  assert.deepEqual(first.read().packaging.layoutResolution, layoutResolution, 'derived solve cannot rewrite the old candidate');

  // A resolved status alone is insufficient after input/duration changes.
  const mismatch = first.read(derivedId);
  mismatch.narration.durationUs = 2_000_000;
  first.save(mismatch, derivedId);
  assert.equal((await exportOne(first)).items[0].status, 'render_queued');
  assert.equal(calls, callsBefore + 2);

  for (const mutation of ['review', 'edit', 'candidate', 'batchVersion', 'stop', 'unfreeze']) {
    const f = await fixture();
    let expected = f.read();
    const result = await exportOne(f, async input => {
      const solved = await resolveLayout(input);
      if (mutation === 'review') { expected.review = { decision: 'rejected' }; f.save(expected); }
      if (mutation === 'edit') { expected.editRevision = 1; expected.packaging.varsOverrides.title = '新标题'; f.save(expected); }
      if (mutation === 'candidate') createOutputVersion(f.db, f.planId, { arrangementJson: expected });
      if (mutation === 'batchVersion') {
        const next = createBatchProductionVersion(f.db, f.batchId, { copyCount: 1 });
        f.db.prepare('UPDATE batch_productions SET currentVersionId=? WHERE id=?').run(next, f.batchId);
      }
      if (mutation === 'stop') f.db.prepare("UPDATE batch_productions SET controlState='stopped' WHERE id=?").run(f.batchId);
      if (mutation === 'unfreeze') f.db.prepare("UPDATE batch_production_versions SET inputState='draft' WHERE id=?").run(f.batchVersionId);
      expected = f.read();
      return solved;
    });
    assert.equal(result.items[0].status, 'skipped', mutation);
    assert.deepEqual(f.read(), expected, `${mutation}: must not overwrite concurrent changes with the solved snapshot`);
    assert.equal(f.tasks(), 0, mutation);
  }
  for (const failure of ['infeasible', 'budget_exceeded', 'throw', 'wrongHash'] as const) {
    const f = await fixture();
    const original = f.read();
    const result = await exportOne(f, async input => {
      if (failure === 'throw') throw new Error('fixture solve failed');
      if (failure === 'wrongHash') return { ...await resolveLayout(input), inputHash: 'f'.repeat(64) };
      return { status: failure };
    });
    assert.equal(result.items[0].status, 'skipped', failure);
    assert.deepEqual(f.read(), original, `${failure}: no partial cache saved`);
    assert.equal(f.tasks(), 0);
  }
  // Cached frozen resources still pass through the real integrity gate.
  const f = await fixture();
  await exportOne(f);
  const { bundleDir } = readPackagingLayoutBundle(f.read().packaging.layoutResolution);
  const frozenFile = path.join(bundleDir, 'auto-layout/runtime.js');
  const originalBytes = fs.readFileSync(frozenFile);
  fs.writeFileSync(frozenFile, 'tampered');
  try {
    const original = f.read();
    const result = await exportOne(f);
    assert.equal(result.items[0].status, 'skipped');
    assert.match(result.items[0].reason ?? '', /变化|缺失/);
    assert.deepEqual(f.read(), original);
    assert.equal(f.tasks(), 1);
  } finally { fs.writeFileSync(frozenFile, originalBytes); }
  console.log('batch export layout tests passed');
} finally {
  for (const db of databases) db.close();
  for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
  Object.assign(process.env, envBefore);
  fs.rmSync(root, { recursive: true, force: true });
}

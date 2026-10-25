import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import Database from 'better-sqlite3';
import ts from 'typescript';
import type { VideoAnalysisResult } from '../lib/final-edit/asset-analysis.ts';

// Exercise production analysis and the whole route; SQL below only creates/mutates fixtures.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'final-edit-reanalyze-'));
const previousDataRoot = process.env.CREATIVE_STUDIO_DATA_ROOT;
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
register('./typescript-extension-loader.mjs', import.meta.url);

async function main() {
  const assetAnalysis = await import('../lib/final-edit/asset-analysis.ts');
  const { analyzeFinalEditAsset, FINAL_EDIT_ANALYZER_VERSION } = assetAnalysis;
  const { initFinalEditSchema } = await import('../lib/final-edit/schema.ts');
  const { FinalEditError } = await import('../lib/final-edit/errors.ts');
  const storagePaths = await import('../lib/final-edit/storage-path.ts');
  type Dependencies = Parameters<typeof analyzeFinalEditAsset>[0];
  type Input = Parameters<typeof analyzeFinalEditAsset>[1];
  type StoredRow = {
    videoJobId: string; shotSetId: string; fileFingerprint: string; providerId: string;
    model: string; analyzerVersion: string; status: string; mediaJson: string; generatedJson: string;
    manualOverrideJson: string; autoUseDisabled: number; errorCode: string | null;
    errorMessage: string | null; analyzedAt: string | null; updatedAt: string;
  };
  const media = { durationUs: 12_345_678, width: 720, height: 960, fps: 24 };
  const analysis: VideoAnalysisResult = {
    summary: '产品特写', sellingPoints: ['轻便'], semanticTags: ['产品'],
    usableRanges: [{ startUs: 0, endUs: 12_000_000, qualityScore: 0.9 }],
    qualityIssues: [], coverFrameTimesUs: [1_000_000],
    scenes: [{ startUs: 0, endUs: 12_000_000, description: '产品展示', labels: ['特写'], qualityScore: 0.9 }],
  };
  const invalidAnalysis = { ...analysis, usableRanges: [{ startUs: 10, endUs: 5, qualityScore: 1 }] };
  const manual = JSON.stringify({ summary: '人工确认', usableRanges: [{ startUs: 1, endUs: 2 }] });
  let passed = 0;

  function fixture() {
    const dir = fs.mkdtempSync(path.join(root, 'case-'));
    fs.mkdirSync(path.join(dir, 'storage'));
    const filePath = path.join(dir, 'storage', 'video.mp4');
    // No codec/network needed: hashing uses real bytes, media probing is an injected boundary.
    fs.writeFileSync(filePath, 'fixture video bytes');
    const db = new Database(':memory:');
    initFinalEditSchema(db);
    db.exec(`CREATE TABLE script_providers (id TEXT PRIMARY KEY, model TEXT, defaultModel TEXT);
      INSERT INTO script_providers VALUES ('vision', 'model-a', 'default-a');
      CREATE TABLE video_jobs (id TEXT PRIMARY KEY, shotSetId TEXT, localVideoPath TEXT, status TEXT);
      INSERT INTO video_jobs VALUES ('video', 'set-a', 'video.mp4', 'succeeded');`);
    const calls: string[] = [];
    const input: Input = { filePath, videoJobId: 'video', shotSetId: 'set-a', providerId: 'vision', mode: 'prepare' };
    const deps: Dependencies = {
      db,
      probeVideo: async (value) => {
        assert.deepEqual(value, { filePath, videoJobId: 'video' });
        calls.push('probe');
        return media;
      },
      analyzeVideo: async (value) => {
        assert.deepEqual(value, { filePath, videoJobId: 'video', shotSetId: input.shotSetId, providerId: input.providerId });
        calls.push('analyze');
        return analysis;
      },
    };
    return {
      dir, db, deps, input, calls,
      run: (overrides: Partial<Input> = {}) => analyzeFinalEditAsset(deps, { ...input, ...overrides }),
      row: () => db.prepare('SELECT * FROM final_edit_asset_analysis WHERE videoJobId=?').get('video') as StoredRow | undefined,
      protect: () => db.prepare(`UPDATE final_edit_asset_analysis SET manualOverrideJson=?, autoUseDisabled=1,
        errorCode='old_error', errorMessage='old message', analyzedAt='2000-01-01', updatedAt='2000-01-01'`).run(manual),
    };
  }
  type Fixture = ReturnType<typeof fixture>;
  async function check(name: string, body: (f: Fixture) => Promise<void>) {
    const f = fixture();
    try { await body(f); passed++; }
    catch (error) { throw new Error(name, { cause: error }); }
    finally { f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
  function assertStored(f: Fixture, model = 'model-a', providerId = 'vision') {
    const row = f.row()!;
    assert.equal(row.videoJobId, 'video');
    assert.equal(row.shotSetId, f.input.shotSetId);
    assert.equal(row.fileFingerprint, createHash('sha256').update(fs.readFileSync(f.input.filePath)).digest('hex'));
    assert.equal(row.providerId, providerId);
    assert.equal(row.model, model);
    assert.equal(row.analyzerVersion, '2');
    assert.equal(row.status, 'succeeded');
    assert.deepEqual(JSON.parse(row.mediaJson), media);
    assert.deepEqual(JSON.parse(row.generatedJson), analysis);
    assert.equal(row.errorCode, null);
    assert.equal(row.errorMessage, null);
    assert.ok(row.analyzedAt && Number.isFinite(Date.parse(row.analyzedAt)));
    assert.ok(Number.isFinite(Date.parse(row.updatedAt)));
  }

  assert.equal(FINAL_EDIT_ANALYZER_VERSION, '2');
  await check('prepare persists complete metadata and probes again on cache hit', async f => {
    const first = await f.run();
    assert.deepEqual(first, { fingerprint: f.row()!.fileFingerprint, media, analysis, status: 'succeeded', cacheHit: false });
    assertStored(f);
    const freshMedia = { ...media, fps: 30 };
    f.deps.probeVideo = async () => { f.calls.push('probe'); return freshMedia; };
    const cached = await f.run();
    assert.equal(cached.cacheHit, true);
    assert.deepEqual(cached.analysis, analysis);
    assert.deepEqual(cached.media, freshMedia);
    assert.deepEqual(JSON.parse(f.row()!.mediaJson), freshMedia);
    assert.deepEqual(f.calls, ['probe', 'analyze', 'probe']);
  });

  await check('refresh bypasses cache, repairs metadata and preserves manual decisions', async f => {
    await f.run();
    f.protect();
    await f.run({ mode: 'refresh' });
    assert.deepEqual(f.calls, ['probe', 'analyze', 'probe', 'analyze']);
    f.db.exec("UPDATE final_edit_asset_analysis SET mediaJson='{}', analyzerVersion='1'");
    f.input.shotSetId = 'set-b';
    const refreshed = await f.run({ mode: 'refresh' });
    assert.equal(refreshed.cacheHit, false);
    assertStored(f);
    assert.equal(f.row()!.manualOverrideJson, manual);
    assert.equal(f.row()!.autoUseDisabled, 1);
    assert.notEqual(f.row()!.updatedAt, '2000-01-01');
  });

  for (const invalid of [false, true]) {
    await check(`refresh ${invalid ? 'invalid output' : 'provider failure'} preserves entire row`, async f => {
      await f.run();
      f.protect();
      const before = f.row();
      const failure = new Error('provider offline');
      f.deps.analyzeVideo = async () => { if (invalid) return invalidAnalysis; throw failure; };
      await assert.rejects(f.run({ mode: 'refresh' }), error => invalid
        ? error instanceof FinalEditError && error.code === 'analysis_failed'
        : error === failure);
      assert.deepEqual(f.row(), before);
    });
  }

  const cacheChanges: Array<[string, (f: Fixture) => void]> = [
    ['broken JSON', f => { f.db.exec("UPDATE final_edit_asset_analysis SET generatedJson='{'"); }],
    ['missing fields', f => { f.db.exec("UPDATE final_edit_asset_analysis SET generatedJson='{}'"); }],
    ['invalid range', f => { f.db.prepare('UPDATE final_edit_asset_analysis SET generatedJson=?').run(JSON.stringify(invalidAnalysis)); }],
    ['old version', f => { f.db.exec("UPDATE final_edit_asset_analysis SET analyzerVersion='1'"); }],
    ['model', f => { f.db.exec("UPDATE script_providers SET model='model-b'"); }],
    ['provider', f => { f.input.providerId = 'other'; }],
    ['file bytes', f => { fs.writeFileSync(f.input.filePath, 'changed video bytes'); }],
    ['failed status with valid JSON', f => { f.db.exec("UPDATE final_edit_asset_analysis SET status='failed'"); }],
  ];
  for (const [name, change] of cacheChanges) {
    await check(`prepare invalidates cache: ${name}`, async f => {
      await f.run();
      change(f);
      const result = await f.run();
      assert.equal(result.cacheHit, false);
      assert.equal(result.status, 'succeeded');
      assert.deepEqual(f.calls, ['probe', 'analyze', 'probe', 'analyze']);
      assertStored(f, name === 'model' ? 'model-b' : name === 'provider' ? '' : 'model-a', f.input.providerId);
    });
  }

  await check('explicit model, default model and absent provider table', async f => {
    await f.run({ model: 'explicit' });
    assertStored(f, 'explicit');
    assert.equal((await f.run({ model: 'explicit' })).cacheHit, true);
    await f.run({ model: '' });
    assertStored(f, '');
    f.db.exec("UPDATE script_providers SET model=''");
    await f.run();
    assertStored(f, 'default-a');
    f.db.exec('DROP TABLE script_providers');
    await f.run();
    assertStored(f, '');
  });

  for (const invalid of [false, true]) {
    await check(`prepare ${invalid ? 'invalid output' : 'provider failure'} degrades and retries`, async f => {
      const succeed = f.deps.analyzeVideo;
      f.deps.analyzeVideo = async () => { if (invalid) return invalidAnalysis; throw new Error('temporary failure'); };
      const failed = await f.run();
      assert.equal(failed.status, 'failed');
      assert.equal(failed.cacheHit, false);
      assert.deepEqual(failed.media, media);
      assert.equal(failed.fingerprint, f.row()!.fileFingerprint);
      assert.deepEqual(failed.analysis, { summary: '', sellingPoints: [], semanticTags: [], usableRanges: [], qualityIssues: ['analysis_failed'], coverFrameTimesUs: [] });
      assert.equal(f.row()!.status, 'failed');
      assert.equal(f.row()!.errorCode, 'analysis_failed');
      assert.ok(f.row()!.errorMessage);
      f.protect();
      f.deps.analyzeVideo = succeed;
      const recovered = await f.run();
      assert.equal(recovered.cacheHit, false);
      assertStored(f);
      assert.equal(f.row()!.manualOverrideJson, manual);
      assert.equal(f.row()!.autoUseDisabled, 1);
      assert.equal((await f.run()).cacheHit, true);
      assert.equal(f.calls.filter(call => call === 'analyze').length, 1);
    });
  }

  for (const mode of ['prepare', 'refresh'] as const) {
    for (const existing of [false, true]) {
      await check(`${mode} probe failure leaves ${existing ? 'existing' : 'absent'} row unchanged`, async f => {
        if (existing) { await f.run(); f.protect(); }
        const before = f.row();
        f.calls.length = 0;
        f.deps.probeVideo = async () => { f.calls.push('probe'); throw new Error('probe failed'); };
        await assert.rejects(f.run({ mode }), /probe failed/);
        assert.deepEqual(f.calls, ['probe']);
        assert.deepEqual(f.row(), before);
      });
    }
  }

  // Transpile and execute the entire route. Only external boundaries are faked;
  // the actual analysis module and storage-path resolver perform all writes/path checks.
  const routeCode = ts.transpileModule(fs.readFileSync(new URL('../app/api/final-edit-assets/[videoJobId]/reanalyze/route.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  function route(f: Fixture) {
    const providers = [
      { id: 'disabled', configured: false, supportsVision: true, model: 'disabled-model' },
      { id: 'text-only', configured: true, supportsVision: false, model: 'text-model' },
      { id: 'vision', configured: true, supportsVision: true, model: 'route-model' },
      { id: 'requested', configured: true, supportsVision: true, model: 'requested-model' },
    ];
    const dependencies: Record<string, unknown> = {
      'node:path': path,
      'next/server': { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } },
      '@/lib/db': { getDb: () => f.db },
      '@/lib/data-root': { dataRoot: () => f.dir },
      '@/lib/script-providers': { getAvailableProviders: () => providers },
      '@/lib/ffmpeg': { probeVideoMedia: (filePath: string) => f.deps.probeVideo({ filePath, videoJobId: 'video' }) },
      '@/lib/final-edit/adapters/video-analysis': {
        analyzeVideoWithVision: (value: { filePath: string; videoJobId: string; providerId: string; cacheDir: string }) => {
          assert.equal(value.cacheDir, path.join(f.dir, 'storage', 'final-edits', 'analysis', 'video'));
          return f.deps.analyzeVideo({ filePath: value.filePath, videoJobId: value.videoJobId, providerId: value.providerId, shotSetId: f.input.shotSetId });
        },
      },
      '@/lib/final-edit/storage-path': storagePaths,
      '@/lib/final-edit/asset-analysis': assetAnalysis,
    };
    type Post = (request: Request, context: { params: Promise<{ videoJobId: string }> }) => Promise<Response>;
    const exports = {} as { POST: Post };
    vm.runInNewContext(routeCode, { exports, Error, require: (name: string) => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected route dependency: ${name}`);
      return dependencies[name];
    } });
    return {
      providers,
      post: (body: unknown = {}, videoJobId = 'video') => exports.POST(
        new Request('http://localhost/api/final-edit-assets/video/reanalyze', { method: 'POST', body: JSON.stringify(body) }),
        { params: Promise.resolve({ videoJobId }) },
      ),
    };
  }

  for (const requested of ['requested', 'disabled', 'text-only', 'unknown', undefined]) {
    await check(`route selects provider: ${requested ?? 'default'}`, async f => {
      const selected = requested === 'requested' ? 'requested' : 'vision';
      f.input.providerId = selected;
      const handler = route(f);
      for (let i = 0; i < 2; i++) {
        const response = await handler.post({ providerId: requested });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { success: true, analysis });
        assertStored(f, selected === 'requested' ? 'requested-model' : 'route-model', selected);
      }
      assert.deepEqual(f.calls, ['probe', 'analyze', 'probe', 'analyze'], 'route must refresh, with probe before each AI call');
    });
  }
  await check('route returns 409 without a configured vision provider', async f => {
    const handler = route(f);
    handler.providers.splice(2);
    const response = await handler.post({ providerId: 'disabled' });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'vision_provider_unavailable', message: '没有可用的视觉分析供应商' });
    assert.deepEqual(f.calls, []);
    assert.equal(f.row(), undefined);
  });
  for (const missing of ['absent', 'not succeeded', 'no path']) {
    await check(`route returns 404: ${missing}`, async f => {
      if (missing === 'not succeeded') f.db.exec("UPDATE video_jobs SET status='failed'");
      if (missing === 'no path') f.db.exec("UPDATE video_jobs SET localVideoPath=''");
      const response = await route(f).post({}, missing === 'absent' ? 'missing' : 'video');
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: 'video_not_found', message: '视频素材不存在' });
      assert.deepEqual(f.calls, []);
      assert.equal(f.row(), undefined);
    });
  }
  for (const failure of ['probe', 'analysis', 'invalid result']) {
    await check(`route returns 400 and preserves entire row: ${failure}`, async f => {
      await f.run();
      f.protect();
      const before = f.row();
      f.calls.length = 0;
      if (failure === 'probe') f.deps.probeVideo = async () => { f.calls.push('probe'); throw new Error('probe failed'); };
      else f.deps.analyzeVideo = async () => {
        f.calls.push('analyze');
        if (failure === 'invalid result') return invalidAnalysis;
        throw new Error('analysis failed');
      };
      const response = await route(f).post();
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.error, 'reanalyze_failed');
      assert.equal(body.message, failure === 'invalid result' ? '视频分析结果结构无效' : `${failure} failed`);
      assert.deepEqual(f.row(), before);
      assert.deepEqual(f.calls, failure === 'probe' ? ['probe'] : ['probe', 'analyze'], 'failed probe must never call AI');
    });
  }
  console.log(`final-edit-reanalyze: ${passed} behavior tests passed`);
}

try { await main(); }
finally {
  if (previousDataRoot === undefined) delete process.env.CREATIVE_STUDIO_DATA_ROOT;
  else process.env.CREATIVE_STUDIO_DATA_ROOT = previousDataRoot;
  fs.rmSync(root, { recursive: true, force: true });
}

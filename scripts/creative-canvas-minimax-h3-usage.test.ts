import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import Database from 'better-sqlite3';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-h3-usage-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
register('./typescript-extension-loader.mjs', import.meta.url);
const { CREATIVE_CANVAS_MIGRATIONS } = await import('../lib/creative-canvas/schema.ts');
const { createCanvas } = await import('../lib/creative-canvas/repository.ts');
const { getCanvasTask } = await import('../lib/creative-canvas/tasks.ts');
const { canvasTaskActualCost, canvasTaskCostQuote, recordCanvasTaskUsage } = await import('../lib/creative-canvas/usage.ts');
const { initUsageSchema } = await import('../lib/usage-schema.ts');
const { BILLING_MODEL_PRICES, CORE_USAGE_PRICING_VERSION } = await import('../lib/usage-pricing.ts');
const h3Id = BILLING_MODEL_PRICES.find((entry) => entry.model === 'minimax-h3')!.id;
const db = new Database(':memory:');
try {
  db.pragma('foreign_keys = ON');
  for (const migration of CREATIVE_CANVAS_MIGRATIONS) db.exec(migration.sql);
  assert.equal(initUsageSchema(db).available, true);
  db.exec('CREATE TABLE video_providers (id TEXT PRIMARY KEY, name TEXT, type TEXT, baseUrl TEXT, defaultModel TEXT)');
  db.prepare('INSERT INTO video_providers VALUES (?, ?, ?, ?, ?)')
    .run(h3Id, 'MiniMax H3', 'openai-video', 'http://127.0.0.1:4000', 'minimax-h3');
  const canvas = createCanvas(db, { name: 'H3 pricing' });
  const foreign = createCanvas(db, { name: 'other' });
  function task(id: string, resolution: string, outputSec = 5, mode = 'reference-to-video', model = 'minimax-h3') {
    db.prepare(`INSERT INTO creative_canvas_tasks
      (id, canvasId, nodeId, nodeEpoch, mediaKind, phase, providerSnapshot, parameterSnapshot, createdAt, updatedAt)
      VALUES (?, ?, ?, 0, 'video', 'queued', ?, ?, '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z')`)
      .run(id, canvas.id, id, JSON.stringify({ providerIdentity: model === 'minimax-h3' ? h3Id : 'company-wan-3-0', modelAlias: model }),
        JSON.stringify({ generationMode: mode, parameters: { resolution, durationSec: outputSec } }));
    return getCanvasTask(db, id)!;
  }
  function asset(id: string, mediaKind: string, durationSec: number | null, canvasId = canvas.id) {
    db.prepare(`INSERT INTO creative_canvas_assets
      (id, canvasId, mediaKind, relativePath, contentHash, mimeType, byteSize, width, height, durationSec, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, 1, 320, 240, ?, '2026-11-12T00:00:00Z')`)
      .run(id, canvasId, mediaKind, id, id, mediaKind + '/test', durationSec);
  }
  function reference(taskId: string, assetId: string | null, upstreamTaskId: string | null = null) {
    const order = Number(db.prepare('SELECT COUNT(*) FROM creative_canvas_task_inputs WHERE taskId = ?').pluck().get(taskId));
    db.prepare(`INSERT INTO creative_canvas_task_inputs (id, taskId, refId, orderIndex, role, assetId, upstreamTaskId, createdAt)
      VALUES (?, ?, ?, ?, 'reference', ?, ?, '2026-11-12')`)
      .run(taskId + '-' + order, taskId, 'ref-' + order, order, assetId, upstreamTaskId);
  }
  function accept(id: string) { db.prepare("UPDATE creative_canvas_tasks SET submissionState = 'accepted' WHERE id = ?").run(id); }
  function ledger(id: string) { return db.prepare('SELECT * FROM usage_ledger WHERE refId = ?').get(id) as { costMicros: number; quantity: number; callCount: number; detailJson: string } | undefined; }
  asset('video5', 'video', 5);
  asset('audio', 'audio', 15);
  asset('image', 'image', null);
  for (const [resolution, expected] of [['768P', 500], ['2K', 800]] as const) {
    const current = task(resolution, resolution);
    reference(current.id, 'video5'); reference(current.id, 'audio'); reference(current.id, 'image');
    const quote = canvasTaskCostQuote(db, current);
    assert.equal(quote.kind, 'priced');
    if (quote.kind !== 'priced') throw new Error('missing quote');
    assert.equal(quote.reserve.minor, expected);
    const snapshot = quote.pricingSnapshot as Record<string, unknown>;
    assert.deepEqual(snapshot.quantity, { input_second: 5, output_second: 5 });
    assert.equal(snapshot.resolution, resolution, 'reference dimensions do not set the billing tier');
    assert.equal(snapshot.inputVideoDurationSec, 5, 'audio and image do not add input-video seconds');
    accept(current.id);
    assert.deepEqual(canvasTaskActualCost(db, current), quote.reserve);
    assert.equal(recordCanvasTaskUsage(db, { taskId: current.id }).inserted, true);
    assert.equal(recordCanvasTaskUsage(db, { taskId: current.id }).inserted, false);
    const row = ledger(current.id)!;
    assert.equal(row.costMicros, expected * 10_000);
    assert.equal(row.quantity, 10); assert.equal(row.callCount, 1);
    const detail = JSON.parse(row.detailJson);
    assert.equal(detail.estimated, true);
    assert.deepEqual(detail.priceComponents.map((component: { key: string; quantity: number; componentCostMicros: number }) => [component.key, component.quantity, component.componentCostMicros]), [
      ['input_second', 5, expected * 5_000], ['output_second', 5, expected * 5_000],
    ]);
  }
  const fraction = task('fraction', '768P', 15);
  asset('fraction-a', 'video', 2.125); asset('fraction-b', 'video', 3.25);
  reference(fraction.id, 'fraction-a'); reference(fraction.id, 'fraction-b');
  const multi = canvasTaskCostQuote(db, fraction);
  assert.equal(multi.kind, 'priced');
  if (multi.kind === 'priced') assert.equal(multi.reserve.minor, 1019, '5.375 input + 15 output; no Seedance minimum or per-video ceiling');
  accept(fraction.id);
  assert.equal(recordCanvasTaskUsage(db, { taskId: fraction.id }).inserted, true);
  assert.equal(ledger(fraction.id)!.costMicros, 10_187_500, 'ledger retains micros; reservation rounds up to cents');
  const upstream = task('upstream', '2K');
  db.prepare('UPDATE creative_canvas_tasks SET outputAssetId = ? WHERE id = ?').run('video5', upstream.id);
  const downstream = task('downstream', '768P'); reference(downstream.id, null, upstream.id);
  const downstreamQuote = canvasTaskCostQuote(db, downstream);
  assert.equal(downstreamQuote.kind, 'priced');
  if (downstreamQuote.kind === 'priced') assert.equal(downstreamQuote.reserve.minor, 500);
  for (const [id, duration] of [['missing', null], ['zero', 0], ['negative', -1]] as const) {
    asset(id + '-asset', 'video', duration);
    const pending = task(id, '2K'); reference(id, id + '-asset'); accept(id);
    assert.equal(canvasTaskCostQuote(db, pending).kind, 'unpriced');
    assert.equal(canvasTaskActualCost(db, pending), null);
    assert.equal(recordCanvasTaskUsage(db, { taskId: id }).reason, 'usage_pending');
    assert.equal(ledger(id), undefined);
  }
  asset('foreign-video', 'video', 5, foreign.id);
  const wrongCanvas = task('foreign-input', '2K'); reference(wrongCanvas.id, 'foreign-video');
  assert.equal(canvasTaskCostQuote(db, wrongCanvas).kind, 'unpriced');
  const noVideo = task('audio-image', '768P'); reference(noVideo.id, 'audio'); reference(noVideo.id, 'image');
  const audioQuote = canvasTaskCostQuote(db, noVideo);
  assert.equal(audioQuote.kind, 'priced');
  if (audioQuote.kind === 'priced') assert.equal(audioQuote.reserve.minor, 250);
  assert.equal(canvasTaskCostQuote(db, task('bad-resolution', '1080P')).kind, 'unpriced');
  const wanQuote = canvasTaskCostQuote(db, task('wan', '1080P', 5, 'reference-to-video', 'wan-3.0'));
  assert.equal(wanQuote.kind, 'priced');
  if (wanQuote.kind === 'priced') assert.equal(wanQuote.reserve.minor, 600);

  // Simulate a persisted admitted execution quote, then edit unrelated live metadata.
  db.exec(`CREATE TABLE execution_operations (id TEXT PRIMARY KEY, module TEXT, taskId TEXT);
    CREATE TABLE execution_attempts (id TEXT PRIMARY KEY, operationId TEXT, pricingSnapshotJson TEXT, createdAt TEXT);`);
  const frozenTask = task('frozen', '768P'); reference(frozenTask.id, 'video5');
  const frozenQuote = canvasTaskCostQuote(db, frozenTask);
  assert.equal(frozenQuote.kind, 'priced');
  db.prepare('INSERT INTO execution_operations VALUES (?, ?, ?)').run('op', 'canvas', frozenTask.id);
  db.prepare('INSERT INTO execution_attempts VALUES (?, ?, ?, ?)').run('attempt', 'op', JSON.stringify(frozenQuote.pricingSnapshot), '2026-11-12');
  db.prepare('UPDATE creative_canvas_assets SET durationSec = 12 WHERE id = ?').run('video5');
  accept(frozenTask.id);
  assert.deepEqual(canvasTaskActualCost(db, frozenTask), { currency: 'CNY', minor: 500 }, 'settlement uses original admitted seconds');
  assert.equal(recordCanvasTaskUsage(db, { taskId: frozenTask.id }).inserted, true);
  assert.equal(ledger(frozenTask.id)!.costMicros, 5_000_000);
  const oldTask = task('historical', '768P'); reference(oldTask.id, 'video5'); accept(oldTask.id);
  db.prepare('INSERT INTO execution_operations VALUES (?, ?, ?)').run('old-op', 'canvas', oldTask.id);
  db.prepare('INSERT INTO execution_attempts VALUES (?, ?, ?, ?)').run('old-attempt', 'old-op', JSON.stringify({ pricingVersion: CORE_USAGE_PRICING_VERSION, coreModelKey: h3Id, quantity: 5 }), '2026-11-11');
  assert.deepEqual(canvasTaskActualCost(db, oldTask), { currency: 'CNY', minor: 400 }, 'historical average quote is not repriced');
  assert.equal(recordCanvasTaskUsage(db, { taskId: oldTask.id }).inserted, true);
  assert.equal(ledger(oldTask.id)!.costMicros, 4_000_000);
} finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
console.log('creative-canvas-minimax-h3-usage.test.ts passed');

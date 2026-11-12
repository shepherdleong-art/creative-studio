import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import Database from 'better-sqlite3';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seedance-stage-usage-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
register('./typescript-extension-loader.mjs', import.meta.url);
const { CREATIVE_CANVAS_MIGRATIONS } = await import('../lib/creative-canvas/schema.ts');
const { createCanvas } = await import('../lib/creative-canvas/repository.ts');
const { getCanvasTask } = await import('../lib/creative-canvas/tasks.ts');
const { canvasTaskActualCost, canvasTaskCostQuote, recordCanvasTaskUsage } = await import('../lib/creative-canvas/usage.ts');
const { initUsageSchema } = await import('../lib/usage-schema.ts');
const db = new Database(':memory:');
try {
  db.pragma('foreign_keys = ON');
  for (const migration of CREATIVE_CANVAS_MIGRATIONS) db.exec(migration.sql);
  assert.equal(initUsageSchema(db).available, true);
  db.exec(`CREATE TABLE video_providers (id TEXT PRIMARY KEY, name TEXT, type TEXT, baseUrl TEXT, defaultModel TEXT);
    INSERT INTO video_providers VALUES ('company-seedance-2-5', 'Seedance 2.5', 'openai-video', 'http://127.0.0.1:4000', 'doubao-seedance-2-5-260628');`);
  const canvas = createCanvas(db, { name: 'stage pricing' });
  const otherCanvas = createCanvas(db, { name: 'other' });
  const provider = { providerIdentity: 'company-seedance-2-5', modelAlias: 'doubao-seedance-2-5-260628' };
  function task(id: string, parameters: Record<string, unknown>, canvasId = canvas.id) {
    db.prepare(`INSERT INTO creative_canvas_tasks
      (id, canvasId, nodeId, nodeEpoch, mediaKind, phase, providerSnapshot, parameterSnapshot, createdAt, updatedAt)
      VALUES (?, ?, ?, 0, 'video', 'queued', ?, ?, '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z')`)
      .run(id, canvasId, id, JSON.stringify(provider), JSON.stringify({ generationMode: 'text-to-video', parameters }));
    return getCanvasTask(db, id)!;
  }
  function asset(id: string, mediaKind: string, width: number, height: number, durationSec: number) {
    db.prepare(`INSERT INTO creative_canvas_assets
      (id, canvasId, mediaKind, relativePath, contentHash, mimeType, byteSize, width, height, durationSec, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, '2026-11-12T00:00:00Z')`)
      .run(id, canvas.id, mediaKind, id, id, mediaKind + '/mp4', width, height, durationSec);
  }
  function complete(id: string, width: number, height: number, tokens?: number) {
    asset(id + '-output', 'video', width, height, 5);
    db.prepare(`UPDATE creative_canvas_tasks SET phase = 'succeeded', submissionState = 'terminal', outputAssetId = ?, providerTaskId = ? WHERE id = ?`)
      .run(id + '-output', id + '-remote', id);
    const stage = JSON.parse(getCanvasTask(db, id)!.parameterSnapshot).parameters.generationStage;
    db.prepare('INSERT INTO creative_canvas_video_metadata VALUES (?, ?)').run(id, JSON.stringify({
      stage, draftConfirmed: stage === 'draft', model: provider.modelAlias,
      remoteCreatedAt: '2026-11-12T00:00:00Z', expiresAt: '2026-11-19T00:00:00Z',
      usage: tokens === undefined ? {} : { completion_tokens: tokens },
    }));
  }
  function ledger(id: string) {
    return db.prepare('SELECT * FROM usage_ledger WHERE refId = ?').get(id) as { costMicros: number; callCount: number; unit: string; detailJson: string } | undefined;
  }
  const draft = task('draft', { generationStage: 'draft', durationSec: 5, aspectRatio: '16:9' });
  const quote = canvasTaskCostQuote(db, draft);
  assert.equal(quote.kind, 'priced');
  if (quote.kind === 'priced') assert.equal(quote.reserve.minor, 337);
  assert.equal(canvasTaskActualCost(db, draft), null, 'do not settle a reservation as actual before completion');
  db.prepare(`UPDATE creative_canvas_tasks SET phase = 'polling', submissionState = 'accepted' WHERE id = ?`).run(draft.id);
  assert.equal(recordCanvasTaskUsage(db, { taskId: draft.id }).reason, 'usage_pending');
  assert.equal(ledger(draft.id), undefined);
  complete('draft', 854, 480, 50_000);
  assert.deepEqual(canvasTaskActualCost(db, draft), { currency: 'CNY', minor: 350 }, 'stale task objects still read the downloaded usage');
  assert.equal(recordCanvasTaskUsage(db, { taskId: 'draft' }).inserted, true);
  assert.equal(ledger('draft')?.costMicros, 3_500_000);
  assert.equal(ledger('draft')?.unit, 'token');
  assert.equal(JSON.parse(ledger('draft')!.detailJson).estimated, false);
  assert.equal(recordCanvasTaskUsage(db, { taskId: 'draft' }).inserted, false);

  const final = task('final', { generationStage: 'final-from-draft', draftAssetId: 'draft-output' });
  assert.equal(canvasTaskCostQuote(db, final).kind, 'priced');
  complete('final', 1920, 1080, 250_000);
  assert.equal(recordCanvasTaskUsage(db, { taskId: 'final' }).inserted, true);
  assert.equal(ledger('final')?.costMicros, 19_250_000, 'a Draft asset is not an input video; use 77, not 46');
  assert.equal(ledger('draft')!.costMicros + ledger('final')!.costMicros, 22_750_000, 'two independent charges with no Draft deduction');
  assert.equal(ledger('draft')?.callCount, 1);
  assert.equal(ledger('final')?.callCount, 1);

  const videoDraft = task('video-draft', { generationStage: 'draft', durationSec: 5, aspectRatio: '16:9' });
  asset('reference', 'video', 1280, 720, 3);
  db.prepare(`INSERT INTO creative_canvas_task_inputs (id, taskId, refId, orderIndex, role, assetId, createdAt)
    VALUES ('input', ?, 'ref1', 0, 'reference', 'reference', '2026-11-12T00:00:00Z')`).run(videoDraft.id);
  const videoDraftQuote = canvasTaskCostQuote(db, videoDraft);
  assert.equal(videoDraftQuote.kind, 'priced');
  if (videoDraftQuote.kind === 'priced') {
    const snapshot = videoDraftQuote.pricingSnapshot as Record<string, unknown>;
    assert.equal(videoDraftQuote.reserve.minor, 364, '3-second reference is billed with the 4-second minimum for 5-second output');
    assert.equal(snapshot.quantity, 86_467.5);
    assert.equal(snapshot.inputVideoDurationSec, 3);
    assert.equal(snapshot.minimumInputVideoDurationSec, 4);
    assert.equal(snapshot.estimatedTokens, 76_860);
    assert.equal(snapshot.minimumTokens, 86_467.5);
  }
  assert.equal(canvasTaskActualCost(db, videoDraft), null, 'pre-submit reservation is not an actual charge');
  complete('video-draft', 854, 480, 90_000);
  assert.equal(recordCanvasTaskUsage(db, { taskId: videoDraft.id }).inserted, true);
  assert.equal(ledger(videoDraft.id)?.costMicros, 3_780_000);
  const videoFinal = task('video-final', { generationStage: 'final-from-draft', draftAssetId: 'video-draft-output' });
  const videoFinalQuote = canvasTaskCostQuote(db, videoFinal);
  assert.equal(videoFinalQuote.kind, 'priced');
  if (videoFinalQuote.kind === 'priced') {
    const snapshot = videoFinalQuote.pricingSnapshot as Record<string, unknown>;
    assert.equal(videoFinalQuote.reserve.minor, 2013);
    assert.equal(snapshot.quantity, 437_400);
    assert.equal(snapshot.inputVideoDurationSec, 3, 'reuse the original references; do not add the 5-second Draft');
  }
  assert.equal(canvasTaskActualCost(db, videoFinal), null);
  complete('video-final', 1920, 1080, 450_000);
  assert.equal(recordCanvasTaskUsage(db, { taskId: videoFinal.id }).inserted, true);
  assert.equal(ledger(videoFinal.id)?.costMicros, 20_700_000, 'Final retains the original Draft video reference tier');

  function reference(taskId: string, assetId: string, order: number) {
    db.prepare(`INSERT INTO creative_canvas_task_inputs (id, taskId, refId, orderIndex, role, assetId, createdAt)
      VALUES (?, ?, ?, ?, 'reference', ?, '2026-11-12T00:00:00Z')`)
      .run(taskId + '-ref-' + order, taskId, 'ref' + order, order, assetId);
  }
  const multi = task('multi', { generationStage: 'draft', durationSec: 5, aspectRatio: '9:16' });
  asset('ref-2s', 'video', 720, 1280, 2);
  reference(multi.id, 'ref-2s', 0);
  reference(multi.id, 'reference', 1);
  const multiQuote = canvasTaskCostQuote(db, multi);
  assert.equal(multiQuote.kind, 'priced');
  if (multiQuote.kind === 'priced') {
    const snapshot = multiQuote.pricingSnapshot as Record<string, unknown>;
    assert.equal(snapshot.inputVideoDurationSec, 5);
    assert.equal(snapshot.quantity, 96_075, 'sum the two references before applying the minimum once');
    assert.equal(multiQuote.reserve.minor, 404);
  }
  const long = task('long', { generationStage: 'draft', durationSec: 5, aspectRatio: '16:9' });
  asset('ref-30s', 'video', 1280, 720, 30);
  reference(long.id, 'ref-30s', 0);
  const longQuote = canvasTaskCostQuote(db, long);
  assert.equal(longQuote.kind, 'priced');
  if (longQuote.kind === 'priced') {
    const snapshot = longQuote.pricingSnapshot as Record<string, unknown>;
    assert.equal(snapshot.quantity, 336_262.5, 'actual reference duration can exceed the minimum');
    assert.equal(longQuote.reserve.minor, 1413);
  }
  const unknown = task('unknown-duration', { generationStage: 'draft', durationSec: 5, aspectRatio: '16:9' });
  asset('ref-unknown', 'video', 1280, 720, 0);
  reference(unknown.id, 'ref-unknown', 0);
  assert.equal(canvasTaskCostQuote(db, unknown).kind, 'unpriced', 'missing reference duration is not zero seconds');
  const withoutUsage = task('video-no-usage', { generationStage: 'draft', durationSec: 5, aspectRatio: '16:9' });
  reference(withoutUsage.id, 'reference', 0);
  complete(withoutUsage.id, 854, 480);
  assert.equal(recordCanvasTaskUsage(db, { taskId: withoutUsage.id }).reason, 'usage_pending', 'a known reservation cannot replace actual video usage');
  assert.equal(ledger(withoutUsage.id), undefined);

  const fallback = task('fallback', { generationStage: 'draft', durationSec: 5, aspectRatio: '16:9' });
  complete('fallback', 854, 480);
  assert.equal(recordCanvasTaskUsage(db, { taskId: fallback.id }).inserted, true);
  assert.equal(ledger(fallback.id)?.costMicros, 3_362_625);
  assert.equal(JSON.parse(ledger(fallback.id)!.detailJson).estimated, true);
  const automatic = task('automatic', { generationStage: 'draft', durationSec: -1, aspectRatio: '16:9' });
  assert.equal(canvasTaskCostQuote(db, automatic).kind, 'unpriced');
  complete('automatic', 854, 480, 60_000);
  assert.equal(recordCanvasTaskUsage(db, { taskId: automatic.id }).inserted, true);
  assert.equal(ledger(automatic.id)?.costMicros, 4_200_000);

  const foreign = task('foreign', { generationStage: 'final-from-draft', draftAssetId: 'draft-output' }, otherCanvas.id);
  assert.equal(canvasTaskCostQuote(db, foreign).kind, 'unpriced');
  db.prepare(`UPDATE creative_canvas_tasks SET phase = 'failed', submissionState = 'terminal' WHERE id = ?`).run(foreign.id);
  assert.equal(recordCanvasTaskUsage(db, { taskId: foreign.id }).priced, false);
  assert.equal(ledger(foreign.id), undefined);
  // Settlement uses actual tokens with the admitted price, for both stages.
  db.exec(`CREATE TABLE execution_operations (id TEXT PRIMARY KEY, module TEXT, taskId TEXT);
    CREATE TABLE execution_attempts (id TEXT PRIMARY KEY, operationId TEXT, pricingSnapshotJson TEXT, createdAt TEXT);`);
  for (const [stage, id, rate] of [['draft', 'frozen-draft', 60_000_000], ['final-from-draft', 'frozen-final', 66_000_000]] as const) {
    const frozenTask = task(id, stage === 'draft'
      ? { generationStage: stage, durationSec: 5, aspectRatio: '16:9' }
      : { generationStage: stage, draftAssetId: 'frozen-draft-output' });
    const frozenQuote = canvasTaskCostQuote(db, frozenTask);
    assert.equal(frozenQuote.kind, 'priced');
    if (frozenQuote.kind !== 'priced') throw new Error('missing stage quote');
    const snapshot = structuredClone(frozenQuote.pricingSnapshot) as { pricingVersion: string; priceComponents: { unitPriceMicros: number }[] };
    snapshot.priceComponents[0].unitPriceMicros = rate;
    snapshot.pricingVersion = 'frozen-stage-price';
    db.prepare('INSERT INTO execution_operations VALUES (?, ?, ?)').run(id + '-op', 'canvas', id);
    db.prepare('INSERT INTO execution_attempts VALUES (?, ?, ?, ?)').run(id + '-attempt', id + '-op', JSON.stringify(snapshot), '2026-11-12');
    complete(id, stage === 'draft' ? 854 : 1920, stage === 'draft' ? 480 : 1080, 100_000);
    assert.deepEqual(canvasTaskActualCost(db, frozenTask), { currency: 'CNY', minor: rate / 100_000 });
    assert.equal(recordCanvasTaskUsage(db, { taskId: id }).inserted, true);
    assert.equal(ledger(id)!.costMicros, rate / 10);
    assert.equal(JSON.parse(ledger(id)!.detailJson).priceComponents[0].unitPriceMicros, rate);
  }
  const frozenAutomatic = task('frozen-automatic', { generationStage: 'draft', durationSec: -1, aspectRatio: '16:9' });
  const automaticQuote = canvasTaskCostQuote(db, frozenAutomatic);
  assert.equal(automaticQuote.kind, 'unpriced');
  const automaticPricing = structuredClone(automaticQuote.pricingSnapshot) as { priceComponents: { unitPriceMicros: number }[] };
  assert.equal(automaticPricing.priceComponents[0].unitPriceMicros, 70_000_000, 'unknown duration still freezes its known unit price');
  automaticPricing.priceComponents[0].unitPriceMicros = 60_000_000;
  db.prepare('INSERT INTO execution_operations VALUES (?, ?, ?)').run('automatic-op', 'canvas', frozenAutomatic.id);
  db.prepare('INSERT INTO execution_attempts VALUES (?, ?, ?, ?)').run('automatic-attempt', 'automatic-op', JSON.stringify(automaticPricing), '2026-11-12');
  assert.equal(canvasTaskActualCost(db, frozenAutomatic), null);
  complete(frozenAutomatic.id, 854, 480, 100_000);
  assert.deepEqual(canvasTaskActualCost(db, frozenAutomatic), { currency: 'CNY', minor: 600 }, 'automatic duration settles when actual usage arrives');
  assert.equal(recordCanvasTaskUsage(db, { taskId: frozenAutomatic.id }).inserted, true);
  assert.equal(ledger(frozenAutomatic.id)!.costMicros, 6_000_000);

  const legacyUnpriced = task('legacy-unpriced', { generationStage: 'draft', durationSec: 5, aspectRatio: '16:9' });
  complete(legacyUnpriced.id, 854, 480, 100_000);
  db.prepare('INSERT INTO execution_operations VALUES (?, ?, ?)').run('legacy-op', 'canvas', legacyUnpriced.id);
  db.prepare('INSERT INTO execution_attempts VALUES (?, ?, ?, ?)').run('legacy-attempt', 'legacy-op', JSON.stringify({ source: 'canvas-usage' }), '2026-11-11');
  assert.equal(canvasTaskActualCost(db, legacyUnpriced), null, 'old unpriced submission does not acquire a new price');
  assert.equal(recordCanvasTaskUsage(db, { taskId: legacyUnpriced.id }).priced, false);
  assert.equal(ledger(legacyUnpriced.id), undefined);

  // Newly enabled stage prices do not reprice an existing immutable ledger row.
  db.prepare(`UPDATE creative_canvas_video_metadata SET metadataJson = ? WHERE taskId = 'draft'`)
    .run(JSON.stringify({ stage: 'draft', usage: { completion_tokens: 1_000_000 } }));
  assert.equal(recordCanvasTaskUsage(db, { taskId: 'draft' }).inserted, false);
  assert.equal(ledger('draft')?.costMicros, 3_500_000);
  console.log('creative-canvas-seedance-stage-usage tests passed');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}

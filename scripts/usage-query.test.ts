import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { initUsageSchema } from '../lib/usage-schema.ts';
import {
  getShanghaiUsagePeriods,
  listUsageRecords,
  parseUsageBoundary,
  queryUsageDashboard,
} from '../lib/usage-query.ts';

const periods = getShanghaiUsagePeriods(new Date('2026-08-18T01:23:45.000Z'));
assert.deepEqual(periods.today, {
  from: '2026-08-17T16:00:00.000Z',
  to: '2026-08-18T16:00:00.000Z',
});
assert.deepEqual(periods.week, {
  from: '2026-08-16T16:00:00.000Z',
  to: '2026-08-23T16:00:00.000Z',
});
assert.deepEqual(periods.month, {
  from: '2026-07-31T16:00:00.000Z',
  to: '2026-08-31T16:00:00.000Z',
});
assert.equal(periods.trend.length, 30);
assert.deepEqual(periods.trend[0], {
  date: '2026-07-20',
  from: '2026-07-19T16:00:00.000Z',
  to: '2026-07-20T16:00:00.000Z',
});
assert.equal(periods.trend.at(-1)?.date, '2026-08-18');
assert.throws(() => parseUsageBoundary('2026-02-30T00:00:00Z'), /invalid usage timestamp/);

const db = new Database(':memory:');
initUsageSchema(db);

const insert = db.prepare(`
  INSERT INTO usage_ledger (
    id, eventKey, coreModelKey, category, providerId, providerName, model,
    pricingVersion, callCount, quantity, unit, priceScale, unitPriceMicros,
    costMicros, detailJson, projectId, refType, refId, createdAt
  ) VALUES (
    @id, @eventKey, @coreModelKey, @category, @providerId, @providerName, @model,
    'v1', @callCount, @quantity, @unit, 1, 0,
    @costMicros, @detailJson, NULL, 'test', @id, @createdAt
  )
`);

function add(input: {
  id: string;
  coreModelKey: string;
  category: string;
  model: string;
  costMicros: number;
  callCount: number;
  quantity: number;
  unit: string;
  createdAt: string;
  detailJson?: string;
}) {
  insert.run({
    ...input,
    eventKey: `event:${input.id}`,
    providerId: `provider:${input.coreModelKey}`,
    providerName: input.model,
    detailJson: input.detailJson ?? '{}',
  });
}

add({ id: 'image-1', coreModelKey: 'company-image2-medium', category: 'image', model: 'image2-medium', costMicros: 1_050_000, callCount: 1, quantity: 1, unit: 'image', createdAt: '2026-08-17T16:00:00.000Z' });
add({ id: 'kling-1', coreModelKey: 'company-kling-3-0', category: 'video', model: 'kling-3.0', costMicros: 2_990_000, callCount: 1, quantity: 5, unit: 'second', createdAt: '2026-08-18T02:00:00.000Z' });
add({ id: 'gpt-1', coreModelKey: 'company-gpt-5-6-luna', category: 'llm_text', model: 'GPT-5-6-Luna-Standard', costMicros: 10, callCount: 1, quantity: 30, unit: 'token', createdAt: '2026-08-18T03:00:00.000Z', detailJson: '{"estimated":false}' });
add({ id: 'old-1', coreModelKey: 'company-image2-medium', category: 'image', model: 'image2-medium', costMicros: 999, callCount: 1, quantity: 1, unit: 'image', createdAt: '2026-07-01T00:00:00.000Z' });
// Exact right boundary is excluded.
add({ id: 'right-boundary', coreModelKey: 'company-image2-medium', category: 'image', model: 'image2-medium', costMicros: 500, callCount: 1, quantity: 1, unit: 'image', createdAt: '2026-08-18T16:00:00.000Z' });

db.prepare(`
  INSERT INTO usage_call_events (
    eventKey, status, ownerInstanceId, snapshotJson, usageJson, createdAt, updatedAt
  ) VALUES (?, 'uncertain', 'old-owner', ?, '{}', ?, ?)
`).run(
  'uncertain:1',
  JSON.stringify({ coreModelKey: 'company-gpt-5-6-luna' }),
  '2026-08-18T04:00:00.000Z',
  '2026-08-18T04:00:00.000Z',
);

db.prepare(`
  INSERT INTO usage_call_events (
    eventKey, status, ownerInstanceId, snapshotJson, usageJson, createdAt, updatedAt
  ) VALUES (?, 'uncertain', 'old-owner', ?, '{}', ?, ?)
`).run(
  'uncertain:tts',
  JSON.stringify({ coreModelKey: 'doubao-seed-tts-2' }),
  '2026-08-18T04:01:00.000Z',
  '2026-08-18T04:01:00.000Z',
);
db.prepare(`
  INSERT INTO usage_call_events (
    eventKey, status, ownerInstanceId, snapshotJson, usageJson, createdAt, updatedAt
  ) VALUES (?, 'uncertain', 'old-owner', 'not-json', 'also-not-json', ?, ?)
`).run('uncertain:bad-json', '2026-08-18T04:02:00.000Z', '2026-08-18T04:02:00.000Z');

const dashboard = queryUsageDashboard(db, {
  now: new Date('2026-08-18T01:23:45.000Z'),
  from: periods.today.from,
  to: periods.today.to,
});
assert.deepEqual(dashboard.periodTotals, {
  todayCostMicros: 4_040_010,
  weekCostMicros: 4_040_510,
  monthCostMicros: 4_040_510,
});
assert.deepEqual(dashboard.totals, { costMicros: 4_040_010, callCount: 3, quantity: 36 });
assert.equal(dashboard.unresolvedCount, 3);
assert.deepEqual(
  dashboard.models.map((row) => [row.coreModelKey, row.costMicros, row.percentage]),
  [
    ['company-kling-3-0', 2_990_000, 74.0097],
    ['company-image2-medium', 1_050_000, 25.99],
    ['company-gpt-5-6-luna', 10, 0.0002],
  ],
);
assert.deepEqual(dashboard.categories.map((row) => [row.category, row.costMicros]), [
  ['video', 2_990_000],
  ['image', 1_050_000],
  ['llm_text', 10],
]);
assert.equal(dashboard.trend.length, 30);
assert.equal(dashboard.trend[28].date, '2026-08-17');
assert.equal(dashboard.trend[28].totalCostMicros, 0);
assert.equal(dashboard.trend[29].costByModel['company-image2-medium'], 1_050_000);
assert.equal(dashboard.trend[29].costByModel['company-kling-3-0'], 2_990_000);
assert.equal(dashboard.trend[0].totalCostMicros, 0, 'missing days must be filled with zero');

const videoOnly = queryUsageDashboard(db, {
  now: new Date('2026-08-18T01:23:45.000Z'),
  from: periods.today.from,
  to: periods.today.to,
  category: 'video',
});
assert.deepEqual(videoOnly.totals, { costMicros: 2_990_000, callCount: 1, quantity: 5 });

const ttsOnly = queryUsageDashboard(db, {
  now: new Date('2026-08-18T01:23:45.000Z'),
  from: periods.today.from,
  to: periods.today.to,
  category: 'tts',
});
assert.equal(ttsOnly.unresolvedCount, 1, 'uncertain TTS must be classifiable from its frozen core model');

const firstPage = listUsageRecords(db, {
  from: periods.today.from,
  to: periods.today.to,
  page: 1,
  pageSize: 2,
});
assert.equal(firstPage.total, 3);
assert.equal(firstPage.totalPages, 2);
assert.deepEqual(firstPage.items.map((row) => row.id), ['gpt-1', 'kling-1']);
assert.deepEqual(firstPage.items[0].detail, { estimated: false });

const capped = listUsageRecords(db, { page: 1, pageSize: 500 });
assert.equal(capped.pageSize, 100);

db.close();
console.log('usage-query tests passed');

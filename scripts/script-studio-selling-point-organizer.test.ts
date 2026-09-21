import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SCRIPT_STUDIO_MIGRATIONS } from '../lib/script-studio/schema.ts';
import { createSellingPointOrganizer, parseOrganizedSellingPoints } from '../lib/script-studio/selling-point-organizer.ts';
import { createLibraryRevision, getCurrentLibraryRevision, getLibraryRevision, type LibrarySellingPointInput } from '../lib/script-studio/libraries.ts';
import { reorganizeLibrary } from '../lib/script-studio/reorganize-library.ts';

const points: LibrarySellingPointInput[] = [
  { title: '43mm芯径', factText: '储物款小Q簧芯径43mm', evidenceQuote: '储物款 43mm芯径', pointType: 'spec', sourcePageIndex: 0, tileRefs: ['tile_1'], usable: true, evidenceGate: 'passed' },
  { title: '3.8圈弹簧', factText: '储物款小Q簧3.8圈', evidenceQuote: '储物款 3.8圈', pointType: 'spec', sourcePageIndex: 1, tileRefs: ['tile_2'], usable: true, evidenceGate: 'passed' },
  { title: '1.2mm线径', factText: '储物款小Q簧线径1.2mm', evidenceQuote: '储物款 1.2mm线径', pointType: 'spec', sourcePageIndex: 1, tileRefs: ['tile_2'], usable: true, evidenceGate: 'passed' },
  { title: '未核验承重', factText: '承重999kg', evidenceQuote: '999kg', pointType: 'spec', usable: true, evidenceGate: 'failed' },
  { title: '用户排除', factText: '不要进入生成', pointType: 'other', usable: true, disabledByUser: true },
];
const raw = { sellingPoints: [{ title: '小Q簧内芯', detail: '储物款配备小Q簧，芯径43mm、3.8圈、线径1.2mm。相关参数属于同一内芯结构。', factIds: ['F1', 'F2', 'F3'] }] };
const organized = parseOrganizedSellingPoints(raw, points);
assert.equal(organized.length, 3, '三个参数组织成一个核心卖点，另保留两个排除项');
assert.equal(organized[0].title, '小Q簧内芯');
for (const point of points.slice(0, 3)) assert.ok(organized[0].factText.includes(point.factText), '原始条件与参数不得丢失');
assert.deepEqual(organized[0].evidenceRefs, [{ pageIndex: 0, tileRef: 'tile_1' }, { pageIndex: 1, tileRef: 'tile_2' }]);
assert.equal(organized[1].evidenceGate, 'failed');
assert.equal(organized[2].disabledByUser, true);
const response = (factIds: string[], detail = raw.sellingPoints[0].detail) => ({ sellingPoints: [{ ...raw.sellingPoints[0], factIds, detail }] });
assert.throws(() => parseOrganizedSellingPoints(response(['F1', 'F2'], '储物款小Q簧芯径43mm、3.8圈。'), points), /遗漏/);
assert.throws(() => parseOrganizedSellingPoints(response(['F1', 'F1', 'F3']), points), /重复/);
assert.throws(() => parseOrganizedSellingPoints(response(['F1', 'F2', 'F4']), points), /未知/);
assert.throws(() => parseOrganizedSellingPoints(response(['F1', 'F2', 'F3'], '承重999kg'), points), /支撑事实之外/);
const organizer = createSellingPointOrganizer(async (input) => {
  const request = JSON.parse(input.userPrompt);
  assert.equal(request.facts.length, 3);
  assert.ok(!input.userPrompt.includes('999kg'));
  return raw;
});
assert.deepEqual(await organizer.organize(points), organized);
let attempts = 0;
await createSellingPointOrganizer(async (request) => {
  attempts += 1;
  if (attempts === 1) return response(['F1', 'F2'], '储物款小Q簧芯径43mm、3.8圈。');
  assert.ok(request.userPrompt.includes('遗漏了已核验事实：F3'));
  assert.ok(request.userPrompt.includes('"factIds":["F1","F2"]'), '修正携带上一份结果，避免重新采样时遗漏别的事实');
  return raw;
}).organize(points);
assert.equal(attempts, 2);
const controller = new AbortController();
await assert.rejects(createSellingPointOrganizer(async () => { controller.abort(); return raw; }).organize(points, controller.signal), /取消/);

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES (\'p\');');
for (const migration of SCRIPT_STUDIO_MIGRATIONS) db.exec(migration.sql);
db.prepare(`INSERT INTO script_studio_source_sets(id,projectId,contentFingerprint,imageAssetIdsJson,createdAt) VALUES ('src','p','fp','["a","b"]','now')`).run();
const base = createLibraryRevision(db, { projectId: 'p', sourceSetId: 'src', sourceFingerprint: 'fp', sellingPoints: points });
const next = await reorganizeLibrary(db, 'p', base.id, organizer, { providerId: 'fake', model: 'fake' });
assert.equal(next.revisionNumber, 2);
assert.equal(next.sellingPoints[0].detailStatus, 'verified');
assert.equal(next.promptContractVersion, 6);
assert.equal(getLibraryRevision(db, 'p', base.id)!.sellingPoints.length, 5, '历史库不可变');
assert.equal(getCurrentLibraryRevision(db, 'p')!.id, next.id);
await assert.rejects(reorganizeLibrary(db, 'p', base.id, organizer, { providerId: 'fake', model: 'fake' }), /已更新/);
const before = getCurrentLibraryRevision(db, 'p')!.id;
await assert.rejects(reorganizeLibrary(db, 'p', before, { async organize() { throw new Error('上游失败'); } }, { providerId: 'fake', model: 'fake' }), /上游失败/);
assert.equal(getCurrentLibraryRevision(db, 'p')!.id, before, '失败不得覆盖当前库');
db.close();
console.log('script-studio-selling-point-organizer.test.ts: ok');

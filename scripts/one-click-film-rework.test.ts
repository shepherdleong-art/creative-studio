// 一键成片 09–12：候选计划范围、等长采用、撤销/恢复与高清来源去重。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ocf-rework-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = dataRoot;
process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'local';

const { ensureOneClickFilmSchemaReady } = await import('../lib/one-click-film/schema.ts');
const { getOrCreateRun } = await import('../lib/one-click-film/store.ts');
const { upsertReviewFromDetection, approveReview } = await import('../lib/one-click-film/review.ts');
const {
  adoptCandidate, createCandidate, listCandidates, listVersions, revertAdoption,
  setCandidateResult, setCandidateTrim,
} = await import('../lib/one-click-film/rework.ts');
const { planHdSources } = await import('../lib/one-click-film/hd.ts');

const dbPath = path.join(dataRoot, 'workbench.db');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    providerId TEXT NOT NULL DEFAULT 'p', model TEXT NOT NULL DEFAULT 'm', prompt TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE video_jobs (
    id TEXT PRIMARY KEY, projectId TEXT, status TEXT, providerTaskId TEXT, localVideoPath TEXT
  );
  INSERT INTO projects (id, name) VALUES ('proj-1', '云朵床项目');
`);
await ensureOneClickFilmSchemaReady({ db, backupRoot: path.join(dataRoot, 'data', 'backups', 'schema-upgrades') });

const run = getOrCreateRun(db, 'proj-1');
const now = new Date().toISOString();
// 两个条目 + 两条已下载原片。
db.prepare(`INSERT INTO one_click_film_entries
  (id, runId, projectId, ordinal, code, structure, structureSource, soundMode, status, outline, narration,
   promptText, promptBaselineJson, promptDurationSec, promptAspectRatio, analysisId, productNameSnapshot,
   createdAt, updatedAt)
  VALUES ('e1', ?, 'proj-1', 1, 'F01', 'scene', 'auto', 'native', 'confirmed', '', '', '', '[]', 15, '3:4', 'a1', '云朵床', ?, ?),
         ('e2', ?, 'proj-1', 2, 'F02', 'problem', 'auto', 'native', 'confirmed', '', '', '', '[]', 15, '3:4', 'a1', '云朵床', ?, ?)
`).run(run.id, now, now, run.id, now, now);
db.prepare(`INSERT INTO video_jobs (id, projectId, status, providerTaskId, localVideoPath) VALUES
  ('v1', 'proj-1', 'succeeded', 'task-A', '/storage/videos/a.mp4'),
  ('v2', 'proj-1', 'succeeded', 'task-B', '/storage/videos/b.mp4')`).run();
db.prepare(`INSERT INTO one_click_film_video_jobs
  (id, runId, projectId, entryId, entryCode, requestKey, shotSetId, shotId, videoJobId, status, providerId,
   model, aspectRatio, durationSec, createdAt, updatedAt)
  VALUES ('j1', ?, 'proj-1', 'e1', 'F01', 'k1', 'ss1', 'sh1', 'v1', 'succeeded', 'pv', 'seedance', '3:4', 15, ?, ?),
         ('j2', ?, 'proj-1', 'e2', 'F02', 'k2', 'ss2', 'sh2', 'v2', 'succeeded', 'pv', 'seedance', '3:4', 15, ?, ?)
`).run(run.id, now, now, run.id, now, now);

for (const [jobId, entryId, code] of [['j1', 'e1', 'F01'], ['j2', 'e2', 'F02']] as const) {
  upsertReviewFromDetection(db, {
    run, jobId, entryId, entryCode: code,
    durationUs: 15_000_000, fps: 24, cutsUs: [6_000_000, 9_000_000], detection: 'cuts',
  });
  approveReview(db, { run, jobId });
}

// ── 候选计划：选区 3 秒，通道最少 4 秒时要生成 4 秒并如实展示 ──
const candidate = createCandidate(db, {
  run, entryId: 'e2', entryCode: 'F02', reviewJobId: 'j2', shotId: 's2',
  replaceStartUs: 6_000_000, replaceEndUs: 9_000_000,
  minimumGenerationUs: 4_000_000,
  prompt: '替换 6–9 秒，保留产品外观',
  references: [{ id: 'ref-1', kind: 'image', purpose: 'appearance', label: '产品图' }],
  providerId: 'pv', model: 'seedance',
});
assert.equal(candidate.replaceStartUs, 6_000_000);
assert.equal(candidate.replaceEndUs, 9_000_000);
assert.equal(candidate.requestedRangeUs, 4_000_000, '生成范围按通道最小时长扩展');
assert.equal(candidate.references[0]!.purpose, 'appearance');

// 候选还没完成时不能采用。
assert.throws(() => adoptCandidate(db, { run, candidateId: candidate.id }), /还没生成完成/);

setCandidateResult(db, {
  run, candidateId: candidate.id, status: 'ready',
  localVideoPath: '/storage/one-click-film/candidates/c1.mp4', durationUs: 5_000_000,
});
// 候选长 5 秒，可移动截取起点，但不能越过可用范围。
setCandidateTrim(db, { run, candidateId: candidate.id, trimStartUs: 1_000_000 });
assert.throws(() => setCandidateTrim(db, { run, candidateId: candidate.id, trimStartUs: 3_000_000 }), /超出可用范围/);

adoptCandidate(db, { run, candidateId: candidate.id });
let candidates = listCandidates(db, run);
assert.equal(candidates.find((item) => item.id === candidate.id)!.adopted, true);
assert.equal(candidates.find((item) => item.id === candidate.id)!.trimStartUs, 1_000_000);

// 撤销后版本可追溯，恢复后再采用同一候选。
revertAdoption(db, { run, entryId: 'e2', entryCode: 'F02', shotId: 's2' });
candidates = listCandidates(db, run);
assert.equal(candidates.find((item) => item.id === candidate.id)!.adopted, false);
const versions = listVersions(db, run, 'e2');
assert.deepEqual(versions.map((version) => version.source), ['candidate', 'restore']);
assert.equal(versions[0]!.adopted.length, 1, '采用版本记录了当时的剪辑');

adoptCandidate(db, { run, candidateId: candidate.id });
assert.equal(listVersions(db, run, 'e2').length, 3);

// ── 高清来源：同一来源只列一次，未采用候选不提交 ──
const unused = createCandidate(db, {
  run, entryId: 'e2', entryCode: 'F02', reviewJobId: 'j2', shotId: 's1',
  replaceStartUs: 0, replaceEndUs: 6_000_000, prompt: '未采用的候选',
  references: [], providerId: 'pv', model: 'seedance',
});
setCandidateResult(db, { run, candidateId: unused.id, status: 'ready', localVideoPath: '/tmp/u.mp4', durationUs: 6_000_000 });

const plan = planHdSources(db, run);
const ids = plan.sources.map((source) => source.sourceVideoJobId);
assert.ok(ids.includes('v1'), 'F01 原片来源进入清单');
assert.ok(ids.includes('v2'), 'F02 原片来源进入清单');
assert.ok(ids.includes(candidate.id), '已采用的补片来源进入清单');
assert.ok(!ids.includes(unused.id), '未采用的候选不得提交');
assert.equal(new Set(ids).size, ids.length, '同一来源只列一次');
assert.equal(plan.conversions, 3);
assert.ok(plan.totalEstimatedCostMicros > 0);
assert.deepEqual(plan.blocked, []);

// 样片缺少供应商标识时定位到具体条目。
db.prepare(`UPDATE video_jobs SET providerTaskId = NULL WHERE id = 'v1'`).run();
const blockedPlan = planHdSources(db, run);
assert.equal(blockedPlan.blocked[0]!.entryCode, 'F01');
assert.match(blockedPlan.blocked[0]!.reason, /供应商标识/);

db.close();
fs.rmSync(dataRoot, { recursive: true, force: true });
console.log('one-click-film rework tests passed');

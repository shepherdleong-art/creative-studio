// 一键成片 13–15：包装资格、24fps/20 帧偏移、导出幂等与 ZIP 清单。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ocf-delivery-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = dataRoot;
process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'local';

const { ensureOneClickFilmSchemaReady } = await import('../lib/one-click-film/schema.ts');
const { getOrCreateRun } = await import('../lib/one-click-film/store.ts');
const { upsertReviewFromDetection, approveReview } = await import('../lib/one-click-film/review.ts');
const {
  buildDecorationCues, buildSubtitleCues, filmTimeForBodyTime, packagingEligibility, parsePackagingOptions,
  preparePackaging, updatePackagingDraft, listPackaging,
} = await import('../lib/one-click-film/packaging.ts');
const { packagingOverlayConfig, splitFilmCoverTitle, stickersForFilmPoints } = await import('../lib/one-click-film/packaging-edit.ts');
const { exportEligibility, exportEntries, exportZipEntries, listExports } = await import('../lib/one-click-film/exports.ts');
const { readFilmBody } = await import('../lib/one-click-film/composition.ts');

// ── 时间基准：正文 0 秒 → 加封面后成片第 20 帧 ──
assert.deepEqual(filmTimeForBodyTime(0, true), { sec: 0.833, frame: 20 });
assert.deepEqual(filmTimeForBodyTime(15, true), { sec: 15.833, frame: 380 });
assert.deepEqual(filmTimeForBodyTime(15, false), { sec: 15, frame: 360 });

// ── 字幕：不配音跳过；TTS 按实测音频时长对时 ──
const nativeCues = buildSubtitleCues({ narration: '第一句。第二句。', soundMode: 'native', durationSec: 15 });
assert.equal(nativeCues.length, 2);
assert.equal(nativeCues[0]!.startSec, 0);
assert.equal(nativeCues[1]!.endSec, 15);
assert.deepEqual(buildSubtitleCues({ narration: '第一句。', soundMode: 'none', durationSec: 15 }), []);
const ttsCues = buildSubtitleCues({ narration: '第一句。第二句。', soundMode: 'tts', durationSec: 15, audioDurationUs: 10_000_000 });
assert.equal(ttsCues[1]!.endSec, 10, 'TTS 字幕按音频实际时长对时');

const cover = splitFilmCoverTitle('林氏钢琴键系列沙发：高靠背分区承托，坐躺都自在');
assert.deepEqual(cover, { title: '林氏钢琴键系列沙发', subtitle: '高靠背分区承托，坐躺都自在' });
const points = buildDecorationCues({ durationSec: 15, narration: '试试分段靠背，坐躺都自在。',
  points: ['宽厚扶手、分段靠背和多块独立填充组成了整个横向结构，视觉上沉稳利落'],
  words: [{ text: '分段靠背', startUs: 3_000_000, endUs: 3_600_000 }] });
assert.equal(points[0]?.text, '分段靠背');
assert.equal(points[0]?.startSec, 3);
assert.ok(points.every(cue => Array.from(cue.text).length <= 14));
const assetStickers = stickersForFilmPoints(points, 360);
assert.equal(assetStickers[0]?.startFrame, 92);
for (const hasCover of [true, false]) {
  const config = packagingOverlayConfig({ template: 'overlay-minimal', title: cover.title, options: parsePackagingOptions({
    cover: hasCover, coverText: { subtitle: cover.subtitle }, assetStickers,
  }), pointCues: points });
  assert.equal(config.varsOverrides?.subtitle, cover.subtitle);
  assert.equal(config.stickers?.[0]?.startFrame, hasCover ? 92 : 72);
  assert.equal(config.stickers?.[0]?.startFrame, Math.round(config.pointCues![0]!.startSec * 24));
}

const dbPath = path.join(dataRoot, 'workbench.db');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    providerId TEXT NOT NULL DEFAULT 'p', model TEXT NOT NULL DEFAULT 'm', prompt TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE video_jobs (
    id TEXT PRIMARY KEY, projectId TEXT, status TEXT, providerTaskId TEXT, localVideoPath TEXT, filmGenerationStage TEXT
  );
  INSERT INTO projects (id, name) VALUES ('proj-1', '云朵床项目');
`);
await ensureOneClickFilmSchemaReady({ db, backupRoot: path.join(dataRoot, 'data', 'backups', 'schema-upgrades') });
const run = getOrCreateRun(db, 'proj-1');
const now = new Date().toISOString();
db.prepare(`INSERT INTO one_click_film_entries
  (id, runId, projectId, ordinal, code, structure, structureSource, soundMode, status, outline, narration,
   promptText, promptBaselineJson, promptDurationSec, promptAspectRatio, analysisId, productNameSnapshot,
   createdAt, updatedAt)
  VALUES ('e1', ?, 'proj-1', 1, 'F01', 'scene', 'auto', 'native', 'confirmed', '', '第一句。第二句。', '', '[]', 15, '3:4', 'a1', '云朵床', ?, ?),
         ('e2', ?, 'proj-1', 2, 'F02', 'problem', 'auto', 'none', 'confirmed', '', '', '', '[]', 15, '3:4', 'a1', '云朵床', ?, ?)
`).run(run.id, now, now, run.id, now, now);
db.prepare(`INSERT INTO video_jobs (id, projectId, status, providerTaskId, localVideoPath) VALUES
  ('v1', 'proj-1', 'succeeded', 'task-A', '/storage/videos/a.mp4'),
  ('v2', 'proj-1', 'succeeded', 'task-B', '/storage/videos/b.mp4')`).run();
db.prepare(`INSERT INTO one_click_film_video_jobs
  (id, runId, projectId, entryId, entryCode, requestKey, shotSetId, shotId, videoJobId, status, providerId,
   model, generationMode, aspectRatio, durationSec, createdAt, updatedAt)
  VALUES ('j1', ?, 'proj-1', 'e1', 'F01', 'k1', 'ss1', 'sh1', 'v1', 'succeeded', 'pv', 'seedance', 'direct', '3:4', 15, ?, ?),
         ('j2', ?, 'proj-1', 'e2', 'F02', 'k2', 'ss2', 'sh2', 'v2', 'succeeded', 'pv', 'seedance', 'direct', '3:4', 15, ?, ?)
`).run(run.id, now, now, run.id, now, now);
// 此处只测登记与版本，实际渲染和真实媒体在员工贯通验收验证。
const videoDir = path.join(dataRoot, 'storage', 'videos');
fs.mkdirSync(videoDir, { recursive: true });
fs.writeFileSync(path.join(videoDir, 'a.mp4'), Buffer.from('fake-video-a'));
fs.writeFileSync(path.join(videoDir, 'b.mp4'), Buffer.from('fake-video-b'));
function settleFixtureRender() {
  const body = readFilmBody(db, run, 'F01')!;
  db.prepare("UPDATE one_click_film_packaging SET status='ready', relativePath='videos/a.mp4', sourceSignature=? WHERE entryId='e1'")
    .run(body.signature);
}

// ── 包装资格：未审片不能包装 ──
assert.deepEqual(packagingEligibility(db, run, 'F01'), { ready: false, reason: '还没有生成原片' });
upsertReviewFromDetection(db, {
  run, jobId: 'j1', entryId: 'e1', entryCode: 'F01',
  durationUs: 15_000_000, fps: 24, cutsUs: [], detection: 'single',
});
assert.equal(packagingEligibility(db, run, 'F01').reason, '待审片');
approveReview(db, { run, jobId: 'j1' });
assert.equal(packagingEligibility(db, run, 'F01').ready, true);

const prepared = preparePackaging(db, {
  run,
  options: { template: 'overlay-minimal', cover: true, subtitles: true, decoration: true, bgm: true, titleMode: 'shared', title: '把松弛感带回家' },
});
assert.deepEqual(prepared.map((item) => [item.entryCode, item.ok]), [['F01', true], ['F02', false]]);
const records = listPackaging(db, run);
assert.equal(records[0]!.title, '把松弛感带回家');
assert.equal(records[0]!.subtitleCues.length, 2);
assert.equal(records[0]!.ready, false, '保存配置就绪不代表渲染完成');

// 只移动花字起点：修订递增，正文时间不变。
const moved = updatePackagingDraft(db, {
  run, entryCode: 'F01',
  pointCues: [{ id: 'dec-0', text: '松弛', startSec: 4, endSec: 8 }],
});
assert.equal(moved[0]!.revision, 2);
assert.equal(moved[0]!.pointCues[0]!.startSec, 4);
assert.equal(filmTimeForBodyTime(moved[0]!.pointCues[0]!.startSec, true).frame, 116, '正文 4 秒对应成片第 116 帧');
assert.equal(moved[0]!.ready, false);
settleFixtureRender();

// ── 导出资格与幂等 ──
const eligibility = exportEligibility(db, run);
assert.deepEqual(eligibility.map((item) => [item.entryCode, item.eligible]), [['F01', true], ['F02', false]]);
assert.match(eligibility[1]!.reason, /还没有包装|还没有生成原片|待审片/);

const first = exportEntries(db, { run, all: true });
assert.deepEqual(first.exported.map((item) => item.entryCode), ['F01']);
assert.equal(first.exported[0]!.versions.packagingRevision, 2);
assert.equal(first.exported[0]!.versions.soundMode, 'native');
const firstChecksum = first.exported[0]!.checksum;

const repeat = exportEntries(db, { run, codes: ['F01'] });
assert.deepEqual(repeat.reused, ['F01'], '重复提交找回同一记录');
assert.equal(repeat.exported[0]!.id, first.exported[0]!.id);
assert.equal(repeat.exported[0]!.checksum, firstChecksum);

// 改标题重新包装 → 新记录，旧记录仍可取回。
updatePackagingDraft(db, { run, entryCode: 'F01', title: '新的标题' });
settleFixtureRender();
const second = exportEntries(db, { run, codes: ['F01'] });
assert.notEqual(second.exported[0]!.id, first.exported[0]!.id, '重新导出形成独立记录');
const all = listExports(db, run);
assert.equal(all.length, 2);
assert.ok(all.some((record) => record.checksum === firstChecksum), '旧交付文件摘要不变');

// ── ZIP 清单只来自登记记录 ──
const zipEntries = exportZipEntries(db, { run, ids: all.map((record) => record.id) });
assert.equal(zipEntries.length, 2);
assert.ok(zipEntries.every((entry) => fs.existsSync(entry.filePath)));
assert.equal(new Set(zipEntries.map((entry) => entry.filename)).size, 2, 'ZIP 内文件名可区分');

db.close();
fs.rmSync(dataRoot, { recursive: true, force: true });
console.log('one-click-film delivery tests passed');

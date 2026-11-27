// 一键成片 13–15：包装资格、24fps/20 帧偏移、导出幂等与 ZIP 清单。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ocf-delivery-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = dataRoot;
process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'local';

const { ensureOneClickFilmSchemaReady, ONE_CLICK_FILM_MIGRATIONS } = await import('../lib/one-click-film/schema.ts');
const { getOrCreateRun } = await import('../lib/one-click-film/store.ts');
const { upsertReviewFromDetection, approveReview } = await import('../lib/one-click-film/review.ts');
const {
  buildDecorationCues, buildSubtitleCues, filmTimeForBodyTime, packagingEligibility, parsePackagingOptions,
  preparePackaging, updatePackagingDraft, listPackaging,
} = await import('../lib/one-click-film/packaging.ts');
const { filmCaptionSvg, resolveFilmSubtitleStyle, splitSubtitleCues, packagingOverlayConfig, splitFilmCoverTitle, stickersForFilmPoints } = await import('../lib/one-click-film/packaging-edit.ts');
const { exportEligibility, exportEntries, exportZipEntries, listExports } = await import('../lib/one-click-film/exports.ts');
const { readFilmBody } = await import('../lib/one-click-film/composition.ts');
const { composeCoverJpg } = await import('../lib/media-core/cover-compose.ts');
const { writeFilmCover } = await import('../lib/one-click-film/cover-render.ts');
const { listFilmCoverCandidates } = await import('../lib/one-click-film/cover-assets.ts');
const { coverFramingGeometry, panCoverFraming } = await import('../lib/media-core/cover-framing.ts');

// ── 时间基准：正文 0 秒 → 加封面后成片第 20 帧 ──
assert.deepEqual(filmTimeForBodyTime(0, true), { sec: 0.833, frame: 20 });
assert.deepEqual(filmTimeForBodyTime(15, true), { sec: 15.833, frame: 380 });
assert.deepEqual(filmTimeForBodyTime(15, false), { sec: 15, frame: 360 });

assert.equal(parsePackagingOptions({ cover: true }).coverMedia, undefined, '旧草稿保留默认首帧来源');
assert.deepEqual(parsePackagingOptions({ cover: false, coverMedia: {
  kind: 'video_frame', frame: 97, shotId: 'shot-02', framing: { scale: 7, offsetX: -2, offsetY: 0.2 },
} }).coverMedia, { kind: 'video_frame', frame: 97, shotId: 'shot-02', framing: { scale: 3, offsetX: -1, offsetY: 0.2 } });
for (const coverMedia of [
  { kind: 'auto_frame', sourceSignature: 'body-v2', frame: 72, shotId: 'shot-02' },
  { kind: 'project_image', assetId: 'project-image-1' },
  { kind: 'generated_image', assetId: 'generated-image-1' },
]) assert.deepEqual(parsePackagingOptions({ coverMedia }).coverMedia, coverMedia);
assert.equal(parsePackagingOptions({ coverMedia: { kind: 'video_frame', frame: 10.5 } }).coverMedia, undefined);

// ── 字幕：不配音跳过；TTS 按实测音频时长对时 ──
const nativeCues = buildSubtitleCues({ narration: '第一句。第二句。', soundMode: 'native', durationSec: 15 });
assert.deepEqual(nativeCues.map(cue => cue.text), ['第一句', '第二句']);
const savedCue = { id: 'edited', text: '靠久了脖子累。', startSec: 1.25, endSec: 2.5 };
assert.deepEqual(splitSubtitleCues([savedCue]), [{ ...savedCue, text: '靠久了脖子累' }]);
assert.deepEqual(splitSubtitleCues([{ ...savedCue, text: '，。' }]), []);
const style = resolveFilmSubtitleStyle();
assert.equal(filmCaptionSvg(style, '厚3.5cm，够软。', 720, 960), filmCaptionSvg(style, '厚3.5cm 够软', 720, 960));
assert.deepEqual(splitSubtitleCues([{ ...savedCue, text: '厚3.5cm,' }]), [{ ...savedCue, text: '厚3.5cm' }]);
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
  CREATE TABLE image_assets (
    id TEXT PRIMARY KEY, projectId TEXT, role TEXT, usage TEXT, path TEXT, originalPath TEXT
  );
  INSERT INTO projects (id, name) VALUES ('proj-1', '云朵床项目'), ('proj-2', '另一个项目');
`);
db.exec(`CREATE TABLE one_click_film_schema_migrations (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL)`);
for (const migration of ONE_CLICK_FILM_MIGRATIONS.filter(({ version }) => version <= 13)) {
  db.exec(migration.sql);
  db.prepare(`INSERT INTO one_click_film_schema_migrations VALUES (?, '2026-11-25T00:00:00.000Z')`).run(migration.version);
}
const upgradedSchema = await ensureOneClickFilmSchemaReady({ db, backupRoot: path.join(dataRoot, 'data', 'backups', 'schema-upgrades') });
assert.equal(upgradedSchema.state, 'ready');
assert.ok(upgradedSchema.backupDirectory, '新增封面资产表前保留经过验证的备份');
assert.ok(upgradedSchema.appliedVersions.includes(15));
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
assert.equal(first.exported[0]!.versions.coverMedia?.kind, 'auto_frame');
assert.equal(first.exported[0]!.versions.coverMedia?.kind === 'auto_frame' && first.exported[0]!.versions.coverMedia.frame, 0);
const firstChecksum = first.exported[0]!.checksum;

const repeat = exportEntries(db, { run, codes: ['F01'] });
assert.deepEqual(repeat.reused, ['F01'], '重复提交找回同一记录');
assert.equal(repeat.exported[0]!.id, first.exported[0]!.id);
assert.equal(repeat.exported[0]!.checksum, firstChecksum);

// 选帧、关闭后重新打开、拒绝旧修订，重新导出时旧交付保持原封面。
const chosen = { kind: 'video_frame', frame: 210, shotId: 'shot-03' } as const;
const disabled = updatePackagingDraft(db, { run, entryCode: 'F01', expectedRevision: 2, options: { cover: false, coverMedia: chosen } })[0]!;
assert.equal(disabled.revision, 3);
assert.equal(disabled.options.cover, false);
assert.deepEqual(disabled.options.coverMedia, chosen);
assert.throws(() => updatePackagingDraft(db, { run, entryCode: 'F01', expectedRevision: 2, options: { coverMedia: null } }), { status: 409 });
const restored = updatePackagingDraft(db, { run, entryCode: 'F01', expectedRevision: 3, options: { cover: true } })[0]!;
assert.equal(restored.options.cover, true);
assert.deepEqual(restored.options.coverMedia, chosen);
assert.throws(() => updatePackagingDraft(db, { run, entryCode: 'F01', expectedRevision: 4,
  options: { coverMedia: { kind: 'video_frame', frame: '210' } },
}), { status: 400 });
settleFixtureRender();
const second = exportEntries(db, { run, codes: ['F01'] });
assert.notEqual(second.exported[0]!.id, first.exported[0]!.id, '重新导出形成独立记录');
assert.deepEqual(second.exported[0]!.versions.coverMedia, chosen);
const all = listExports(db, run);
assert.equal(all.length, 2);
assert.ok(all.some((record) => record.checksum === firstChecksum), '旧交付文件摘要不变');
assert.deepEqual(all.find((record) => record.id === first.exported[0]!.id)?.versions, first.exported[0]!.versions);
const clamped = updatePackagingDraft(db, { run, entryCode: 'F01', expectedRevision: 4,
  options: { coverMedia: { kind: 'video_frame', frame: 1500 } },
})[0]!;
assert.deepEqual(clamped.options.coverMedia, { kind: 'video_frame', frame: 359 });

// 素材与脚本中的托管图可用于封面，其他项目或缺失文件不会泄露路径。
const imageDir = path.join(dataRoot, 'storage', 'originals');
fs.mkdirSync(imageDir);
const detailFile = path.join(imageDir, 'detail.jpg');
await sharp({ create: { width: 4, height: 3, channels: 3, background: 'red' } }).jpeg().toFile(detailFile);
const insertImage = db.prepare('INSERT INTO image_assets VALUES (?, ?, ?, ?, ?, ?)');
insertImage.run('detail', 'proj-1', 'input', 'detail_page', detailFile, detailFile);
insertImage.run('other-project', 'proj-2', 'input', 'detail_page', detailFile, detailFile);
insertImage.run('different-usage', 'proj-1', 'input', 'other', detailFile, detailFile);
insertImage.run('missing-file', 'proj-1', 'input', 'scene_seed', path.join(imageDir, 'missing.jpg'), null);
const selectedImage = updatePackagingDraft(db, { run, entryCode: 'F01', expectedRevision: 5,
  options: { coverMedia: { kind: 'project_image', assetId: 'detail', framing: { scale: 5, offsetX: -8, offsetY: 6 } } },
})[0]!;
assert.deepEqual(selectedImage.options.coverMedia, { kind: 'project_image', assetId: 'detail', framing: { scale: 3, offsetX: -1, offsetY: 1 } });
db.exec('SAVEPOINT missing_cover');
try {
  db.prepare("DELETE FROM image_assets WHERE id='detail'").run();
  const disabledMissing = updatePackagingDraft(db, { run, entryCode: 'F01', expectedRevision: 6,
    title: '关闭缺图的片头', options: { cover: false, coverMedia: selectedImage.options.coverMedia } })[0]!;
  assert.deepEqual(disabledMissing.options.coverMedia, selectedImage.options.coverMedia);
  assert.equal(disabledMissing.options.cover, false);
  assert.throws(() => updatePackagingDraft(db, { run, entryCode: 'F01', expectedRevision: 7, options: { cover: true } }),
    { status: 400, message: '当前封面图片不可用' });
  assert.throws(() => updatePackagingDraft(db, { run, entryCode: 'F01', expectedRevision: 7,
    options: { cover: false, coverMedia: { kind: 'project_image', assetId: 'other-project' } } }), { status: 400 });
} finally { db.exec('ROLLBACK TO missing_cover; RELEASE missing_cover'); }
for (const assetId of ['other-project', 'different-usage', 'missing-file', '../detail.jpg']) {
  assert.throws(() => updatePackagingDraft(db, { run, entryCode: 'F01', expectedRevision: 6,
    options: { coverMedia: { kind: 'project_image', assetId } },
  }), { status: 400, message: '当前封面图片不可用' });
}
assert.equal(listPackaging(db, run)[0]!.revision, 6, '拒绝非法封面引用时保留已保存修订');

const generatedPath = path.join(imageDir, 'generated.png');
await sharp({ create: { width: 12, height: 16, channels: 3, background: 'blue' } }).png().toFile(generatedPath);
const insertCoverAsset = db.prepare(`INSERT INTO one_click_film_cover_assets
  (id, runId, projectId, entryId, entryCode, status, requestKey, requestHash, providerId, model, referenceImagesJson,
   prompt, requestedSize, providerFingerprint, relativePath, width, height, createdAt, updatedAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'provider', 'model', '[]', '全景封面', '768x1024', 'fingerprint', ?, 12, 16, ?, ?)`);
insertCoverAsset.run('generated-a', run.id, 'proj-1', 'e1', 'F01', 'ready', 'key-a', 'hash-a', 'originals/generated.png', now, now);
insertCoverAsset.run('generated-b', run.id, 'proj-1', 'e2', 'F02', 'ready', 'key-b', 'hash-b', 'originals/generated.png', now, now);
insertCoverAsset.run('pending-a', run.id, 'proj-1', 'e1', 'F01', 'queued', 'key-c', 'hash-c', null, now, now);
const otherRun = getOrCreateRun(db, 'proj-2');
db.prepare(`INSERT INTO one_click_film_entries
  (id, runId, projectId, ordinal, code, structure, structureSource, soundMode, status, promptAspectRatio,
    analysisId, productNameSnapshot, createdAt, updatedAt)
  VALUES ('e3', ?, 'proj-2', 1, 'F01', 'scene', 'auto', 'none', 'confirmed', '3:4', 'a2', '书桌', ?, ?)`)
  .run(otherRun.id, now, now);
insertCoverAsset.run('generated-other-project', otherRun.id, 'proj-2', 'e3', 'F01', 'ready', 'key-d', 'hash-d', 'originals/generated.png', now, now);
const reopened = new Database(dbPath, { readonly: true });
assert.deepEqual(listFilmCoverCandidates(reopened, run, 'e1').map(candidate => [candidate.id, candidate.status, Boolean(candidate.imageUrl)]),
  [['generated-a', 'ready', true], ['pending-a', 'queued', false]]);
reopened.close();
for (const assetId of ['generated-b', 'pending-a', 'generated-other-project']) {
  assert.throws(() => updatePackagingDraft(db, { run, entryCode: 'F01', expectedRevision: 6,
    options: { coverMedia: { kind: 'generated_image', assetId } },
  }), { status: 400, message: '当前封面图片不可用' });
}
const generatedSelection = { kind: 'generated_image', assetId: 'generated-a', framing: { scale: 1.5, offsetX: 0, offsetY: 0.5 } };
const generated = updatePackagingDraft(db, { run, entryCode: 'F01', expectedRevision: 6,
  options: { coverMedia: generatedSelection },
})[0]!;
assert.deepEqual(generated.options.coverMedia, generatedSelection);
settleFixtureRender();
const generatedExport = exportEntries(db, { run, codes: ['F01'] }).exported[0]!;
assert.equal(generatedExport.versions.packagingRevision, 7);
assert.deepEqual(generatedExport.versions.coverMedia, generatedSelection);
assert.deepEqual(listExports(db, run).find(record => record.id === second.exported[0]!.id)?.versions, second.exported[0]!.versions);

// EXIF 右转后，原图右侧的蓝色块位于底部；取景移到最下应仅保留蓝色。
const orientedFile = path.join(imageDir, 'oriented.jpg');
await sharp(Buffer.from(`<svg width="120" height="40"><path fill="red" d="M0 0h40v40H0z"/>
  <path fill="green" d="M40 0h40v40H40z"/><path fill="blue" d="M80 0h40v40H80z"/></svg>`))
  .withMetadata({ orientation: 6 }).jpeg().toFile(orientedFile);
const cropFile = path.join(imageDir, 'cover-crop.jpg');
await composeCoverJpg({ coverSourcePath: orientedFile, jpgPath: cropFile, output: { width: 36, height: 36 },
  framing: { scale: 1, offsetX: 0, offsetY: 1 } });
const crop = await sharp(cropFile).raw().toBuffer({ resolveWithObject: true });
assert.equal(crop.info.width, 36);
assert.equal(crop.info.height, 36);
assert.ok(crop.data.every((pixel, index) => index % 3 === 2 ? pixel > 220 : pixel < 30), 'EXIF 方向矫正发生在取景之前');
await assert.rejects(writeFilmCover({ bodyPath: path.join(videoDir, 'a.mp4'),
  cover: { kind: 'project_image', assetId: 'detail' }, jpgPath: cropFile,
}), { status: 400, message: '当前封面图片不可用' });

const squareCover = { sourceWidth: 200, sourceHeight: 100, outputWidth: 100, outputHeight: 100,
  framing: { scale: 1, offsetX: 0, offsetY: 0 } };
const panned = panCoverFraming(squareCover, { x: 25, y: 80 });
assert.deepEqual(panned, { scale: 1, offsetX: -0.5, offsetY: 0 });
assert.equal(coverFramingGeometry({ ...squareCover, framing: panned }).left, 25);
const edge = panCoverFraming(squareCover, { x: 800, y: 80 });
assert.deepEqual(coverFramingGeometry({ ...squareCover, framing: edge }), { resizedWidth: 200, resizedHeight: 100, left: 0, top: 0 });

// ── ZIP 清单只来自登记记录 ──
const zipEntries = exportZipEntries(db, { run, ids: listExports(db, run).map((record) => record.id) });
assert.equal(zipEntries.length, 3);
assert.ok(zipEntries.every((entry) => fs.existsSync(entry.filePath)));
assert.equal(new Set(zipEntries.map((entry) => entry.filename)).size, 3, 'ZIP 内文件名可区分');

db.close();
fs.rmSync(dataRoot, { recursive: true, force: true });
console.log('one-click-film delivery tests passed');

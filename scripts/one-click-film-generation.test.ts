// 一键成片 05–08：生成闸门、TTS 版本绑定、切点审片与合并规则。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ocf-generation-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = dataRoot;
process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'local';

const { ensureOneClickFilmSchemaReady } = await import('../lib/one-click-film/schema.ts');
const {
  applyScriptPlan, confirmAnalysis, confirmEntry, createAnalysisVersion, getOrCreateRun,
  listEntries, listSellingPoints, markAnalysisSucceeded, updateEntryDraft,
} = await import('../lib/one-click-film/store.ts');
const { assertEntriesReadyForGeneration, assertEntriesReadyWithNarration } = await import('../lib/one-click-film/generation.ts');
const { narrationGate, narrationSignature, confirmNarration } = await import('../lib/one-click-film/tts.ts');
const { splitShot, mergeShots, undoMerge, undoableMergeId, approveReview,
  upsertReviewFromDetection, listReviews, markShotReview } = await import('../lib/one-click-film/review.ts');
const { validateGenerationSettings } = await import('../lib/one-click-film/video-models.ts');

const dbPath = path.join(dataRoot, 'workbench.db');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    providerId TEXT NOT NULL DEFAULT 'p', model TEXT NOT NULL DEFAULT 'm', prompt TEXT NOT NULL DEFAULT '',
    storeCode TEXT NOT NULL DEFAULT '', productCode TEXT NOT NULL DEFAULT '',
    productSubmodel TEXT NOT NULL DEFAULT '', productionType TEXT NOT NULL DEFAULT '',
    editorName TEXT NOT NULL DEFAULT ''
  );
  INSERT INTO projects (id, name) VALUES ('proj-1', '20261120-X店-XQ9A-AI种草-紫菜卷');
`);
await ensureOneClickFilmSchemaReady({ db, backupRoot: path.join(dataRoot, 'data', 'backups', 'schema-upgrades') });

const run = getOrCreateRun(db, 'proj-1');
const analysis = createAnalysisVersion(db, { run, sourceImageIds: ['img-1'], status: 'running' });
markAnalysisSucceeded(db, {
  analysisId: analysis.id, productName: '云朵床', appearance: '卧室', sceneClues: '卧室',
  providerId: 'vision', model: 'vision-model', raw: {},
  points: [{
    text: '卧室放松体验', originalText: '卧室放松体验', sourceImageId: 'img-1', sourceLabel: '场景图',
    evidenceRefs: [{ imageId: 'img-1', label: '场景图' }], kind: 'usage', selected: true,
  }],
});
confirmAnalysis(db, { analysisId: analysis.id, productName: '云朵床', points: listSellingPoints(db, analysis.id) });
const applied = applyScriptPlan(db, {
  run,
  analysis: { ...analysis, confirmedProductName: '云朵床', confirmedAt: new Date().toISOString() },
  points: listSellingPoints(db, analysis.id),
  plan: { count: 2, plan: { mode: 'auto' }, soundMode: 'native' },
});

// ── 生成闸门：待确认条目被逐条指出 ──
assert.throws(
  () => assertEntriesReadyForGeneration(applied.entries),
  /F01、F02/,
  '待确认条目必须被指出',
);
confirmEntry(db, { run, code: 'F01' });
assert.throws(() => assertEntriesReadyForGeneration(applied.entries), /F02/);
confirmEntry(db, { run, code: 'F02' });
assert.doesNotThrow(() => assertEntriesReadyForGeneration(listEntries(db, run.id)), '两条都确认后闸门放行');

// ── TTS 版本绑定 ──
const ttsEntry = db.prepare(`SELECT * FROM one_click_film_entries WHERE runId = ? AND code = 'F01'`).get(run.id) as {
  id: string; narration: string;
};
db.prepare(`UPDATE one_click_film_entries SET soundMode = 'tts', ttsProviderId = 'doubao-seed-tts-2',
  ttsVoice = 'zh_female_vv_uranus_bigtts', ttsSpeed = 1 WHERE id = ?`).run(ttsEntry.id);
const entries = db.prepare(`SELECT * FROM one_click_film_entries WHERE runId = ? ORDER BY ordinal`).all(run.id) as Array<{
  id: string; code: string; narration: string; soundMode: string; ttsProviderId: string; ttsVoice: string;
  ttsSpeed: number; promptDurationSec: number;
}>;
const signature = narrationSignature({
  text: entries[0]!.narration, providerId: entries[0]!.ttsProviderId,
  voice: entries[0]!.ttsVoice, speed: entries[0]!.ttsSpeed,
});
const now = new Date().toISOString();
db.prepare(`
  INSERT INTO one_click_film_narrations
    (id, runId, projectId, entryId, entryCode, signature, providerId, voice, speed, text, relativePath,
     durationUs, status, createdAt, updatedAt)
  VALUES ('nar-1', ?, 'proj-1', ?, 'F01', ?, 'doubao-seed-tts-2', 'zh_female_vv_uranus_bigtts', 1, ?, 'narration/f01.mp3', 14500000, 'ready', ?, ?)
`).run(run.id, entries[0]!.id, signature, entries[0]!.narration, now, now);

const gateEntries = entries.map((entry) => ({
  ...entry,
  soundMode: entry.soundMode as 'native' | 'tts' | 'none',
  structure: 'scene' as const,
  structureSource: 'auto' as const,
  status: 'confirmed' as const,
  title: '', outline: '', promptText: '', promptBaseline: [], promptAspectRatio: '3:4',
  scriptRevision: 0, scriptConfirmedAt: now, analysisId: analysis.id,
  productNameSnapshot: '云朵床', sellingPointsSnapshot: ['卧室放松体验'],
  runId: run.id, projectId: 'proj-1', ordinal: 1, createdAt: now, updatedAt: now,
  promptDurationSec: entry.promptDurationSec,
}));
assert.match(narrationGate(db, gateEntries)[0] ?? '', /需要重新生成并确认配音/);
assert.throws(
  () => assertEntriesReadyWithNarration(db, gateEntries),
  /需要重新生成并确认配音/,
  'TTS 条目缺确认配音时整批提交必须被拦',
);

assert.throws(() => confirmNarration(db, { run, narrationId: 'nar-1', listened: true }), /请先试听/);
db.prepare("UPDATE one_click_film_narrations SET listenedAt=? WHERE id='nar-1'").run(now);
confirmNarration(db, { run, narrationId: 'nar-1', listened: false });
assert.deepEqual(narrationGate(db, gateEntries), [], '试听确认后配音闸门放行');

// An active owner retains its running narration. An interrupted row is retried using the same id.
const { synthesizeNarrations } = await import('../lib/one-click-film/tts.ts');
const { tryFilmRequestLock } = await import('../lib/one-click-film/request-lock.ts');
db.exec(`CREATE TABLE final_edit_tts_providers(id TEXT, name TEXT, type TEXT, baseUrl TEXT,
  apiKey TEXT, keyEnv TEXT, model TEXT, enabled INTEGER)`);
db.prepare("UPDATE one_click_film_narrations SET status='running', confirmedAt=NULL WHERE id='nar-1'").run();
const held = await tryFilmRequestLock('narration', [ttsEntry.id, signature]);
assert.ok(held);
try {
  await synthesizeNarrations({ db, run, codes: ['F01'] });
  assert.equal(db.prepare('SELECT status FROM one_click_film_narrations').pluck().get(), 'running');
} finally { held.release(); }
await synthesizeNarrations({ db, run, codes: ['F01'] });
const recovered = db.prepare('SELECT id,status,errorMessage FROM one_click_film_narrations').get() as Record<string,string>;
assert.equal(recovered.id, 'nar-1');
assert.equal(recovered.status, 'failed');
assert.match(recovered.errorMessage, /供应商未启用/);

const { filmAccountRef } = await import('../lib/one-click-film/film-account.ts');
const proxy = { id: 'company', baseUrl: 'http://127.0.0.1:4000', apiKey: 'local-proxy',
  baseUrlEnv: 'COMPANY_VIDEO_BASE_URL', apiKeyEnv: '', type: 'openai-video' };
const config = (account: string) => fs.writeFileSync(path.join(dataRoot, 'config.yaml'), JSON.stringify({
  model_list: [{ model_name: 'film', litellm_params: { model: 'remote-film', api_base: 'https://fixture.invalid', api_key: account } }],
}));
config('fixture-account-one');
const firstAccount = filmAccountRef(proxy, 'film');
assert.ok(firstAccount);
config('fixture-account-two');
assert.notEqual(filmAccountRef(proxy, 'film'), firstAccount);
assert.equal(filmAccountRef(proxy, 'absent'), null);
const { videoJobFileUrl } = await import('../lib/one-click-film/generation.ts');
assert.equal(videoJobFileUrl('/storage/videos/original.mp4'), '/api/videos/videos/original.mp4?preview=1');
assert.equal(videoJobFileUrl('/storage/one-click-film/previews/body.mp4'), '/api/videos/one-click-film/previews/body.mp4');

// 口播变化后旧配音不再属于新版本。
updateEntryDraft(db, { run, code: 'F01', narration: '改过的一句口播。' });
const refreshedEntries = listEntries(db, run.id);
assert.match(narrationGate(db, refreshedEntries)[0] ?? '', /需要重新生成并确认配音/);

// ── 生成参数校验 ──
const option = {
  key: 'seedance-2.5' as const,
  label: 'Seedance 2.5',
  providerId: 'p', providerName: 'P', providerType: 'openai-video', model: 'doubao-seedance-2-5',
  durations: [4, 5, 6, 15, 30], durationLabel: '4–30 秒',
  aspectRatios: ['3:4', '9:16', '16:9'], resolutions: ['720p'],
  modes: ['draft', 'direct'] as Array<'draft' | 'direct'>, hasApiKey: true,
};
assert.equal(validateGenerationSettings({ option, durationSec: 15, aspectRatio: '3:4', mode: 'draft' }).ok, true);
assert.match(validateGenerationSettings({ option, durationSec: 31, aspectRatio: '3:4', mode: 'draft' }).message, /4–30 秒/);
assert.match(validateGenerationSettings({ option, durationSec: 15, aspectRatio: '21:9', mode: 'draft' }).message, /不支持 21:9/);
assert.match(
  validateGenerationSettings({ option: { ...option, modes: ['direct'] }, durationSec: 15, aspectRatio: '3:4', mode: 'draft' }).message,
  /只能直接生成/,
);

// ── 切点审片 ──
upsertReviewFromDetection(db, {
  run, jobId: 'job-1', entryId: entries[0]!.id, entryCode: 'F01',
  durationUs: 15_000_000, fps: 24, cutsUs: [6_000_000, 9_000_000], detection: 'cuts',
});
const firstReview = listReviews(db, run)[0]!;
assert.equal(firstReview.shots.length, 3, '6 秒、9 秒两个切点应形成 3 个镜头');
assert.deepEqual(firstReview.shots.map((shot) => [shot.startUs, shot.endUs]), [
  [0, 6_000_000], [6_000_000, 9_000_000], [9_000_000, 15_000_000],
]);

const split = splitShot(db, { run, jobId: 'job-1', shotId: 's2', atUs: 7_500_000 });
assert.equal(split.length, 4, '切分后多一个镜头');
assert.deepEqual(split.map((shot) => [shot.startUs, shot.endUs]), [
  [0, 6_000_000], [6_000_000, 7_500_000], [7_500_000, 9_000_000], [9_000_000, 15_000_000],
]);
assert.throws(() => splitShot(db, { run, jobId: 'job-1', shotId: 's2', atUs: 6_050_000 }), /至少保留 0.1 秒/);

const merged = mergeShots(db, { run, jobId: 'job-1', shotIds: ['s2', 's3'] });
assert.deepEqual(merged.map((shot) => [shot.startUs, shot.endUs]), [
  [0, 6_000_000], [6_000_000, 9_000_000], [9_000_000, 15_000_000],
]);
assert.throws(() => mergeShots(db, { run, jobId: 'job-1', shotIds: ['s1', 's3'] }), /只能合并相邻镜头/);

markShotReview(db, { run, jobId: 'job-1', shotId: 's1', mark: 'ok' });
const mergeId = undoableMergeId(db, listReviews(db, run)[0]!);
assert.ok(mergeId);
const restored = undoMerge(db, { run, jobId: 'job-1', mergeId });
assert.deepEqual(restored, split.map((shot) => shot.id === 's1' ? { ...shot, reviewMark: 'ok' } : shot));
assert.equal(undoableMergeId(db, listReviews(db, run)[0]!), null);
assert.throws(() => undoMerge(db, { run, jobId: 'job-1', mergeId }), /无法撤回/);
approveReview(db, { run, jobId: 'job-1' });
assert.equal(listReviews(db, run)[0]!.approved, true);

// 识别失败仍保留整条原片。
upsertReviewFromDetection(db, {
  run, jobId: 'job-2', entryId: entries[1]!.id, entryCode: 'F02',
  durationUs: 12_000_000, fps: 24, cutsUs: [], detection: 'failed', detectionError: 'scene detect timeout',
});
const failed = listReviews(db, run).find((review) => review.jobId === 'job-2')!;
assert.equal(failed.detection, 'failed');
assert.deepEqual(failed.shots.map((shot) => [shot.startUs, shot.endUs]), [[0, 12_000_000]]);

// Legacy reviews used the container duration: 25 pictures with audio through frame 26.
const { runFfmpeg, probeVideoMedia } = await import('../lib/ffmpeg.ts');
const { bodyFrame, playableFilmBody, renderFilmBody } = await import('../lib/one-click-film/composition.ts');
const { countFilmFrames } = await import('../lib/one-click-film/frames.ts');
const original = path.join(dataRoot, 'audio-tail.mp4');
await runFfmpeg(['-f', 'lavfi', '-i', 'color=s=64x64:r=24:d=1.04', '-f', 'lavfi', '-i', 'anullsrc=r=48000:d=1.072',
  '-c:v', 'libx264', '-c:a', 'aac', original]);
const reviewDurationUs = (await probeVideoMedia(original)).durationUs;
const frames = bodyFrame(reviewDurationUs);
assert.equal(frames, 26);
const tail = { id: 'take', videoJobId: 'take', file: original, start: 20, end: frames, trim: 0, whole: false };
const saved = { entryCode: 'F01', entryId: 'entry', jobId: 'job', originalVideoJobId: 'original',
  originalPath: original, reviewDurationUs, frames, snapshot: {}, draft: true, approved: true, hdApproved: false,
  signature: 'reviewed-edit', edits: [tail] };
const playable = await playableFilmBody(saved);
assert.equal(playable.frames, 25);
assert.equal(playable.edits[0]!.end, 25);
assert.equal(playable.signature, saved.signature);
assert.equal(saved.edits[0]!.end, 26);
const preview = path.join(dataRoot, 'preview.mp4');
await renderFilmBody(saved, preview);
assert.equal(await countFilmFrames(preview), 25);
assert.ok((await probeVideoMedia(preview)).hasAudio);
await assert.rejects(renderFilmBody({ ...saved, edits: [{ ...tail, trim: 24 }] }, preview), /校验失败/);

db.close();
fs.rmSync(dataRoot, { recursive: true, force: true });
console.log('one-click-film generation tests passed');

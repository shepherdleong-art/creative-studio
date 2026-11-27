// 一键成片 01–04：数量/结构契约、卖点来源校验、条目身份与单条重做隔离。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ocf-domain-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = dataRoot;
process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'local';
register('./typescript-extension-loader.mjs', import.meta.url);

const { ONE_CLICK_FILM_MIGRATIONS, ensureOneClickFilmSchemaReady } = await import('../lib/one-click-film/schema.ts');
const {
  parseEntryCount, parseStructurePlan, structureAt, entryCode, parseSoundMode,
  parseModelPreset, parseModelSelection, inferModelFromContext, resolveModelSelection, formatModelLabel,
} = await import('../lib/one-click-film/contract.ts');
const { buildPrompt, retimePromptText, replaceVoiceSection, replaceModelLine } = await import('../lib/one-click-film/prompt.ts');
const { validateConfirmation } = await import('../lib/one-click-film/selling-points.ts');
const {
  applyScriptPlan, confirmAnalysis, confirmEntry, createAnalysisVersion, getEntry,
  getOrCreateRun, listEntries, listScriptRevisions, listSellingPoints, markAnalysisSucceeded, redraftEntry,
  replaceSellingPoints, restoreRetiredScripts, updateEntryDraft,
} = await import('../lib/one-click-film/store.ts');

// ── 契约边界 ──
assert.equal(parseEntryCount(1), 1);
assert.equal(parseEntryCount(12), 12);
for (const bad of [0, 13, 1.5, 'x', null]) {
  assert.throws(() => parseEntryCount(bad), /1-12/, `数量 ${String(bad)} 必须被拒绝`);
}
assert.equal(parseSoundMode('tts'), 'tts');
assert.throws(() => parseSoundMode('voice'), /配音方式/);
assert.equal(entryCode(1), 'F01');
assert.equal(entryCode(12), 'F12');

const auto = parseStructurePlan({ mode: 'auto' });
assert.deepEqual([0, 1, 2, 3].map((index) => structureAt(auto, index)), ['scene', 'result', 'problem', 'scene']);
const batch = parseStructurePlan({ mode: 'batch', structure: 'problem' });
assert.deepEqual([0, 1].map((index) => structureAt(batch, index)), ['problem', 'problem']);
const individual = parseStructurePlan({ mode: 'individual', choices: ['scene', 'auto', 'problem'] });
assert.deepEqual([0, 1, 2].map((index) => structureAt(individual, index)), ['scene', 'result', 'problem']);

// ── 出镜人物契约与自动识别 ──
assert.equal(parseModelPreset(undefined), 'auto');
assert.equal(parseModelPreset('child'), 'child');
assert.throws(() => parseModelPreset('alien'), /出镜人物/);
assert.throws(() => parseModelSelection('custom', '   '), /出镜人物描述/);
assert.deepEqual(parseModelSelection('custom', ' 5岁小女孩，穿米色家居服 '), {
  preset: 'custom',
  custom: '5岁小女孩，穿米色家居服',
});
assert.equal(inferModelFromContext({ product: '米氏家居儿童小沙发' }), 'child');
assert.equal(inferModelFromContext({ product: '小沙发', points: ['适合亲子阅读陪读'] }), 'parent_child');
assert.equal(inferModelFromContext({ suggestedModel: 'adult_male', product: '儿童沙发' }), 'adult_male');
assert.deepEqual(
  resolveModelSelection({ preset: 'auto' }, { product: '儿童小沙发' }),
  { preset: 'child', custom: '' },
);
assert.deepEqual(
  resolveModelSelection({ preset: 'adult_female' }, { suggestedModel: 'child', product: '儿童小沙发' }),
  { preset: 'adult_female', custom: '' },
);
assert.equal(formatModelLabel({ preset: 'auto' }, 'child'), '自动匹配（儿童）');
assert.equal(formatModelLabel({ preset: 'custom', custom: '4岁小男孩' }), '4岁小男孩');

// ── 卖点来源校验 ──
assert.throws(
  () => validateConfirmation({ productName: '云朵床', points: [{ text: '面料亲肤', selected: true, sourceImageId: null, evidenceRefs: [] }] }),
  /缺少来源/,
  '勾选但无来源的卖点必须拒绝',
);
assert.throws(
  () => validateConfirmation({ productName: '  ', points: [] }),
  /产品名称/,
);
const confirmedContent = validateConfirmation({
  productName: '云朵床',
  points: [
    { text: '卧室放松体验', selected: true, sourceImageId: 'img-1', evidenceRefs: [] },
    { text: '面料触感', selected: false, sourceImageId: 'img-1', evidenceRefs: [] },
  ],
});
assert.deepEqual(confirmedContent, { productName: '云朵床', points: ['卧室放松体验'] });

// ── 提示词：时间码覆盖正文、声音段可独立替换 ──
const promptText = buildPrompt({
  subject: { product: '云朵床', appearance: '卧室，软包靠背', points: ['卧室放松体验'], genre: '淘系种草' },
  structure: 'scene', sound: 'native', title: '下班后，用上云朵床的那一刻',
  angle: '日常场景 → 使用体验', story: '人物走近床边坐下。',
  narration: '我给自己留了几分钟。我用上云朵床，试了试。', durationSec: 15, aspectRatio: '3:4',
});
assert.match(promptText, /【15 秒 · 淘系种草 · 3:4 画幅】/);
assert.match(promptText, /【分镜 · 6 镜】/);
assert.match(promptText, /镜1｜0\.0–/);
assert.match(promptText, /【配音安排】/);
assert.doesNotMatch(promptText, /15\.0–15\.0s/);

const retimed = retimePromptText(promptText, 15, 12);
assert.match(retimed, /【12 秒 ·/);
assert.match(retimed, /镜1｜0\.0–/);
const silent = replaceVoiceSection(retimed, { sound: 'none', narration: '', durationSec: 12 });
assert.match(silent, /【声音要求】/);
assert.doesNotMatch(silent, /【配音安排】/);
assert.match(silent, /【分镜 · 6 镜】/, '换声音方式不得重写分镜');

const childPrompt = buildPrompt({
  subject: {
    product: '儿童小沙发',
    appearance: '客厅儿童角，米白色皮面',
    points: ['皮面耐折约五万次'],
    genre: '淘系种草',
    model: { preset: 'child', custom: '' },
  },
  structure: 'scene', sound: 'native', title: '家里总怕沙发掉皮',
  angle: '日常场景 → 使用体验', story: '小朋友坐上小沙发翻看绘本。',
  narration: '给娃买的小沙发，皮面很耐折。', durationSec: 15, aspectRatio: '3:4',
});
assert.match(childPrompt, /人物：同一位约 4–7 岁儿童（小朋友）/);
assert.match(childPrompt, /小朋友走进客厅儿童角/);

const productOnlyPrompt = buildPrompt({
  subject: {
    product: '米白色小沙发',
    appearance: '客厅一角',
    points: ['皮面细腻'],
    genre: '淘系种草',
    model: { preset: 'none', custom: '' },
  },
  structure: 'scene', sound: 'native', title: '质感细节',
  angle: '纯产品展示', story: '环绕展示皮面纹理。',
  narration: '看这个皮面纹理很细腻。', durationSec: 15, aspectRatio: '3:4',
});
assert.match(productOnlyPrompt, /人物：无出镜人物/);
assert.doesNotMatch(productOnlyPrompt, /人物走进/);

const replacedCustomPrompt = replaceModelLine(childPrompt, { preset: 'custom', custom: '5岁穿米色家居服的小女孩' });
assert.match(replacedCustomPrompt, /人物：5岁穿米色家居服的小女孩/);

// ── 数据库与条目身份 ──
// 共享升级 gate 会为迁移创建已验证备份，内存库无法备份，因此用临时文件库。
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
const backupRoot = path.join(dataRoot, 'data', 'backups', 'schema-upgrades');
db.exec('CREATE TABLE one_click_film_schema_migrations (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL)');
for (const migration of ONE_CLICK_FILM_MIGRATIONS.filter(item => item.version <= 15)) {
  db.exec(migration.sql);
  db.prepare("INSERT INTO one_click_film_schema_migrations VALUES (?, datetime('now'))").run(migration.version);
}

const run = getOrCreateRun(db, 'proj-1');
assert.equal(getOrCreateRun(db, 'proj-1').id, run.id, '同一项目复用同一个 run');

const analysis = createAnalysisVersion(db, {
  run, sourceImageIds: ['img-1', 'img-2'], status: 'running',
});
markAnalysisSucceeded(db, {
  analysisId: analysis.id,
  productName: '云朵床',
  appearance: '卧室，软包靠背，正面与斜侧面',
  sceneClues: '卧室',
  providerId: 'vision',
  model: 'vision-model',
  raw: {},
  points: [
    {
      text: '卧室放松体验', originalText: '卧室放松体验', sourceImageId: 'img-1', sourceLabel: '场景图',
      evidenceRefs: [{ imageId: 'img-1', label: '场景图' }], kind: 'usage', selected: true,
    },
    {
      text: '面料触感细节', originalText: '面料触感细节', sourceImageId: 'img-2', sourceLabel: '详情页',
      evidenceRefs: [{ imageId: 'img-2', label: '详情页', locator: 'tile_1' }], kind: 'claim', selected: true,
    },
  ],
});
confirmAnalysis(db, { analysisId: analysis.id, productName: '云朵床', points: listSellingPoints(db, analysis.id) });

const applied = applyScriptPlan(db, {
  run,
  analysis: { ...analysis, confirmedProductName: '云朵床', confirmedAt: new Date().toISOString() },
  points: listSellingPoints(db, analysis.id),
  plan: { count: 2, plan: { mode: 'individual', choices: ['scene', 'problem'] }, soundMode: 'native' },
});
assert.deepEqual(applied.added, ['F01', 'F02']);
assert.deepEqual(applied.entries.map((entry) => entry.code), ['F01', 'F02']);
assert.deepEqual(applied.entries.map((entry) => entry.structure), ['scene', 'problem']);
assert.ok(applied.entries.every((entry) => entry.sellingPointsSnapshot.length === 2));

const legacyCover = db.prepare(`INSERT INTO one_click_film_cover_assets
  (id,runId,projectId,entryId,entryCode,status,requestKey,requestHash,providerId,model,referenceImagesJson,
    prompt,requestedSize,providerFingerprint,remoteId,errorCode,operationId,createdAt,updatedAt)
  VALUES (?,?,'proj-1',?,'F01','failed',?,'hash','p','m','[]','','1024x1024','fp',?,?,?,datetime('now'),datetime('now'))`);
for (const [id, remoteId, reason, operationId] of [
  ['timed-out', 'opaque/id', 'poll_timeout', null],
  ['rejected', null, 'policy', null],
  ['unconfirmed-team', null, 'submission_unknown', 'team-operation'],
  ['unconfirmed-local', null, 'submission_unknown', null],
]) {
  legacyCover.run(id, run.id, applied.entries[0].id, id, remoteId, reason, operationId);
}
const legacyPackaging = db.prepare(`INSERT INTO one_click_film_packaging
  (id,runId,entryId,entryCode,status,optionsJson,relativePath,createdAt,updatedAt)
  VALUES (?,?,?,?,'ready',?,'old.mp4',datetime('now'),datetime('now'))`);
for (const entry of applied.entries) {
  const options = entry.code === 'F01' ? { cover: true } : { cover: false, decoration: false };
  legacyPackaging.run(entry.code, run.id, entry.id, entry.code, JSON.stringify(options));
}
const first = await ensureOneClickFilmSchemaReady({ db, backupRoot });
assert.equal(first.state, 'ready');
const migratedPackaging = db.prepare('SELECT status,revision FROM one_click_film_packaging WHERE entryCode=?');
assert.deepEqual(migratedPackaging.get('F01'), { status: 'pending', revision: 2 });
assert.deepEqual(migratedPackaging.get('F02'), { status: 'ready', revision: 1 });
const migratedCover = db.prepare('SELECT status, remoteId, nextAttemptAt FROM one_click_film_cover_assets WHERE id=?');
assert.deepEqual(migratedCover.get('rejected'), { status: 'failed', remoteId: null, nextAttemptAt: null });
const timedOut = migratedCover.get('timed-out') as { status: string; remoteId: string; nextAttemptAt: string };
assert.equal(timedOut.status, 'running');
assert.equal(timedOut.remoteId, 'opaque/id');
assert.ok(Date.parse(timedOut.nextAttemptAt) <= Date.now());
const unconfirmed = migratedCover.get('unconfirmed-team') as { status: string; nextAttemptAt: string };
assert.equal(unconfirmed.status, 'running');
assert.ok(Date.parse(unconfirmed.nextAttemptAt) <= Date.now());
assert.deepEqual(migratedCover.get('unconfirmed-local'), { status: 'failed', remoteId: null, nextAttemptAt: null });
const second = await ensureOneClickFilmSchemaReady({ db, backupRoot });
assert.equal(second.state, 'current', '重复执行迁移必须幂等');

// 手改并确认 F01，只重做 F02。
const f01Before = getEntry(db, run.id, 'F01');
const f01HandEdited = updateEntryDraft(db, {
  run, code: 'F01',
  outline: '手改大纲：下班回家先坐一会儿',
  narration: '手改口播：我把手机放到一边，在床边坐了一会儿。',
});
const f01Confirmed = confirmEntry(db, { run, code: 'F01' });
assert.equal(f01Confirmed.status, 'confirmed');
assert.ok(f01Confirmed.scriptConfirmedAt, '确认时写入确认记录');
const f01Revisions = db.prepare(`SELECT COUNT(*) AS n FROM one_click_film_script_revisions WHERE entryId = ?`)
  .get(f01Before.id) as { n: number };
assert.ok(f01Revisions.n >= 1, '确认时写入脚本修订历史');

const f02Before = getEntry(db, run.id, 'F02');
const f02Edited = updateEntryDraft(db, { run, code: 'F02', outline: '未确认的手改大纲' });
const f02Redrafted = redraftEntry(db, { run, code: 'F02' });
const history = listScriptRevisions(db, run.id, 'F02');
assert.deepEqual(history.map(record => record.outline), [f02Redrafted.outline, f02Edited.outline, f02Before.outline]);
assert.deepEqual(listScriptRevisions(db, 'another-run', 'F02'), []);
assert.equal(f02Redrafted.status, 'pending', '重做后回到待确认');
assert.equal(f02Redrafted.structure, 'problem', '重做沿用原结构');
assert.deepEqual(f02Redrafted.sellingPointsSnapshot, f02Before.sellingPointsSnapshot, '重做沿用已选卖点');
assert.notEqual(f02Redrafted.narration, f02Before.narration, '重做产生可区分的新稿');
assert.equal(f02Redrafted.scriptRevision, f02Before.scriptRevision + 1);

const f01After = getEntry(db, run.id, 'F01');
assert.equal(f01After.id, f01Before.id, 'F01 条目标识不变');
assert.equal(f01After.outline, f01HandEdited.outline, 'F01 手改全文逐字保留');
assert.equal(f01After.scriptConfirmedAt, f01Confirmed.scriptConfirmedAt, 'F01 确认记录不变');

// 减少数量只删尾部，F01 身份与内容保留。
const reduced = applyScriptPlan(db, {
  run,
  analysis: { ...analysis, confirmedProductName: '云朵床', confirmedAt: new Date().toISOString() },
  points: listSellingPoints(db, analysis.id),
  plan: { count: 1, plan: { mode: 'auto' }, soundMode: 'native' },
});
assert.deepEqual(reduced.removed, ['F02']);
assert.deepEqual(listEntries(db, run.id, 'retired').map(entry => entry.id), [f02Before.id]);
assert.equal(listEntries(db, run.id, 'all')[1]?.promptText, f02Redrafted.promptText);
const { generatePlanCopies } = await import('../lib/one-click-film/script-generation.ts');
const reusable = await generatePlanCopies(db, {
  run, analysis: { ...analysis, confirmedProductName: '云朵床' }, points: listSellingPoints(db, analysis.id),
  plan: { count: 2, plan: { mode: 'individual', choices: ['auto', 'problem'] }, soundMode: 'native' },
});
assert.equal(reusable.size, 0, '按原结构加回条目不重新调用模型');
assert.deepEqual(reduced.kept, ['F01']);
assert.equal(getEntry(db, run.id, 'F01').id, f01Before.id);
assert.equal(getEntry(db, run.id, 'F01').outline, f01HandEdited.outline);

// Restore the original per-entry structure even when the active batch now uses auto.
const originalBatch = restoreRetiredScripts(db, run, 'F02');
assert.deepEqual(originalBatch[1], f02Redrafted);
assert.equal(originalBatch[0]!.scriptConfirmedAt, f01Confirmed.scriptConfirmedAt);
assert.deepEqual(restoreRetiredScripts(db, run, 'F02'), originalBatch);
applyScriptPlan(db, { run, analysis: { ...analysis, confirmedProductName: '云朵床' }, points: listSellingPoints(db, analysis.id),
  plan: { count: 1, plan: { mode: 'auto' }, soundMode: 'native' } });

// 再增回两条：新条目结构按自动搭配，F01 仍不动。
const restored = applyScriptPlan(db, {
  run,
  analysis: { ...analysis, confirmedProductName: '云朵床', confirmedAt: new Date().toISOString() },
  points: listSellingPoints(db, analysis.id),
  plan: { count: 2, plan: { mode: 'auto' }, soundMode: 'native' },
});
assert.deepEqual(restored.added, ['F02']);
assert.deepEqual(restored.kept, ['F01']);
assert.equal(restored.entries[1]!.structure, 'result');
assert.equal(restored.entries[1]!.id, f02Before.id);
assert.equal(restored.entries[1]!.scriptRevision, f02Redrafted.scriptRevision + 1);
assert.ok(listScriptRevisions(db, run.id, 'F02').some(record => record.promptText === f02Redrafted.promptText));

// 改整批结构：只重写结构变化的条目。F01 本来就是「场景体验」，整批也设为场景体验时保留。
const structureChange = applyScriptPlan(db, {
  run,
  analysis: { ...analysis, confirmedProductName: '云朵床', confirmedAt: new Date().toISOString() },
  points: listSellingPoints(db, analysis.id),
  plan: { count: 2, plan: { mode: 'batch', structure: 'scene' }, soundMode: 'native' },
});
assert.deepEqual(structureChange.kept, ['F01'], '结构未变的条目保留');
assert.deepEqual(structureChange.rewritten, ['F02'], '只重写结构变化的条目');
assert.equal(structureChange.entries[1]!.structure, 'scene');

// 换声音方式：只替换声音段，手改分镜与叙事保留。
const beforeSound = getEntry(db, run.id, 'F01');
applyScriptPlan(db, {
  run,
  analysis: { ...analysis, confirmedProductName: '云朵床', confirmedAt: new Date().toISOString() },
  points: listSellingPoints(db, analysis.id),
  plan: { count: 2, plan: { mode: 'batch', structure: 'scene' }, soundMode: 'none' },
});
const afterSound = getEntry(db, run.id, 'F01');
assert.equal(afterSound.soundMode, 'none');
assert.equal(afterSound.status, 'pending', '换声音后回到待确认');
assert.match(afterSound.promptText, /【声音要求】/);
assert.match(afterSound.promptText, /【分镜 · 6 镜】/);
assert.equal(afterSound.outline, beforeSound.outline, '换声音不得重写大纲');

// 卖点改写落库，确认时使用改写后的文字。
const points = listSellingPoints(db, analysis.id);
points[0] = { ...points[0]!, text: '卧室里的放松片刻', edited: true };
replaceSellingPoints(db, analysis.id, points);
assert.equal(listSellingPoints(db, analysis.id)[0]!.text, '卧室里的放松片刻');

// 出镜人物：整批设置、逐条覆盖与保留单条设置。
const batchChild = applyScriptPlan(db, {
  run,
  analysis: { ...analysis, confirmedProductName: '云朵床', confirmedAt: new Date().toISOString() },
  points: listSellingPoints(db, analysis.id),
  plan: { count: 2, plan: { mode: 'batch', structure: 'scene' }, soundMode: 'none', modelPreset: 'child' },
});
assert.deepEqual(batchChild.rewritten, ['F01', 'F02']);
assert.equal(batchChild.entries[0]!.modelPreset, 'child');
assert.match(batchChild.entries[0]!.promptText, /人物：同一位约 4–7 岁儿童（小朋友）/);

// 仅给 F02 单独换为自定义人物重做，F01 不受影响。
const f02Custom = redraftEntry(db, {
  run,
  code: 'F02',
  model: { preset: 'custom', custom: '年轻妈妈和4岁宝宝' },
});
assert.equal(f02Custom.modelPreset, 'custom');
assert.equal(f02Custom.modelCustom, '年轻妈妈和4岁宝宝');
assert.equal(f02Custom.modelSource, 'individual');
assert.match(f02Custom.promptText, /人物：年轻妈妈和4岁宝宝/);
assert.equal(getEntry(db, run.id, 'F01').modelPreset, 'child');

// 新增第 3 条并保持单条覆盖：F02 保持自定义，F01 保留儿童，F03 跟随整批儿童。
const expandedKeepIndividual = applyScriptPlan(db, {
  run,
  analysis: { ...analysis, confirmedProductName: '云朵床', confirmedAt: new Date().toISOString() },
  points: listSellingPoints(db, analysis.id),
  plan: {
    count: 3,
    plan: { mode: 'batch', structure: 'scene' },
    soundMode: 'none',
    modelPreset: 'child',
    preserveIndividualModel: true,
  },
});
assert.deepEqual(expandedKeepIndividual.kept, ['F01', 'F02']);
assert.deepEqual(expandedKeepIndividual.added, ['F03']);
assert.equal(getEntry(db, run.id, 'F02').modelPreset, 'custom');
assert.equal(getEntry(db, run.id, 'F03').modelPreset, 'child');

// 单条保存草稿切人物时，自动同步提示词中的「人物：」行。
const f03Saved = updateEntryDraft(db, {
  run,
  code: 'F03',
  modelPreset: 'none',
});
assert.equal(f03Saved.modelPreset, 'none');
assert.equal(f03Saved.modelSource, 'individual');
assert.match(f03Saved.promptText, /人物：无出镜人物/);

assert.equal(listEntries(db, run.id).length, 3);
const { checkOneClickFilmReadiness } = await import('../lib/one-click-film/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
db.exec('DROP TABLE one_click_film_cover_assets');
const missingCoverAssetTable = await checkOneClickFilmReadiness({ db, ...schemaUpgradeRuntimePaths(dataRoot) });
assert.equal(missingCoverAssetTable.available, false, '数据库缺少已迁移的封面资产表时，一键成片暂停受理');
if (!missingCoverAssetTable.available) assert.equal(missingCoverAssetTable.code, 'schema_history_invalid');
db.close();
fs.rmSync(dataRoot, { recursive: true, force: true });
console.log('one-click-film domain tests passed');

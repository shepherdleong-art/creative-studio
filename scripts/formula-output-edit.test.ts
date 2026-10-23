/** A12/A30：通过现有成片编辑/读取接口验证原声、画面、字幕与撤销的原子性。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-output-edit-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_FORMULA_MIXCUT = '1';
const { checkBatchProductionReadiness } = await import('../lib/batch-production/readiness.ts');
const { checkFormulaReadiness } = await import('../lib/batch-production/formula/readiness.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { createAsset, createAnalysisVersion } = await import('../lib/batch-production/assets.ts');
const { createBatchProduction, createBatchProductionVersion, addAssetToPool } = await import('../lib/batch-production/versions.ts');
const { createProjectScript, snapshotScriptIntoBatch } = await import('../lib/batch-production/scripts.ts');
const { createOutputPlansForSnapshot, createOutputVersion } = await import('../lib/batch-production/plans.ts');
const { applyBatchOutputClipEdit, getBatchOutputArrangementView } = await import('../lib/batch-production/output-arrangement.ts');
const { setBatchPlanReviews, readBatchPlanReview } = await import('../lib/batch-production/review.ts');
const { scheduleRenderAfterCoverChange } = await import('../lib/batch-production/phase-e.ts');
const db = new Database(path.join(root, 'test.db'));
try {
  db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY,name TEXT); INSERT INTO projects VALUES ('p','测试项目');");
  const readinessOptions = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(readinessOptions)).available, true);
  assert.equal((await checkFormulaReadiness(readinessOptions)).available, true);
  db.exec('CREATE TABLE final_edit_bgm_tracks (id TEXT PRIMARY KEY,relativePath TEXT,fileFingerprint TEXT,durationUs INTEGER,status TEXT)');
  const batchId = createBatchProduction(db, 'p', '声音编辑', undefined, { planningMode: 'formula' });
  const batchVersionId = createBatchProductionVersion(db, batchId, { copyCount: 1 });
  const fingerprint = `sha256:${'a'.repeat(64)}`;
  const assetId = createAsset(db, { projectId: 'p', sourceKind: 'managed', locationJson: { key: 'fixture' },
    contentFingerprint: fingerprint, mediaKind: 'video', mediaJson: { durationSec: 8 } });
  const analysisId = createAnalysisVersion(db, { assetId, analyzerVersion: 'fixture', providerId: 'fixture', model: 'fixture', analysisJson: { durationUs: 8_000_000 } });
  addAssetToPool(db, batchVersionId, { assetId, analysisId });
  const scriptId = createProjectScript(db, 'p', { sourceKind: 'script_draft', sourceId: 'script', title: '脚本', bodyText: '好擦洗。坐得稳。', sourceVersion: '1' });
  const snapshot = snapshotScriptIntoBatch(db, batchVersionId, { scriptId, copyCount: 1 });
  const [planId] = createOutputPlansForSnapshot(db, batchVersionId, snapshot);
  const sound = { id: 'source:slot-a', mediaId: 'source:slot-a', kind: 'source', linkedVideoClipId: 'slot-a',
    sourceInUs: 5_000_000, sourceOutUs: 7_000_000, timelineStartUs: 0, timelineEndUs: 2_000_000, gainDb: 0 };
  const voice = { id: 'tts:voice', mediaId: 'tts:voice', kind: 'narration',
    sourceInUs: 0, sourceOutUs: 1_000_000, timelineStartUs: 4_000_000, timelineEndUs: 5_000_000, gainDb: 0 };
  const arrangement = {
    preset: '3:4', fps: 24, productionReady: false,
    formula: { version: 1, selectionStageId: 'selection', timelineStageId: 'timeline',
      audioSources: [
        { mediaId: sound.mediaId, kind: 'source', slotId: 'slot-a', assetId, contentFingerprint: fingerprint, sourceDurationUs: 8_000_000,
          verifiedInUs: 5_000_000, verifiedOutUs: 7_000_000,
          words: [{ id: 'source-word', text: '好擦洗', sourceInUs: 5_250_000, sourceOutUs: 6_750_000 }] },
        { mediaId: voice.mediaId, kind: 'narration', contentFingerprint: `sha256:${'b'.repeat(64)}`, sourceDurationUs: 1_000_000,
          verifiedInUs: 0, verifiedOutUs: 1_000_000,
          words: [{ id: 'tts-word', text: '坐得稳', sourceInUs: 0, sourceOutUs: 1_000_000 }] },
      ] },
    clips: [
      { clipId: 'slot-a', segmentId: 'slot-a', assetId, contentFingerprint: fingerprint, sourceStartUs: 5_000_000, sourceEndUs: 7_000_000, timelineStartUs: 0, timelineEndUs: 2_000_000, locked: false, playbackRate: 1 },
      { clipId: 'slot-b', segmentId: 'slot-b', assetId, contentFingerprint: fingerprint, sourceStartUs: 0, sourceEndUs: 2_000_000, timelineStartUs: 4_000_000, timelineEndUs: 6_000_000, locked: false, playbackRate: 1 },
    ],
    audioPlan: { version: 1, revision: 0, bodyDurationUs: 6_000_000, clips: [sound, voice] },
    subtitle: { cues: [{ id: 'source-word', sourceSegmentId: sound.id, text: '好擦洗', startUs: 250_000, endUs: 1_750_000, timingSource: 'aligned' },
      { id: 'tts-word', sourceSegmentId: voice.id, text: '坐得稳', startUs: 4_000_000, endUs: 5_000_000, timingSource: 'aligned' }] },
  };
  createOutputVersion(db, planId, { arrangementJson: arrangement });
  db.prepare("UPDATE batch_production_versions SET inputState='frozen' WHERE id=?").run(batchVersionId);
  db.prepare("UPDATE batch_productions SET currentVersionId=?,status='running' WHERE id=?").run(batchVersionId, batchId);
  assert.equal(scheduleRenderAfterCoverChange(db, 'p', batchId, planId), null, '公式编辑草稿不能排入尚不支持该格式的封面渲染');
  const view = () => getBatchOutputArrangementView(db, 'p', batchId, planId);
  const edit = (command: Parameters<typeof applyBatchOutputClipEdit>[4]) => applyBatchOutputClipEdit(db, 'p', batchId, planId,
    { expectedEditRevision: view().editRevision, expectedOutputVersionId: view().outputVersionId!, ...command });
  const result = edit({ type: 'move_clip', clipId: 'slot-a', startUs: 2_000_000 });
  assert.equal(result.editRevision, 1);
  assert.deepEqual(view().audioPlan?.clips[0], { ...sound, timelineStartUs: 2_000_000, timelineEndUs: 4_000_000 });
  assert.deepEqual(view().subtitleCues.map(cue => [cue.text, cue.startUs, cue.endUs]), [['好擦洗', 2_250_000, 3_750_000], ['坐得稳', 4_000_000, 5_000_000]]);
  const split = edit({ type: 'split', clipId: 'slot-a', offsetUs: 1_000_000 });
  assert.equal(split.editRevision, 2, '联动关系也参与修订，旧窗口不能覆盖分割');
  assert.deepEqual(view().audioPlan?.clips.filter(clip => clip.kind === 'source').map(clip => [clip.sourceInUs, clip.sourceOutUs, clip.timelineStartUs, clip.timelineEndUs]),
    [[5_000_000, 6_000_000, 2_000_000, 3_000_000], [6_000_000, 7_000_000, 3_000_000, 4_000_000]]);
  assert.deepEqual(view().subtitleCues.map(cue => [cue.text, cue.startUs, cue.endUs]), [['好擦洗', 2_250_000, 3_750_000], ['坐得稳', 4_000_000, 5_000_000]], '连续分割不重复显示一句话');
  edit({ type: 'set_subtitle_cue_text', cueId: 'source-word', text: '好擦洗！' });
  assert.equal(view().subtitleCues[0].text, '好擦洗！', '人工修改字幕不会被原转写覆盖');
  const beforeMove = view();
  edit({ type: 'move_clip', clipId: 'slot-a', startUs: 0 });
  assert.deepEqual(view().subtitleCues.filter(cue => cue.text === '好擦洗！').map(cue => [cue.startUs, cue.endUs]),
    [[250_000, 1_000_000], [3_000_000, 3_750_000]], '手改文字随拆开的原声分别移动');
  assert.ok(view().audioPlan?.issues.some(issue => issue.code === 'speech_discontinuous'), '一句话被拆开须提示处理');
  edit({ type: 'restore_arrangement', expectedEditRevision: view().editRevision, snapshot: {
    ...beforeMove, musicTrackId: beforeMove.music.trackId, musicGainDb: beforeMove.music.gainDb,
    musicFadeInSec: beforeMove.music.fadeInSec, musicFadeOutSec: beforeMove.music.fadeOutSec, narrationGainDb: beforeMove.narration.gainDb,
  } });
  assert.deepEqual(view().subtitleCues.map(cue => [cue.text, cue.startUs, cue.endUs]),
    [['好擦洗！', 2_250_000, 3_750_000], ['坐得稳', 4_000_000, 5_000_000]], '撤销移动时原样恢复快照字幕');
  const beforeDelete = view();
  edit({ type: 'delete', clipId: 'slot-a' });
  assert.equal(view().audioPlan?.clips.some(clip => clip.linkedVideoClipId === 'slot-a'), false);
  assert.ok(view().audioPlan?.issues.some(issue => issue.code === 'speech_incomplete'));
  edit({ type: 'restore_arrangement', expectedEditRevision: view().editRevision, snapshot: {
    ...beforeDelete, musicTrackId: beforeDelete.music.trackId, musicGainDb: beforeDelete.music.gainDb,
    musicFadeInSec: beforeDelete.music.fadeInSec, musicFadeOutSec: beforeDelete.music.fadeOutSec, narrationGainDb: beforeDelete.narration.gainDb,
  } });
  assert.deepEqual(view().audioPlan?.clips, beforeDelete.audioPlan?.clips);
  assert.deepEqual(view().subtitleCues.map(cue => [cue.text, cue.startUs, cue.endUs]),
    beforeDelete.subtitleCues.map(cue => [cue.text, cue.startUs, cue.endUs]), '撤销恢复原手改字幕，不把旧字幕再按新位置移动一次');
  const currentView = view();
  assert.throws(() => applyBatchOutputClipEdit(db, 'p', batchId, planId, {
    type: 'move_clip', clipId: 'slot-a', startUs: 0, expectedEditRevision: 0, expectedOutputVersionId: currentView.outputVersionId!,
  }), /已被修改|修订/, '旧窗口不能覆盖已经保存的音画编辑');
  assert.deepEqual(view(), currentView, '拒绝时画面、声音、字幕和修订均不改变');
  edit({ type: 'move_audio_clip', track: 'narration', clipId: 'tts:voice', timelineStartUs: 5_000_000 });
  assert.equal(view().audioPlan?.clips.find(clip => clip.id === 'tts:voice')?.timelineStartUs, 5_000_000);
  assert.deepEqual(view().subtitleCues.filter(cue => cue.text === '坐得稳').map(cue => [cue.startUs, cue.endUs]), [[5_000_000, 6_000_000]]);
  assert.deepEqual(view().clips, currentView.clips, '独立配音移动不挪动画面');
  edit({ type: 'move_audio_clip', track: 'narration', clipId: 'tts:voice', timelineStartUs: 6_000_000 });
  assert.equal(view().audioPlan?.bodyDurationUs, 7_000_000, '正文终点取全部实际音画的结尾');
  edit({ type: 'trim_subtitle_cue', cueId: 'tts-word', startUs: 6_100_000, endUs: 6_900_000 });
  assert.equal(view().subtitleCues.find(cue => cue.id === 'tts-word')?.endUs, 6_900_000, '字幕校验也使用同一正文终点');
  createOutputVersion(db, planId, { arrangementJson: arrangement });
  const noChange = edit({ type: 'move_audio_clip', track: 'narration', clipId: 'tts:voice', timelineStartUs: 4_000_000 });
  assert.equal(noChange.changed, false, '重复提交同一配音位置不制造新修订');
  assert.equal(view().editRevision, 0);
  const intact = view();
  for (const command of [
    { type: 'move_audio_clip', track: 'narration', clipId: 'tts:voice', timelineStartUs: 1_000_000 },
    { type: 'move_audio_clip', track: 'narration', clipId: 'source:slot-a', timelineStartUs: 2_000_000 },
    { type: 'set_clip_playback_rate', clipId: 'slot-a', playbackRate: 2 },
  ] as const) {
    assert.throws(() => edit(command), /重叠|关联|变速/);
    assert.deepEqual(view(), intact, '非法编辑不能留下半份声画修改');
  }
  assert.throws(() => edit({ type: 'restore_arrangement', snapshot: { ...intact,
    audioPlan: { ...intact.audioPlan!, clips: intact.audioPlan!.clips.map(clip => clip.kind === 'narration' ? { ...clip, mediaId: 'other-output-voice' } : clip) },
  } }), /来源不一致/);
  assert.deepEqual(view(), intact, '撤销不能注入另一输出的声音');
  const trimmed = edit({ type: 'trim', clipId: 'slot-a', sourceStartUs: 5_500_000, sourceEndUs: 7_500_000 });
  assert.deepEqual(view().audioPlan?.clips[0], { ...sound, sourceInUs: 5_500_000, sourceOutUs: 7_500_000 });
  assert.deepEqual(view().subtitleCues[0] && [view().subtitleCues[0].startUs, view().subtitleCues[0].endUs], [0, 1_250_000]);
  assert.ok(view().audioPlan?.issues.some(issue => issue.code === 'speech_incomplete'));
  assert.ok(view().audioPlan?.issues.some(issue => issue.code === 'source_range_unverified'));
  assert.ok(trimmed.warnings.some(warning => warning.includes('截断')));

  createOutputVersion(db, planId, { arrangementJson: arrangement });
  edit({ type: 'trim_variable', clipId: 'slot-a', sourceStartUs: 5_250_000, sourceEndUs: 7_000_000 });
  assert.deepEqual(view().audioPlan?.clips[0], { ...sound, sourceInUs: 5_250_000, timelineStartUs: 250_000 });
  assert.equal(view().audioPlan?.issues.length, 0, '只裁掉句前空白不误报截断话语');
  const beforeVoiceSplit = view();
  edit({ type: 'split_audio_clip', track: 'narration', clipId: 'tts:voice', atUs: 4_500_000 });
  assert.deepEqual(view().audioPlan?.clips.filter(clip => clip.kind === 'narration').map(clip => [clip.mediaId, clip.sourceInUs, clip.sourceOutUs, clip.timelineStartUs, clip.timelineEndUs]),
    [['tts:voice', 0, 500_000, 4_000_000, 4_500_000], ['tts:voice', 500_000, 1_000_000, 4_500_000, 5_000_000]]);
  assert.deepEqual(view().subtitleCues.filter(cue => cue.text === '坐得稳').map(cue => [cue.startUs, cue.endUs]), [[4_000_000, 5_000_000]]);
  edit({ type: 'delete_audio_clip', track: 'narration', clipId: 'tts:voice' });
  assert.ok(view().audioPlan?.issues.some(issue => issue.mediaId === 'tts:voice' && issue.code === 'speech_incomplete'));
  assert.deepEqual(view().audioPlan?.clips.filter(clip => clip.kind === 'narration').map(clip => [clip.sourceInUs, clip.sourceOutUs]), [[500_000, 1_000_000]]);
  assert.equal(setBatchPlanReviews(db, 'p', batchId, { items: [{ planId, ...view().reviewContext! }], decision: 'approved' }).results[0].status, 'not_ready',
    '待处理的公式草稿不能通过原审核入口绕过声音检查');
  assert.equal(readBatchPlanReview(db, 'p', batchId, planId).decision, null);
  edit({ type: 'restore_arrangement', snapshot: { ...beforeVoiceSplit } });
  assert.deepEqual(view().audioPlan?.clips, beforeVoiceSplit.audioPlan?.clips, '撤销同时恢复配音来源和两套时间坐标');
  assert.equal(view().audioPlan?.issues.length, 0);
  const latest = view();
  assert.throws(() => edit({ type: 'restore_arrangement', snapshot: { ...currentView } }), /版本/,
    '当前修订正确也不能把上一个输出版本的撤销快照套过来');
  assert.deepEqual(view(), latest);
  const wordBoundaryFixture = structuredClone(arrangement);
  wordBoundaryFixture.formula.audioSources[0].words = [
    { id: 'source-word-1', text: '好', sourceInUs: 5_250_000, sourceOutUs: 5_750_000 },
    { id: 'source-word-2', text: '擦洗', sourceInUs: 6_250_000, sourceOutUs: 6_750_000 },
  ];
  createOutputVersion(db, planId, { arrangementJson: wordBoundaryFixture });
  edit({ type: 'split', clipId: 'slot-a', offsetUs: 1_000_000 });
  const rightClip = view().clips.find(clip => clip.sourceStartUs === 6_000_000)!;
  edit({ type: 'move_clip', clipId: rightClip.clipId, startUs: 2_000_000 });
  assert.ok(view().audioPlan?.issues.some(issue => issue.code === 'speech_discontinuous'), '在词间拆开一句话，也不能当成完整连续原声');
  createOutputVersion(db, planId, { arrangementJson: arrangement });
  edit({ type: 'trim_audio_clip', track: 'narration', clipId: 'tts:voice', sourceStartUs: 250_000, sourceEndUs: 1_000_000,
    timelineStartUs: 4_250_000, timelineEndUs: 5_000_000 });
  assert.deepEqual(view().audioPlan?.clips.find(clip => clip.kind === 'narration'), { ...voice, sourceInUs: 250_000, timelineStartUs: 4_250_000 });
  assert.ok(view().audioPlan?.issues.some(issue => issue.mediaId === 'tts:voice' && issue.code === 'speech_incomplete'));
  createOutputVersion(db, planId, { arrangementJson: arrangement });
  assert.equal(view().music.ducking?.enabled, false, '旧草稿缺少压低设置时保持原音量，不自动改变听感');
  const ducking = { version: 1 as const, enabled: true, reductionDb: 8, attackMs: 100, releaseMs: 250 };
  edit({ type: 'set_music', trackId: null, gainDb: -18, fadeInSec: 0, fadeOutSec: 0, ducking });
  assert.deepEqual(view().music.ducking, ducking);
  assert.equal(edit({ type: 'set_music', trackId: null, gainDb: -18, fadeInSec: 0, fadeOutSec: 0, ducking }).changed, false,
    '相同压低设置重复保存不制造新修订');
  const beforeInvalidMusic = view();
  for (const invalid of [null, { ...ducking, version: 2 }, { ...ducking, enabled: 'true' },
    { ...ducking, reductionDb: -1 }, { ...ducking, reductionDb: 25 }, { ...ducking, reductionDb: NaN },
    { ...ducking, attackMs: 2001 }, { ...ducking, attackMs: 0.5 }, { ...ducking, releaseMs: -1 }, { ...ducking, releaseMs: 5001 }]) {
    assert.throws(() => edit({ type: 'set_music', trackId: null, gainDb: -6, fadeInSec: 1, fadeOutSec: 2, ducking: invalid }), /音乐压低参数无效/);
    assert.deepEqual(view(), beforeInvalidMusic, '压低参数无效时，不能部分保存音量、淡化或修订');
  }
  edit({ type: 'set_music', trackId: null, gainDb: -18, fadeInSec: 0, fadeOutSec: 0,
    ducking: { ...ducking, reductionDb: 0, attackMs: 0, releaseMs: 0 } });
  assert.equal(view().music.ducking?.reductionDb, 0, '允许不额外压低以及零过渡时间');
  db.prepare('INSERT INTO final_edit_bgm_tracks VALUES (?,?,?,?,?)').run('edit-music', 'bgm/edit.wav', fingerprint, 8_000_000, 'ready');
  edit({ type: 'set_music', trackId: 'edit-music', gainDb: -18, fadeInSec: 0, fadeOutSec: 0, ducking });
  const beforeInvalidCut = view();
  assert.throws(() => edit({ type: 'trim_audio_clip', track: 'bgm', clipId: 'bgm-full',
    sourceStartUs: 5_000_000, sourceEndUs: 7_000_000, timelineStartUs: 1_000_000, timelineEndUs: 4_000_000 }), /区间|速度/,
  '两秒音乐不能保存成三秒播放窗口而悄悄变速');
  assert.deepEqual(view(), beforeInvalidCut, '错误音乐裁切不改变修订和成片内容');
  assert.throws(() => edit({ type: 'restore_arrangement', snapshot: { ...beforeInvalidCut,
    musicTrackId: beforeInvalidCut.music.trackId, musicGainDb: -18, musicFadeInSec: 0, musicFadeOutSec: 0,
    musicSourceFingerprint: beforeInvalidCut.formulaPreview!.music!.sourceFingerprint, musicDucking: ducking,
    audio: { bgm: [{ id: 'invalid', sourceStartUs: 0, sourceEndUs: 2_000_000, timelineStartUs: 0, timelineEndUs: 3_000_000 }] },
  } }), /区间|速度/, '整包恢复同样不能绕过音乐区间检查');
  assert.deepEqual(view(), beforeInvalidCut);
  db.prepare("UPDATE final_edit_bgm_tracks SET durationUs=1000000 WHERE id='edit-music'").run();
  edit({ type: 'trim_audio_clip', track: 'bgm', clipId: 'bgm-full', sourceStartUs: 7_500_000, sourceEndUs: 9_500_000,
    timelineStartUs: 1_000_000, timelineEndUs: 3_000_000 });
  assert.equal(view().formulaPreview!.music!.durationUs, 8_000_000, '循环与裁切使用本输出保存的文件时长，不读取后来改动的曲库');
  edit({ type: 'split_audio_clip', track: 'bgm', clipId: 'bgm-full', atUs: 2_000_000 });
  assert.deepEqual(view().audio?.bgm?.map(clip => [clip.sourceStartUs, clip.sourceEndUs]),
    [[7_500_000, 8_500_000], [8_500_000, 9_500_000]], '跨音乐尾部的循环片段也能分割并保留连续取源');
  // Real TTS returns words/characters, which must appear as readable phrases rather than flash one at a time.
  const wordArrangement = structuredClone(arrangement);
  wordArrangement.formula.audioSources[0].words = [
    { id: 'w1', text: '买', sourceInUs: 5_100_000, sourceOutUs: 5_250_000 },
    { id: 'w2', text: '沙发', sourceInUs: 5_250_000, sourceOutUs: 5_600_000 },
    { id: 'w3', text: '前，', sourceInUs: 5_600_000, sourceOutUs: 5_800_000 },
    { id: 'w4', text: '先', sourceInUs: 5_900_000, sourceOutUs: 6_050_000 },
    { id: 'w5', text: '量', sourceInUs: 6_050_000, sourceOutUs: 6_300_000 },
    { id: 'w6', text: '尺寸。', sourceInUs: 6_300_000, sourceOutUs: 6_800_000 },
  ];
  createOutputVersion(db, planId, { arrangementJson: wordArrangement });
  edit({ type: 'move_clip', clipId: 'slot-a', startUs: 2_000_000 });
  assert.deepEqual(view().subtitleCues.map(cue => [cue.text, cue.startUs, cue.endUs]),
    [['买沙发前，', 2_100_000, 2_800_000], ['先量尺寸。', 2_900_000, 3_800_000], ['坐得稳', 4_000_000, 5_000_000]],
    '逐字时间应组成可读短句，起止沿用首尾真实词边界，不按字数猜时间');
  const groupedCues = view().subtitleCues;
  edit({ type: 'split', clipId: 'slot-a', offsetUs: 1_000_000 });
  assert.deepEqual(view().subtitleCues, groupedCues, '连续分割不把短句变回逐字字幕');
  console.log('formula-output-edit: linked edits, readable aligned captions, music ducking validation and legacy settings passed');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}

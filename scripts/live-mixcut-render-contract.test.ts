import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { resolveFullRenderContractHash, resolveFullRenderContract, computeFullRenderContractHash } from '../lib/live-mixcut/cover-contract.ts';

// Public render identity seam. The database supplies frozen inputs; assertions
// observe only the contract used to queue, reuse and accept rendered outputs.
const db = new Database(':memory:');
try {
  db.exec(`
    CREATE TABLE live_mixcut_output_versions (id TEXT,planId TEXT,arrangementJson TEXT);
    CREATE TABLE live_mixcut_output_plans (id TEXT,batchVersionId TEXT,seq INTEGER,scriptSnapshotId TEXT);
    CREATE TABLE live_mixcut_production_versions (id TEXT,defaultsJson TEXT);
    CREATE TABLE live_mixcut_script_snapshots (id TEXT,sourceScriptId TEXT,coverTitleJson TEXT);
    CREATE TABLE live_mixcut_assets (id TEXT,contentFingerprint TEXT);
    CREATE TABLE live_mixcut_asset_pool_items (batchVersionId TEXT,assetId TEXT,colorJson TEXT);
    CREATE TABLE live_mixcut_asset_analysis (assetId TEXT,colorJson TEXT,createdAt TEXT);
    INSERT INTO live_mixcut_output_plans VALUES ('plan','version',1,'script');
    INSERT INTO live_mixcut_production_versions VALUES ('version','{}');
    INSERT INTO live_mixcut_script_snapshots VALUES ('script','source-script','{}');
    INSERT INTO live_mixcut_assets VALUES ('a','sha256:video-a'),('b','sha256:video-b');
    INSERT INTO live_mixcut_output_versions VALUES ('out','plan','{}');
  `);
  const arrangement = {
    planningMode: 'formula', preset: '3:4', editRevision: 0, fps: 24,
    clips: [
      { clipId: 'v1', assetId: 'a', contentFingerprint: 'sha256:video-a', sourceStartUs: 0, sourceEndUs: 2_000_000, timelineStartUs: 0, timelineEndUs: 2_000_000 },
      { clipId: 'v2', assetId: 'b', contentFingerprint: 'sha256:video-b', sourceStartUs: 0, sourceEndUs: 1_000_000, timelineStartUs: 2_000_000, timelineEndUs: 3_000_000 },
    ],
    formula: { version: 1, selectionStageId: 'selection', timelineStageId: 'timeline',
      videoSources: [{ mediaId: 'v1', assetId: 'a', contentFingerprint: 'sha256:video-a' }, { mediaId: 'v2', assetId: 'b', contentFingerprint: 'sha256:video-b' }],
      audioSources: [
        { mediaId: 'source', kind: 'source', slotId: 'slot', assetId: 'a', contentFingerprint: 'sha256:video-a', sourceDurationUs: 2_000_000, verifiedInUs: 0, verifiedOutUs: 2_000_000, words: [] },
        { mediaId: 'voice', kind: 'narration', contentFingerprint: 'sha256:voice', sourceDurationUs: 1_000_000, verifiedInUs: 0, verifiedOutUs: 1_000_000, words: [] },
      ] },
    audioPlan: { version: 1, revision: 0, bodyDurationUs: 3_000_000, issues: [], clips: [
      { id: 's1', mediaId: 'source', kind: 'source', linkedVideoClipId: 'v1', sourceInUs: 0, sourceOutUs: 2_000_000, timelineStartUs: 0, timelineEndUs: 2_000_000, gainDb: 0 },
      { id: 's2', mediaId: 'voice', kind: 'narration', sourceInUs: 0, sourceOutUs: 1_000_000, timelineStartUs: 2_000_000, timelineEndUs: 3_000_000, gainDb: 0 },
    ] },
    narration: { gainDb: 0 },
    music: { trackId: 'track', source: { trackId: 'track', relativePath: 'bgm/a.wav', fileFingerprint: 'sha256:music', durationUs: 5_000_000 },
      ducking: { version: 1, enabled: true, reductionDb: 8, attackMs: 100, releaseMs: 250 } },
  };
  function identity(value = arrangement) {
    db.prepare('UPDATE live_mixcut_output_versions SET arrangementJson=? WHERE id=?').run(JSON.stringify(value), 'out');
    return resolveFullRenderContractHash(db, 'out');
  }
  const baseline = identity();
  const current = resolveFullRenderContract(db, 'out');
  assert.equal(current.formula?.version, 'formula-render/2');
  assert.notEqual(computeFullRenderContractHash({ ...current, formula: { ...current.formula!, version: 'formula-render/1' } }), baseline,
    '字幕换行改变实际画面，不能复用旧单行渲染的文件');
  const manualSource = (id: string) => ({ ...arrangement, clips: arrangement.clips.map((clip, index) =>
    index === 0 ? { ...clip, formulaSourceId: id } : clip) });
  assert.notEqual(identity(manualSource('manual-media:first')), identity(manualSource('manual-media:second')),
    '人工素材核验依据改变必须使旧制作检查和渲染身份失效');
  const legacy = { ...arrangement, planningMode: 'semantic', formula: undefined, audioPlan: undefined };
  db.prepare('UPDATE live_mixcut_output_versions SET arrangementJson=? WHERE id=?').run(JSON.stringify(legacy), 'out');
  assert.equal(resolveFullRenderContractHash(db, 'out'), 'rnd_7d8ee3470ccd2c61faf65659a21140c2', '普通批次保持改造前的契约身份');
  const quieter = structuredClone(arrangement);
  quieter.audioPlan.clips[0].gainDb = -6;
  assert.notEqual(identity(quieter), baseline, '逐段原声音量变化必须使旧视频失效，不能只依赖编辑修订号');
  const changes: Array<[string, (value: typeof arrangement) => void]> = [
    ['配音文件', value => { value.formula.audioSources[1].contentFingerprint = 'sha256:new-voice'; }],
    ['声音入点', value => { value.audioPlan.clips[1].sourceInUs = 100_000; value.audioPlan.clips[1].sourceOutUs = 1_100_000; }],
    ['正文时长', value => { value.audioPlan.bodyDurationUs = 4_000_000; }],
    ['总人声音量', value => { value.narration.gainDb = -9; }],
    ['音乐文件', value => { value.music.source.fileFingerprint = 'sha256:new-music'; }],
    ['音乐路径', value => { value.music.source.relativePath = 'bgm/other.wav'; }],
    ['音乐时长', value => { value.music.source.durationUs = 6_000_000; }],
    ['说话压低音乐', value => { value.music.ducking.reductionDb = 12; }],
    ['声音来源版本', value => { value.formula.timelineStageId = 'other-timeline'; }],
  ];
  for (const [label, mutate] of changes) {
    const changed = structuredClone(arrangement);
    mutate(changed);
    assert.notEqual(identity(changed), baseline, `${label}变化必须使旧视频失效`);
  }
  const metadataOnly = { ...arrangement, review: { decision: 'approved' }, warnings: ['审片提醒'],
    music: { ...arrangement.music, sourceHistory: [{ fileFingerprint: 'sha256:old-music' }] } };
  assert.equal(identity(metadataOnly), baseline, '审核状态、提醒和撤销音乐历史不改变实际渲染输入');
  identity();
  db.prepare('UPDATE live_mixcut_assets SET contentFingerprint=? WHERE id=?').run('sha256:replaced-video', 'b');
  assert.notEqual(resolveFullRenderContractHash(db, 'out'), baseline, '非封面镜头实际文件身份变化也必须使旧视频失效');
  db.prepare('UPDATE live_mixcut_assets SET contentFingerprint=? WHERE id=?').run('sha256:video-b', 'b');
  db.prepare('UPDATE live_mixcut_production_versions SET defaultsJson=? WHERE id=?').run(JSON.stringify({ batchBgmParams: { gainDb: -30 } }), 'version');
  assert.notEqual(resolveFullRenderContractHash(db, 'out'), baseline, '从批次继承的音乐音量也属于实际渲染输入');
  db.exec('DROP TABLE live_mixcut_asset_analysis; CREATE TABLE live_mixcut_asset_analysis (assetId TEXT,createdAt TEXT)');
  assert.doesNotThrow(() => resolveFullRenderContractHash(db, 'out'), '公式素材未进入旧素材池时使用中性色彩，不查询分析表中不存在的颜色字段');
  console.log('formula render contract tests passed');
} finally {
  db.close();
}

import { seedLiveMixcutProjects } from './live-mixcut-test-helpers.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// 只测 AI 判断与缓存：假模型回复，不调用任何真实接口。
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-judgment-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;
process.env.CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE = '1';
const db = new Database(path.join(root, 'workbench.db'));
try {
  db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL); INSERT INTO projects VALUES ('p','AI 判断'),('other','别的任务');");
  const { checkBatchProductionReadiness } = await import('../lib/live-mixcut/readiness.ts');
  const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
  const { judgeFormulaFilm, formulaJudgmentFingerprint, JUDGMENT_RELATED_LIMIT } = await import('../lib/live-mixcut/formula/judgment.ts');
  const options = { db, ...schemaUpgradeRuntimePaths(root) };
  assert.equal((await checkBatchProductionReadiness(options)).available, true);
  seedLiveMixcutProjects(options, ['p', 'other']);

  const input = {
    script: { lines: ['三厘米金属脚，扫地机自由进出。', '坐下去就不想起来。'] },
    voiceOvers: [
      { logicalCode: 'VO1', plannedLine: '坐下去就不想起来', speechText: '三二一开始，这款钢琴键沙发坐下去就不想起来。' },
      { logicalCode: 'VO2', plannedLine: null, speechText: '三厘米金属脚，扫地机进得去。' },
    ],
    materials: [
      { logicalCode: 'G1', assetId: 'asset-g1', fileName: 'G1_金属脚_扫地机.mp4', description: '镜头对准三厘米金属脚，扫地机从下面穿过' },
      { logicalCode: 'G2', assetId: 'asset-g2', fileName: 'G2_坐姿.mp4', description: '模特坐在沙发上' },
      { logicalCode: 'P1', assetId: 'asset-p1', fileName: 'P1_全景.mp4', description: null },
    ],
  };
  const calls: Array<{ systemPrompt: string; userPrompt: string }> = [];
  const replies: Array<unknown> = [];
  const model = { id: 'judge-fixture', name: '测试模型', model: 'judge/1', async complete(prompt: { systemPrompt: string; userPrompt: string }) {
    calls.push(prompt);
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply;
  } };
  const signal = new AbortController().signal;

  // 1. 正常回复：对不上号的行号/编号/assetId 丢掉，其余按原顺序保留。
  replies.push({ similar: [{ lineIndex: 0, logicalCode: 'VO2' }, { lineIndex: 9, logicalCode: 'VO1' },
    { lineIndex: 1, logicalCode: 'VO9' }, { lineIndex: 1, logicalCode: 'VO1' }, { lineIndex: 0, logicalCode: 'VO1' }],
    bestVo: 'VO7', related: [
      { lineIndex: 0, assetIds: ['asset-g1', 'asset-unknown', 'asset-g1', 'asset-p1'] },
      { lineIndex: 1, assetIds: ['asset-g2', 'asset-g1'] },
      { lineIndex: 5, assetIds: ['asset-g1'] },
      { lineIndex: 1, assetIds: [] },
    ] });
  const first = await judgeFormulaFilm(db, 'p', input, model, signal);
  assert.equal(first.cached, false);
  assert.deepEqual(first.judgment.similar, [{ lineIndex: 0, logicalCode: 'VO2' }, { lineIndex: 1, logicalCode: 'VO1' }],
    '行号对不上、编号不存在的条目丢掉；同一行只留第一个');
  assert.equal(first.judgment.bestVo, null, '不存在的口播编号不能留');
  assert.deepEqual(first.judgment.related, [
    { lineIndex: 0, assetIds: ['asset-g1', 'asset-p1'] },
    { lineIndex: 1, assetIds: ['asset-g2', 'asset-g1'] },
  ], '未知 assetId 丢掉，顺序不变，空排序不留');
  assert.equal(calls.length, 1);
  // 提示词里对照的是原声实际说的话，文件名台词只作参考；素材带文件名和画面描述。
  const sent = JSON.parse(calls[0].userPrompt) as {
    voiceOvers: Array<{ logicalCode: string; speechText: string; plannedLine: string | null }>;
    materials: Array<{ logicalCode: string; assetId: string; fileName: string; description: string | null }>;
  };
  assert.deepEqual(sent.voiceOvers.map(item => [item.logicalCode, item.speechText, item.plannedLine]),
    [['VO1', '三二一开始，这款钢琴键沙发坐下去就不想起来。', '坐下去就不想起来'], ['VO2', '三厘米金属脚，扫地机进得去。', null]]);
  assert.deepEqual(sent.materials.find(item => item.assetId === 'asset-g1'),
    { logicalCode: 'G1', assetId: 'asset-g1', fileName: 'G1_金属脚_扫地机.mp4', description: '镜头对准三厘米金属脚，扫地机从下面穿过' });
  assert.match(calls[0].systemPrompt, /speechText/);
  assert.match(calls[0].systemPrompt, new RegExp(`最多 ${JUDGMENT_RELATED_LIMIT} 个`));

  // 2. 同样的文案、同样的素材：直接读缓存，不再调用模型。
  const second = await judgeFormulaFilm(db, 'p', input, model, signal);
  assert.equal(second.cached, true);
  assert.equal(calls.length, 1, '第二次不调用模型');
  assert.deepEqual(second.judgment, first.judgment);
  assert.equal(formulaJudgmentFingerprint(input, model), formulaJudgmentFingerprint(
    { ...input, materials: [...input.materials].reverse(), voiceOvers: [...input.voiceOvers].reverse() }, model),
    '素材或口播顺序不同但内容相同，指纹相同');
  replies.push({ similar: [], bestVo: null, related: [] });
  assert.equal((await judgeFormulaFilm(db, 'other', input, model, signal)).cached, false, '缓存按任务隔离');
  assert.equal(calls.length, 2);
  // 文件内容变化（描述不同）算新的判断。
  const changedMaterial = { ...input, materials: input.materials.map(item => item.assetId === 'asset-g1'
    ? { ...item, description: '金属脚特写，没有扫地机' } : item) };
  replies.push({ similar: [], bestVo: 'VO1', related: [{ lineIndex: 0, assetIds: ['asset-p1'] }] });
  const changed = await judgeFormulaFilm(db, 'p', changedMaterial, model, signal);
  assert.equal(changed.cached, false);
  assert.equal(changed.judgment.bestVo, 'VO1');
  assert.equal(calls.length, 3);
  // 换了模型也要重新判断。
  const otherModel = { ...model, id: 'judge-other', model: 'judge/2', async complete() { calls.push({ systemPrompt: '', userPrompt: '' }); return { similar: [], bestVo: null, related: [] }; } };
  assert.equal((await judgeFormulaFilm(db, 'p', changedMaterial, otherModel, signal)).cached, false);

  // 3. 整份格式不对：重试一次；第二次正常就用第二次的。
  const brokenInput = { ...input, script: { lines: ['换一条文案。'] } };
  replies.push({ similar: 'nope' }, { similar: [], bestVo: null, related: [{ lineIndex: 0, assetIds: ['asset-g2'] }] });
  const retried = await judgeFormulaFilm(db, 'p', brokenInput, model, signal);
  assert.deepEqual(retried.judgment.related, [{ lineIndex: 0, assetIds: ['asset-g2'] }]);
  // 两次都不对：这条成片失败，写明原因。
  const hopeless = { ...input, script: { lines: ['再换一条文案。'] } };
  replies.push({ bestVo: 'VO1' }, { similar: [] });
  await assert.rejects(() => judgeFormulaFilm(db, 'p', hopeless, model, signal), /AI 判断返回格式不正确/);
  // 调用本身报错：不重试，直接失败并写明原因。
  const failing = { ...input, script: { lines: ['第三条文案。'] } };
  replies.push(new Error('network down'));
  await assert.rejects(() => judgeFormulaFilm(db, 'p', failing, model, signal), /AI 判断调用失败.*测试模型/);
  // 模型回了无效 JSON 也算格式不对：重试一次。
  const invalidJson = { ...input, script: { lines: ['第四条文案。'] } };
  replies.push(new Error('测试模型 返回了无效 JSON。原始回复: xxx'), { similar: [], bestVo: null, related: [] });
  assert.equal((await judgeFormulaFilm(db, 'p', invalidJson, model, signal)).cached, false);
  // 数字行号、字符串 assetId 之外的脏条目不影响整体判断。
  const dirty = { ...input, script: { lines: ['第五条文案。'] } };
  replies.push({ similar: [null, 1, { lineIndex: '0', logicalCode: 'VO1' }], bestVo: 'VO9', related: [null, { lineIndex: 0, assetIds: 'x' }] });
  const dirtyResult = await judgeFormulaFilm(db, 'p', dirty, model, signal);
  assert.deepEqual(dirtyResult.judgment, { similar: [], bestVo: null, related: [] });
  assert.equal((db.prepare('SELECT count(*) AS count FROM live_mixcut_formula_judgments WHERE projectId=?').get('p') as { count: number }).count, 6);
  console.log('formula-judgment: 三样判断、条目过滤、内容缓存、格式重试与失败原因通过');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}

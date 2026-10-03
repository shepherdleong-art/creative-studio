import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureScriptStudioSchemaReady } from '../lib/script-studio/schema.ts';
import { createLibraryRevision } from '../lib/script-studio/libraries.ts';
import { createTask, decideTaskRequest, getTask } from '../lib/script-studio/tasks.ts';
import { executeScriptStudioTask } from '../lib/script-studio/runner.ts';
import { normalizeGeneratedScript, buildScriptPrompt, buildScriptBodyRepairPrompt, buildScriptEndingReviewPrompt, type ScriptGenerator, type ScriptGeneratorInput } from '../lib/script-studio/generator.ts';
import { parseScriptProductionMode } from '../lib/script-studio/generation-contract.ts';
import { PAIN_REVIEW_CHECKS, painBrief, painPlan, painContentIssues, parsePainPlanning, parsePainReview } from '../lib/script-studio/pain-solving.ts';
import type { PainSolvingOpportunity } from '../lib/script-studio/types.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'script-pain-'));
const db = new Database(path.join(root, 'workbench.db'));
try {
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE shot_sets (id TEXT PRIMARY KEY, projectId TEXT NOT NULL);
    CREATE TABLE image_assets (id TEXT PRIMARY KEY, projectId TEXT);
    INSERT INTO projects VALUES ('p1', '测试');`);
  await ensureScriptStudioSchemaReady({ db, backupRoot: path.join(root, 'backups') });
  db.exec(`INSERT INTO script_studio_source_sets VALUES ('source', 'p1', 'fp', '["image"]', '2026-09-16');`);
  const library = createLibraryRevision(db, { projectId: 'p1', sourceSetId: 'source', sourceFingerprint: 'fp', productName: '测试沙发', category: '沙发', sellingPoints: [
    { title: '高靠背', factText: '高靠背承托头颈', evidenceQuote: '高靠背承托头颈', pointType: 'structure', evidenceGate: 'passed', usable: true, sourcePageIndex: 0, tileRefs: ['tile_1'] },
    { title: '窄扶手', factText: '窄扶手节省横向空间', evidenceQuote: '窄扶手节省横向空间', pointType: 'structure', evidenceGate: 'passed', usable: true, sourcePageIndex: 0, tileRefs: ['tile_1'] },
    { title: '禁用能力', factText: '禁止进入分析', evidenceQuote: '禁止进入分析', pointType: 'efficacy', evidenceGate: 'failed', usable: true, sourcePageIndex: 0, tileRefs: ['tile_1'] },
    { title: '越界定位', factText: '禁止使用越界证据', evidenceQuote: '禁止使用越界证据', pointType: 'structure', evidenceGate: 'passed', usable: true, sourcePageIndex: 99, tileRefs: ['tile_1'] },
  ] });
  const [head, narrow] = library.sellingPoints;
  const opportunity: PainSolvingOpportunity = {
    version: 'pain-solving-v1', audience: '习惯靠坐看剧的人', scenario: '晚上靠坐看剧', problem: '头颈缺少承托',
    benefit: '靠坐时头颈有承托', mechanism: '高靠背为头颈提供靠点', main: { label: '高靠背承托', factIds: [head!.id] },
    support: null, path: 'direct', possibleCause: '', concern: '', proposition: '靠坐看剧时，通过高靠背让头颈有承托',
    matchReason: '高靠背承托头颈的原文直接回应靠坐需求', scores: { painIntensity: 2, factMatch: 3, sceneClarity: 3 },
  };
  const planning = { libraryRevision: { ...library, sellingPoints: library.sellingPoints.slice(0, 2) }, requestedCount: 3, creativeBrief: '' };
  assert.equal(parseScriptProductionMode(undefined, 30), 'standard');
  assert.throws(() => parseScriptProductionMode('pain_solving_15s', 30));
  assert.throws(() => parseScriptProductionMode('unknown', 15));
  assert.throws(() => parsePainPlanning({}, planning));
  assert.equal(parsePainPlanning({ opportunities: [opportunity, opportunity] }, planning).opportunities.length, 1);
  assert.equal(parsePainPlanning({ opportunities: [{ ...opportunity, scores: { ...opportunity.scores, factMatch: 2 } }] }, planning).opportunities.length, 0);
  assert.equal(parsePainPlanning({ opportunities: [{ ...opportunity, main: { label: '伪造', factIds: ['unknown'] } }] }, planning).opportunities.length, 0);
  assert.equal(parsePainPlanning({ opportunities: [{ ...opportunity, path: 'dilemma' }] }, planning).opportunities.length, 0);
  assert.equal(parsePainPlanning({ opportunities: [{ ...opportunity, path: 'diagnosis' }] }, planning).opportunities.length, 0);
  const different = { ...opportunity, problem: '横向空间有限', path: 'diagnosis', possibleCause: '扶手占空间', main: { label: '窄扶手', factIds: [narrow!.id] } };
  assert.equal(parsePainPlanning({ opportunities: [opportunity, different] }, planning).opportunities.length, 2);
  const goodReview = { pass: true, issues: [], checks: Object.fromEntries(PAIN_REVIEW_CHECKS.map((name) => [name, true])) };
  assert.equal(parsePainReview(goodReview).pass, true);
  assert.equal(parsePainReview({ ...goodReview, checks: { ...goodReview.checks, factsSupported: false } }).pass, false);
  assert.equal(parsePainReview({ pass: true }).pass, false);
  assert.equal(parsePainReview({ ...goodReview, issues: ['存在推测功效'] }).pass, false);
  const input: ScriptGeneratorInput = { libraryRevision: library, plan: painPlan(opportunity, 1), brief: painBrief(opportunity, 1), audience: opportunity.audience,
    platform: '淘宝逛逛', tone: '自然可信', creativeBrief: '', targetDurationSec: 15, previousScripts: [] };
  const rawScript = {
    title: '靠坐头颈有承托', coverTitleParts: { primary: '靠坐有承托', secondary: '高靠背支撑头颈' },
    segments: [
      { narration: '晚上靠坐看剧，头颈总想找个靠点？', sellingPointIdRefs: [] },
      { narration: '这款沙发用高靠背承托头颈。', sellingPointIdRefs: [head!.id] },
      { narration: '靠背向上延伸，让靠坐时的头颈有处可依。', sellingPointIdRefs: [head!.id] },
      { narration: '看剧靠坐时，头颈也能有承托。', sellingPointIdRefs: [head!.id] },
    ],
  };
  const content = normalizeGeneratedScript(rawScript, input);
  assert.deepEqual(painContentIssues(content), []);
  assert.ok(painContentIssues({ ...content, segments: content.segments.slice(0, 3) }).length);
  const prompt = JSON.parse(buildScriptPrompt(input).userPrompt);
  assert.equal(prompt.painSolving.problem, opportunity.problem);
  assert.equal(prompt.sellingPoints.length, 1);
  assert.ok(!prompt.requirements.some((s: string) => s.includes('完整表达与 CTA 优先')));
  const repair = JSON.parse(buildScriptBodyRepairPrompt({ ...input, content, qualityIssues: ['闭环'] }).userPrompt);
  assert.ok(!repair.output.segments[0].narration.includes('CTA'));
  const review = JSON.parse(buildScriptEndingReviewPrompt({ ...input, content }).userPrompt);
  assert.ok(review.output.checks.closedLoop);
  assert.equal(review.output.checks.actionInvitation, undefined);
  const request = { projectId: 'p1', mode: 'reuse' as const, libraryRevisionId: library.id, targetDurationSec: 15, requestedCount: 3, creativeBrief: '', providerId: 'fake' };
  const resolveProvider = () => ({ vision: { id: 'fake', model: 'fake' } });
  const standardKey = decideTaskRequest(db, request, resolveProvider).requestKey;
  const painRequest = decideTaskRequest(db, { ...request, productionMode: 'pain_solving_15s', explicitRequestKey: 'action' }, resolveProvider);
  const painKey = decideTaskRequest(db, { ...request, productionMode: 'pain_solving_15s' }, resolveProvider).requestKey;
  assert.notEqual(standardKey, painKey);
  createTask(db, { ...request, requestKey: 'action', inputSnapshot: painRequest.snapshot! });
  assert.throws(() => decideTaskRequest(db, { ...request, explicitRequestKey: 'action' }, resolveProvider), /不同请求内容/);
  assert.ok(decideTaskRequest(db, { ...request, productionMode: 'pain_solving_15s', explicitRequestKey: 'action' }, () => { throw Error('不应解析供应商'); }).existing);

  let analysisCalls = 0, generationCalls = 0, repairs = 0;
  const generator: ScriptGenerator = {
    async planPainOpportunities(input) {
      analysisCalls++;
      assert.equal(input.libraryRevision.sellingPoints.length, 2, '证据失败和越界引用均不能进入分析');
      return { opportunities: [opportunity], shortageReason: '仅一个有依据的内容机会' };
    },
    async generate(input) { generationCalls++; return { content: normalizeGeneratedScript(rawScript, input), attempts: 1 }; },
    async repairScriptContent() { repairs++; throw Error('不应强加CTA'); },
    async reviewScriptContent() { return goodReview; },
  };
  const snapshot = { targetDurationSec: 15, requestedCount: 3, creativeBrief: '', productionMode: 'pain_solving_15s' };
  function makeTask(key: string) { return createTask(db, { projectId: 'p1', requestKey: key, mode: 'reuse', libraryRevisionId: library.id, requestedCount: 3, inputSnapshot: snapshot }).task; }
  const task = makeTask('one-opportunity');
  const deps = { db, projectId: 'p1', taskId: task.id, libraryRevisionId: library.id, inputSnapshot: snapshot, generator,
    visionExtractor: { async extract() { throw Error('不能重新识图'); } }, reprobe: { kind: 'vision_closed_question' as const, async verify() { throw Error('不能重复核验'); } } };
  const result = await executeScriptStudioTask(deps);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.succeededCount, 1);
  assert.equal(result.failedCount, 0, '机会不足不计为生成失败');
  assert.equal(repairs, 0, '结果式收束直接通过');
  const savedTask = getTask(db, 'p1', task.id)!;
  const planSnapshot = JSON.parse(savedTask.stages.find((s) => s.stage === 'plan')!.payloadJson);
  assert.equal(planSnapshot.shortageCount, 2);
  assert.equal(planSnapshot.painPlanning.opportunities[0].main.factIds[0], head!.id);
  await executeScriptStudioTask(deps);
  assert.equal(analysisCalls, 1, '恢复复用冻结策划');
  assert.equal(generationCalls, 1, '恢复不重复保存已完成方向');
  const zero = makeTask('zero');
  const zeroResult = await executeScriptStudioTask({ ...deps, taskId: zero.id, generator: { ...generator, async planPainOpportunities() { return { opportunities: [], shortageReason: '证据不足以直接回应痛点' }; } } });
  assert.equal(zeroResult.status, 'succeeded');
  assert.equal(zeroResult.failedCount, 0);
  assert.equal(generationCalls, 1, '零机会不能进入生成');
  const rejected = makeTask('rejected');
  const rejectedResult = await executeScriptStudioTask({ ...deps, taskId: rejected.id, generator: { ...generator,
    repairScriptContent: undefined,
    async reviewScriptContent() { return { ...goodReview, checks: { ...goodReview.checks, factsSupported: false }, issues: ['作用解释缺少证据'] }; },
  } });
  assert.equal(rejectedResult.status, 'failed');
  assert.equal(rejectedResult.failedCount, 1, '只有实际生成的机会失败，不能算成三条失败');
  assert.equal(rejectedResult.succeededCount, 0);
  // Retry/revision uses frozen opportunities and carries prior siblings into semantic review.
  const frozenTask = makeTask('frozen-retry');
  let reviewedPeers = 0;
  const frozenResult = await executeScriptStudioTask({ ...deps, taskId: frozenTask.id,
    inputSnapshot: { ...snapshot, requestedCount: 1, painRetryOpportunities: [opportunity], painPriorOpportunities: [different] },
    generator: { ...generator,
      async planPainOpportunities() { throw Error('冻结机会不能重新策划'); },
      async generate(input) { return { content: normalizeGeneratedScript({ ...rawScript,
        title: '看剧时头颈有处可靠', coverTitleParts: { primary: '头颈找到靠点', secondary: '靠坐看剧有承托' } }, input), attempts: 1 }; },
      async reviewScriptContent(input) { reviewedPeers = input.peerPainOpportunities?.length ?? 0; return goodReview; },
    },
  });
  assert.equal(frozenResult.succeededCount, 1);
  assert.equal(reviewedPeers, 1, '补跑仍检查与已完成机会的实质差异');
  const badPlanTask = makeTask('bad-plan');
  const badPlanResult = await executeScriptStudioTask({ ...deps, taskId: badPlanTask.id,
    generator: { ...generator, async planPainOpportunities() { throw Error('内容机会分析连接失败'); } },
  });
  assert.equal(badPlanResult.status, 'failed');
  assert.equal(badPlanResult.failedCount, 0, '策划前失败不能伪报三条正文失败');
  assert.match(badPlanResult.errorMessage ?? '', /连接失败/);
  console.log('script-studio-pain-solving.test.ts: ok (evidence, diversity, prompts, identity, shortage, review, recovery)');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}

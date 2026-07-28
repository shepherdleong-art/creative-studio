import assert from 'node:assert/strict';
import {
  ScriptGenerationV3Error,
  analyzeScriptStrategyV3,
  generateScriptV3,
} from '../lib/script-generation-v3.ts';
import { buildScriptDurationAdvisory, buildScriptDurationBudget } from '../lib/script-duration-policy.ts';

const baseInput = {
  projectName: '沙发任务',
  productName: '云感沙发',
  productCode: 'SF-A1',
  productCategory: '家具',
  targetAudience: '久坐上班族',
  tone: '温柔种草',
  platform: '小红书',
  selectedSellingPoints: [
    { title: '112°承托', priority: 'highest', reason: '缓解久坐疲劳' },
    { title: '5芯软弹', priority: 'high', reason: '坐感柔软' },
  ],
  templateId: 'scene_seeding',
  templateName: '场景种草',
  targetDurationSec: 15,
  shotSetId: 'set-a',
  visuals: [
    {
      shotId: 'shot-a', shotIndex: 1, imageAssetId: 'image-a', sourceFilename: 'scene-a.png',
      mimeType: 'image/png', imageBase64: 'image-a-base64',
    },
    {
      shotId: 'shot-b', shotIndex: 2, imageAssetId: 'image-b', sourceFilename: 'scene-b.jpg',
      mimeType: 'image/jpeg', imageBase64: 'image-b-base64',
    },
  ],
};

function feasibleResult(value: Record<string, unknown>): Record<string, unknown> {
  const segments = Array.isArray(value.segments) ? value.segments : [];
  return {
    materialAssessment: {
      templateFeasible: true,
      unsupportedNarrativeBeats: [],
      reason: '所选模板的核心阶段都能由候选分镜承接',
    },
    ...value,
    segments: segments.map((segment, index) => ({
      visualRefs: [`visual-${(index % baseInput.visuals.length) + 1}`],
      ...(segment && typeof segment === 'object' ? segment : {}),
    })),
  };
}

const budget = buildScriptDurationBudget(15);
assert.equal(budget.introDurationSec, 20 / 24);
assert.equal(Number(budget.targetNarrationSec.toFixed(6)), 14.166667);
assert.deepEqual([budget.minContentCharacters, budget.maxContentCharacters], [54, 59]);

const legacyAdvisory = buildScriptDurationAdvisory(10);
assert.deepEqual(
  [legacyAdvisory.minContentCharacters, legacyAdvisory.maxContentCharacters],
  [35, 38],
  '混剪字数提醒必须覆盖旧脚本中的非标准目标时长，且不能因此阻止生成',
);
assert.deepEqual(
  [buildScriptDurationAdvisory(10, 0.5).minContentCharacters, buildScriptDurationAdvisory(10, 0.5).maxContentCharacters],
  [18, 19],
  '慢语速必须收紧建议字数，避免预计时长超标却不提醒',
);
assert.deepEqual(
  [buildScriptDurationAdvisory(10, 2).minContentCharacters, buildScriptDurationAdvisory(10, 2).maxContentCharacters],
  [70, 77],
  '快语速应放宽建议字数，避免对可正常完成的文案误提醒',
);

{
  const calls: Array<{ images?: unknown[]; systemPrompt: string; userPrompt: string }> = [];
  const responses = [
    feasibleResult({
      title: '下班后的云感支撑',
      coverTitleParts: { primary: '下班就该这样躺', secondary: '5芯软弹·112°稳稳承托' },
      segments: [{
        id: 'shot-1',
        shotId: 'must-be-ignored',
        imageAssetId: 'must-be-ignored',
        narration: `${'舒适承托'.repeat(20)}。`,
        subtitle: '模型给出的错误字幕！',
        sellingPointRefs: ['112°承托'],
        visualIntent: '人物下班后放松使用场景',
        visualKeywords: ['沙发', '放松'],
      }],
      droppedShots: [{ shotId: 'must-be-ignored' }],
    }),
    feasibleResult({
      title: '下班后的云感支撑',
      coverTitleParts: { primary: '下班就该这样躺', secondary: '5芯软弹·112°稳稳承托' },
      segments: [
        {
          id: 'segment-a',
          narration: '忙碌一天回到家，只想陷进柔软怀抱。',
          subtitle: '不应被信任',
          sellingPointRefs: ['5芯软弹'],
          visualIntent: '人物下班后放松使用场景',
          visualKeywords: ['回家', '放松'],
        },
        {
          id: 'segment-b',
          narration: '112°稳稳承托腰背，久坐之后也能舒服伸展。',
          sellingPointRefs: ['112°承托'],
          visualIntent: '靠背承托状态特写',
          visualKeywords: ['靠背', '承托'],
        },
        {
          id: 'segment-c',
          narration: '5芯软弹层层释压，让每次坐下都轻松自在又安心。',
          sellingPointRefs: ['5芯软弹'],
          visualIntent: '坐垫回弹与材质细节',
          visualKeywords: ['回弹', '材质'],
        },
      ],
    }),
  ];
  const result = await generateScriptV3(baseInput, {
    completeJson: async (request) => {
      calls.push({
        images: request.images,
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt,
      });
      return responses.shift();
    },
  });

  assert.equal(result.attempts, 2, '超长首稿应触发一次完整重写');
  assert.equal(calls.length, 2);
  const expectedImages = [
    { mimeType: 'image/png', imageBase64: 'image-a-base64' },
    { mimeType: 'image/jpeg', imageBase64: 'image-b-base64' },
  ];
  assert.ok(calls.every((call) => JSON.stringify(call.images) === JSON.stringify(expectedImages)), '首次生成和完整重写都必须查看当前分镜组图片');
  assert.match(calls[0].systemPrompt, /必须查看随用户消息附带的全部候选分镜图/);
  assert.match(calls[0].systemPrompt, /必须严格遵循用户消息中的 template 叙事结构和写作规则/);
  const initialPrompt = JSON.parse(calls[0].userPrompt) as {
    template: {
      id: string;
      name: string;
      objective: string;
      narrativeStructure: string[];
      writingRules: string[];
      desiredAudienceResponse: string;
    };
    visualMaterials: Array<{ visualRef: string; imageOrder: number; shotIndex: number }>;
    requirements: string[];
  };
  assert.deepEqual(initialPrompt.template, {
    id: 'scene_seeding',
    name: '场景种草',
    objective: '让目标用户先向往一个具体生活状态，再把产品写成这个场景中自然且必要的一部分。',
    narrativeStructure: [
      '交代目标人群熟悉的时间、地点和人物状态',
      '用动作或感官细节建立生活氛围与代入感',
      '让产品在场景需要中自然出现，不突然推销',
      '把已选卖点转译成场景中的具体体验改善',
      '用令人向往的生活结果或状态收束',
    ],
    writingRules: [
      '开头不得先报参数、品牌口号或促销信息',
      '场景细节必须服务目标人群和真实使用情境，避免空泛堆砌氛围词',
      '所有产品收益必须能追溯到已选卖点，禁止虚构生活效果',
    ],
    desiredAudienceResponse: '“我也想拥有这样的生活，而且这个产品确实适合这个场景。”',
  });
  assert.deepEqual(initialPrompt.visualMaterials, [
    { visualRef: 'visual-1', imageOrder: 1, shotIndex: 1 },
    { visualRef: 'visual-2', imageOrder: 2, shotIndex: 2 },
  ]);
  assert.ok(initialPrompt.requirements.includes(
    '先判断全部 template.narrativeStructure 是否都有附图承接；若任一核心阶段缺少画面，返回 templateFeasible=false 和空 segments，禁止硬写',
  ));
  assert.ok(initialPrompt.requirements.includes(
    '每段必须返回至少一个 visualRefs，并且只能引用 visualMaterials 中真实存在的 visualRef',
  ));
  assert.match(calls[1].userPrompt, /too_long/);
  const rewritePrompt = JSON.parse(calls[1].userPrompt) as {
    template?: { id?: string };
    visualMaterials?: Array<{ visualRef: string }>;
  };
  assert.equal(rewritePrompt.template?.id, 'scene_seeding', '重写不能丢失模板约束');
  assert.deepEqual(rewritePrompt.visualMaterials?.map((item) => item.visualRef), ['visual-1', 'visual-2'], '重写不能丢失视觉素材索引');
  assert.equal(result.script.version, 3);
  assert.equal(result.script.shotSetId, 'set-a');
  assert.equal(result.script.durationStatus, 'qualified');
  assert.equal(result.script.segments[0].subtitle, '忙碌一天回到家 只想陷进柔软怀抱');
  assert.equal(result.script.fullScript, result.script.segments.map((segment) => segment.narration).join('\n'));
  assert.equal(result.script.fullSubtitle, result.script.segments.map((segment) => segment.subtitle).join('\n'));
  assert.ok(result.script.segments.every((segment) => !('shotId' in segment)));
  assert.ok(result.script.segments.every((segment) => !('visualRefs' in segment)), '生成期画面引用不能形成持久化素材绑定');
  assert.ok(result.script.contentCharacterCount >= budget.minContentCharacters);
  assert.ok(result.script.contentCharacterCount <= budget.maxContentCharacters);
}

{
  let calls = 0;
  const result = await generateScriptV3(baseInput, {
    completeJson: async () => {
      calls += 1;
      if (calls === 1) {
        return feasibleResult({
          title: '缺少画面证据',
          coverTitleParts: { primary: '下班就该这样躺', secondary: '112°稳稳承托' },
          segments: [{
            narration: `${'舒适承托'.repeat(13)}安心。`,
            sellingPointRefs: ['112°承托'],
            visualIntent: '',
            visualKeywords: [],
          }],
        });
      }
      return feasibleResult({
        title: '画面可承接脚本',
        coverTitleParts: { primary: '下班就该这样躺', secondary: '112°稳稳承托' },
        segments: [{
          narration: `${'舒适承托'.repeat(13)}安心。`,
          sellingPointRefs: ['112°承托'],
          visualIntent: '附图中可见的沙发靠背承托细节',
          visualKeywords: ['沙发', '靠背', '承托'],
        }],
      });
    },
  });
  assert.equal(result.attempts, 2, '缺少真实画面语义的首稿必须按结构错误完整重写');
}

{
  let calls = 0;
  const result = await generateScriptV3(baseInput, {
    completeJson: async () => {
      calls += 1;
      if (calls === 1) {
        return feasibleResult({
          title: '引用了不存在的图片',
          coverTitleParts: { primary: '下班就该这样躺', secondary: '112°稳稳承托' },
          segments: [{
            narration: `${'舒适承托'.repeat(13)}安心。`,
            sellingPointRefs: ['112°承托'],
            visualIntent: '沙发靠背承托细节',
            visualKeywords: ['沙发', '承托'],
            visualRefs: ['visual-99'],
          }],
        });
      }
      return feasibleResult({
        title: '真实图片可承接脚本',
        coverTitleParts: { primary: '下班就该这样躺', secondary: '112°稳稳承托' },
        segments: [{
          narration: `${'舒适承托'.repeat(13)}安心。`,
          sellingPointRefs: ['112°承托'],
          visualIntent: '附图中可见的沙发靠背承托细节',
          visualKeywords: ['沙发', '靠背', '承托'],
          visualRefs: ['visual-1'],
        }],
      });
    },
  });
  assert.equal(result.attempts, 2, '引用不存在图片的首稿必须按结构错误完整重写');
  assert.ok(result.script.segments.every((segment) => !('visualRefs' in segment)), '校验通过后仍不能持久化图片引用');
}

{
  let calls = 0;
  await assert.rejects(
    generateScriptV3({ ...baseInput, templateId: 'unboxing', templateName: '开箱体验' }, {
      completeJson: async () => {
        calls += 1;
        return {
          materialAssessment: {
            templateFeasible: false,
            unsupportedNarrativeBeats: ['按顺序呈现拆包、取出产品与关键细节'],
            reason: '附图只展示成品，没有包装或拆包过程',
          },
          title: '',
          coverTitleParts: { primary: '', secondary: '' },
          segments: [],
        };
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ScriptGenerationV3Error);
      assert.equal(error.code, 'script_material_mismatch');
      assert.deepEqual(error.details.unsupportedNarrativeBeats, ['按顺序呈现拆包、取出产品与关键细节']);
      assert.equal(error.details.materialReason, '附图只展示成品，没有包装或拆包过程');
      assert.equal(error.details.attempts, 1);
      return true;
    },
  );
  assert.equal(calls, 1, '模板和素材不匹配时应立即停止，不能盲目重试');
}

{
  let calls = 0;
  await assert.rejects(
    generateScriptV3({ ...baseInput, templateId: 'unboxing', templateName: '开箱体验' }, {
      completeJson: async () => {
        calls += 1;
        return {
          materialAssessment: {
            templateFeasible: false,
            unsupportedNarrativeBeats: calls === 1
              ? []
              : calls === 2
                ? ['按顺序呈现拆包、取出产品与关键细节', '模板中不存在的阶段']
                : ['按顺序呈现拆包、取出产品与关键细节'],
            reason: '附图只展示成品，没有包装或拆包过程',
          },
          segments: [],
        };
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ScriptGenerationV3Error);
      assert.equal(error.code, 'script_material_mismatch');
      assert.deepEqual(error.details.unsupportedNarrativeBeats, ['按顺序呈现拆包、取出产品与关键细节']);
      assert.equal(error.details.attempts, 3);
      return true;
    },
  );
  assert.equal(calls, 3, '缺少或混入非法模板阶段的 mismatch 响应必须先修正，不能返回信息不完整的错误');
}

{
  const result = await generateScriptV3(baseInput, {
    completeJson: async () => feasibleResult({
      title: '云感沙发推荐',
      coverTitleParts: {
        primary: '这是一个明显超过建议长度且无法直接用于封面的主标题',
        secondary: '这是一个明显超过建议长度且只是重复主标题意思的副标题',
      },
      segments: [{
        narration: `${'舒适承托'.repeat(13)}安心。`,
        sellingPointRefs: ['112°承托'],
        visualIntent: '产品使用场景',
        visualKeywords: ['产品'],
      }],
    }),
  });
  assert.equal(result.script.coverTitleParts.source, 'system_split');
  assert.ok(Array.from(result.script.coverTitleParts.primary.replace(/[\p{P}\p{S}\s]/gu, '')).length >= 4);
  assert.ok(Array.from(result.script.coverTitleParts.primary.replace(/[\p{P}\p{S}\s]/gu, '')).length <= 10);
  assert.ok(Array.from(result.script.coverTitleParts.secondary.replace(/[\p{P}\p{S}\s]/gu, '')).length >= 6);
  assert.ok(Array.from(result.script.coverTitleParts.secondary.replace(/[\p{P}\p{S}\s]/gu, '')).length <= 14);
}

{
  let calls = 0;
  await assert.rejects(
    generateScriptV3(baseInput, {
      completeJson: async () => {
        calls += 1;
        return feasibleResult({
          title: '始终超长',
          coverTitleParts: { primary: '始终超长', secondary: '仍然没有贴合目标' },
          segments: [{
            narration: `${'超长内容'.repeat(30)}。`,
            sellingPointRefs: ['112°承托'],
            visualIntent: '产品使用场景',
            visualKeywords: ['产品'],
          }],
        });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ScriptGenerationV3Error);
      assert.equal(error.code, 'script_duration_unresolved');
      assert.equal(error.details.attempts, 3);
      return true;
    },
  );
  assert.equal(calls, 3, '首次生成加最多两次修正');
}

{
  const analysisRequests: Array<{ systemPrompt: string; userPrompt: string }> = [];
  const analysis = await analyzeScriptStrategyV3({
    sellingPoints: ['112°承托', '5芯软弹'],
    targetAudience: '久坐上班族',
    platform: '小红书',
  }, {
    completeJson: async (request) => {
      analysisRequests.push({ systemPrompt: request.systemPrompt, userPrompt: request.userPrompt });
      return {
        rankings: [
          { rank: 1, title: '112°承托', priority: 'highest', reason: '直击久坐痛点' },
          { rank: 2, title: '5芯软弹', priority: 'high', reason: '提供舒适证据' },
        ],
        audienceInsight: '关注腰背舒适',
        platformAdvice: '用生活场景建立代入感',
        recommendedTemplate: { id: 'unknown-template', name: '未知模板', reason: '模型建议' },
      };
    },
  });
  assert.equal(analysis.version, 3);
  assert.equal(analysis.recommendationSource, 'system_fallback');
  assert.notEqual(analysis.recommendedTemplate.id, 'unknown-template');
  assert.equal(analysisRequests.length, 1);
  const analysisRequest = analysisRequests[0];
  assert.match(analysisRequest.systemPrompt, /依据每个模板的目标、叙事结构和适用卖点推荐/);
  const analysisPrompt = JSON.parse(analysisRequest.userPrompt) as {
    allowedTemplates: Array<{
      id: string;
      objective: string;
      suitable: string;
      narrativeStructure: string[];
      writingRules: string[];
      desiredAudienceResponse: string;
    }>;
  };
  assert.deepEqual(
    analysisPrompt.allowedTemplates.map((template) => template.id),
    ['pain_point', 'scene_seeding', 'feature_showcase', 'emotional', 'comparison', 'unboxing', 'problem_solving'],
  );
  assert.deepEqual(
    Object.fromEntries(analysisPrompt.allowedTemplates.map((template) => [template.id, template.narrativeStructure[0]])),
    {
      pain_point: '用具体生活场景或问题句直接点出目标人群正在经历的痛点',
      scene_seeding: '交代目标人群熟悉的时间、地点和人物状态',
      feature_showcase: '先亮出最重要且最能影响购买决策的核心功能',
      emotional: '从目标人群熟悉的具体生活时刻切入',
      comparison: '先定义同一个使用场景和明确的比较维度',
      unboxing: '从收到产品或准备开箱的第一时刻开始',
      problem_solving: '明确一个目标人群经常遇到的具体问题',
    },
  );
  assert.ok(analysisPrompt.allowedTemplates.every((template) => (
    template.objective
      && template.suitable
      && template.narrativeStructure.length >= 5
      && template.writingRules.length >= 3
      && template.desiredAudienceResponse
  )));
}

console.log('script generation v3 tests passed');

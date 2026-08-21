import assert from 'node:assert/strict';
import {
  betterCandidate,
  ScriptGenerationV3Error,
  type ScriptCandidate,
  analyzeScriptStrategyV3,
  generateScriptV3,
} from '../lib/script-generation-v3.ts';
import { buildScriptDurationAdvisory, buildScriptDurationBudget } from '../lib/script-duration-policy.ts';
import type { ScriptOutputV3 } from '../lib/script-providers/types.ts';

function candidate(
  qualification: ScriptCandidate['qualification'],
  advisories: string[] = [],
  marker = '',
): ScriptCandidate {
  return {
    qualification,
    advisories,
    script: { version: 3, marker } as unknown as ScriptOutputV3,
  };
}

{
  const firstQualified = candidate('qualified', ['标题兜底'], 'first');
  const secondQualified = candidate('qualified', ['标题兜底'], 'second');
  const fewerAdvisories = candidate('qualified', [], 'fewer');
  const tooShort = candidate('too_short', [], 'short');
  const tooLong = candidate('too_long', [], 'long');

  assert.equal(betterCandidate(null, firstQualified), firstQualified, '无既有候选时直接采用当前候选');
  assert.equal(
    betterCandidate(firstQualified, tooShort),
    firstQualified,
    'qualified 必须优先于非 qualified，即使非 qualified 没有 advisories',
  );
  assert.equal(
    betterCandidate(tooShort, firstQualified),
    firstQualified,
    '后出现 qualified 时必须覆盖先出现的非 qualified',
  );
  assert.equal(
    betterCandidate(firstQualified, fewerAdvisories),
    fewerAdvisories,
    '同为 qualified 时 advisories 少者胜',
  );
  assert.equal(
    betterCandidate(firstQualified, secondQualified),
    firstQualified,
    'advisories 数量相同时必须保留先出现的候选，不能漂移',
  );
  assert.equal(
    betterCandidate(tooShort, tooLong),
    tooShort,
    '两个都非 qualified 时保留先出现的，不比较 too_short/too_long 的先后',
  );
}

const baseInput = {
  projectName: '任务 A',
  productName: '',
  productCode: 'SF-A1',
  productCategory: '家具',
  targetAudience: '久坐上班族',
  tone: '温柔种草',
  platform: '小红书',
  selectedSellingPoints: [
    { sellingPointId: 'selling-point-1', title: '112°承托', priority: 'highest', reason: '缓解久坐疲劳' },
    { sellingPointId: 'selling-point-2', title: '5芯软弹', priority: 'high', reason: '坐感柔软' },
  ],
  templateId: 'scene_seeding',
  templateName: '场景种草',
  targetDurationSec: 15,
  shotSetId: 'set-a',
  visuals: [
    {
      shotId: 'shot-a', shotIndex: 1, imageAssetId: 'image-a', sourceFilename: 'asset-1.png',
      mimeType: 'image/png', imageBase64: 'image-a-base64',
    },
    {
      shotId: 'shot-b', shotIndex: 2, imageAssetId: 'image-b', sourceFilename: 'asset-2.jpg',
      mimeType: 'image/jpeg', imageBase64: 'image-b-base64',
    },
  ],
};

const validCoverTitleParts = {
  primary: '松弛感软弹沙发',
  secondary: '理想客厅必备',
  productCategoryTerm: '沙发',
  primaryStyleModifier: '松弛感',
  primaryEvidenceTerm: '软弹',
  secondaryRole: 'scene_aspiration',
  secondaryQualifier: '理想',
  secondarySceneTerm: '客厅',
  secondaryValuePhrase: '必备',
  visualRefs: ['visual-1', 'visual-2'],
  sellingPointIds: ['selling-point-2'],
};

function feasibleResult(
  value: Record<string, unknown>,
  coverTitleParts: Record<string, unknown> = validCoverTitleParts,
): Record<string, unknown> {
  const segments = Array.isArray(value.segments) ? value.segments : [];
  const normalizedSegments = segments.map((segment, index) => {
    const source = segment && typeof segment === 'object' ? segment as Record<string, unknown> : {};
    const visualKeywords = Array.isArray(source.visualKeywords) && source.visualKeywords.length > 0
      ? [...source.visualKeywords, '客厅', '沙发']
      : source.visualKeywords;
    const sellingPointRefs = Array.isArray(source.sellingPointRefs) ? source.sellingPointRefs : [];
    const sellingPointIds = sellingPointRefs.map((reference) => (
      `selling-point-${baseInput.selectedSellingPoints.findIndex((point) => point.title === reference) + 1}`
    )).filter((id) => id !== 'selling-point-0');
    return {
      visualRefs: [`visual-${(index % baseInput.visuals.length) + 1}`],
      ...source,
      visualKeywords,
      sellingPointIds,
    };
  });
  const usedSellingPointIds = new Set(normalizedSegments.flatMap((segment) => (
    Array.isArray(segment.sellingPointIds) ? segment.sellingPointIds : []
  )));
  const defaultSellingPointUsage = baseInput.selectedSellingPoints.map((point, index) => {
    const sellingPointId = `selling-point-${index + 1}`;
    const used = usedSellingPointIds.has(sellingPointId);
    return {
      sellingPointId,
      status: used ? 'used' : 'omitted_no_visual_support',
      reason: used ? '卖点与对应图片细节一致' : '当前分镜图片没有清晰呈现该卖点',
      visualRefs: used ? ['visual-1', 'visual-2'] : [],
    };
  });
  return {
    materialAssessment: {
      templateFeasible: true,
      unsupportedNarrativeBeats: [],
      reason: '所选模板的核心阶段都能由候选分镜承接',
    },
    ...value,
    coverTitleParts,
    segments: normalizedSegments,
    sellingPointUsage: Array.isArray(value.sellingPointUsage)
      ? value.sellingPointUsage
      : defaultSellingPointUsage,
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
  const requestController = new AbortController();
  const progressEvents: Array<{ phase: string; attempt?: number }> = [];
  const calls: Array<{ images?: unknown[]; systemPrompt: string; userPrompt: string; signal?: AbortSignal }> = [];
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
  const result = await generateScriptV3({
    ...baseInput,
    projectName: '任务 A',
    productName: '',
    productCategory: '家具',
    visuals: baseInput.visuals.map((visual, index) => ({ ...visual, sourceFilename: `asset-${index + 1}.png` })),
  }, {
    completeJson: async (request) => {
      calls.push({
        images: request.images,
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt,
        signal: request.signal,
      });
      return responses.shift();
    },
    signal: requestController.signal,
    onProgress: (progress) => progressEvents.push(progress),
  });

  assert.equal(result.attempts, 2, '超长首稿应触发一次完整重写');
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.signal === requestController.signal), '取消信号必须传到每一次模型请求');
  assert.deepEqual(progressEvents.map(({ phase, attempt }) => ({ phase, attempt })), [
    { phase: 'generating', attempt: 1 },
    { phase: 'validating', attempt: 1 },
    { phase: 'generating', attempt: 2 },
    { phase: 'validating', attempt: 2 },
  ], '进度必须来自真实的模型调用与校验节点');
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
    allowedTemplates?: Array<{ id: string; name: string; suitable: string }>;
    visualMaterials: Array<{ visualRef: string; imageOrder: number; shotIndex: number }>;
    outputContract: {
      coverTitleParts: {
        primary: string;
        secondary: string;
        productCategoryTerm: string;
        primaryStyleModifier: string;
        primaryEvidenceTerm: string;
        secondaryRole: string;
        secondaryQualifier: string;
        secondarySceneTerm: string;
        secondaryValuePhrase: string;
        visualRefs: string;
        sellingPointIds: string;
      };
      sellingPointUsage: Array<Record<string, string>>;
    };
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
  assert.deepEqual(
    initialPrompt.allowedTemplates?.map((template) => template.id),
    ['pain_point', 'scene_seeding', 'feature_showcase', 'emotional', 'comparison', 'unboxing', 'problem_solving'],
    '生成提示词必须把 allowedTemplates 全部传下去，模型才有依据推荐更契合的模板',
  );
  assert.ok(
    initialPrompt.allowedTemplates?.every((template) => template.name && template.suitable),
    'allowedTemplates 必须带 name 和 suitable',
  );
  assert.ok(initialPrompt.requirements.includes(
    '若部分叙事阶段缺少画面承接：仍必须产出完整脚本，把缺失阶段合并或跳过、其余阶段照常推进，并在 unsupportedNarrativeBeats 中原样列出被跳过的阶段；同时在 suggestedTemplateId 给出 allowedTemplates 中更契合当前图片的模板 id。只有全部叙事阶段都无任何画面承接时，才返回 templateFeasible=false 和空 segments。',
  ));
  assert.ok(initialPrompt.requirements.includes(
    '每段必须返回至少一个 visualRefs，并且只能引用 visualMaterials 中真实存在的 visualRef',
  ));
  assert.ok(initialPrompt.requirements.includes(
    '封面标题必须是两段式：primary 使用“可见气质/材质/核心特征 + 具体产品品类”，secondary 使用“场景向往/理想状态/购买理由”；两句都必须独立完整且互相补充',
  ));
  assert.match(initialPrompt.outputContract.coverTitleParts.primary, /温润黑胡桃木床/);
  assert.match(initialPrompt.outputContract.coverTitleParts.secondary, /理想卧室必备/);
  assert.match(initialPrompt.outputContract.coverTitleParts.primaryEvidenceTerm, /selectedSellingPoints/);
  assert.match(initialPrompt.outputContract.coverTitleParts.secondarySceneTerm, /visualKeywords/);
  assert.match(initialPrompt.outputContract.coverTitleParts.sellingPointIds, /sellingPointId/);
  assert.match(initialPrompt.outputContract.sellingPointUsage[0].status, /omitted_no_visual_support/);
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
  assert.deepEqual(result.script.coverTitleParts, {
    primary: '松弛感软弹沙发',
    secondary: '理想客厅必备',
    source: 'model',
  });
  assert.ok(result.script.segments.every((segment) => !('shotId' in segment)));
  assert.ok(result.script.segments.every((segment) => !('visualRefs' in segment)), '生成期画面引用不能形成持久化素材绑定');
  assert.deepEqual(result.script.sellingPointUsage, [{
    sellingPointId: 'selling-point-1',
    title: '112°承托',
    status: 'used',
    reason: '卖点与对应图片细节一致',
  }, {
    sellingPointId: 'selling-point-2',
    title: '5芯软弹',
    status: 'used',
    reason: '卖点与对应图片细节一致',
  }]);
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
  const prompts: string[] = [];
  await assert.rejects(
    generateScriptV3({ ...baseInput, templateId: 'unboxing', templateName: '开箱体验' }, {
      completeJson: async (request) => {
        calls += 1;
        prompts.push(request.userPrompt);
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
      assert.equal(error.details.attempts, 2);
      return true;
    },
  );
  assert.equal(calls, 2, '模板和素材完全不匹配时第 1 次必须按 blocking 重写，第 2 次仍空才抛');
  assert.match(prompts[1] || '', /必须降级出稿，不得返回空 segments/, '重写提示词必须要求模型降级出稿而不是继续返回空 segments');
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
      assert.equal(error.details.attempts, 2, '第 2 次仍返回空 segments 时必须在当次抛出');
      return true;
    },
  );
  assert.equal(calls, 2, '非法模板阶段必须被过滤而不是抛错，二次仍空 segments 即判真失败');
}

{
  let calls = 0;
  const result = await generateScriptV3({ ...baseInput, templateId: 'unboxing', templateName: '开箱体验' }, {
    completeJson: async () => {
      calls += 1;
      return feasibleResult({
        title: '降级出稿',
        segments: [{
          narration: `${'舒适承托'.repeat(13)}安心。`,
          sellingPointRefs: ['112°承托'],
          visualIntent: '附图中可见的客厅沙发使用场景',
          visualKeywords: ['沙发', '客厅'],
          visualRefs: ['visual-1'],
        }],
        materialAssessment: {
          templateFeasible: false,
          unsupportedNarrativeBeats: ['从收到产品或准备开箱的第一时刻开始'],
          reason: '附图没有包装或拆包过程，但能承接其余阶段',
          suggestedTemplateId: 'scene_seeding',
        },
      });
    },
  });
  assert.equal(calls, 1, '部分阶段缺少画面但正文非空时必须降级出稿而不是重试');
  assert.equal(result.attempts, 1);
  assert.ok(result.script.warnings?.some((warning) => (
    warning.code === 'unsupported_narrative_beats'
    && warning.unsupportedNarrativeBeats?.[0] === '从收到产品或准备开箱的第一时刻开始'
    && warning.suggestedTemplateId === 'scene_seeding'
    && warning.suggestedTemplateName === '场景种草'
    && /开箱体验/.test(warning.message)
    && /场景种草/.test(warning.message)
  )), '降级出稿必须携带缺失阶段与建议模板的警告');
}

{
  let calls = 0;
  const result = await generateScriptV3({ ...baseInput, templateId: 'unboxing', templateName: '开箱体验' }, {
    completeJson: async () => {
      calls += 1;
      return feasibleResult({
        title: '非法建议被丢弃',
        segments: [{
          narration: `${'舒适承托'.repeat(13)}安心。`,
          sellingPointRefs: ['112°承托'],
          visualIntent: '附图中可见的客厅沙发使用场景',
          visualKeywords: ['沙发', '客厅'],
          visualRefs: ['visual-1'],
        }],
        materialAssessment: {
          templateFeasible: false,
          unsupportedNarrativeBeats: ['从收到产品或准备开箱的第一时刻开始'],
          reason: '附图没有包装或拆包过程',
          suggestedTemplateId: 'not-a-real-template',
        },
      });
    },
  });
  assert.equal(calls, 1);
  const warning = result.script.warnings?.find((item) => item.code === 'unsupported_narrative_beats');
  assert.ok(warning, '非法 suggestedTemplateId 不影响降级出稿');
  assert.equal(warning?.suggestedTemplateId, undefined, '非法模板建议必须被丢弃');
  assert.equal(warning?.suggestedTemplateName, undefined);
  assert.equal(/更契合/.test(warning?.message || ''), false, '没有合法建议时不得编造模板名');
}

{
  let calls = 0;
  const prompts: string[] = [];
  const result = await generateScriptV3(baseInput, {
    completeJson: async (request) => {
      calls += 1;
      prompts.push(request.userPrompt);
      return feasibleResult({
        title: '云感沙发推荐',
        segments: [{
          narration: `${'舒适承托'.repeat(13)}安心。`,
          sellingPointRefs: ['112°承托'],
          visualIntent: '产品使用场景',
          visualKeywords: ['产品'],
        }],
      }, calls === 1 ? {
        primary: '把周末窝成沙发',
        secondary: '美好生活新选择',
        productCategoryTerm: '沙发',
        primaryStyleModifier: '',
        primaryEvidenceTerm: '软弹',
        secondaryRole: 'scene_aspiration',
        secondaryQualifier: '',
        secondarySceneTerm: '美好生活',
        secondaryValuePhrase: '新选择',
        visualRefs: ['visual-1'],
        sellingPointRefs: ['5芯软弹'],
      } : validCoverTitleParts);
    },
  });
  assert.equal(calls, 2, '不完整主标题或泛化副标题必须触发完整重写，不能用系统截断兜底');
  assert.match(prompts[1], /contract_invalid/);
  assert.deepEqual(result.script.coverTitleParts, {
    primary: '松弛感软弹沙发',
    secondary: '理想客厅必备',
    source: 'model',
  });
  assert.equal('productCategoryTerm' in result.script.coverTitleParts, false);
  assert.equal('secondaryRole' in result.script.coverTitleParts, false);
  assert.equal('visualRefs' in result.script.coverTitleParts, false);
  assert.equal('sellingPointRefs' in result.script.coverTitleParts, false);
}

{
  let calls = 0;
  const result = await generateScriptV3(baseInput, {
    completeJson: async () => {
      calls += 1;
      const coverTitleParts = calls === 1
        ? { ...validCoverTitleParts, visualRefs: ['visual-2'] }
        : calls === 2
          ? {
              ...validCoverTitleParts,
              secondary: '安心客厅安心之选',
              secondaryQualifier: '安心',
              secondaryValuePhrase: '安心之选',
            }
          : validCoverTitleParts;
      return feasibleResult({
        title: '真实依据标题',
        segments: [{
          narration: `${'舒适承托'.repeat(13)}安心。`,
          sellingPointRefs: ['112°承托'],
          visualIntent: '附图中可见的客厅沙发使用场景',
          visualKeywords: ['沙发', '客厅'],
          visualRefs: ['visual-1'],
        }],
      }, coverTitleParts);
    },
  });
  assert.equal(calls, 3, '标题图片与场景词不对应、或组成词内部重复时都必须重写');
  assert.deepEqual(result.script.coverTitleParts, {
    primary: '松弛感软弹沙发',
    secondary: '理想客厅必备',
    source: 'model',
  });
}

{
  let calls = 0;
  const prompts: string[] = [];
  const result = await generateScriptV3(baseInput, {
    completeJson: async (request) => {
      calls += 1;
      prompts.push(request.userPrompt);
      return feasibleResult({
        title: '标题依据与正文不交汇',
        segments: [{
          narration: `${'舒适承托'.repeat(13)}安心。`,
          sellingPointRefs: ['112°承托'],
          visualIntent: '附图中可见的客厅沙发使用场景',
          visualKeywords: ['沙发', '客厅'],
          visualRefs: ['visual-1'],
        }],
      }, calls === 1
        ? { ...validCoverTitleParts, visualRefs: ['visual-2'] }
        : validCoverTitleParts);
    },
  });
  assert.equal(calls, 2, '标题依据与正文段落不交汇时必须定点修正后通过');
  const secondPrompt = JSON.parse(prompts[1]) as { validationIssues?: string[]; requirements?: string[] };
  assert.ok(
    secondPrompt.validationIssues?.some((issue) => issue.includes('「沙发」') && issue.includes('visualKeywords')),
    '修正提示词必须指出品类词缺少正文承接的具体规则',
  );
  assert.ok(
    secondPrompt.validationIssues?.some((issue) => issue.includes('「客厅」') && issue.includes('visualKeywords')),
    '修正提示词必须指出场景词缺少正文承接的具体规则',
  );
  assert.equal(
    secondPrompt.requirements?.[0],
    '逐项修复 validationIssues 列出的全部问题，其余已合规内容保持不变',
    '有具体失配明细时必须要求定点修复',
  );
  assert.equal(result.script.coverTitleParts.primary, '松弛感软弹沙发');
}

{
  let calls = 0;
  await assert.rejects(
    generateScriptV3(baseInput, {
      completeJson: async () => {
        calls += 1;
        return feasibleResult({
          title: '始终不交汇',
          segments: [{
            narration: `${'舒适承托'.repeat(13)}安心。`,
            sellingPointRefs: ['112°承托'],
            visualIntent: '附图中可见的客厅沙发使用场景',
            visualKeywords: ['沙发', '客厅'],
            visualRefs: ['visual-1'],
          }],
        }, { ...validCoverTitleParts, visualRefs: ['visual-2'] });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ScriptGenerationV3Error);
      assert.equal(error.code, 'script_contract_invalid');
      const issues = (error.details as { validationIssues?: string[] }).validationIssues;
      assert.ok(
        Array.isArray(issues) && issues.some((issue) => issue.includes('「沙发」')),
        '最终错误必须携带逐条校验明细，供服务端日志定位',
      );
      return true;
    },
  );
  assert.equal(calls, 3, '三次都失配时按既有上限放弃');
}

{
  let calls = 0;
  const result = await generateScriptV3(baseInput, {
    completeJson: async () => {
      calls += 1;
      if (calls === 1) throw new Error('GPT / OpenAI 返回了无效 JSON。原始回复: {"materialAssessment":...');
      return feasibleResult({
        title: '截断后重试',
        segments: [{
          narration: `${'舒适承托'.repeat(13)}安心。`,
          sellingPointRefs: ['112°承托'],
          visualIntent: '附图中可见的客厅沙发使用场景',
          visualKeywords: ['沙发', '客厅'],
          visualRefs: ['visual-1'],
        }],
      });
    },
  });
  assert.equal(calls, 2, '模型返回截断/非法 JSON 时必须消耗一次修正机会重试，而不是直接终止');
  assert.equal(result.attempts, 2);
}

{
  let calls = 0;
  const result = await generateScriptV3(baseInput, {
    completeJson: async () => {
      calls += 1;
      return feasibleResult({
        title: '卖点采用状态校验',
        segments: [{
          narration: `${'柔软坐感'.repeat(13)}安心。`,
          sellingPointRefs: ['5芯软弹'],
          visualIntent: '附图中的沙发坐垫和客厅环境',
          visualKeywords: ['沙发', '客厅'],
          visualRefs: ['visual-1'],
        }],
        ...(calls === 1 ? {
          sellingPointUsage: [{
            sellingPointId: 'selling-point-1',
            status: 'used',
            reason: '声称正文已经采用',
            visualRefs: ['visual-1'],
          }, {
            sellingPointId: 'selling-point-2',
            status: 'omitted_no_visual_support',
            reason: '声称正文没有采用',
            visualRefs: [],
          }],
        } : {}),
      });
    },
  });
  assert.equal(calls, 2, '卖点采用状态与正文引用不一致时必须重写');
  assert.deepEqual(result.script.sellingPointUsage, [{
    sellingPointId: 'selling-point-1',
    title: '112°承托',
    status: 'omitted_no_visual_support',
    reason: '当前分镜图片没有清晰呈现该卖点',
  }, {
    sellingPointId: 'selling-point-2',
    title: '5芯软弹',
    status: 'used',
    reason: '卖点与对应图片细节一致',
  }]);
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
  let analysisSellingPointIds: string[] = [];
  const analysis = await analyzeScriptStrategyV3({
    sellingPoints: ['"1.婴幼级半青皮，A 类认证透气耐折', '2.1.3mm 黄金厚度，保留自然皮纹'],
    targetAudience: '25-40岁女性',
    platform: '小红书',
  }, {
    completeJson: async (request) => {
      analysisRequests.push({ systemPrompt: request.systemPrompt, userPrompt: request.userPrompt });
      const requestPrompt = JSON.parse(request.userPrompt) as {
        sellingPoints: Array<{ sellingPointId: string }>;
      };
      analysisSellingPointIds = requestPrompt.sellingPoints.map((point) => point.sellingPointId);
      if (analysisRequests.length === 1) {
        return {
          rankings: [{ sellingPointId: 'unknown', rank: 1, reason: '泛化理由' }],
          recommendedTemplate: { id: 'unknown-template', reason: '' },
        };
      }
      return {
        rankings: [
          {
            sellingPointId: analysisSellingPointIds[0],
            rank: 1,
            factors: { audienceFit: 2, platformFit: 2, sellingPointStrength: 3 },
            reason: '材质安全能回应目标人群顾虑，但平台画面表达相对有限',
          },
          {
            sellingPointId: analysisSellingPointIds[1],
            rank: 2,
            factors: { audienceFit: 5, platformFit: 5, sellingPointStrength: 4 },
            reason: '自然皮纹适合小红书近景展示，也符合目标人群对家居质感的关注',
          },
        ],
        audienceInsight: '25-40岁女性更关注材质安全、真实触感和客厅整体质感',
        platformAdvice: '小红书适合从生活场景切入，用材质近景和具体认证建立信任',
        recommendedTemplate: { id: 'scene_seeding', reason: '场景种草能把材质质感转化为生活方式体验' },
      };
    },
  });
  assert.equal(analysis.version, 3);
  assert.equal(analysis.recommendationSource, 'model');
  assert.equal(analysis.recommendedTemplate.id, 'scene_seeding');
  assert.equal(analysisRequests.length, 2, '缺少人群/平台分析或卖点 ID 非法时必须重写，不能静默兜底');
  assert.deepEqual(analysis.rankings.map((ranking) => ({
    sellingPointId: ranking.sellingPointId,
    title: ranking.title,
    rank: ranking.rank,
    priority: ranking.priority,
  })), [{
    sellingPointId: analysisSellingPointIds[1],
    title: '2.1.3mm 黄金厚度，保留自然皮纹',
    rank: 1,
    priority: 'highest',
  }, {
    sellingPointId: analysisSellingPointIds[0],
    title: '"1.婴幼级半青皮，A 类认证透气耐折',
    rank: 2,
    priority: 'high',
  }], '服务端必须按三维评分计算名次，并用稳定 ID 回填用户原文');
  const analysisRequest = analysisRequests[0];
  assert.match(analysisRequest.systemPrompt, /依据每个模板的目标、叙事结构和适用卖点推荐/);
  const analysisPrompt = JSON.parse(analysisRequest.userPrompt) as {
    targetAudience: string;
    platform: string;
    sellingPoints: Array<{ sellingPointId: string; title: string }>;
    outputContract: {
      audienceInsight: string;
      platformAdvice: string;
      rankings: Array<{ sellingPointId: string; factors: Record<string, string> }>;
    };
    allowedTemplates: Array<{
      id: string;
      objective: string;
      suitable: string;
      narrativeStructure: string[];
      writingRules: string[];
      desiredAudienceResponse: string;
    }>;
  };
  assert.equal(analysisPrompt.targetAudience, '25-40岁女性');
  assert.equal(analysisPrompt.platform, '小红书');
  assert.deepEqual(analysisPrompt.sellingPoints.map((point) => point.title), [
    '"1.婴幼级半青皮，A 类认证透气耐折',
    '2.1.3mm 黄金厚度，保留自然皮纹',
  ]);
  assert.ok(analysisPrompt.sellingPoints.every((point) => /^selling-point-[a-f0-9]{16}$/u.test(point.sellingPointId)));
  assert.equal(new Set(analysisPrompt.sellingPoints.map((point) => point.sellingPointId)).size, 2);
  assert.match(analysisPrompt.outputContract.audienceInsight, /目标人群/);
  assert.match(analysisPrompt.outputContract.platformAdvice, /平台/);
  assert.match(analysisPrompt.outputContract.rankings[0].sellingPointId, /sellingPoints/);
  assert.deepEqual(Object.keys(analysisPrompt.outputContract.rankings[0].factors), [
    'audienceFit', 'platformFit', 'sellingPointStrength',
  ]);
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
  assert.match(analysisRequests[1].userPrompt, /validationIssues/);
}

{
  let calls = 0;
  await assert.rejects(
    () => analyzeScriptStrategyV3({
      sellingPoints: ['安全面料', '实木框架'],
      targetAudience: '亲子家庭',
      platform: '抖音',
    }, {
      completeJson: async (request) => {
        calls += 1;
        const requestPrompt = JSON.parse(request.userPrompt) as {
          sellingPoints: Array<{ sellingPointId: string }>;
        };
        const duplicateId = requestPrompt.sellingPoints[0].sellingPointId;
        return {
          audienceInsight: '亲子家庭关注材质安全和耐用性',
          platformAdvice: '抖音适合用直接利益点和可视化证据快速建立认知',
          rankings: [{
            sellingPointId: duplicateId, rank: 1,
            factors: { audienceFit: 5, platformFit: 4, sellingPointStrength: 4 }, reason: '安全价值明确',
          }, {
            sellingPointId: duplicateId, rank: 1,
            factors: { audienceFit: 4, platformFit: 4, sellingPointStrength: 5 }, reason: '重复的非法排名',
          }],
          recommendedTemplate: { id: 'pain_point', reason: '适合直接切入家庭安全顾虑' },
        };
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ScriptGenerationV3Error);
      assert.equal(error.code, 'script_analysis_contract_invalid');
      assert.equal(error.details.kind, 'analysis_contract');
      assert.equal(error.details.attempts, 3);
      assert.ok(error.details.validationIssues.some((issue: string) => issue.startsWith('duplicate_selling_point_id:')));
      assert.ok(error.details.validationIssues.some((issue: string) => issue.startsWith('missing_selling_point_id:')));
      return true;
    },
  );
  assert.equal(calls, 3, '策略分析最多进行三次合同修正，仍失败必须显式报错');
}

{
  let calls = 0;
  await assert.rejects(
    () => analyzeScriptStrategyV3({
      sellingPoints: ['安全面料'],
      targetAudience: '   ',
      platform: '小红书',
    }, {
      completeJson: async () => {
        calls += 1;
        return {};
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ScriptGenerationV3Error);
      assert.equal(error.code, 'script_analysis_contract_invalid');
      assert.equal(error.message, '请先填写目标人群，再进行策略分析');
      assert.equal(error.details.attempts, 0);
      return true;
    },
  );
  assert.equal(calls, 0, '缺少目标人群时不得把泛化任务发送给模型');
}

console.log('script generation v3 tests passed');

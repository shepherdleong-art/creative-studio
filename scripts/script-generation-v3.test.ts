import assert from 'node:assert/strict';
import {
  ScriptGenerationV3Error,
  analyzeScriptStrategyV3,
  generateScriptV3,
} from '../lib/script-generation-v3.ts';
import { buildScriptDurationBudget } from '../lib/script-duration-policy.ts';

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
};

const budget = buildScriptDurationBudget(15);
assert.equal(budget.introDurationSec, 20 / 24);
assert.equal(Number(budget.targetNarrationSec.toFixed(6)), 14.166667);
assert.deepEqual([budget.minContentCharacters, budget.maxContentCharacters], [54, 59]);

{
  const calls: Array<{ images?: unknown[]; userPrompt: string }> = [];
  const responses = [
    {
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
    },
    {
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
    },
  ];
  const result = await generateScriptV3(baseInput, {
    completeJson: async (request) => {
      calls.push({ images: request.images, userPrompt: request.userPrompt });
      return responses.shift();
    },
  });

  assert.equal(result.attempts, 2, '超长首稿应触发一次完整重写');
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.images == null), 'V3 不得发送分镜图片');
  assert.match(calls[1].userPrompt, /too_long/);
  assert.equal(result.script.version, 3);
  assert.equal(result.script.shotSetId, 'set-a');
  assert.equal(result.script.durationStatus, 'qualified');
  assert.equal(result.script.segments[0].subtitle, '忙碌一天回到家 只想陷进柔软怀抱');
  assert.equal(result.script.fullScript, result.script.segments.map((segment) => segment.narration).join('\n'));
  assert.equal(result.script.fullSubtitle, result.script.segments.map((segment) => segment.subtitle).join('\n'));
  assert.ok(result.script.segments.every((segment) => !('shotId' in segment)));
  assert.ok(result.script.contentCharacterCount >= budget.minContentCharacters);
  assert.ok(result.script.contentCharacterCount <= budget.maxContentCharacters);
}

{
  const result = await generateScriptV3(baseInput, {
    completeJson: async () => ({
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
        return {
          title: '始终超长',
          coverTitleParts: { primary: '始终超长', secondary: '仍然没有贴合目标' },
          segments: [{
            narration: `${'超长内容'.repeat(30)}。`,
            sellingPointRefs: ['112°承托'],
            visualIntent: '产品使用场景',
            visualKeywords: ['产品'],
          }],
        };
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
  const analysis = await analyzeScriptStrategyV3({
    sellingPoints: ['112°承托', '5芯软弹'],
    targetAudience: '久坐上班族',
    platform: '小红书',
  }, {
    completeJson: async () => ({
      rankings: [
        { rank: 1, title: '112°承托', priority: 'highest', reason: '直击久坐痛点' },
        { rank: 2, title: '5芯软弹', priority: 'high', reason: '提供舒适证据' },
      ],
      audienceInsight: '关注腰背舒适',
      platformAdvice: '用生活场景建立代入感',
      recommendedTemplate: { id: 'unknown-template', name: '未知模板', reason: '模型建议' },
    }),
  });
  assert.equal(analysis.version, 3);
  assert.equal(analysis.recommendationSource, 'system_fallback');
  assert.notEqual(analysis.recommendedTemplate.id, 'unknown-template');
}

console.log('script generation v3 tests passed');

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { completeJson, getAvailableProviders } from '../script-providers/index.ts';
import {
  parseEntryCount,
  parseModelSelection,
  parseSoundMode,
  parseStructurePlan,
  resolveModelSelection,
  SCRIPT_TITLE_LIMIT,
  STRUCTURE_LABELS,
  structureAt,
  type ModelSelection,
  type SoundMode,
  type StoryStructure,
} from './contract.ts';
import { OneClickFilmError } from './errors.ts';
import type { SellingPointDraft } from './selling-points.ts';
import { getAnalysis, getEntry, listEntries, redraftEntry, type ApplyScriptPlanInput,
  type OneClickFilmAnalysis, type OneClickFilmRun, type ScriptCopy } from './store.ts';

const SCRIPT_SYSTEM_PROMPT = [
  '写一条淘系种草短片。只返回 JSON。按给定结构选最值得讲的卖点，只写素材能支持的内容。',
  '口播像和朋友自然聊天，直接说产品的特点和用起来的感受。素材、详情页和品牌资料只用于核实信息，口播里不要引用出处，也不要念分析过程。',
  '用短句，给停顿留时间。一个卖点讲清楚就够了，不必把已选卖点逐条念完。',
  '同批口播要能独立成片。优先用有依据的不同主卖点；只有一个可讲时，换使用动作、场景或观察角度。与同批口播拉开开头和叙事重点，避免只换几个词。',
  '严格遵守给定的出镜人物设定（cast 与 modelRule）：每镜写明人物身份与符合年龄体型的具体动作，口播视角与人物设定一致；若设为无人物，则只拍产品、材质与空间细节，不写人物全身出镜。',
  '分镜按叙事顺序，给出至少六镜和具体动作，无封面、烧录字幕、花字或音乐。提供旧稿时改写大纲、口播与分镜，不照抄。无配音时口播留空。',
].join('\n');

export function modelScriptDirection(model: ModelSelection): { cast: string; rule: string } {
  switch (model.preset) {
    case 'none':
      return {
        cast: '无出镜人物（纯产品展示）',
        rule: '全片不出现人物全身或正脸（仅必要时可出现局部手部轻触材质），每镜聚焦产品轮廓、表面纹理、结构细节与居家光影，不要写人物走进或坐下。',
      };
    case 'adult_female':
      return {
        cast: '成年女性（约 25–35 岁居家体验者）',
        rule: '每镜明确写“年轻女性”使用产品的日常动作，自然生活化，衣着外观前后一致。',
      };
    case 'adult_male':
      return {
        cast: '成年男性（约 25–35 岁居家体验者）',
        rule: '每镜明确写“年轻男性”使用产品的日常动作，自然生活化，衣着外观前后一致。',
      };
    case 'child':
      return {
        cast: '儿童（约 4–7 岁小朋友，身高体型与产品比例自然匹配）',
        rule: '每镜必须明确写“小朋友”完成符合儿童年龄与体型的真实使用动作（如坐上去、靠背、翻绘本、玩耍等，切勿写成成年人办公或下班放松动作）；如有口播，用家长或大人画外音视角自然分享给孩子用的感受。',
      };
    case 'parent_child':
      return {
        cast: '亲子互动（年轻家长 + 约 4–6 岁小朋友）',
        rule: '每镜明确写家长与小朋友的互动和使用动作（小朋友实际体验产品，家长在旁陪伴、整理或触摸材质），两人外观衣着前后一致；如有口播，用家长画外音视角自然分享。',
      };
    case 'custom':
      return {
        cast: model.custom,
        rule: `每镜必须严格围绕「${model.custom}」写出明确的人物称谓和符合其身份、年龄与体型的具体使用动作，口播视角与该人物设定一致，衣着外观前后一致。`,
      };
    default:
      return {
        cast: '根据产品适用人群自动匹配最合适的单一体验者',
        rule: '先根据产品名称、外观与卖点判断真实适用人群（儿童用品用小朋友或亲子，成人用品用对应成年人），每镜写出明确的人物身份与符合年龄体型的使用动作，不要只笼统写“人物”。',
      };
  }
}
const NARRATION_ATTRIBUTION = /(?:详情页|商品页|产品页|页面|素材|图片|资料)[^，。！？；\n]{0,5}(?:标注|注明|写着|写了|显示|提到|展示|介绍|说明)|(?:据|根据|按照)\s*(?:官方|品牌|详情页|商品页|素材|产品资料)/u;

const NARRATION_DIRECTION: Record<StoryStructure, string> = {
  scene: '从具体日常动作开场，按使用顺序讲亲身感受。',
  result: '第一句直接说一个看得见或感受得到的结果，再回带动作和原因。',
  problem: '第一句提出一个具体困扰，接着用真实的使用动作回应它。',
};

function narrationsOverlap(left: string, right: string): boolean {
  const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 10) return false;
  if (a.slice(0, 10) === b.slice(0, 10)) return true;
  const pairs = (text: string) => new Set(Array.from({ length: text.length - 1 }, (_, i) => text.slice(i, i + 2)));
  const aPairs = pairs(a);
  const bPairs = pairs(b);
  const shared = [...aPairs].filter((pair) => bPairs.has(pair)).length;
  return shared / Math.max(aPairs.size, bPairs.size) >= 0.65;
}

async function generateCopy(input: {
  run: OneClickFilmRun; analysis: OneClickFilmAnalysis; points: string[]; code: string; structure: StoryStructure;
  sound: SoundMode; model: ModelSelection; durationSec: number; aspectRatio: string;
  siblingNarrations: string[];
  previous?: { revision: number; outline: string; narration: string; promptText: string };
}): Promise<ScriptCopy> {
  const provider = getAvailableProviders().find((item) => item.id === input.analysis.providerId && item.configured)
    ?? getAvailableProviders().find((item) => item.configured);
  if (!provider) throw new OneClickFilmError('invalid_input', '没有可用的脚本模型');
  const product = input.analysis.confirmedProductName || input.analysis.productName;
  const resolvedModel = resolveModelSelection(input.model, {
    suggestedModel: input.analysis.suggestedModel,
    product,
    appearance: input.analysis.appearance,
    sceneClues: input.analysis.sceneClues,
    points: input.points,
  });
  const modelGuide = modelScriptDirection(resolvedModel);
  const task = {
    task: 'write_one_click_film_script',
    product,
    appearance: input.analysis.appearance,
    sceneClues: input.analysis.sceneClues,
    evidence: input.points,
    entry: input.code,
    structure: STRUCTURE_LABELS[input.structure],
    narrationDirection: NARRATION_DIRECTION[input.structure],
    cast: modelGuide.cast,
    modelRule: modelGuide.rule,
    siblingNarrations: input.sound === 'none' ? [] : input.siblingNarrations,
    sound: input.sound, duration: input.durationSec,
    aspectRatio: input.aspectRatio, previous: input.previous,
    output: { title: '成片及封面标题，结合本条主卖点，简明具体', angle: 'string', outline: 'string',
      narration: input.sound === 'none' ? '空字符串' : `可直接念的成稿，控制在约 ${Math.floor(input.durationSec * 4)} 字内，句间留停顿`,
      shots: resolvedModel.preset === 'none'
        ? ['景别｜机位和运镜｜产品外观、材质或居家空间细节展示']
        : ['景别｜机位和运镜｜明确出镜人物实际使用产品的动作'] },
  };
  const string = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : '';
  const comparedNarrations = [...task.siblingNarrations, input.previous?.narration ?? ''];
  let issue = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const correction = issue
      ? `上一稿的口播${issue}。请按本条结构换开头和具体叙事重点，用能直接说出口的短句，只讲有素材依据的产品和使用感受，重新返回完整 JSON。`
      : undefined;
    const userPrompt = JSON.stringify({ ...task, correction });
    const revision = createHash('sha256').update(JSON.stringify([SCRIPT_SYSTEM_PROMPT, userPrompt])).digest('hex');
    const response = await completeJson<{
      title?: unknown; angle?: unknown; outline?: unknown; narration?: unknown; shots?: unknown;
    }>({
      providerId: provider.id, systemPrompt: SCRIPT_SYSTEM_PROMPT, userPrompt, maxTokens: 3600,
      usageContext: { enabled: true, projectId: input.run.projectId, refType: 'one-click-film-script', refId: input.run.id },
      executionContext: { taskId: input.run.id, step: `script-${input.code}`, inputRevision: revision,
        scope: { resourceType: 'project', resourceId: input.run.projectId } },
    });
    const title = string(response?.title, SCRIPT_TITLE_LIMIT).replace(/[\r\n]+/g, ' ');
    const angle = string(response?.angle, 240);
    const story = string(response?.outline, 1500);
    const narration = input.sound === 'none' ? '' : string(response?.narration, 1700);
    const directions = Array.isArray(response?.shots) ? response.shots.map((shot) => string(shot, 350)).filter(Boolean).slice(0, 12) : [];
    if (!title || !angle || !story || (input.sound !== 'none' && !narration) || directions.length < 6) {
      throw new OneClickFilmError('invalid_input', `${input.code} 返回的脚本缺少标题、大纲、口播或完整分镜，请重试`);
    }
    if (NARRATION_ATTRIBUTION.test(narration)) issue = '包含素材出处';
    else if (comparedNarrations.some((other) => narrationsOverlap(narration, other))) issue = '与同批文案或本条旧稿过于相似';
    else return { title, angle, story, narration, directions };
  }
  throw new OneClickFilmError('invalid_input', `${input.code} 口播仍${issue}，请调整选用的卖点或结构后重新生成`);
}

export async function generatePlanCopies(db: Database.Database, input: {
  run: OneClickFilmRun; analysis: OneClickFilmAnalysis; points: SellingPointDraft[]; plan: ApplyScriptPlanInput;
}): Promise<Map<number, ScriptCopy>> {
  const count = parseEntryCount(input.plan.count);
  const plan = parseStructurePlan(input.plan.plan);
  const sound = parseSoundMode(input.plan.soundMode);
  const batchModel = input.plan.modelPreset !== undefined
    ? parseModelSelection(input.plan.modelPreset, input.plan.modelCustom)
    : null;
  const points = input.points.filter((point) => point.selected).map((point) => point.text);
  const existing = new Map(listEntries(db, input.run.id, 'all').map((entry) => [entry.ordinal, entry]));
  const copies = new Map<number, ScriptCopy>();
  const siblingNarrations: string[] = [];
  const pending: Array<{ ordinal: number; structure: StoryStructure; model: ModelSelection }> = [];
  for (let ordinal = 1; ordinal <= count; ordinal++) {
    const entry = existing.get(ordinal);
    const structure = structureAt(plan, ordinal - 1);
    const targetModel: ModelSelection = !entry
      ? (batchModel ?? { preset: 'auto', custom: '' })
      : !batchModel || (input.plan.preserveIndividualModel && entry.modelSource === 'individual')
        ? { preset: entry.modelPreset, custom: entry.modelCustom }
        : batchModel;
    if (entry?.structure === structure && entry.analysisId === input.analysis.id
      && entry.productNameSnapshot === (input.analysis.confirmedProductName || input.analysis.productName)
      && JSON.stringify(entry.sellingPointsSnapshot) === JSON.stringify(points)
      && entry.modelPreset === targetModel.preset
      && entry.modelCustom === targetModel.custom) {
      if (entry.narration) siblingNarrations.push(entry.narration);
    } else {
      pending.push({ ordinal, structure, model: targetModel });
    }
  }
  for (const { ordinal, structure, model } of pending) {
    const code = `F${String(ordinal).padStart(2, '0')}`;
    const copy = await generateCopy({
      run: input.run, analysis: input.analysis, points, code, structure, sound, model, siblingNarrations,
      durationSec: input.plan.durationSec ?? 15, aspectRatio: input.plan.aspectRatio ?? '3:4',
    });
    copies.set(ordinal, copy);
    if (copy.narration) siblingNarrations.push(copy.narration);
  }
  return copies;
}

export async function generateRedraft(
  db: Database.Database,
  run: OneClickFilmRun,
  code: string,
  revision?: number,
  overrideModel?: { modelPreset?: unknown; modelCustom?: unknown },
) {
  const entry = getEntry(db, run.id, code);
  if (revision !== undefined && revision !== entry.scriptRevision) return entry;
  const analysis = getAnalysis(db, entry.analysisId);
  if (!analysis) throw new OneClickFilmError('not_found', '该条目引用的素材分析已不存在', 404);
  const nextModel = overrideModel?.modelPreset !== undefined
    ? parseModelSelection(overrideModel.modelPreset, overrideModel.modelCustom)
    : { preset: entry.modelPreset, custom: entry.modelCustom };
  const modelChanged = nextModel.preset !== entry.modelPreset || nextModel.custom !== entry.modelCustom;
  const copy = await generateCopy({
    run, analysis, points: entry.sellingPointsSnapshot, code, structure: entry.structure,
    sound: entry.soundMode, model: nextModel, durationSec: entry.promptDurationSec, aspectRatio: entry.promptAspectRatio,
    siblingNarrations: listEntries(db, run.id).filter((other) => other.id !== entry.id && other.narration).map((other) => other.narration),
    previous: { revision: entry.scriptRevision, outline: entry.outline, narration: entry.narration, promptText: entry.promptText },
  });
  return redraftEntry(db, {
    run,
    code,
    copy,
    expectedRevision: entry.scriptRevision,
    model: nextModel,
    modelSource: modelChanged ? 'individual' : entry.modelSource,
  });
}

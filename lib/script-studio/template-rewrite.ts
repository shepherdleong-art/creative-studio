import { createHash } from 'node:crypto';
import type { FrozenViralTemplateSpec } from './types.ts';
import { scriptTitleRequirements } from './title-policy.ts';

/**
 * 爆文模板改写模式（迁移方案 §4）：从外部项目 index.html 迁移的提示词与本地纯函数。
 * 集中管理：字数口径、文风检测与预设、结构 fallback、筛选/风格/改写/后处理提示词、
 * 响应解析、文字差异（LCS）、残留检查。除注明「适配」处外，提示词均为源项目原文迁移。
 */

export const TEMPLATE_REWRITE_VERSION = 'template-rewrite-v1';

/** 口播语速（字/秒）：口播时长 → 目标字数换算基准（源码 TPL_DUR_WPS=6）。 */
export const TPL_DUR_WPS = 6;

/** 中文字数统计（源码 cnLen：不含标点/空格/字母数字，与 AI 口径一致）。 */
export function cnLen(value: string): number {
  return String(value || '').replace(/[^一-鿿]/g, '').length;
}

/** 目标中文字数 = 秒数 × 6；容差 ±15%（min 下限 20，与源码 fixScriptLength 一致）。 */
export function targetCharsForDuration(durationSec: number): number {
  return Math.max(0, Math.round(durationSec * TPL_DUR_WPS));
}

export function charBoundsForTarget(targetChars: number): { min: number; max: number } {
  return {
    min: Math.max(20, Math.round(targetChars * 0.85)),
    max: Math.round(targetChars * 1.15),
  };
}

/** 字数口径：标题 + 正文（不计段名、标点、空白和修改说明）。 */
export function scriptCnLen(title: string, segments: Array<{ narration: string }>): number {
  return cnLen(title) + segments.reduce((sum, segment) => sum + cnLen(segment.narration), 0);
}

// ---------------------------------------------------------------------------
// 文风检测（迁移 TPL_STYLE_KEYWORDS / detectTplStyle / TPL_STYLE_PRESETS）
// ---------------------------------------------------------------------------

const TPL_STYLE_KEYWORDS: Record<string, { w: number; words: string[] }> = {
  hot: { w: 1.6, words: ['现在拍', '到手价', '马上', '立即', '抢', '秒杀', '仅需', '只要', '划算', '便宜', '亏本', '库存', '下单', '拍下', '优惠', '买它', '冲', '别犹豫', '错过', '最后', '限时', '上车', '福利', '直降', '立减', '拼手速', '家人们'] },
  grass: { w: 1.3, words: ['成分', '功效', '适合', '测评', '使用感受', '质地', '温和', '不刺激', '分享', '教程', '为什么', '因为', '所以', '亲测', '有效', '敏感肌', '肤质', '含量', '配方', '步骤'] },
  feel: { w: 1.3, words: ['故事', '生活', '陪伴', '家人', '孩子', '妈妈', '时光', '心情', '温暖', '治愈', '回忆', '仪式感', '终于', '曾经', '希望', '爱自己', '日子', '瞬间', '岁月', '烟火气'] },
  friend: { w: 1.5, words: ['我跟你说', '姐妹', '闺蜜', '太好用', '绝了', '安利', '回购', '无限回', '爱了', '真的', '巨', '超好用', '墙裂', '必入', '人手一个', '囤', '挖到宝'] },
  expert: { w: 1.5, words: ['参数', '实测', '数据', '结论', '评测', '标准', '对比', '专业', '实验室', '测试', '值不值', '性价比', '续航', '功率', '容量', '尺寸', '性能', '认证', '质保', '售后', '拆解', '升级'] },
};

export type TemplateStylePresetKey = '' | 'hot' | 'grass' | 'feel' | 'friend' | 'expert';

/** 本地文风识别（迁移 detectTplStyle）：关键词打分 + 类目先验，最高 ≥2 才采用，否则通用。 */
export function detectTemplateStyle(t: {
  title?: string; name?: string; refText?: string; structSummary?: string;
  subCategory?: string; category?: string;
}): TemplateStylePresetKey {
  const text = [t.title || '', t.name || '', t.refText || '', t.structSummary || '', t.subCategory || t.category || ''].join('\n');
  if (!text.trim()) return '';
  const lower = text.toLowerCase();
  const scores: Record<string, number> = {};
  for (const [key, cfg] of Object.entries(TPL_STYLE_KEYWORDS)) {
    let score = 0;
    for (const word of cfg.words) {
      const wl = word.toLowerCase();
      let idx = 0;
      while ((idx = lower.indexOf(wl, idx)) !== -1) { score += 1; idx += wl.length; }
    }
    scores[key] = score * cfg.w;
  }
  // 类目先验：3C/家电/数码 → 专家测评；食品/日百/快消/美妆 → 闺蜜安利
  const catText = `${t.category || ''} ${t.subCategory || ''}`;
  if (/3c|数码|家电|电器|手机|电脑|耳机|电视|空调|冰箱|洗衣机|小家电/.test(catText)) scores.expert = (scores.expert || 0) + 2.2;
  if (/食品|零食|饮料|日百|日用|洗护|纸巾|厨房|速食|美妆|个护/.test(catText)) scores.friend = (scores.friend || 0) + 2.2;
  let best: TemplateStylePresetKey = '';
  let bestScore = 0;
  for (const [key, score] of Object.entries(scores)) {
    if (score > bestScore) { best = key as TemplateStylePresetKey; bestScore = score; }
  }
  return bestScore >= 2 ? best : '';
}

export interface TemplateStylePreset {
  name: string;
  role: string;
  guide: string;
  neg: string;
}

/** 文风预设（迁移 TPL_STYLE_PRESETS）：role=系统角色，guide=正文风格约束，neg=文风专属禁止项。 */
export const TPL_STYLE_PRESETS: Record<TemplateStylePresetKey, TemplateStylePreset> = {
  '': { name: '通用（默认）', role: '', guide: '', neg: '' },
  hot: {
    name: '🔥 激情叫卖（直播/信息流）',
    role: '你是抖音带货爆款编剧，擅长3秒钩子+强逼单。',
    guide: '\n\n【文风：激情叫卖】\n- 开头前12个字必须命中一个真实痛点或反差，禁止铺垫客套\n- 卖点用"可感知的动作/结果"描述（如"5秒出雾、机身只有一包纸重"），不用抽象形容词堆砌\n- 结尾逼单必须给出明确行动指令（如"现在拍、到手价XX"）\n- 口语化、有节奏感，多用短句',
    neg: '\n\n【文风禁止】感叹号堆砌、"家人们冲"式空喊',
  },
  grass: {
    name: '🌿 理性种草（小红书/测评）',
    role: '你是成分党/参数党测评博主，口吻克制、证据导向。',
    guide: '\n\n【文风：理性种草】\n- 每个卖点都配一个"为什么有效"的解释\n- 允许一句自嘲或瑕疵坦白提升可信度\n- 结尾不硬逼单，用"可以试试/适合这类人"收尾\n- 少用感叹号，陈述句为主',
    neg: '\n\n【文风禁止】感叹号堆砌、形容词刷屏',
  },
  feel: {
    name: '💗 情感共鸣（品牌向/高客单）',
    role: '你是品牌叙事文案，擅长把产品藏进生活场景。',
    guide: '\n\n【文风：情感共鸣】\n- 开头是"一个画面"而非"一个观点"（具象细节开场）\n- 产品出现在故事中段而非开头\n- 卖点转化为"它如何改变了一天"\n- 结尾温和引导，不命令',
    neg: '\n\n【文风禁止】硬广词、价格直给、命令式口吻',
  },
  friend: {
    name: '💬 闺蜜安利（快消/食品/日百）',
    role: '你是闺蜜式分享者，口语化、有生活气。',
    guide: '\n\n【文风：闺蜜安利】\n- 用"我跟你说…"式口语钩子开场\n- 卖点用"我用了…之后"的体验化表达\n- 加入1个具体生活场景细节\n- 允许感叹词与省略号，结尾催促式收尾',
    neg: '\n\n【文风禁止】书面腔、数据轰炸、官方话术',
  },
  expert: {
    name: '🧪 专家测评（3C/家电/母婴）',
    role: '你是品类工程师/评测专家，结论先行、数据支撑。',
    guide: '\n\n【文风：专家测评】\n- 开头结论先行（"先说结论：…"）\n- 卖点必须有参数或实测支撑\n- 允许给出"适合人群/不适合人群"的客观边界\n- 逼单弱化，强调"值不值"',
    neg: '\n\n【文风禁止】无依据对比、恐吓式营销、虚假参数',
  },
};

/** 合规护栏（迁移 TPL_NEG_HINT）：生成环节注入的负面提示词。 */
export const TPL_NEG_HINT = '\n\n【负面提示词·必须遵守】\n- 禁用极限词/绝对化承诺：最好、最佳、第一、唯一、顶级、极致、100%、零风险、根治、永久、绝对有效等\n- 禁用虚假紧迫：仅此一天、最后一天、限时抢购、错过不再有、秒杀\n- 禁用伪科学/无依据的"专家说"表述\n- 禁用AI套话：总而言之、综上所述、值得拥有、不容错过（空喊式）\n- 每段只讲一个卖点，严禁重复或注水';

/** 生成附加约束（迁移 TPL_GEN_HINT）：痛点精简、结构顺序、人群场景全替换、修改说明要求。 */
export const TPL_GEN_HINT = '。痛点精简：全篇只保留1~2个痛点（选最扎心的），严禁罗列堆砌多个痛点；整体段落顺序严格参考模板结构；产品卖点和用户群体全部替换为本家信息——卖点用我给出的，目标人群按卖点对应人群设定，参考文案里出现的人群、场景、参数一律换成本家的。文末单独用【修改说明】开头另起一段，简要说明相对参考模板改了哪些地方（替换的卖点、更换的用户群体、痛点精简情况）；【修改说明】不计入正文字数统计，正文中不要出现【修改说明】。';

/** 结构 fallback（源码默认）：模板没有结构字段时保留原文并使用该默认。 */
export const TPL_FALLBACK_STRUCTURE = '钩子>痛点>卖点>逼单';

// ---------------------------------------------------------------------------
// 风格分析（迁移 analyzeStyle）
// ---------------------------------------------------------------------------

export interface TemplateStyleAnalysis {
  说话感觉?: string;
  开头词?: string[];
  句长?: string;
  钩子套路?: string;
  结尾方式?: string;
  禁用词?: string[];
}

export function buildStyleAnalysisRequest(refText: string): { systemPrompt: string; userPrompt: string; maxTokens: number } {
  return {
    systemPrompt: '你是个天天刷带货视频的人，一眼就能看出文案是啥风格。分析别人文案的风格特点，输出干净JSON。',
    userPrompt: '看看这个带货文案，告诉我：\n\n1. 这人说话是什么感觉？（像朋友聊天 / 像专家讲课 / 像柜姐推销 / 像自己用过在分享）\n2. 他最爱用什么词开头？（给3-5个例子）\n3. 句子是长的还是短的？\n4. 他用了什么套路吸引人继续看？\n5. 结尾怎么收的？\n6. 有没有什么词他绝对不用？（比如文案里从没出现过"家人们""绝绝子"这种，列2-3个）\n\n输出严格JSON格式：{"说话感觉":"","开头词":[],"句长":"短句多"或"长短混合"或"长句多","钩子套路":"","结尾方式":"","禁用词":[]}\n\n文案：\n' + refText,
    maxTokens: 500,
  };
}

export function parseStyleAnalysis(raw: unknown): TemplateStyleAnalysis | null {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!record) return null;
  const asStringArray = (value: unknown): string[] =>
    (Array.isArray(value) ? value : []).map((item) => String(item ?? '').trim()).filter(Boolean);
  const result: TemplateStyleAnalysis = {};
  if (typeof record['说话感觉'] === 'string' && record['说话感觉'].trim()) result['说话感觉'] = record['说话感觉'].trim();
  const openings = asStringArray(record['开头词']);
  if (openings.length) result['开头词'] = openings;
  if (typeof record['句长'] === 'string' && record['句长'].trim()) result['句长'] = record['句长'].trim();
  if (typeof record['钩子套路'] === 'string' && record['钩子套路'].trim()) result['钩子套路'] = record['钩子套路'].trim();
  if (typeof record['结尾方式'] === 'string' && record['结尾方式'].trim()) result['结尾方式'] = record['结尾方式'].trim();
  const banned = asStringArray(record['禁用词']);
  if (banned.length) result['禁用词'] = banned;
  return Object.keys(result).length > 0 ? result : null;
}

/** 风格要求段（迁移 genScriptViaDoubao 的 styleGuide 拼接，含「开头3秒铁律」）。 */
export function styleGuideFromAnalysis(analysis: TemplateStyleAnalysis | null, refText: string): string {
  if (!analysis) {
    return '\n\n⚠️ 请模仿参考文案的语气节奏与结构，但用我的卖点重写内容，避免逐句照抄。\n';
  }
  let guide = '\n\n【风格要求——照这个来】\n';
  if (analysis['说话感觉']) guide += '- 说话感觉：' + analysis['说话感觉'] + '\n';
  if (analysis['句长']) guide += '- 句长：' + analysis['句长'] + '\n';
  if (analysis['开头词']?.length) guide += '- 多用这些开头：' + analysis['开头词'].join('、') + '\n';
  if (analysis['钩子套路']) guide += '- 钩子套路：' + analysis['钩子套路'] + '\n';
  if (analysis['结尾方式']) guide += '- 结尾：' + analysis['结尾方式'] + '\n';
  if (analysis['禁用词']?.length) guide += '\n别用这些词（原文案里没有）：' + analysis['禁用词'].join('、') + '\n';
  guide += '\n保持它这种说话感觉和节奏，但句子要自己重写、信息要换成我的卖点，不要照抄原句。\n';
  const opening = refText.split(/[。！？!?\n]/).map((x) => x.trim()).filter((x) => x.length > 2).slice(0, 2).join('。');
  if (opening) {
    guide += '【开头3秒铁律】参考文案的开头是："' + opening.slice(0, 80) + '"。你的开头前两句话必须模仿它的句式、语气和钩子节奏——先立钩子再引出产品，禁止铺垫和客套。\n';
  }
  return guide;
}

// ---------------------------------------------------------------------------
// 卖点筛选（迁移 filterTplSellingPoints；适配：稳定组 ID 而非易错的文本切分）
// ---------------------------------------------------------------------------

export interface TemplateFilterCandidate {
  id: string;
  /** 完整「标题（详解）」——不切碎括号描述。 */
  text: string;
}

export function buildFilterRequest(input: { refSnippet: string; candidates: TemplateFilterCandidate[] }): { systemPrompt: string; userPrompt: string; maxTokens: number } {
  return {
    systemPrompt: '你是电商短视频文案卖点甄别助手，负责把用户卖点中与参考爆款同类的部分筛出来。',
    userPrompt: '下面【参考文案】是一个已爆款带货视频的文案，它卖的产品有自己明确的核心卖点和人群。下面【候选卖点】是你要推广的本家产品的卖点列表。\n\n请判断：候选卖点中，哪些与参考文案所卖产品属于同一品类方向、或能对上参考产品的核心卖点/目标人群/使用场景（同类可比、能直接"替换"参考产品讲）？只保留这类卖点。\n\n【参考文案】\n' + input.refSnippet + '\n\n【候选卖点】\n' + input.candidates.map((c) => c.id + '. ' + c.text).join('\n') + '\n\n输出严格JSON格式：{"keep":[编号]}（keep放你要保留的候选卖点编号，按原始顺序，只保留同类/相近的；都不相近则输出{"keep":[]}）。不要输出任何其他文字。',
    maxTokens: 300,
  };
}

/**
 * 解析筛选结果（迁移 keep 语义）：非法/越界编号剔除；keep 为空表示全不相似，
 * 由调用方降级保留全部输入卖点（与源码一致，不丢卖点）。
 */
export function parseFilterKeep(raw: unknown, candidateIds: string[]): string[] | null {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!record || !Array.isArray(record.keep)) return null;
  const keep: string[] = [];
  for (const value of record.keep) {
    const id = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
    if (id && candidateIds.includes(id) && !keep.includes(id)) keep.push(id);
  }
  return keep;
}

// ---------------------------------------------------------------------------
// 首稿 / 字数修正（迁移 genScriptViaDoubao + TPL_GEN_HINT + fixScriptLength 修正语义）
// 适配：JSON 输出包装（结构转换不额外重写口播）；修复请求带当前稿件与原约束（有意修复源缺陷）。
// ---------------------------------------------------------------------------

export interface TemplateDraftPromptInput {
  /** 本模板冻结白名单卖点的完整「标题（详解）」文本列表。 */
  sellingPointTexts: string[];
  refText: string;
  structure: string;
  styleGuide: string;
  stylePresetGuide: string;
  stylePresetNeg: string;
  targetChars: number;
  previousTitles: string[];
  /** 字数修正：带当前字数与目标；为空表示首稿。 */
  fixHint?: string;
  /** 字数/残留修正时的当前稿件（源缺陷修复：修正请求必须带当前稿）。 */
  currentDraft?: string;
}

export function buildDraftRequest(input: TemplateDraftPromptInput): { systemPrompt: string; userPrompt: string; maxTokens: number } {
  const sp = input.sellingPointTexts.map((text, index) => `${index + 1}. ${text}`).join('\n');
  const { min, max } = charBoundsForTarget(input.targetChars);
  const fixSec = input.fixHint ? ('\n\n【字数修正】' + input.fixHint) : '';
  const draftSec = input.currentDraft
    ? '\n\n【当前稿件——在它的基础上修正，保留合格内容与【段名】结构】\n' + input.currentDraft
    : '';
  const prevSec = input.previousTitles.length ? '\n\n已生成标题（请避开）：' + input.previousTitles.join(' / ') : '';
  const structSec = input.structure ? '\n\n用【段名】标注段落\n结构：' + input.structure : '';
  const refSection = '\n\n【参考文案——请逐句对照模仿】\n' + input.refText;
  const systemPrompt = '你是带货文案改写专家。参考文案只是"骨架"：你要借鉴它的语气、节奏、开头钩子和结构，但内容必须围绕我给你的【产品卖点】重新组织——把参考里讲它家产品的话，全部换成讲我家的产品（参数/材质/功能/场景/人群都要换成本家卖点对应的说法）。禁止直接照抄参考文案的成句，改动要明显但读起来自然、口语化。广告法要守。';
  const userPrompt = '借鉴下面的参考文案（作为语气/节奏/结构参考），用我给出的【产品卖点】重新写本家产品文案：参考文案里的产品名、材质、尺寸、价格、场景、人群等凡是它家产品专属的信息，一律替换成我卖点里的本家信息；意思要换着说、句子要重写，避免与参考文案逐字相同。\n\n输出格式（必须严格遵守）：只返回一个 JSON 对象 {"title":"方案标题（4-16字，仿参考标题风格）","coverTitleParts":{"primary":"封面主标题（4-12字，人群/痛点/场景钩子）","secondary":"封面副标题（4-10字，具体卖点/收益）"},"note":"修改说明","segments":[{"label":"段名","text":"正文","refs":["1"]}]}；正文每段一个【段名】；refs 填该段实际用到的【产品卖点】编号（至少一段要有引用，不引用卖点的段填 []）。\n全篇总字数必须约' + input.targetChars + '字（仅计方案标题和正文的中文字数，不含封面主副标题与标点符号；合格范围 ' + min + '~' + max + ' 字），写完自己数一遍，超了精简、少了补足；每段只讲一个卖点，严禁重复；不要在正文输出字数统计之类的注释；note 写【修改说明】内容（相对参考模板改了哪些地方），没有可说明的留空字符串' + fixSec + TPL_GEN_HINT + draftSec + '\n\n我的产品卖点：\n' + sp + structSec + refSection + input.styleGuide + prevSec + '\n\n不碰广告法违禁词。' + input.stylePresetGuide + (input.stylePresetNeg || '') + TPL_NEG_HINT + '\n\n【标题要求】\n' + scriptTitleRequirements({ requireCoverHook: true }).join('\n');
  return { systemPrompt, userPrompt, maxTokens: 3000 };
}

// ---------------------------------------------------------------------------
// 去 AI 味（迁移 humanize）与朗读流畅检查（迁移 smoothCheckScript）
// 可选润色：网络/格式失败保留上一有效稿并记录降级。
// ---------------------------------------------------------------------------

export function buildHumanizeRequest(text: string): { systemPrompt: string; userPrompt: string; maxTokens: number } {
  return {
    systemPrompt: '你是改写文案的。把AI写的东西改成真人说话的样子。',
    userPrompt: '把这段话改得更像真人说的：\n\n1. 每句话开头别重复——别连着用"它""这款""而且"开头\n2. 打破AI最爱的套路："不仅...而且..."换掉、"让您..."改成"让你..."、"带来...体验"直接说具体感受\n3. 长句子（超过15字）拆短\n4. 加1-2个语气词（嗯、真的、说实话），别加太多\n5. 去掉无意义的夸装词（极致、非凡、前所未有的）\n6. 结尾别用"赶紧""马上""现在就"—换成自然收尾\n\n保留所有产品卖点，总字数必须与原文一致（上下浮动不超过5字），不得扩写，不得新增重复内容。\n\n输出格式：只返回 JSON 对象 {"text":"改写后的完整文案（保留【段名】分段）"}。\n\n原文：\n' + text,
    maxTokens: 2000,
  };
}

export function buildSmoothCheckRequest(full: string): { systemPrompt: string; userPrompt: string; maxTokens: number } {
  return {
    systemPrompt: '你是带货口播文案审校，专门检查文案"读出来顺不顺"。',
    userPrompt: '请把下面文案**出声朗读一遍**，找出读起来拗口、磕绊、书面化、断句不顺的地方，做最小修改让口播更顺畅自然（例如：长句拆成短句、把"以便/从而/因此/从而"这类书面词换成口语说法、调整别扭的语序）。要求：\n1) 保留【】分段标签和内容意思，不增删卖点\n2) 每段内容与原文一致，总字数接近原文（±20字内）\n3) 如果整篇读起来已经顺畅，就原样返回，不要改\n\n输出格式：只返回 JSON 对象 {"text":"检查后的完整文案（保留【段名】分段）"}。\n\n文案：\n' + full,
    maxTokens: 2500,
  };
}

// ---------------------------------------------------------------------------
// 修改说明（迁移 ensureTplNote）：首稿 note 缺失且预算有余时才补生成。
// ---------------------------------------------------------------------------

export function buildEnsureNoteRequest(input: { refText: string; body: string; sellingPointText: string }): { systemPrompt: string; userPrompt: string; maxTokens: number } {
  return {
    systemPrompt: '你是文案修改说明的记录员。',
    userPrompt: '请对比「参考模板文案」与「最终生成文案」，输出一段【修改说明】（3-5句话，不要标题前缀）：1) 替换了哪些产品卖点/参数；2) 目标用户群体换成了什么人群；3) 痛点精简到几个、分别是什么；4) 保留了参考模板的什么结构。\n\n输出格式：只返回 JSON 对象 {"note":"修改说明内容"}。\n\n参考模板文案：\n' + (input.refText || '（无）') + '\n\n最终生成文案：\n' + input.body + '\n\n用户产品卖点：\n' + input.sellingPointText,
    maxTokens: 600,
  };
}

// ---------------------------------------------------------------------------
// 响应解析（迁移 genScriptViaDoubao 的标题/分段解析、元注释清洗、extractScriptNote）
// ---------------------------------------------------------------------------

export interface TemplateDraftParsed {
  title: string;
  coverTitleParts: { primary: string; secondary: string };
  segments: Array<{ label: string; text: string; refs: string[] }>;
  note: string;
}

/** 修改说明单独提取（迁移 extractScriptNote）：【修改说明】等段/尾注独立成 note，正文不混入。 */
export function extractScriptNote(segments: Array<{ label: string; text: string; refs?: string[] }>): { segments: Array<{ label: string; text: string; refs: string[] }>; note: string } {
  let note = '';
  const out: Array<{ label: string; text: string; refs: string[] }> = [];
  for (const seg of segments || []) {
    const label = (seg.label || '').trim();
    const text = (seg.text || '').trim();
    if (!text) continue;
    if (/^(修改说明|修正说明|调整说明|修改备注|备注|已修改|修改后|按意见|注[：:]?)/.test(label)) {
      note = (note ? note + '\n' : '') + text;
      continue;
    }
    const lines = text.split('\n');
    let cut = -1;
    for (let k = 0; k < lines.length; k += 1) {
      if (/^(修改说明|修正说明|调整说明|修改备注|备注|说明|已修改|已按|修改后|注)[：:]?/.test(lines[k]!.trim())) { cut = k; break; }
    }
    if (cut >= 0) {
      const head = lines.slice(0, cut).join('\n').trim();
      const tail = lines.slice(cut).join('\n').trim();
      if (head) out.push({ label, text: head, refs: seg.refs ?? [] });
      if (tail) note = (note ? note + '\n' : '') + tail;
    } else {
      out.push({ label, text, refs: seg.refs ?? [] });
    }
  }
  return { segments: out, note };
}

function cleanMetaSegments<T extends { label: string; text: string }>(segments: T[]): T[] {
  // 清洗 AI 元注释（字数统计/修正说明/已修改等——不进正文不复制），迁移源码过滤规则。
  return segments.filter((seg) => {
    const txt = (seg.text || '').trim();
    if (!txt) return false;
    const flat = txt.replace(/[（()）\s]/g, '');
    if (/^(字数|全文|当前约|目标约|已按|已为您|已修改|已完成|已精简|已扩写|以上为|以上是|本条文案|本段文案|字数修正|修正说明|统计|备注|注[：:]|输出说明|提示)/.test(flat)) return false;
    if (/^(字数|全文共|本文共|当前约|目标约|已精简|已扩写|已修改|已完成|以上|说明|备注|统计|注[：:])/.test(flat)) return false;
    if (/字数[：:]?\d+\s*字|已(精简|扩写|修改|调整)[^。！？!?]{0,12}$/.test(txt)) return false;
    return true;
  });
}

/** 解析「标题：… + 【段名】…」文本（humanize/smooth 返回的文本也走这里，与源码同规则）。 */
export function parseSegmentedText(text: string): { title: string; segments: Array<{ label: string; text: string }> } {
  let title = '';
  let bodyText = String(text || '');
  const titleMatch = bodyText.match(/^[\s\r\n]*标题[：:]\s*(.+?)(?:\n|$)/) || bodyText.match(/\n标题[：:]\s*(.+?)(?:\n|$)/);
  if (titleMatch) {
    title = titleMatch[1]!.trim().replace(/[《》""'「」]/g, '').trim();
    bodyText = bodyText.replace(titleMatch[0], '').replace(/^\s+/, '').trim();
  }
  const segments: Array<{ label: string; text: string }> = [];
  let currentLabel = '文案';
  let currentText = '';
  for (const line of bodyText.split('\n').filter((l) => l.trim())) {
    const m = line.match(/^【(.+?)】/);
    if (m) {
      if (currentText) {
        const t = currentText.trim();
        if (t && t !== '正文' && t !== '正文：' && t !== '正文:' && t !== '标题') segments.push({ label: currentLabel, text: t });
        currentText = '';
      }
      currentLabel = m[1]!.trim();
      currentText = line.replace(/^【.+?】/, '').trim() + '\n';
    } else if (/^标题[：:]\s*\S/.test(line.trim()) || /^正文[：:]?\s*$/.test(line.trim())) {
      continue;
    } else {
      currentText += line + '\n';
    }
  }
  if (currentText) {
    const t = currentText.trim();
    if (t && t !== '正文' && t !== '正文：' && t !== '正文:' && t !== '标题') segments.push({ label: currentLabel, text: t });
  }
  if (segments.length === 0 && bodyText.trim()) segments.push({ label: '文案', text: bodyText.trim() });
  return { title, segments };
}

/** 解析首稿 JSON 响应；结构非法返回 null（调用方按生成失败处理）。 */
export function parseDraftResponse(raw: unknown): TemplateDraftParsed | null {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!record) return null;
  const rawSegments = Array.isArray(record.segments) ? record.segments : [];
  const segments: Array<{ label: string; text: string; refs: string[] }> = [];
  for (const item of rawSegments) {
    const seg = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const label = typeof seg.label === 'string' ? seg.label.trim() : '';
    const text = typeof seg.text === 'string' ? seg.text.trim() : (typeof seg.narration === 'string' ? (seg.narration as string).trim() : '');
    const refs = (Array.isArray(seg.refs) ? seg.refs : (Array.isArray(seg.sellingPointIds) ? seg.sellingPointIds : []))
      .map((value) => String(value ?? '').trim()).filter(Boolean);
    if (text) segments.push({ label: label || '文案', text, refs });
  }
  if (!segments.length) return null;
  const cleaned = extractScriptNote(cleanMetaSegments(segments));
  if (!cleaned.segments.length) return null;
  const note = [typeof record.note === 'string' ? record.note.trim() : '', cleaned.note].filter(Boolean).join('\n').trim();
  const title = (typeof record.title === 'string' ? record.title : '').trim().replace(/[《》""'「」]/g, '').trim();
  const cover = record.coverTitleParts && typeof record.coverTitleParts === 'object'
    ? record.coverTitleParts as Record<string, unknown> : {};
  return {
    title,
    coverTitleParts: {
      primary: typeof cover.primary === 'string' ? cover.primary.trim() : '',
      secondary: typeof cover.secondary === 'string' ? cover.secondary.trim() : '',
    },
    segments: cleaned.segments,
    note,
  };
}

/** humanize/smooth 的 JSON 包装文本解析（迁移源码的重解析与「大改动丢弃」守卫）。 */
export function parsePolishedText(raw: unknown): string | null {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const text = typeof record?.text === 'string' ? record.text.trim() : '';
  if (text.length < 10 || !text.includes('【')) return null;
  return text;
}

// ---------------------------------------------------------------------------
// 参考产品信息残留检查（迁移方案 §4.4 终检）：正文与参考文案不得有连续成句照抄。
// ---------------------------------------------------------------------------

export const RESIDUAL_RUN_MIN = 12;

/** 生成文本中与参考文案连续相同 ≥12 个中文字片段（疑似参考产品信息残留/逐句照抄）。 */
export function findResidualRuns(refText: string, generatedText: string, minRun: number = RESIDUAL_RUN_MIN): string[] {
  const normalize = (value: string) => String(value || '').replace(/[^一-鿿]/g, '');
  const ref = normalize(refText);
  const gen = normalize(generatedText);
  const hits: string[] = [];
  if (ref.length < minRun || gen.length < minRun) return hits;
  for (let i = 0; i + minRun <= gen.length; i += 1) {
    const window = gen.slice(i, i + minRun);
    if (ref.includes(window)) {
      // 扩展命中片段到最长，避免重复报告重叠窗口。
      let end = i + minRun;
      while (end < gen.length && ref.includes(gen.slice(i, end + 1))) end += 1;
      const run = gen.slice(i, end);
      if (!hits.some((existing) => existing.includes(run))) hits.push(run);
      i = end - 1;
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 文字差异（迁移 diffMark 的 LCS 词级 diff）：实现已上移到 diff-mark.ts 与前端共用；
// 只标「文字差异」，不宣称原创率/语义相似度/合规证明。
// ---------------------------------------------------------------------------
export { diffMarkWords, type DiffMarkWord } from './diff-mark.ts';

/** 模板计划指纹（恢复校验）：任务快照的模板全文与顺序变化时不得复用中间态。 */
export function templatePlanFingerprint(templates: FrozenViralTemplateSpec[]): string {
  return createHash('sha256').update(JSON.stringify(
    templates.map((t) => [t.entryId, t.contentHash, t.refText.length, t.structure]),
  )).digest('hex');
}

/** 冻结模板计划解析（任务快照 → 强类型；非法即抛 invalid_input，不静默修复）。 */
export function parseFrozenTemplatePlan(value: unknown): FrozenViralTemplateSpec[] {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const list = record && Array.isArray(record.templates) ? record.templates : null;
  if (!list || list.length === 0) return [];
  const out: FrozenViralTemplateSpec[] = [];
  for (const item of list) {
    const t = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const asStr = (v: unknown) => (typeof v === 'string' ? v : '');
    const entry: FrozenViralTemplateSpec = {
      entryId: asStr(t.entryId),
      revisionId: asStr(t.revisionId),
      sourceTemplateId: asStr(t.sourceTemplateId),
      name: asStr(t.name),
      title: asStr(t.title),
      category: asStr(t.category),
      subCategory: asStr(t.subCategory),
      refText: asStr(t.refText),
      structure: asStr(t.structure) || TPL_FALLBACK_STRUCTURE,
      structureOrigin: t.structureOrigin === 'source' ? 'source' : 'fallback',
      contentHash: asStr(t.contentHash),
    };
    if (!entry.entryId || !entry.refText || !entry.contentHash) return [];
    out.push(entry);
  }
  return out;
}

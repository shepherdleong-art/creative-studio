import { STRUCTURE_LABELS, type ModelSelection, type SoundMode, type StoryStructure } from './contract.ts';

/**
 * 分镜提示词构建：只产出确定性的文本，不调用模型。
 *
 * 契约要点（PRD「步骤间的确认与版本」「声音和生成参数」）：
 * - 每条含产品与场景约束、叙事结构、按起止时间排列的分镜、景别、运镜、人物动作及声音安排；
 * - 时间码覆盖目标正文，从正文第 0 秒起算（封面到第五步才加）；
 * - 原生画外音要求人物自然使用产品、旁白在画外讲述；TTS 与不配音只要求环境声与动作声。
 */

export interface FilmSubject {
  product: string;
  appearance: string;
  points: string[];
  genre: string;
  model?: ModelSelection;
}

export function modelPromptLine(model?: ModelSelection): string {
  switch (model?.preset) {
    case 'none':
      return '人物：无出镜人物，纯产品与居家空间展示，不要出现人物全身或正脸。';
    case 'adult_female':
      return '人物：同一位约 25–35 岁成年女性体验者，日常居家穿搭，衣着、外貌和动作前后一致。';
    case 'adult_male':
      return '人物：同一位约 25–35 岁成年男性体验者，日常居家穿搭，衣着、外貌和动作前后一致。';
    case 'child':
      return '人物：同一位约 4–7 岁儿童（小朋友），身高体型与产品比例自然匹配，穿舒适日常童装，全片外貌、衣着和动作前后一致。';
    case 'parent_child':
      return '人物：同一组亲子（一位年轻家长与一位约 4–6 岁小朋友），孩子身高体型与产品比例自然匹配，两人衣着居家协调、外貌前后一致。';
    case 'custom': {
      const custom = model.custom?.trim();
      return custom
        ? `人物：${custom}，体型比例与产品自然匹配，全片外貌、衣着和动作前后一致。`
        : '人物：同一位体验者，衣着、外观和动作前后一致。';
    }
    default:
      return '人物：同一位体验者，衣着、外观和动作前后一致。';
  }
}

/** 只替换全局设定里的「人物：...」行，保留用户手改的其他分镜与叙事。 */
export function replaceModelLine(text: string, model?: ModelSelection): string {
  const line = modelPromptLine(model);
  if (/^人物：.*$/m.test(text)) {
    return text.replace(/^人物：.*$/m, line);
  }
  return text;
}

function actorLabelFor(model?: ModelSelection): string {
  switch (model?.preset) {
    case 'adult_female':
      return '年轻女性';
    case 'adult_male':
      return '年轻男性';
    case 'child':
      return '小朋友';
    case 'parent_child':
      return '小朋友和家长';
    case 'custom':
      return model.custom?.trim() || '体验者';
    default:
      return '人物';
  }
}

export interface PromptBuildInput {
  subject: FilmSubject;
  structure: StoryStructure;
  sound: SoundMode;
  title: string;
  angle: string;
  story: string;
  narration: string;
  durationSec: number;
  aspectRatio: string;
  directions?: string[];
}

interface Beat {
  weight: number;
  direction: string;
}

/** 结构 → 分镜节拍。每个结构至少 6 镜，覆盖正文时长。 */
function beatsFor(input: PromptBuildInput, focus: string): Beat[] {
  const { product, appearance, model } = input.subject;
  const scene = appearance || '参考素材中的真实使用场景';
  if (model?.preset === 'none') {
    const entry: Beat = { weight: 2, direction: `全景｜场景入口，缓慢推近｜呈现${scene}中的${product}全貌与空间光影。` };
    const contact: Beat = { weight: 2, direction: `中景｜产品斜侧面，平稳环绕｜展示${product}的整体轮廓与外观结构。` };
    const action: Beat = { weight: 2.5, direction: `中近景｜产品正面，缓慢横移｜聚焦${product}的表面纹理与细节做工。` };
    const detail: Beat = { weight: 2, direction: `特写｜产品外侧，缓慢靠近｜围绕「${focus}」拍清${product}的关键细节，只使用参考素材可见的外观。` };
    const result: Beat = { weight: 2.5, direction: `中景｜产品正侧方，固定机位｜自然光下停留展示${product}的质感与整体比例。` };
    const close: Beat = { weight: 2, direction: `全景｜场景一侧，缓慢拉远｜在同一空间中自然收尾，呈现${product}与环境的融合。` };
    const question: Beat = { weight: 2, direction: `近景｜产品侧前方，轻推｜对准「${focus}」对应的部位，用细节构图带出体验疑问。` };
    const check: Beat = { weight: 2, direction: `近景｜回到开场同一角度，镜头稳定｜清晰展示${product}对应部位的真实状态，回应开头疑问。` };
    if (input.structure === 'result') {
      return [result, entry, contact, detail, action, { ...close, direction: `中景｜回到开场机位，缓慢拉远｜重现开头的产品质感与空间氛围。` }];
    }
    if (input.structure === 'problem') return [question, entry, contact, action, detail, check, close];
    return [entry, contact, action, detail, result, close];
  }

  const actor = actorLabelFor(model);
  const entry: Beat = { weight: 2, direction: `全景｜场景入口，平视侧跟｜${actor}走进${scene}，与${product}自然同框。` };
  const contact: Beat = { weight: 2, direction: `中景｜人物斜侧面，跟随手部轻推｜${actor}走近${product}，伸手接触外观可见的部位。` };
  const action: Beat = { weight: 2.5, direction: `中近景｜人物侧面，顺动作横移｜${actor}连续完成一次日常使用动作，让与${product}的接触清楚可见。` };
  const detail: Beat = { weight: 2, direction: `特写｜产品外侧，缓慢靠近｜围绕「${focus}」拍清与${product}接触的一处细节，只使用参考素材可见的外观。` };
  const result: Beat = { weight: 2.5, direction: `中景｜人物正侧方，固定机位｜${actor}完成使用后稍作停留，用表情和动作交代感受，与${product}同框。` };
  const close: Beat = { weight: 2, direction: `全景｜场景一侧，缓慢拉远｜${actor}继续使用${product}，在同一空间自然收尾。` };
  const question: Beat = { weight: 2, direction: `近景｜人物侧前方，轻推｜${actor}在接触${product}前短暂停顿，用动作带出对「${focus}」的疑问。` };
  const check: Beat = { weight: 2, direction: `近景｜回到开场同一角度，镜头稳定｜${actor}再次尝试刚才的动作，呈现实际体验对开头疑问的回答。` };

  if (input.structure === 'result') {
    return [result, entry, contact, detail, action, { ...close, direction: `中景｜回到开场机位，缓慢拉远｜重现开头的使用状态，让观众理解为什么喜欢这个时刻。` }];
  }
  if (input.structure === 'problem') return [question, entry, contact, action, detail, check, close];
  return [entry, contact, action, detail, result, close];
}

function timedLines(items: Beat[], durationSec: number, label: string): string[] {
  const total = items.reduce((sum, item) => sum + item.weight, 0) || 1;
  let cumulative = 0;
  return items.map((item, index) => {
    const start = cumulative / total * durationSec;
    cumulative += item.weight;
    const end = cumulative / total * durationSec;
    return `${label}${index + 1}｜${start.toFixed(1)}–${end.toFixed(1)}s｜${item.direction}`;
  });
}

/** 与原型一致：正文按句切分，逐句对时；原生画外音时写入提示词。 */
export function narrationLines(narration: string): string[] {
  return (narration.match(/[^。！？!?\n]+[。！？!?]?/g) || []).map((line) => line.trim()).filter(Boolean);
}

export function buildPromptBlocks(input: PromptBuildInput): string[] {
  const focus = input.subject.points[0] || '日常使用体验';
  const beats = input.directions?.length ? input.directions.map((direction) => ({ direction, weight: 1 })) : beatsFor(input, focus);
  const lines = narrationLines(input.narration);
  const nativeVoiceGuide = input.subject.model?.preset === 'none'
    ? '原生画外音，口吻像在向朋友介绍实际体验。画面专注展示产品与空间，旁白在画外连续讲述。'
    : '原生画外音，口吻像在向朋友介绍实际体验。人物自然使用产品，旁白在画外连续讲述。';
  const voice = input.sound === 'native'
    ? [
        '【配音安排】',
        nativeVoiceGuide,
        ...timedLines(lines.map((line) => ({ weight: line.length, direction: line })), input.durationSec, '旁白'),
      ]
    : ['【声音要求】', '仅保留现场环境声与动作声，无旁白、对白、歌声或背景音乐。'];

  return [
    `【${input.durationSec} 秒 · ${input.subject.genre} · ${input.aspectRatio} 画幅】`,
    [
      '【全局设定】',
      modelPromptLine(input.subject.model),
      `产品：${input.subject.product}。全片以参考素材为准。`,
      `场景：${input.subject.appearance || '参考素材中的真实使用场景'}。`,
      `卖点：${input.subject.points.join('、')}。`,
      '画面：生活流，自然光，动作衔接剪切。不要生成可读字幕、花字、水印或背景音乐。',
    ].join('\n'),
    `【叙事】\n${input.title} · ${STRUCTURE_LABELS[input.structure]}\n${input.angle}\n${input.story}`,
    [`【分镜 · ${beats.length} 镜】`, ...timedLines(beats, input.durationSec, '镜')].join('\n'),
    voice.join('\n'),
  ];
}

export function buildPrompt(input: PromptBuildInput): string {
  return buildPromptBlocks(input).join('\n\n');
}

/**
 * 只替换提示词里的声音安排段，保留其余手写正文。
 * 切换整批配音方式时用它，避免把用户改过的分镜和叙事重写掉。
 */
export function replaceVoiceSection(text: string, input: {
  sound: SoundMode;
  narration: string;
  durationSec: number;
}): string {
  const voice = input.sound === 'native'
    ? [
        '【配音安排】',
        '原生画外音，口吻像在向朋友介绍实际体验。人物自然使用产品，旁白在画外连续讲述。',
        ...timedLines(
          narrationLines(input.narration).map((line) => ({ weight: line.length, direction: line })),
          input.durationSec,
          '旁白',
        ),
      ].join('\n')
    : ['【声音要求】', '仅保留现场环境声与动作声，无旁白、对白、歌声或背景音乐。'].join('\n');
  const sectionStart = Math.max(text.lastIndexOf('\n\n【配音安排】'), text.lastIndexOf('\n\n【声音要求】'));
  if (sectionStart < 0) {
    return text.trim() ? `${text.trim()}\n\n${voice}` : voice;
  }
  return `${text.slice(0, sectionStart)}\n\n${voice}`;
}

/**
 * 时长/画幅变化后的建议稿：只重排明确标注的「镜/旁白」区间与标题行，
 * 其余手写正文原样保留，避免把用户改过的散文重写掉。
 */
export function retimePromptText(text: string, fromSec: number, toSec: number): string {
  let result = text;
  if (fromSec !== toSec && fromSec > 0) {
    result = result.replace(
      /^((?:镜|旁白)\d+｜)(\d+(?:\.\d+)?)–(\d+(?:\.\d+)?)s｜/gm,
      (_match, label: string, start: string, end: string) => (
        `${label}${(Number(start) * toSec / fromSec).toFixed(1)}–${(Number(end) * toSec / fromSec).toFixed(1)}s｜`
      ),
    );
    result = result.replace(/^【(\d+) 秒 ·/m, `【${toSec} 秒 ·`);
  }
  return result;
}

export interface PromptReview {
  /** 建议采用的全文（保留手改，只替换能安全识别的区间）。 */
  text: string;
  recommended: string;
  /** 手改内容与新参数冲突、需要用户核对。 */
  conflict: boolean;
}

export function reviewPromptForSettings(input: {
  savedText: string;
  savedBaseline: string[];
  savedDurationSec: number;
  next: PromptBuildInput;
}): PromptReview {
  const recommended = buildPrompt(input.next);
  if (!input.savedText.trim()) return { text: recommended, recommended, conflict: false };
  if (input.savedText === input.savedBaseline.join('\n\n')) {
    return { text: recommended, recommended, conflict: false };
  }
  const retimed = retimePromptText(input.savedText, input.savedDurationSec, input.next.durationSec);
  const nextBlocks = buildPromptBlocks(input.next);
  // 逐块比对：只替换仍与旧基线一致（或仅时长不同）的块；用户改过的块保留并标记冲突。
  const savedBlocks = retimed.split('\n\n');
  let conflict = false;
  const merged = nextBlocks.map((block, index) => {
    const current = savedBlocks[index];
    if (current === undefined) return block;
    const baseline = input.savedBaseline[index];
    const retimedBaseline = baseline === undefined ? undefined : retimePromptText(baseline, input.savedDurationSec, input.next.durationSec);
    if (retimedBaseline === current) return block;
    conflict = true;
    return current;
  });
  const extra = savedBlocks.slice(nextBlocks.length).filter((block) => block.trim());
  return { text: [...merged, ...extra].join('\n\n'), recommended, conflict };
}

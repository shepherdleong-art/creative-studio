import { STRUCTURE_LABELS, type SoundMode, type StoryStructure } from './contract.ts';

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
}

interface Beat {
  weight: number;
  direction: string;
}

/** 结构 → 分镜节拍。每个结构至少 6 镜，覆盖正文时长。 */
function beatsFor(input: PromptBuildInput, focus: string): Beat[] {
  const { product, appearance } = input.subject;
  const scene = appearance || '参考素材中的真实使用场景';
  const entry: Beat = { weight: 2, direction: `全景｜场景入口，平视侧跟｜人物走进${scene}，与${product}自然同框。` };
  const contact: Beat = { weight: 2, direction: `中景｜人物斜侧面，跟随手部轻推｜人物走近${product}，伸手接触外观可见的部位。` };
  const action: Beat = { weight: 2.5, direction: `中近景｜人物侧面，顺动作横移｜人物连续完成一次日常使用动作，让手与${product}的接触清楚可见。` };
  const detail: Beat = { weight: 2, direction: `特写｜产品外侧，缓慢靠近｜围绕「${focus}」拍清手与${product}接触的一处细节，只使用参考素材可见的外观。` };
  const result: Beat = { weight: 2.5, direction: `中景｜人物正侧方，固定机位｜人物完成使用后稍作停留，用表情和动作交代感受，与${product}同框。` };
  const close: Beat = { weight: 2, direction: `全景｜场景一侧，缓慢拉远｜人物继续使用${product}，在同一空间自然收尾。` };
  const question: Beat = { weight: 2, direction: `近景｜人物侧前方，轻推｜人物在接触${product}前短暂停顿，用动作带出对「${focus}」的疑问。` };
  const check: Beat = { weight: 2, direction: '近景｜回到开场同一角度，镜头稳定｜人物再次尝试刚才的动作，呈现实际体验对开头疑问的回答。' };

  if (input.structure === 'result') {
    return [result, entry, contact, detail, action, { ...close, direction: `中景｜回到开场机位，缓慢拉远｜重现开头的使用状态，让观众理解人物为什么喜欢这个时刻。` }];
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
  const beats = beatsFor(input, focus);
  const lines = narrationLines(input.narration);
  const voice = input.sound === 'native'
    ? [
        '【配音安排】',
        '原生画外音，口吻像在向朋友介绍实际体验。人物自然使用产品，旁白在画外连续讲述。',
        ...timedLines(lines.map((line) => ({ weight: line.length, direction: line })), input.durationSec, '旁白'),
      ]
    : ['【声音要求】', '仅保留现场环境声与动作声，无旁白、对白、歌声或背景音乐。'];

  return [
    `【${input.durationSec} 秒 · ${input.subject.genre} · ${input.aspectRatio} 画幅】`,
    [
      '【全局设定】',
      '人物：同一位体验者，衣着、外观和动作前后一致。',
      `产品：${input.subject.product}。全片以参考素材为准。`,
      `场景：${input.subject.appearance || '参考素材中的真实使用场景'}。`,
      `卖点：${input.subject.points.join('、')}。`,
      '画面：第三人称生活流，自然光，动作衔接剪切。避免 POV、内部结构、可读字幕、花字、水印及背景音乐。',
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

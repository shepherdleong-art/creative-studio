/**
 * 排片计算：把「一条脚本怎么排成一条成片」的规矩集中在这里的纯计算模块。
 *
 * 纯计算：不读数据库、不调 AI、不调配音、不碰文件；需要的东西都由调用方作为输入给它。
 * 同一套规矩分两次调用：
 *   - assignFormulaVoice（定声音，配音之前）
 *   - arrangeFormulaTime（排时间，配音之后）
 *
 * 规矩见 docs/superpowers/specs/2026-10-28-实拍混剪新规矩-确认单.md 第 1 节；
 * 本模块照搬原型 outputs/2026-10-28-实拍混剪排片原型/实拍混剪排片原型.html 的 `Rules.assemble`。
 */

export const SCHEDULING_VERSION = 'formula-scheduling/2' as const;

/** 收尾：最后一句声音之后，最后一个画面多放 0.75 秒。 */
export const TAIL_US = 750_000;
/** 一行配音比镜头只长半秒以内时，这个镜头多用一点原片，不插补镜。 */
export const BORROW_MAX_US = 500_000;
/** 插入的补镜最短 1 秒，不会一闪而过。 */
export const MIN_FILLER_US = 1_000_000;
/** 口播说话起止前后各留的固定余量。 */
export const SPEECH_MARGIN_US = 120_000;
/** 成片帧率；时间边界统一落到这一档。 */
export const SCHEDULING_FPS = 24;

export interface SchedulingWord {
  text: string;
  startUs: number;
  endUs: number;
}

/** 口播镜头清洗后的原声：文字、逐字时间和说话起止。 */
export interface SchedulingSpeech {
  text: string;
  words: SchedulingWord[];
  startUs: number;
  endUs: number;
  /** 开头被剪掉的倒数/口令在源片里的结束时间；余量不能伸进去。 */
  headCutEndUs?: number | null;
  /** 结尾被剪掉的口令在源片里的开始时间；余量不能伸进去。 */
  tailCutStartUs?: number | null;
}

export interface SchedulingFile {
  assetId: string;
  contentFingerprint: string;
  fileName: string;
  /** 素材编号；补镜和替代镜头用它做标记。 */
  logicalCode?: string | null;
  durationUs: number;
  /** 有效片段（非口播来自「分析画面」；口播由本模块按说话起止加余量算出）。 */
  usableInUs: number;
  usableOutUs: number;
  /** 仅口播镜头：清洗后的原声。 */
  speech: SchedulingSpeech | null;
}

export interface SchedulingSlotMaterial {
  logicalCode: string;
  /** 编号去掉数字后的部分，如 S、P、VO。 */
  kind: string;
  files: SchedulingFile[];
  isVo: boolean;
  /** 口播台词（来自素材文件名）；不是口播时为 null。 */
  voLine: string | null;
  /** 全景展示：文件名同时含「整体外观」「无人出镜」。 */
  wide: boolean;
  /** 全景体验：P 镜头且文件名含「全景」。 */
  wideExperience: boolean;
}

export interface SchedulingScript {
  /** 原脚本号，如「889」。 */
  scriptNumber: string;
  /** 份次，从 1 数。 */
  copyIndex: number;
  /** 文案，按行。 */
  lines: string[];
  /** 编号公式，按公式顺序。 */
  codes: string[];
  /** 预估时长（秒）；只作显示，不参与计算。 */
  estimatedDurationSec?: number | null;
}

export interface SchedulingJudgment {
  /** AI 判断：文案哪一行和公式里哪段口播意思相近。 */
  similar: Array<{ lineIndex: number; logicalCode: string }>;
  /** 口播一段都没用上时（以及统一配音时），AI 挑的最搭的一段。 */
  bestVo: string | null;
  /** 每行文案相关的非口播素材排序（assetId 从相关到不相关）。 */
  related: Array<{ lineIndex: number; assetIds: string[] }>;
}

export interface SchedulingInput {
  script: SchedulingScript;
  /** 公式里出现的每个编号的材料；缺号给空 files。 */
  materials: SchedulingSlotMaterial[];
  /** AI 判断；没有时按「没有相近口播、没有相关排序」处理。 */
  judgment: SchedulingJudgment | null;
  /** 替换表：缺号 → 替代编号。 */
  replacements?: Readonly<Record<string, string>>;
  /** 声音方式：原声＋配音 / 统一配音。 */
  voiceMode: 'mixed' | 'narration';
  /** 审片时恢复了文案行；这些行按普通文案重新配音。 */
  restoredLines?: readonly number[];
}

export type LineFate =
  | { type: 'source'; logicalCode: string; basis: 'planned' | 'similar' }
  | { type: 'narration' };

export interface VoicePlanLine {
  index: number;
  text: string;
  fate: LineFate | null;
}

export interface SchedulingSubstitution {
  replacedCode: string;
  from: 'replacement-table' | 'same-kind' | 'wide' | 'wide-experience' | 'other';
  file: SchedulingFile;
}

export type VoicePlanItem =
  | { kind: 'shot'; slotIndex: number; logicalCode: string; file: SchedulingFile; lineIndexes: number[];
      dropped: boolean; substitution: SchedulingSubstitution | null }
  | { kind: 'vo'; slotIndex: number; logicalCode: string; file: SchedulingFile; role: 'anchor' | 'similar' | 'picked' }
  | { kind: 'insert'; lineIndexes: number[] }
  | { kind: 'ending'; lineIndexes: number[] };

export interface VoicePlan {
  algorithmVersion: typeof SCHEDULING_VERSION;
  mode: 'mixed' | 'narration';
  lines: VoicePlanLine[];
  items: VoicePlanItem[];
  /** 公式里每段口播的用途；没列到的就是不用的。 */
  voUsage: Array<{ slotIndex: number; logicalCode: string; role: 'anchor' | 'similar' | 'picked' | 'muted'; coversLines: number[] }>;
  unusedSlots: Array<{ slotIndex: number; logicalCode: string; reason: string }>;
  missingCodes: string[];
  movedLast: boolean;
  warnings: string[];
}

export interface NarrationTake {
  lineIndex: number;
  text: string;
  durationUs: number;
  /** 逐字时间，相对这段配音音频的开头。 */
  words: SchedulingWord[];
  /** 配音音频的内容指纹（用于下游核验）；没有就按文字和时长生成。 */
  contentFingerprint?: string | null;
  /** 配音音频的存储相对路径（渲染要用）。 */
  relativePath?: string | null;
}

export interface TimelineClip {
  id: string;
  kind: 'shot' | 'vo' | 'substitute' | 'filler';
  logicalCode: string;
  assetId: string;
  contentFingerprint: string;
  fileName: string;
  sourceInUs: number;
  sourceOutUs: number;
  timelineStartFrame: number;
  timelineEndFrame: number;
  timelineStartUs: number;
  timelineEndUs: number;
  /** 这段画面承载的文案行（原声覆盖的文案行记在对应 vo 上）。 */
  lineIndexes: number[];
  /** 只有 vo 有：公式里的镜头序号，用来把原声和画面配成一对。 */
  slotIndex?: number;
  /** 补镜原因；只有 filler 有。 */
  fillerCause?: 'overflow' | 'gap' | 'ending';
  substitution?: SchedulingSubstitution | null;
}

export interface TimelineSound {
  id: string;
  kind: 'source' | 'narration';
  /** source 对应公式镜头 slotIndex；narration 对应文案行。 */
  slotIndex: number | null;
  lineIndexes: number[];
  logicalCode: string | null;
  assetId: string | null;
  contentFingerprint: string;
  fileName: string | null;
  text: string;
  timelineStartFrame: number;
  timelineEndFrame: number;
  timelineStartUs: number;
  timelineEndUs: number;
  sourceInUs: number;
  sourceOutUs: number;
  /** 配音音频的存储相对路径；只有 narration 有。 */
  relativePath?: string | null;
}

export interface TimelineWord {
  soundId: string;
  text: string;
  startUs: number;
  endUs: number;
}

export type SchedulingMark =
  | { type: 'skipped-line'; lineIndex: number; logicalCode: string; basis: 'planned' | 'similar' }
  | { type: 'substitute'; replacedCode: string; from: SchedulingSubstitution['from']; assetId: string }
  | { type: 'filler'; cause: 'overflow' | 'gap' | 'ending'; lineIndexes: number[] }
  | { type: 'last-line-moved' }
  | { type: 'unused-shot'; logicalCode: string; reason: string }
  | { type: 'unused-vo'; logicalCode: string; reason: string }
  | { type: 'muted-vo'; logicalCode: string };

export interface TimelinePlan {
  algorithmVersion: typeof SCHEDULING_VERSION;
  mode: 'mixed' | 'narration';
  fps: typeof SCHEDULING_FPS;
  clips: TimelineClip[];
  sounds: TimelineSound[];
  words: TimelineWord[];
  marks: SchedulingMark[];
  /** 公式里没用上的镜头和原因。 */
  unused: Array<{ logicalCode: string; reason: string }>;
  totalFrames: number;
  totalDurationUs: number;
  /** 最后一句声音结束的位置；收尾从它开始算。 */
  speechEndUs: number;
  warnings: string[];
}

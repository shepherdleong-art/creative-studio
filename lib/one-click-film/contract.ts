import { OneClickFilmError } from './errors.ts';

/**
 * 一键成片脚本阶段的共享契约（纯模块，前后端共用，不读环境变量）。
 *
 * 与详情页智能脚本的 6 条上限不同：一键成片在本模块编排 1–12 条目标成片。
 * 现有详情页脚本公开入口继续使用其单批 6 份限制，两边互不放宽。
 */

export const ONE_CLICK_FILM_MIN_ENTRIES = 1;
export const ONE_CLICK_FILM_MAX_ENTRIES = 12;

export const STORY_STRUCTURES = ['scene', 'result', 'problem'] as const;
export type StoryStructure = (typeof STORY_STRUCTURES)[number];

export const STRUCTURE_LABELS: Record<StoryStructure, string> = {
  scene: '场景体验',
  result: '结果先行',
  problem: '痛点解决',
};

/** 自动搭配顺序：与原型一致，按场景 → 结果 → 痛点循环。 */
const AUTO_STRUCTURE_ORDER: StoryStructure[] = ['scene', 'result', 'problem'];

export const REWORK_VIDEO_PROMPT_LIMIT = 8000;
export const SCRIPT_TITLE_LIMIT = 60;

export const SOUND_MODES = ['native', 'tts', 'none'] as const;
export type SoundMode = (typeof SOUND_MODES)[number];

export const SOUND_LABELS: Record<SoundMode, string> = {
  native: '原生画外音',
  tts: 'TTS 统一旁白',
  none: '不配音',
};

export const MODEL_PRESETS = [
  'auto',
  'none',
  'adult_female',
  'adult_male',
  'child',
  'parent_child',
  'custom',
] as const;
export type ModelPreset = (typeof MODEL_PRESETS)[number];

export const MODEL_PRESET_LABELS: Record<ModelPreset, string> = {
  auto: '自动匹配',
  none: '无人物（纯产品）',
  adult_female: '成年女性',
  adult_male: '成年男性',
  child: '儿童',
  parent_child: '亲子互动',
  custom: '自定义',
};

export const MODEL_CUSTOM_LIMIT = 80;

export type ModelSource = 'batch' | 'individual';

export interface ModelSelection {
  preset: ModelPreset;
  custom: string;
}

const CONCRETE_SUGGESTED_MODELS = ['none', 'adult_female', 'adult_male', 'child', 'parent_child'] as const;
type ConcreteSuggestedModel = (typeof CONCRETE_SUGGESTED_MODELS)[number];

export function parseModelPreset(value: unknown): ModelPreset {
  if (value === undefined || value === null || value === '') return 'auto';
  if (typeof value === 'string' && (MODEL_PRESETS as readonly string[]).includes(value)) {
    return value as ModelPreset;
  }
  throw new OneClickFilmError('invalid_input', '不支持的出镜人物设置');
}

export function parseModelSelection(presetValue: unknown, customValue?: unknown): ModelSelection {
  const preset = parseModelPreset(presetValue);
  const custom = preset === 'custom' && typeof customValue === 'string'
    ? customValue.trim().replace(/[\r\n]+/g, ' ').slice(0, MODEL_CUSTOM_LIMIT)
    : '';
  if (preset === 'custom' && !custom) {
    throw new OneClickFilmError('invalid_input', '选择自定义人物时，请填写出镜人物描述');
  }
  return { preset, custom };
}

export function parseSuggestedModel(value: unknown): ConcreteSuggestedModel | '' {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().toLowerCase();
  if ((CONCRETE_SUGGESTED_MODELS as readonly string[]).includes(normalized)) {
    return normalized as ConcreteSuggestedModel;
  }
  return '';
}

const PARENT_CHILD_CUE = /亲子|母婴|陪读|带娃|宝妈|家长.{0,6}(?:宝宝|孩子|小朋友|儿童)|(?:爸爸|妈妈).{0,6}(?:宝宝|孩子|小朋友|儿童)/u;
const CHILD_CUE = /儿童|宝宝|幼童|幼儿|小朋友|小童|童床|童椅|婴儿|婴幼儿|小学生|低龄|小孩/u;

export function inferModelFromContext(context?: {
  suggestedModel?: string;
  product?: string;
  appearance?: string;
  sceneClues?: string;
  points?: string[];
}): Exclude<ModelPreset, 'custom'> {
  const suggested = parseSuggestedModel(context?.suggestedModel);
  if (suggested) return suggested;
  const text = [
    context?.product ?? '',
    context?.appearance ?? '',
    context?.sceneClues ?? '',
    ...(context?.points ?? []),
  ].join(' ');
  if (PARENT_CHILD_CUE.test(text)) return 'parent_child';
  if (CHILD_CUE.test(text)) return 'child';
  return 'auto';
}

export function resolveModelSelection(
  selection: { preset: ModelPreset; custom?: string },
  context?: {
    suggestedModel?: string;
    product?: string;
    appearance?: string;
    sceneClues?: string;
    points?: string[];
  },
): ModelSelection {
  if (selection.preset !== 'auto') {
    return {
      preset: selection.preset,
      custom: selection.preset === 'custom'
        ? (selection.custom ?? '').trim().replace(/[\r\n]+/g, ' ').slice(0, MODEL_CUSTOM_LIMIT)
        : '',
    };
  }
  return { preset: inferModelFromContext(context), custom: '' };
}

export function formatModelLabel(
  selection: { preset: ModelPreset; custom?: string },
  resolvedAuto?: ModelPreset,
): string {
  if (selection.preset === 'custom') {
    return selection.custom?.trim() || MODEL_PRESET_LABELS.custom;
  }
  if (selection.preset === 'auto' && resolvedAuto && resolvedAuto !== 'auto') {
    return `${MODEL_PRESET_LABELS.auto}（${MODEL_PRESET_LABELS[resolvedAuto]}）`;
  }
  return MODEL_PRESET_LABELS[selection.preset];
}

export type StructurePlanMode = 'auto' | 'batch' | 'individual';

export interface StructurePlan {
  mode: StructurePlanMode;
  /** mode=batch 时的整批结构；mode=individual 时为逐条选择（auto 表示让该条自动搭配）。 */
  structure?: StoryStructure;
  choices?: Array<StoryStructure | 'auto'>;
}

export function parseEntryCount(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(num) || num < ONE_CLICK_FILM_MIN_ENTRIES || num > ONE_CLICK_FILM_MAX_ENTRIES) {
    throw new OneClickFilmError(
      'invalid_input',
      `成片数量必须是 ${ONE_CLICK_FILM_MIN_ENTRIES}-${ONE_CLICK_FILM_MAX_ENTRIES} 的整数`,
    );
  }
  return num;
}

export function parseStructure(value: unknown): StoryStructure {
  if (typeof value === 'string' && (STORY_STRUCTURES as readonly string[]).includes(value)) {
    return value as StoryStructure;
  }
  throw new OneClickFilmError('invalid_input', '不支持的视频结构');
}

export function parseSoundMode(value: unknown): SoundMode {
  if (typeof value === 'string' && (SOUND_MODES as readonly string[]).includes(value)) {
    return value as SoundMode;
  }
  throw new OneClickFilmError('invalid_input', '不支持的配音方式');
}

export function parseStructurePlan(value: unknown): StructurePlan {
  const raw = (value ?? { mode: 'auto' }) as Record<string, unknown>;
  if (raw.mode === 'auto' || raw.mode === undefined || raw.mode === null) return { mode: 'auto' };
  if (raw.mode === 'batch') return { mode: 'batch', structure: parseStructure(raw.structure) };
  if (raw.mode === 'individual') {
    if (!Array.isArray(raw.choices)) throw new OneClickFilmError('invalid_input', '逐条指定结构需要提供每条的选择');
    const choices = raw.choices.map((choice) => (
      choice === 'auto' || choice === undefined || choice === null ? 'auto' as const : parseStructure(choice)
    ));
    return { mode: 'individual', choices };
  }
  throw new OneClickFilmError('invalid_input', '不支持的结构搭配方式');
}

/** 第 index 条（0 起）实际使用的结构：未指定时按固定顺序自动搭配。 */
export function structureAt(plan: StructurePlan, index: number): StoryStructure {
  const choice = plan.mode === 'individual' ? plan.choices?.[index] ?? 'auto' : plan.mode === 'batch' ? plan.structure : 'auto';
  return choice === 'auto' || !choice ? AUTO_STRUCTURE_ORDER[index % AUTO_STRUCTURE_ORDER.length] : choice;
}

/** 条目编号：F01…F12，界面与文件名共用。 */
export function entryCode(ordinal: number): string {
  return `F${String(ordinal).padStart(2, '0')}`;
}

export function parseEntryCode(value: string): number {
  const match = /^F(\d{2})$/.exec(value.trim());
  const ordinal = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(ordinal) || ordinal < 1) throw new OneClickFilmError('invalid_input', `无效的成片编号：${value}`);
  return ordinal;
}

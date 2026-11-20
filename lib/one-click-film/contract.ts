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

export const SOUND_MODES = ['native', 'tts', 'none'] as const;
export type SoundMode = (typeof SOUND_MODES)[number];

export const SOUND_LABELS: Record<SoundMode, string> = {
  native: '原生画外音',
  tts: 'TTS 统一旁白',
  none: '不配音',
};

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

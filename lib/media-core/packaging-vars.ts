// 包装文案自动组装 v2（种草风四套模板 · 变量契约 {title, subtitle, point1-3, accent1-3}）
// 纯函数、确定性、不调 LLM。
// 要点：标题用产品名称（回退链：productName → 卖点/字幕提炼产品词 → 货号）；
//       卖点优先项目卖点库（AI 已排序），无则字幕启发式；空字符串 = 模板隐藏该元素。

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface PackagingVars {
  title: string;
  subtitle: string;
  point1: string;
  point2: string;
  point3: string;
  accent1: string;
  accent2: string;
  accent3: string;
}

/** v2 首发四套模板（overlay-basic 为 v1 遗留模板，只兼容旧任务，不进选择器）。 */
export const PACKAGING_TEMPLATE_IDS = ['overlay-poster', 'overlay-journal', 'overlay-minimal', 'overlay-variety'] as const;
export type PackagingTemplateId = typeof PACKAGING_TEMPLATE_IDS[number];
export const DEFAULT_PACKAGING_TEMPLATE: PackagingTemplateId = 'overlay-poster';

/** v2 变量键；空字符串 = 模板隐藏对应元素。 */
export const PACKAGING_VAR_KEYS: ReadonlyArray<keyof PackagingVars> = ['title', 'subtitle', 'point1', 'point2', 'point3', 'accent1', 'accent2', 'accent3'];

/** §7：单条卖点的手动布局（v2：元素可视中心点的画布百分比绝对坐标 + 等比缩放倍率 + 可选旋转）。 */
export interface PackagingPointLayout {
  /** 元素可视中心点的画布百分比坐标 0~100（绝对坐标，非 style 偏移）。 */
  x: number;
  y: number;
  /** 相对倍率 0.3~3。 */
  scale: number;
  /** 顺时针旋转角度 -180~180（可选，缺省 0；0 与缺省等价，不存储）。 */
  rotate?: number;
}

/** §7：按模板分别记忆的手动布局。外层键=模板 id；
 * cover 键=point1-3（封面卖点）+ title/subtitle（主副标题，§18），cues 键=正片卖点 cue id（cue:<id> 布局引用）。 */
export type PackagingLayouts = Record<string, {
  cover?: Record<string, PackagingPointLayout>;
  cues?: Record<string, PackagingPointLayout>;
}>;

/** 混剪组的包装配置（final_edit_groups.packagingJson）。 */
export interface FinalEditPackagingConfig {
  enabled: boolean;
  template: PackagingTemplateId;
  /** 文案覆盖层：键为 PACKAGING_VAR_KEYS 之一，值为最终文案（空串=隐藏该元素）。 */
  varsOverrides: Partial<PackagingVars>;
  /** v3 动态时序包装：正片卖点提示（对时后的条目），由包装配置/脚本变更时一次性提取。
   * 元素与 packaging-cues.ts 的 PointCue 同构（此处内联声明避免模块循环依赖）。 */
  pointCues?: Array<{ id: string; text: string; startSec: number; endSec: number }>;
  /** pointCues 的过期键：口播内容哈希（v2 起带版本盐前缀）。哈希变化自动重新提取（§7.4-2）。 */
  pointCuesKey?: string;
  /** 正片卖点模式：timed=随口播对时弹出；even=无口播按时长均分；none=无卖点仅封面。 */
  pointCuesMode?: 'timed' | 'even' | 'none';
  /** §7：pointCues 被手动编辑过——此后口播哈希变化不再自动重提取，需显式「重新提取」复位。 */
  pointCuesEdited?: boolean;
  /** §7：按模板分别记忆的手动布局（默认 {}）。 */
  layouts?: PackagingLayouts;
  /** §9 ②：当前选择的卖点字体（UI 记录用；字体文件已物化到 packaging/fonts/user/）。 */
  pointFont?: { family: string; file: string };
  /** §10 ②：主标题/副标题独立字体（缺省=模板原生字体，不注入）。 */
  titleFont?: { family: string; file: string };
  subtitleFont?: { family: string; file: string };
}

/** 存量无 id 数据的确定性回填（parse 是纯函数必须幂等）：text+startSec+endSec 的 sha256 前 8 位。 */
function backfillPointCueId(text: string, startSec: number, endSec: number): string {
  return `p_${createHash('sha256').update(`${text}|${startSec}|${endSec}`).digest('hex').slice(0, 8)}`;
}

/** 仅当数组元素形态合法时才接受 pointCues；脏数据忽略。存量无 id 项读取时确定性回填。 */
export function sanitizePointCues(input: unknown): FinalEditPackagingConfig['pointCues'] {
  if (!Array.isArray(input)) return undefined;
  const result: NonNullable<FinalEditPackagingConfig['pointCues']> = [];
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const raw = item as { id?: unknown; text?: unknown; startSec?: unknown; endSec?: unknown };
    if (typeof raw.text !== 'string' || !raw.text.trim()) continue;
    const startSec = Number(raw.startSec);
    const endSec = Number(raw.endSec);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) continue;
    const text = raw.text.slice(0, 60);
    const id = typeof raw.id === 'string' && raw.id.trim()
      ? raw.id.trim().slice(0, 24)
      : backfillPointCueId(text, startSec, endSec);
    result.push({ id, text, startSec, endSec });
    if (result.length >= 24) break;
  }
  return result;
}

/** 布局键白名单：模板 id 与 cue id 只允许安全字符（防 __proto__ 等特殊键）。 */
const LAYOUT_TEMPLATE_KEY = /^[A-Za-z0-9._-]{1,64}$/;
const LAYOUT_CUE_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const LAYOUT_COVER_KEYS = ['point1', 'point2', 'point3', 'title', 'subtitle'] as const;

function sanitizePointLayout(input: unknown): PackagingPointLayout | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = input as { x?: unknown; y?: unknown; scale?: unknown; rotate?: unknown };
  const x = Number(raw.x);
  const y = Number(raw.y);
  const scale = Number(raw.scale);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale)) return undefined;
  const layout: PackagingPointLayout = {
    x: Math.max(0, Math.min(100, x)),
    y: Math.max(0, Math.min(100, y)),
    scale: Math.max(0.3, Math.min(3, scale)),
  };
  // rotate 可选：有限数值钳到 -180~180（超出取最近边界）；0 与缺省等价不存储；非法值仅丢该字段不丢整条
  if (raw.rotate !== undefined && raw.rotate !== null) {
    const rotate = Number(raw.rotate);
    if (Number.isFinite(rotate)) {
      const clamped = Math.max(-180, Math.min(180, rotate));
      if (clamped !== 0) layout.rotate = clamped;
    }
  }
  return layout;
}

/** §7：解析/清洗 layouts（逐层校验，脏数据丢弃对应键不抛错；空壳模板键不保留）。 */
export function sanitizePackagingLayouts(input: unknown): PackagingLayouts {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const result: PackagingLayouts = {};
  for (const [templateId, value] of Object.entries(input as Record<string, unknown>)) {
    if (!LAYOUT_TEMPLATE_KEY.test(templateId) || !PACKAGING_TEMPLATE_IDS.includes(templateId as PackagingTemplateId)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const raw = value as { cover?: unknown; cues?: unknown };
    const entry: { cover?: Record<string, PackagingPointLayout>; cues?: Record<string, PackagingPointLayout> } = {};
    if (raw.cover && typeof raw.cover === 'object' && !Array.isArray(raw.cover)) {
      const cover: Record<string, PackagingPointLayout> = {};
      for (const key of LAYOUT_COVER_KEYS) {
        const layout = sanitizePointLayout((raw.cover as Record<string, unknown>)[key]);
        if (layout) cover[key] = layout;
      }
      if (Object.keys(cover).length > 0) entry.cover = cover;
    }
    if (raw.cues && typeof raw.cues === 'object' && !Array.isArray(raw.cues)) {
      const cues: Record<string, PackagingPointLayout> = {};
      for (const [cueId, layoutRaw] of Object.entries(raw.cues as Record<string, unknown>)) {
        if (!LAYOUT_CUE_KEY.test(cueId) || ['__proto__', 'constructor', 'prototype'].includes(cueId)) continue;
        const layout = sanitizePointLayout(layoutRaw);
        if (layout) cues[cueId] = layout;
      }
      if (Object.keys(cues).length > 0) entry.cues = cues;
    }
    if (entry.cover || entry.cues) result[templateId] = entry;
  }
  return result;
}

/** §6 编辑提交入参：与 PackagingLayouts 同构，但叶子允许 null（= 删除该键，见 mergePackagingLayouts）。 */
export type PackagingLayoutsPatch = Record<string, {
  cover?: Record<string, PackagingPointLayout | null>;
  cues?: Record<string, PackagingPointLayout | null>;
}>;

/** 段级合并：未传该段保留现状；脏段不动现状；叶子 null 删除该键（sanitizePointLayout 本就丢 null，
 * 故 null 必须在清洗前显式处理）；合法叶子清洗后并入；段清空后不占键。 */
function mergeLayoutSection(
  base: Record<string, PackagingPointLayout> | undefined,
  incoming: unknown,
  keyAllowed: (key: string) => boolean,
): Record<string, PackagingPointLayout> | undefined {
  if (incoming === undefined) return base;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return base;
  const next: Record<string, PackagingPointLayout> = { ...(base ?? {}) };
  for (const [key, layoutRaw] of Object.entries(incoming as Record<string, unknown>)) {
    if (!keyAllowed(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    if (layoutRaw === null) { delete next[key]; continue; }
    const layout = sanitizePointLayout(layoutRaw);
    if (layout) next[key] = layout;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** §7/§6：layouts 写入合并——'__clear' 清空全部；模板值空对象 = 清空该模板（「恢复默认版式」）；
 * 否则 cover/cues 段级并入既有条目，叶子值 null = 删除该键（单条复位）；整体脏数据不动现状。 */
export function mergePackagingLayouts(current: PackagingLayouts, incoming: unknown): PackagingLayouts {
  if (incoming === '__clear') return {};
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return current; // 脏数据不动现状
  const merged: PackagingLayouts = { ...current };
  for (const [templateId, value] of Object.entries(incoming as Record<string, unknown>)) {
    if (!LAYOUT_TEMPLATE_KEY.test(templateId) || !PACKAGING_TEMPLATE_IDS.includes(templateId as PackagingTemplateId)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (Object.keys(value).length === 0) { delete merged[templateId]; continue; } // 空对象 = 清空该模板
    const raw = value as { cover?: unknown; cues?: unknown };
    const base = merged[templateId];
    const cover = mergeLayoutSection(base?.cover, raw.cover, (key) => (LAYOUT_COVER_KEYS as readonly string[]).includes(key));
    const cues = mergeLayoutSection(base?.cues, raw.cues, (key) => LAYOUT_CUE_KEY.test(key));
    if (cover || cues) merged[templateId] = { ...(cover ? { cover } : {}), ...(cues ? { cues } : {}) };
    else delete merged[templateId];
  }
  return merged;
}

/** 解析 final_edit_groups.packagingJson（历史空值/脏值回退默认配置）。
 * 兼容两种输入：SQLite 原始字符串 与 已解析对象（PATCH 命令体）。 */
export function parsePackagingConfig(json: unknown): FinalEditPackagingConfig {
  let source: unknown = json;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch { source = {}; }
  }
  const raw = (source && typeof source === 'object' && !Array.isArray(source) ? source : {}) as { enabled?: unknown; template?: unknown; varsOverrides?: unknown; pointCues?: unknown; pointCuesKey?: unknown; pointCuesMode?: unknown; pointCuesEdited?: unknown; layouts?: unknown; pointFont?: unknown; titleFont?: unknown; subtitleFont?: unknown };
  const template = typeof raw.template === 'string' && (PACKAGING_TEMPLATE_IDS as readonly string[]).includes(raw.template)
    ? raw.template as PackagingTemplateId
    : DEFAULT_PACKAGING_TEMPLATE;
  const pointCues = sanitizePointCues(raw.pointCues);
  const pointCuesMode = raw.pointCuesMode === 'even' || raw.pointCuesMode === 'none' ? raw.pointCuesMode : 'timed';
  const layouts = sanitizePackagingLayouts(raw.layouts);
  const parseFontSlot = (value: unknown): { family: string; file: string } | undefined => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const slot = value as { family?: unknown; file?: unknown };
      if (typeof slot.family === 'string' && slot.family.trim() && typeof slot.file === 'string' && slot.file.trim()) {
        return { family: slot.family.trim().slice(0, 120), file: slot.file.trim().slice(0, 200) };
      }
    }
    return undefined;
  };
  const pointFont = parseFontSlot(raw.pointFont);
  const titleFont = parseFontSlot(raw.titleFont);
  const subtitleFont = parseFontSlot(raw.subtitleFont);
  return {
    enabled: raw.enabled === true,
    template,
    varsOverrides: sanitizePackagingVarsOverrides(raw.varsOverrides),
    ...(pointCues ? { pointCues } : {}),
    ...(typeof raw.pointCuesKey === 'string' && raw.pointCuesKey ? { pointCuesKey: raw.pointCuesKey } : {}),
    pointCuesMode,
    // §7：缺省 false / {}（缺字段即默认，保持存量 JSON 干净）
    ...(raw.pointCuesEdited === true ? { pointCuesEdited: true } : {}),
    ...(Object.keys(layouts).length > 0 ? { layouts } : {}),
    ...(pointFont ? { pointFont } : {}),
    ...(titleFont ? { titleFont } : {}),
    ...(subtitleFont ? { subtitleFont } : {}),
  };
}

/** 只收白名单键的字符串值，超长截断；脏数据整体忽略。 */
export function sanitizePackagingVarsOverrides(input: unknown): Partial<PackagingVars> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const result: Partial<PackagingVars> = {};
  const source = input as Record<string, unknown>;
  for (const key of PACKAGING_VAR_KEYS) {
    const value = source[key];
    if (typeof value === 'string') result[key] = value.slice(0, 100);
  }
  return result;
}

export interface PackagingVarsSourceCue {
  text: string;
  textSource: 'script' | 'manual';
  startUs: number;
}

export interface BuildPackagingVarsInput {
  subtitleCues: PackagingVarsSourceCue[];
  coverTitle?: { primary: string; secondary: string };
  exportIdentity?: { taskName: string; productCode: string };
  /** 项目级数据：产品名与 AI 卖点库（来自 projects.productName / sellingPointsJson）。 */
  project?: { productName?: string; sellingPoints?: string[] };
  /** 画面吸色（packaging-color.ts 输出），仅 overlay-poster 模板使用。 */
  accents?: string[];
  /** 预留：后期包装界面的文字编辑只改这个覆盖层，不动本函数的推导逻辑。 */
  overrides?: Partial<PackagingVars>;
}

const MAX_POINT_CHARS = 12;
const MAX_CUE_POINT_CHARS = 14;
const MAX_TITLE_CHARS = 20;
const MAX_SUBTITLE_CHARS = 16;

/** 产品名词白名单：用于从卖点/字幕句中提炼产品词（取最后一个名词及其前 ≤4 字修饰）。 */
const PRODUCT_NOUNS = ['餐边柜', '斗柜', '衣柜', '书柜', '橱柜', '鞋柜', '床头柜', '电视柜', '储物柜', '柜', '床', '床垫', '桌', '椅', '架', '沙发', '灯', '窗帘', '被', '枕', '凳', '几', '箱', '篮', '镜', '毯'];

function normalizeForDedupe(text: string): string {
  return text.replace(/[\s，。！？、,.!?；;：:"""''（）()【】\[\]「」]/g, '');
}

function truncate(text: string, maxChars: number): string {
  const chars = [...text];
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join('');
}

/** 清理卖点库条目：去序号前缀（"1. "/"1、"）、去首尾引号空格。 */
export function cleanSellingPoint(raw: string): string {
  return raw
    .replace(/^[\s"""'']+/, '')
    .replace(/[\s"""'']+$/, '')
    .replace(/^\d{1,2}\s*[.、．:：]\s*/, '')
    .trim();
}

/** 修饰语开头的残字/功能字：取名词前 ≤4 字修饰时剥离（如「进口白桦木餐边柜」不留「口」）。 */
const MODIFIER_STRIP_CHARS = new Set([...'口的是了用与和有在和或及更最很超真']);

/** 从一句话中提炼产品词：定位最后一个产品名词，取其前 ≤4 字修饰（剥离开头残字）。 */
export function extractProductWord(sentence: string): string {
  const text = sentence.trim();
  if (!text) return '';
  let bestEnd = -1;
  let bestNoun = '';
  let bestIndex = -1;
  for (const noun of PRODUCT_NOUNS) {
    const index = text.lastIndexOf(noun);
    if (index < 0) continue;
    const end = index + noun.length;
    // 取结束位置最靠后；结束位置相同取更长名词（「餐边柜」结束于 9 优于「柜」结束于 9）
    if (end > bestEnd || (end === bestEnd && noun.length > bestNoun.length)) {
      bestEnd = end;
      bestNoun = noun;
      bestIndex = index;
    }
  }
  if (bestIndex < 0) return '';
  const before = [...text.slice(0, bestIndex)];
  let modifier = before.slice(-4).join('').replace(/^[\s，。、：:;；""''（(【\[]+/, '');
  while (modifier.length > 1 && MODIFIER_STRIP_CHARS.has([...modifier][0])) {
    modifier = [...modifier].slice(1).join('');
  }
  return `${modifier}${bestNoun}`;
}

/** 卖点库优先：top3 清理+精简；无卖点库回退字幕启发式（v1 规则：script 优先、按时间序、去重）。 */
export function selectSellingPoints(cues: PackagingVarsSourceCue[], sellingPoints: string[] = [], count = 3): string[] {
  if (sellingPoints.length > 0) {
    const cleaned: string[] = [];
    const seen = new Set<string>();
    for (const raw of sellingPoints) {
      if (cleaned.length >= count) break;
      const text = truncate(cleanSellingPoint(raw), MAX_POINT_CHARS);
      if (!text) continue;
      const key = normalizeForDedupe(text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      cleaned.push(text);
    }
    if (cleaned.length > 0) return cleaned;
  }
  const sorted = [...cues].sort((a, b) => a.startUs - b.startUs);
  const picked: string[] = [];
  const seen = new Set<string>();
  const tryTake = (cue: PackagingVarsSourceCue) => {
    if (picked.length >= count) return;
    const text = cue.text.trim();
    if (!text || [...text].length > MAX_CUE_POINT_CHARS) return;
    const key = normalizeForDedupe(text);
    if (!key || seen.has(key)) return;
    seen.add(key);
    picked.push(text);
  };
  sorted.filter((cue) => cue.textSource === 'script').forEach(tryTake);
  sorted.filter((cue) => cue.textSource !== 'script').forEach(tryTake);
  return picked;
}

function buildTitle(input: BuildPackagingVarsInput): string {
  if (input.coverTitle) return input.coverTitle.primary.trim();
  const productName = input.project?.productName?.trim() || '';
  if (productName) return truncate(productName, MAX_TITLE_CHARS);
  // 卖点库第一条 → 提炼产品词
  const firstSelling = input.project?.sellingPoints?.[0];
  if (firstSelling) {
    const word = extractProductWord(cleanSellingPoint(firstSelling));
    if (word) return word;
  }
  // 字幕第一条提炼产品词
  for (const cue of input.subtitleCues) {
    const word = extractProductWord(cue.text);
    if (word) return word;
  }
  // 任务名/货号兜底
  const taskName = input.exportIdentity?.taskName.trim() || '';
  if (taskName) return truncate(taskName, MAX_TITLE_CHARS);
  return input.exportIdentity?.productCode.trim() || '';
}

function buildSubtitle(input: BuildPackagingVarsInput): string {
  if (input.coverTitle) return input.coverTitle.secondary.trim();
  // 取卖点库第 4 条：与 point1-3（前三条）错开，避免同一内容同时上副标题和卖点
  const fourth = input.project?.sellingPoints?.[3];
  if (fourth) {
    const cleaned = cleanSellingPoint(fourth);
    if (cleaned) return truncate(cleaned, MAX_SUBTITLE_CHARS);
  }
  return '';
}

/** 项目级包装数据：产品名与 AI 卖点库（sellingPointsJson 的 title 数组）。
 *  单实现（2026-10-12 从 packaging.ts 迁入）：包装任务/预览路由/导出占位校验三方共用，禁双实现。 */
export function loadProjectPackagingData(db: Database.Database, projectId: string): { productName?: string; sellingPoints?: string[] } {
  const row = db.prepare(`SELECT productName, sellingPointsJson FROM projects WHERE id=?`).get(projectId) as { productName: string | null; sellingPointsJson: string | null } | undefined;
  if (!row) return {};
  let sellingPoints: string[] | undefined;
  if (row.sellingPointsJson) {
    try {
      const parsed = JSON.parse(row.sellingPointsJson) as Array<{ title?: unknown }>;
      if (Array.isArray(parsed)) {
        const titles = parsed.map((item) => (typeof item?.title === 'string' ? item.title : '')).filter(Boolean);
        if (titles.length > 0) sellingPoints = titles;
      }
    } catch { /* 脏数据按无卖点库处理 */ }
  }
  return { productName: row.productName?.trim() || undefined, sellingPoints };
}

export function buildPackagingVars(input: BuildPackagingVarsInput): PackagingVars {
  const points = selectSellingPoints(input.subtitleCues, input.project?.sellingPoints ?? []);
  const accents = input.accents ?? [];
  const vars: PackagingVars = {
    title: buildTitle(input),
    subtitle: buildSubtitle(input),
    point1: points[0] || '',
    point2: points[1] || '',
    point3: points[2] || '',
    accent1: accents[0] || '',
    accent2: accents[1] || '',
    accent3: accents[2] || '',
  };
  if (!input.overrides) return vars;
  const merged = { ...vars };
  for (const key of Object.keys(vars) as Array<keyof PackagingVars>) {
    const value = input.overrides[key];
    if (typeof value === 'string') merged[key] = value.trim();
  }
  return merged;
}

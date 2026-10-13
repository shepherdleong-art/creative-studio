// 包装 v3 动态时序：卖点提取 + 对时（一次提取，渲染零推理）
// 三级回退（§7.3）：
//   1. AI 卖点库对齐：sellingPointsJson 短语 ↔ 词级时间戳/字幕 对齐，拿精确入点/出点
//   2. LLM 提取（无卖点库）：复用素材分析在用的 provider 通道（script-providers/completeJson），
//      从口播文本一次性提取卖点短语并对齐；配置时执行，成本可忽略
//   3. 确定性启发式兜底（LLM 不可用）：含数字/材质/功效关键词的句子，截 ≤14 字
// 对时规则（§7.4）：优先词级时间戳 wordTimingsJson，句级字幕兜底；
//   最小展示 1.2s；相邻间隔 <0.6s 顺延；空 pointCues 仅播封面。
// 过期键（§7.4-2）：pointCuesKey = 口播内容哈希，哈希变化自动重新提取。
// 手改卖点文字走 varsOverrides，覆盖层优先于自动提取（模板层已保证）。

import { createHash, randomUUID } from 'node:crypto';
import { cleanSellingPoint } from './packaging-vars.ts';

export interface PointCue {
  /** 稳定 id（p_ 前缀）：layouts.*.cues 的布局引用键；重提取按规范化文本匹配保留。 */
  id: string;
  text: string;
  startSec: number;
  endSec: number;
}

/** 提取阶段（写库前）的卖点：尚无稳定 id，由 persistPointCues 分配。 */
export type PointCueDraft = Omit<PointCue, 'id'>;

/** 生成稳定 cue id：p_ + randomUUID 前 8 位（如 p_x7ab23cd）。 */
export function generatePointCueId(): string {
  return `p_${randomUUID().slice(0, 8)}`;
}

export interface WordTiming {
  text: string;
  startUs: number;
  endUs: number;
}

export interface CueLike {
  text: string;
  startUs: number;
  endUs: number;
}

/** 口播内容哈希（pointCuesKey）：对实际讲述文本求 sha256，内容变化即失效。 */
export function computeNarrationContentKey(narrationText: string): string {
  const normalized = narrationText.replace(/\s+/g, '').trim();
  return createHash('sha256').update(normalized || 'empty').digest('hex').slice(0, 24);
}

/** pointCuesKey 版本盐：v2 = 成片时间轴口径（§9）；v3 = 候选分句拆分（§10，2026-10-09）。
 * 升盐使存量键全部失配，下次配置/导出时按新口径自动重提取一次（edited=true 组仍受手动编辑保护）。 */
export function computePointCuesKey(narrationText: string): string {
  return 'v3:' + computeNarrationContentKey(narrationText);
}

/** 用于子串匹配的规范化：去空白与标点，全半角统一。 */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/[\s\u3000，。！？、,.!?；;：:"""''（）()【】\[\]「」《》·•\-_—…]+/g, '')
    .replace(/[A-Za-z]/g, (ch) => ch.toUpperCase())
    .trim();
}

const MAX_BODY_POINT_CHARS = 18;
const MIN_DISPLAY_SEC = 1.2;
const MIN_GAP_SEC = 0.6;
const MAX_CUES = 12;

function truncate(text: string, maxChars: number): string {
  const chars = [...text];
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join('');
}

/**
 * 词级对齐：把卖点短语匹配到词时间戳序列中的连续窗口，返回精确起止秒。
 * 返回 null 表示未命中（说明口播没有逐词讲到该短语）。
 */
export function alignPointToWords(point: string, words: WordTiming[]): { startSec: number; endSec: number } | null {
  if (words.length === 0) return null;
  const needle = normalizeForMatch(point);
  if (!needle) return null;
  // 构造规范化词序列：记录每个词在拼接串中的偏移，命中后反查覆盖窗口的首/末词
  const parts: Array<{ word: WordTiming; text: string; from: number; to: number }> = [];
  let cursor = 0;
  for (const word of words) {
    const normalized = normalizeForMatch(word.text);
    if (!normalized) continue;
    parts.push({ word, text: normalized, from: cursor, to: cursor + normalized.length });
    cursor += normalized.length;
  }
  if (parts.length === 0) return null;
  const haystack = parts.map((part) => part.text).join('');
  const index = haystack.indexOf(needle);
  if (index < 0) return null;
  const start = parts.find((part) => part.to > index);
  const end = [...parts].reverse().find((part) => part.from < index + needle.length);
  if (!start || !end) return null;
  return { startSec: start.word.startUs / 1e6, endSec: end.word.endUs / 1e6 };
}

/**
 * 句级对齐：字幕 cue 与卖点短语互为包含即命中（沿用 cue 的时间区间）。
 * 返回 null 表示未命中。
 */
export function alignPointToCues(point: string, cues: CueLike[]): { startSec: number; endSec: number } | null {
  const needle = normalizeForMatch(point);
  if (!needle) return null;
  for (const cue of cues) {
    const cueText = normalizeForMatch(cue.text);
    if (!cueText) continue;
    if (cueText.includes(needle) || needle.includes(cueText)) {
      return { startSec: cue.startUs / 1e6, endSec: cue.endUs / 1e6 };
    }
  }
  return null;
}

/** 分句标点（不含「、」：并列修饰劈开会产出残片）。 */
const CLAUSE_SPLIT_RE = /[，。！？；;,!?]+/;
/** 独立成点的最小规范化字数（「7D云感」=4 可独立，「全」=1 残片丢弃）。 */
const MIN_CLAUSE_CHARS = 4;

/**
 * 候选分句拆分：AI/启发式常把相邻两个卖点合进一条（口播是连珠炮短句），
 * 对齐前按分句标点劈开，一条候选只装一个分句——否则卖点变成「半句+下一句残片」
 * （2026-10-09 用户实机反馈：「一键调节躺卧角度，7D 云感」「…餐边柜，全」）。
 * 全是残片时保留最长一片（仍优于整条拼接）。
 */
function splitCandidateClauses(text: string): string[] {
  const pieces = text.split(CLAUSE_SPLIT_RE).map((piece) => piece.trim()).filter(Boolean);
  if (pieces.length <= 1) return [text];
  const clauseLen = (piece: string) => [...normalizeForMatch(piece)].length;
  const viable = pieces.filter((piece) => clauseLen(piece) >= MIN_CLAUSE_CHARS);
  if (viable.length > 0) return viable;
  return [pieces.reduce((a, b) => (clauseLen(a) >= clauseLen(b) ? a : b))];
}

/** 卖点候选池（分句拆分 + 去重 + 长度裁剪），供三级回退共用。 */
export function dedupeCandidates(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of items) {
    const cleaned = cleanSellingPoint(raw);
    for (const clause of splitCandidateClauses(cleaned)) {
      const text = truncate(clause, MAX_BODY_POINT_CHARS);
      if (!text) continue;
      const key = normalizeForMatch(text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(text);
      if (result.length >= MAX_CUES) return result;
    }
  }
  return result;
}

/** 确定性启发式兜底（三级）：含数字/材质/功效关键词的句子，截 ≤14 字。 */
const HEURISTIC_KEYWORDS = ['实木', '木', '皮', '环保', '清漆', '漆', '无味', '味', '甲醛', '安全', '耐用', '承重', '收纳', '容量', '防潮', '防虫', '稳固', '结实', '加厚', '材质', '静音', '设计', '质感', '送到家', '安装', '可选'];

export function extractHeuristicPoints(narrationText: string): string[] {
  const sentences = narrationText
    .split(/[，,。！？!?；;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const picked: string[] = [];
  const seen = new Set<string>();
  for (const sentence of sentences) {
    const hasKeyword = HEURISTIC_KEYWORDS.some((keyword) => sentence.includes(keyword));
    const hasDigit = /\d/.test(sentence);
    if (!hasKeyword && !hasDigit) continue;
    const text = truncate(sentence, 14);
    if (!text) continue;
    const key = normalizeForMatch(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    picked.push(text);
    if (picked.length >= MAX_CUES) break;
  }
  return picked;
}

/** 对时后的正片卖点（timed 模式）：按出现序对齐，未命中（口播没讲）的不入列。
 * 注意：返回的是口播时间轴秒（wordTimings/subtitleCues 口径），成片换算在 buildPointCues 统一做。 */
function alignCandidates(candidates: string[], words: WordTiming[], cues: CueLike[]): PointCueDraft[] {
  const result: PointCueDraft[] = [];
  const seenText = new Set<string>();
  for (const text of candidates) {
    const key = normalizeForMatch(text);
    if (!key || seenText.has(key)) continue;
    const aligned = alignPointToWords(text, words) ?? alignPointToCues(text, cues);
    if (!aligned) continue;
    seenText.add(key);
    result.push({ text, startSec: aligned.startSec, endSec: aligned.endSec });
  }
  return result;
}

/** 后处理：最小展示 1.2s、相邻间隔 <0.6s 顺延、钳制到 [coverSec, totalSec]。
 * 首条从封面边界起算间隔（prevEnd 从 coverSec - MIN_GAP 起步），不额外推迟首条，保证对时精度。
 * 输入必须已是成片时间轴秒（§9：buildPointCues 在调用前完成 coverSec + 口播秒/倍速 换算）。 */
export function postProcessTimedCues(cues: PointCueDraft[], coverSec: number, totalSec: number): PointCueDraft[] {
  const sorted = [...cues].sort((a, b) => a.startSec - b.startSec);
  const result: PointCueDraft[] = [];
  let prevEnd = coverSec - MIN_GAP_SEC;
  for (const cue of sorted) {
    let start = Math.max(cue.startSec, prevEnd + MIN_GAP_SEC);
    start = Math.max(start, coverSec);
    let end = Math.max(cue.endSec, start + MIN_DISPLAY_SEC);
    if (end > totalSec) {
      end = totalSec;
      if (end - start < 0.5) continue; // 挤到最后仍太短则放弃
    }
    result.push({ text: cue.text, startSec: start, endSec: end });
    prevEnd = end;
  }
  return result.slice(0, MAX_CUES);
}

/** 无口播兜底：卖点按视频时长均分，轮流弹入弹出（§7.2）。本来就是成片时间轴口径，无需换算。 */
export function distributeEvenCues(candidates: string[], coverSec: number, totalSec: number): PointCueDraft[] {
  const span = Math.max(0.1, totalSec - coverSec);
  return candidates.slice(0, MAX_CUES).map((text, index) => {
    const slot = span / candidates.length;
    const start = coverSec + index * slot + slot * 0.05;
    const end = Math.min(start + Math.max(MIN_DISPLAY_SEC, slot * 0.85), totalSec);
    return { text, startSec: start, endSec: end };
  });
}

export interface BuildPointCuesInput {
  /** 口播全文（editedNarrationText），用于 LLM/启发式与哈希。 */
  narrationText: string;
  /** 词级时间戳（wordTimingsJson.words），微秒。 */
  words: WordTiming[];
  /** 句级字幕。 */
  subtitleCues: CueLike[];
  /** AI 卖点库（title 数组，已清洗）。 */
  sellingPoints: string[];
  /** 视频总时长（秒，成片时间轴，已含片头且已除倍速）。 */
  totalSec: number;
  /** 封面静帧时长（秒）。 */
  coverSec: number;
  /** 口播播放倍速（§9 时间基准修正：timed 模式对齐结果换算 成片秒 = coverSec + 口播秒/倍速）。 */
  narrationPlaybackRate: number;
  /** 二级回退：LLM 提取回调（无卖点库时调用）；失败/不可用返回空数组。 */
  extractPoints?: (narrationText: string) => Promise<string[]>;
}

export interface BuiltPointCues {
  pointCues: PointCueDraft[];
  mode: 'timed' | 'even' | 'none';
  usedLLM: boolean;
}

export async function buildPointCandidates(input: Pick<BuildPointCuesInput, 'sellingPoints' | 'narrationText' | 'extractPoints'>): Promise<{ candidates: string[]; usedLLM: boolean }> {
  // 1) 候选池：卖点库优先；无则 LLM；LLM 不可用/失败则启发式
  let candidates = dedupeCandidates(input.sellingPoints);
  let usedLLM = false;
  if (candidates.length === 0 && input.extractPoints) {
    try {
      const extracted = await input.extractPoints(input.narrationText);
      const cleaned = dedupeCandidates(extracted);
      if (cleaned.length > 0) {
        candidates = cleaned;
        usedLLM = true;
      }
    } catch { /* LLM 失败走启发式 */ }
  }
  if (candidates.length === 0) candidates = dedupeCandidates(extractHeuristicPoints(input.narrationText));
  return { candidates, usedLLM };
}

export async function buildPointCues(input: BuildPointCuesInput): Promise<BuiltPointCues> {
  const { candidates, usedLLM } = await buildPointCandidates(input);
  return buildLocalPointCues({ ...input, sellingPoints: candidates }, usedLLM);
}

/** Deterministic extraction for transactional creation; no network or writes. */
export function buildLocalPointCues(input: BuildPointCuesInput, usedLLM = false): BuiltPointCues {
  const totalSec = Math.max(input.coverSec + 0.2, input.totalSec);
  const coverSec = Math.min(input.coverSec, totalSec - 0.2);
  // 与 renderer.ts 同口径钳制 0.5~2，缺省 1
  const rate = Number.isFinite(input.narrationPlaybackRate) ? Math.max(0.5, Math.min(2, input.narrationPlaybackRate)) : 1;

  const candidates = dedupeCandidates(input.sellingPoints.length ? input.sellingPoints : extractHeuristicPoints(input.narrationText));
  if (candidates.length === 0) return { pointCues: [], mode: 'none', usedLLM };

  const hasNarrationTiming = input.words.length > 0 || input.subtitleCues.length > 0;
  if (!hasNarrationTiming) {
    // 纯 BGM / 无口播时序：均分兜底
    return { pointCues: distributeEvenCues(candidates, coverSec, totalSec), mode: 'even', usedLLM };
  }

  const aligned = alignCandidates(candidates, input.words, input.subtitleCues);
  if (aligned.length === 0) {
    // 有口播但卖点全部没对齐（如口播没逐字讲）→ 均分兜底，避免静默丢卖点
    return { pointCues: distributeEvenCues(candidates, coverSec, totalSec), mode: 'even', usedLLM };
  }
  // §9 时间基准修正：对齐结果是口播时间轴秒，统一换算为成片时间轴秒后再后处理
  // （与 renderer.ts 字幕同口径：成片秒 = coverSec + 口播秒/倍速；此前漏换算导致弹出系统性提前）
  const filmTimed = aligned.map((cue) => ({
    text: cue.text,
    startSec: coverSec + cue.startSec / rate,
    endSec: coverSec + cue.endSec / rate,
  }));
  return { pointCues: postProcessTimedCues(filmTimed, coverSec, totalSec), mode: 'timed', usedLLM };
}


export interface StoredNarrationTimings {
  words: WordTiming[];
}

function normalizeWords(input: unknown): WordTiming[] {
  if (!Array.isArray(input)) return [];
  const result: WordTiming[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const raw = item as { text?: unknown; startUs?: unknown; endUs?: unknown };
    if (typeof raw.text !== 'string' || !raw.text.trim()) continue;
    const startUs = Number(raw.startUs);
    const endUs = Number(raw.endUs);
    if (!Number.isFinite(startUs) || !Number.isFinite(endUs) || endUs <= startUs) continue;
    result.push({ text: raw.text.trim(), startUs, endUs });
  }
  return result;
}

export function parseStoredWordTimings(json: unknown): StoredNarrationTimings {
  const parsed = (typeof json === 'string' ? (() => { try { return JSON.parse(json); } catch { return null; } })() : json) as { words?: unknown } | unknown[] | null;
  if (Array.isArray(parsed)) {
    // 历史裸数组
    return { words: normalizeWords(parsed) };
  }
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { words?: unknown }).words)) {
    return { words: normalizeWords((parsed as { words: unknown }).words) };
  }
  return { words: [] };
}


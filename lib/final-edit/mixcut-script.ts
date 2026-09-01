import { normalizeAutomaticSubtitleText } from '../subtitle-display.ts';

export type MixcutScriptSyncState = 'synced' | 'modified';

export interface MixcutSourceSegment {
  id?: string;
  shotId?: string;
  narration?: string;
  subtitle?: string;
  sellingPointRefs?: string[];
  visualIntent?: string;
  visualKeywords?: string[];
}

export interface MixcutSourceScript {
  version: number;
  title?: string;
  coverTitleParts?: { primary: string; secondary: string; source?: 'model' | 'system_split' | 'system_composed' };
  targetDurationSec?: number;
  shotSetId: string;
  segments: MixcutSourceSegment[];
  fullScript?: string;
}

export interface MixcutTaskScriptSegment {
  id: string;
  shotId: string;
  narration: string;
  subtitle: string;
  sellingPointRefs?: string[];
  visualIntent?: string;
  visualKeywords?: string[];
}

export interface MixcutTaskScriptSnapshot {
  version: 2;
  source: 'module3' | 'manual';
  sourceDraftId: string | null;
  sourceScriptUpdatedAt: string | null;
  /** 源脚本 revision 身份（project_scripts 才有）。旧快照缺字段时按 null 兼容读取。 */
  sourceScriptRevisionId?: string | null;
  sourceScriptRevisionNumber?: number | null;
  sourceScriptVersion: number | null;
  title: string;
  coverTitleParts?: { primary: string; secondary: string; source?: 'model' | 'system_split' | 'system_composed' };
  targetDurationSec: number;
  shotSetId: string;
  sourceNarrationText: string;
  sourceSegments: MixcutSourceSegment[];
  editedNarrationText: string;
  scriptSyncState: MixcutScriptSyncState;
  segments: MixcutTaskScriptSegment[];
  fullScript: string;
}

export function normalizeNarrationText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t\f\v ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

export function sourceNarrationText(source: Pick<MixcutSourceScript, 'segments' | 'fullScript'>): string {
  const fromSegments = source.segments
    .map((segment) => normalizeNarrationText(String(segment.narration || segment.subtitle || '')))
    .filter(Boolean)
    .join('\n');
  return fromSegments || normalizeNarrationText(source.fullScript || '');
}

export function getScriptSyncState(sourceText: string, editedText: string): MixcutScriptSyncState {
  return normalizeNarrationText(sourceText) === normalizeNarrationText(editedText) ? 'synced' : 'modified';
}

export function buildMixcutSemanticText(input: {
  narration: string;
  sourceScriptVersion: number | null;
  sourceSegment?: Pick<MixcutTaskScriptSegment, 'sellingPointRefs' | 'visualIntent' | 'visualKeywords'>;
}): string {
  if (input.sourceScriptVersion !== 3 || !input.sourceSegment) return input.narration;
  const auxiliary = [
    input.sourceSegment.visualIntent || '',
    ...(input.sourceSegment.visualKeywords || []).slice(0, 8),
    ...(input.sourceSegment.sellingPointRefs || []).slice(0, 8),
  ].filter(Boolean).join(' ').slice(0, 180);
  return auxiliary ? `${input.narration}\n画面语义：${auxiliary}` : input.narration;
}

const MIN_MATCH_SEGMENT_CHARS = 10;
const SOFT_MAX_MATCH_SEGMENT_CHARS = 22;
const HARD_MAX_MATCH_SEGMENT_CHARS = 24;

function contentLength(value: string): number {
  return Array.from(value.replace(/[\p{P}\p{S}\s]/gu, '')).length;
}

function splitByContentLimit(value: string): string[] {
  const total = contentLength(value);
  const chunkCount = Math.ceil(total / HARD_MAX_MATCH_SEGMENT_CHARS);
  if (chunkCount <= 1) return [value];

  const characters = Array.from(value);
  const chunks: string[] = [];
  let current = '';
  let currentContent = 0;
  let remainingContent = total;
  let remainingChunks = chunkCount;
  let target = Math.ceil(remainingContent / remainingChunks);
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    current += character;
    if (!/[\p{P}\p{S}\s]/u.test(character)) currentContent += 1;
    const next = characters[index + 1];
    const nextIsContent = next != null && !/[\p{P}\p{S}\s]/u.test(next);
    if (remainingChunks > 1 && currentContent >= target && nextIsContent) {
      chunks.push(current.trim());
      remainingContent -= currentContent;
      remainingChunks -= 1;
      target = Math.ceil(remainingContent / remainingChunks);
      current = '';
      currentContent = 0;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function rebalanceShortSegments(values: string[]): string[] {
  const balanced = values.slice();
  for (let index = 0; index < balanced.length; index += 1) {
    if (contentLength(balanced[index]) >= MIN_MATCH_SEGMENT_CHARS || balanced.length === 1) continue;
    const pairStart = index < balanced.length - 1 ? index : index - 1;
    if (pairStart < 0) continue;
    const replacement = splitByContentLimit(balanced[pairStart] + balanced[pairStart + 1]);
    balanced.splice(pairStart, 2, ...replacement);
    index = Math.max(-1, pairStart - 1);
  }
  return balanced;
}

function mergeNarrationClauses(sentence: string): string[] {
  const clauses = (sentence.match(/[^，,、]+[，,、]*/g)?.map((part) => part.trim()).filter(Boolean) || [sentence])
    .flatMap(splitByContentLimit);
  const merged: string[] = [];
  let current = '';
  for (const clause of clauses) {
    const currentLength = contentLength(current);
    const combinedLength = currentLength + contentLength(clause);
    const shouldSplit = Boolean(current) && (
      combinedLength > HARD_MAX_MATCH_SEGMENT_CHARS
      || (currentLength >= MIN_MATCH_SEGMENT_CHARS && combinedLength > SOFT_MAX_MATCH_SEGMENT_CHARS)
    );
    if (shouldSplit) {
      merged.push(current);
      current = clause;
    } else {
      current += clause;
    }
  }
  if (current) merged.push(current);
  return rebalanceShortSegments(merged.filter(Boolean));
}

/**
 * Split at explicit lines and sentence punctuation, then use weak punctuation
 * to create material-matching segments. Short comma clauses are merged so TTS
 * does not turn the edit into rapid-fire cuts. Punctuation remains attached.
 */
export function splitNarrationSentences(value: string): string[] {
  const normalized = normalizeNarrationText(value);
  if (!normalized) return [];
  const sentences: string[] = [];
  for (const line of normalized.split('\n')) {
    const matches = line.match(/[^。！？!?；;]+[。！？!?；;]*/g) || [];
    for (const match of matches) {
      const sentence = match.trim();
      if (sentence) sentences.push(...mergeNarrationClauses(sentence));
    }
  }
  return sentences;
}

function usableShotIds(source: MixcutSourceScript | null): string[] {
  if (!source || source.version === 3) return [];
  return source.segments.map((segment) => String(segment.shotId || '').trim()).filter(Boolean);
}

export function buildMixcutTaskScriptSnapshot(input: {
  sourceDraftId?: string | null;
  sourceScriptUpdatedAt?: string | null;
  sourceScriptRevisionId?: string | null;
  sourceScriptRevisionNumber?: number | null;
  sourceScript?: MixcutSourceScript | null;
  shotSetId: string;
  editedNarrationText: string;
}): MixcutTaskScriptSnapshot {
  const editedNarrationText = normalizeNarrationText(input.editedNarrationText);
  if (!input.shotSetId.trim()) throw new Error('shot_set_required');
  if (!editedNarrationText) throw new Error('narration_text_required');
  const source = input.sourceScript || null;
  if (source && input.shotSetId.trim() && source.shotSetId && source.shotSetId !== input.shotSetId) {
    throw new Error('script_shot_set_mismatch');
  }
  const originalText = source ? sourceNarrationText(source) : '';
  const syncState = source ? getScriptSyncState(originalText, editedNarrationText) : 'modified';
  const originalSegments = source?.segments || [];
  const editedLines = editedNarrationText.split('\n').map((line) => line.trim()).filter(Boolean);
  const canPreserveBoundaries = Boolean(source)
    && syncState === 'synced'
    && originalSegments.length > 0
    && originalSegments.every((segment) => normalizeNarrationText(String(segment.narration || segment.subtitle || '')));
  const canMapEditedLines = Boolean(source)
    && syncState === 'modified'
    && editedLines.length === originalSegments.length;
  const mappedParentSegments = canPreserveBoundaries
    ? originalSegments.map((segment) => ({ segment, narration: normalizeNarrationText(String(segment.narration || segment.subtitle || '')) }))
    : canMapEditedLines
      ? originalSegments.map((segment, index) => ({ segment, narration: editedLines[index] }))
      : null;
  const preservedSegments = mappedParentSegments
    ? mappedParentSegments.flatMap(({ segment, narration }, sourceIndex) => {
        // Module 3 already produced the target 5–8 visual sentences: keep them.
        // Character count cannot predict TTS duration across providers/speeds;
        // the real regression is the coarse 3-segment script refined below.
        const parts = originalSegments.length >= 5 && originalSegments.length <= 8
          ? [narration]
          : splitNarrationSentences(narration);
        return parts.map((part, partIndex) => ({
          id: parts.length === 1 && segment.id ? segment.id : `${segment.id || `source-${sourceIndex + 1}`}-part-${partIndex + 1}`,
          shotId: source?.version === 3 ? '' : String(segment.shotId || ''),
          narration: part,
          sellingPointRefs: Array.isArray(segment.sellingPointRefs) ? segment.sellingPointRefs.slice(0, 8) : [],
          visualIntent: String(segment.visualIntent || '').trim(),
          visualKeywords: Array.isArray(segment.visualKeywords) ? segment.visualKeywords.map(String).slice(0, 8) : [],
        }));
      })
    : null;
  const sentences = preservedSegments?.map((segment) => segment.narration) || splitNarrationSentences(editedNarrationText);
  const shotIds = usableShotIds(source);
  const segments = sentences.map((narration, index) => {
    const preserved = preservedSegments?.[index];
    const original = originalSegments[index];
    return {
      id: preserved?.id || `segment-${index + 1}`,
      shotId: source?.version === 3 ? '' : preserved?.shotId || (syncState === 'synced' ? String(original?.shotId || shotIds[index] || '') : ''),
      narration,
      subtitle: normalizeAutomaticSubtitleText(narration),
      ...(preserved?.sellingPointRefs?.length ? { sellingPointRefs: preserved.sellingPointRefs } : {}),
      ...(preserved?.visualIntent ? { visualIntent: preserved.visualIntent } : {}),
      ...(preserved?.visualKeywords?.length ? { visualKeywords: preserved.visualKeywords } : {}),
    };
  });
  return {
    version: 2,
    source: source ? 'module3' : 'manual',
    sourceDraftId: source ? (input.sourceDraftId || null) : null,
    sourceScriptUpdatedAt: source ? (input.sourceScriptUpdatedAt || null) : null,
    sourceScriptRevisionId: source ? (input.sourceScriptRevisionId ?? null) : null,
    sourceScriptRevisionNumber: source ? (input.sourceScriptRevisionNumber ?? null) : null,
    sourceScriptVersion: source?.version || null,
    title: source?.title || '手工混剪文案',
    ...(source?.coverTitleParts ? { coverTitleParts: source.coverTitleParts } : {}),
    targetDurationSec: Math.max(1, Number(source?.targetDurationSec || 15)),
    shotSetId: input.shotSetId,
    sourceNarrationText: originalText,
    sourceSegments: source ? structuredClone(source.segments) : [],
    editedNarrationText,
    scriptSyncState: syncState,
    segments,
    fullScript: editedNarrationText,
  };
}

export function buildMixcutEditingScriptSnapshot(input: {
  sourceDraftId?: string | null;
  sourceScriptUpdatedAt?: string | null;
  sourceScriptRevisionId?: string | null;
  sourceScriptRevisionNumber?: number | null;
  sourceScript?: MixcutSourceScript | null;
  shotSetId: string;
  editedNarrationText: string;
}): MixcutTaskScriptSnapshot {
  const normalized = normalizeNarrationText(input.editedNarrationText);
  if (normalized) return buildMixcutTaskScriptSnapshot({ ...input, editedNarrationText: normalized });
  if (!input.shotSetId.trim()) throw new Error('shot_set_required');
  const source = input.sourceScript || null;
  if (source && input.shotSetId.trim() && source.shotSetId && source.shotSetId !== input.shotSetId) {
    throw new Error('script_shot_set_mismatch');
  }
  const originalText = source ? sourceNarrationText(source) : '';
  return {
    version: 2,
    source: source ? 'module3' : 'manual',
    sourceDraftId: source ? (input.sourceDraftId || null) : null,
    sourceScriptUpdatedAt: source ? (input.sourceScriptUpdatedAt || null) : null,
    sourceScriptRevisionId: source ? (input.sourceScriptRevisionId ?? null) : null,
    sourceScriptRevisionNumber: source ? (input.sourceScriptRevisionNumber ?? null) : null,
    sourceScriptVersion: source?.version || null,
    title: source?.title || '手工混剪文案',
    ...(source?.coverTitleParts ? { coverTitleParts: source.coverTitleParts } : {}),
    targetDurationSec: Math.max(1, Number(source?.targetDurationSec || 15)),
    shotSetId: input.shotSetId,
    sourceNarrationText: originalText,
    sourceSegments: source ? structuredClone(source.segments) : [],
    editedNarrationText: '',
    scriptSyncState: source && !originalText ? 'synced' : 'modified',
    segments: [],
    fullScript: '',
  };
}

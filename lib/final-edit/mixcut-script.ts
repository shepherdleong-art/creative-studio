export type MixcutScriptSyncState = 'synced' | 'modified';

export interface MixcutSourceSegment {
  id?: string;
  shotId?: string;
  narration?: string;
  subtitle?: string;
}

export interface MixcutSourceScript {
  version: number;
  title?: string;
  coverTitleParts?: { primary: string; secondary: string };
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
}

export interface MixcutTaskScriptSnapshot {
  version: 2;
  source: 'module3' | 'manual';
  sourceDraftId: string | null;
  sourceScriptUpdatedAt: string | null;
  title: string;
  coverTitleParts?: { primary: string; secondary: string };
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

const MIN_MATCH_SEGMENT_CHARS = 10;
const SOFT_MAX_MATCH_SEGMENT_CHARS = 22;
const HARD_MAX_MATCH_SEGMENT_CHARS = 24;

function contentLength(value: string): number {
  return Array.from(value.replace(/[\p{P}\p{S}\s]/gu, '')).length;
}

function mergeNarrationClauses(sentence: string): string[] {
  const clauses = sentence.match(/[^，,、]+[，,、]*/g)?.map((part) => part.trim()).filter(Boolean) || [sentence];
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

  if (merged.length > 1 && contentLength(merged.at(-1)!) < MIN_MATCH_SEGMENT_CHARS) {
    const tail = merged.pop()!;
    const previous = merged.pop()!;
    if (contentLength(previous) + contentLength(tail) <= HARD_MAX_MATCH_SEGMENT_CHARS) {
      merged.push(previous + tail);
    } else {
      const characters = Array.from(previous + tail);
      const target = Math.ceil(contentLength(previous + tail) / 2);
      let splitIndex = 0;
      let seen = 0;
      while (splitIndex < characters.length && seen < target) {
        if (!/[\p{P}\p{S}\s]/u.test(characters[splitIndex])) seen += 1;
        splitIndex += 1;
      }
      merged.push(characters.slice(0, splitIndex).join('').trim(), characters.slice(splitIndex).join('').trim());
    }
  }
  return merged.filter(Boolean);
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
  if (!source) return [];
  return source.segments.map((segment) => String(segment.shotId || '').trim()).filter(Boolean);
}

export function buildMixcutTaskScriptSnapshot(input: {
  sourceDraftId?: string | null;
  sourceScriptUpdatedAt?: string | null;
  sourceScript?: MixcutSourceScript | null;
  shotSetId: string;
  editedNarrationText: string;
}): MixcutTaskScriptSnapshot {
  const editedNarrationText = normalizeNarrationText(input.editedNarrationText);
  if (!input.shotSetId.trim()) throw new Error('shot_set_required');
  if (!editedNarrationText) throw new Error('narration_text_required');
  const source = input.sourceScript || null;
  if (source && source.shotSetId !== input.shotSetId) throw new Error('script_shot_set_mismatch');
  const originalText = source ? sourceNarrationText(source) : '';
  const syncState = source ? getScriptSyncState(originalText, editedNarrationText) : 'modified';
  const originalSegments = source?.segments || [];
  const canPreserveBoundaries = Boolean(source)
    && syncState === 'synced'
    && originalSegments.length > 0
    && originalSegments.every((segment) => normalizeNarrationText(String(segment.narration || segment.subtitle || '')));
  const preservedSegments = canPreserveBoundaries
    ? originalSegments.flatMap((segment, sourceIndex) => {
        const narration = normalizeNarrationText(String(segment.narration || segment.subtitle || ''));
        // Module 3 already produced the target 5–8 visual sentences: keep them.
        // Only refine coarse scripts (the real regression had 3 × ~7.4s).
        const parts = originalSegments.length >= 5 && originalSegments.length <= 8
          ? [narration]
          : splitNarrationSentences(narration);
        return parts.map((part, partIndex) => ({
          id: parts.length === 1 && segment.id ? segment.id : `${segment.id || `source-${sourceIndex + 1}`}-part-${partIndex + 1}`,
          shotId: String(segment.shotId || ''),
          narration: part,
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
      shotId: preserved?.shotId || String(original?.shotId || shotIds[index] || ''),
      narration,
      subtitle: narration,
    };
  });
  return {
    version: 2,
    source: source ? 'module3' : 'manual',
    sourceDraftId: source ? (input.sourceDraftId || null) : null,
    sourceScriptUpdatedAt: source ? (input.sourceScriptUpdatedAt || null) : null,
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
  sourceScript?: MixcutSourceScript | null;
  shotSetId: string;
  editedNarrationText: string;
}): MixcutTaskScriptSnapshot {
  const normalized = normalizeNarrationText(input.editedNarrationText);
  if (normalized) return buildMixcutTaskScriptSnapshot({ ...input, editedNarrationText: normalized });
  if (!input.shotSetId.trim()) throw new Error('shot_set_required');
  const source = input.sourceScript || null;
  if (source && source.shotSetId !== input.shotSetId) throw new Error('script_shot_set_mismatch');
  const originalText = source ? sourceNarrationText(source) : '';
  return {
    version: 2,
    source: source ? 'module3' : 'manual',
    sourceDraftId: source ? (input.sourceDraftId || null) : null,
    sourceScriptUpdatedAt: source ? (input.sourceScriptUpdatedAt || null) : null,
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

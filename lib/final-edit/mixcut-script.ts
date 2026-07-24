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

/**
 * Split at explicit lines and Chinese/English sentence punctuation. Punctuation
 * remains attached to its sentence, which makes the result stable and suitable
 * for TTS. No model call or locale-dependent segmenter is involved.
 */
export function splitNarrationSentences(value: string): string[] {
  const normalized = normalizeNarrationText(value);
  if (!normalized) return [];
  const sentences: string[] = [];
  for (const line of normalized.split('\n')) {
    const matches = line.match(/[^。！？!?；;]+[。！？!?；;]*/g) || [];
    for (const match of matches) {
      const sentence = match.trim();
      if (sentence) sentences.push(sentence);
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
  const sentences = canPreserveBoundaries
    ? originalSegments.map((segment) => normalizeNarrationText(String(segment.narration || segment.subtitle || '')))
    : splitNarrationSentences(editedNarrationText);
  const shotIds = usableShotIds(source);
  const segments = sentences.map((narration, index) => {
    const original = originalSegments[index];
    return {
      id: canPreserveBoundaries && original?.id ? original.id : `segment-${index + 1}`,
      shotId: String(original?.shotId || shotIds[index] || ''),
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

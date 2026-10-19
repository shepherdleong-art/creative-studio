export interface TimedMatchSourceSegment {
  id: string;
  shotId?: string;
  text: string;
  startUs: number;
  endUs: number;
}

export interface MatchWordTiming {
  text: string;
  startUs: number;
  endUs: number;
}

export interface TtsAwareMatchSentence {
  id: string;
  sourceSegmentId: string;
  shotId?: string;
  text: string;
  startUs: number;
  endUs: number;
}

const DEFAULT_MIN_SENTENCE_DURATION_US = 1_200_000;
const DEFAULT_MAX_SENTENCE_COUNT = 8;

function finite(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

function overlapUs(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): number {
  return Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
}

function naturalBoundaryText(value: string): boolean {
  return /[，,、。！？!?；;：:]\s*$/u.test(value);
}

/**
 * Repartitions visual matching sentences only after real TTS timings exist.
 * Narration audio, script segments, subtitles, and their persisted ids remain
 * unchanged; the returned ids are deterministic matching-only ids.
 */
export function buildTtsAwareMatchSentences(input: {
  segments: TimedMatchSourceSegment[];
  wordTimings: MatchWordTiming[];
  maxSceneDurationUs: number;
  availableSceneCount: number;
  minSentenceDurationUs?: number;
  maxSentenceCount?: number;
}): TtsAwareMatchSentence[] {
  const segments = input.segments
    .map((segment) => ({
      ...segment,
      id: segment.id.trim(),
      text: segment.text.trim(),
      startUs: finite(segment.startUs),
      endUs: finite(segment.endUs),
    }))
    .filter((segment) => segment.id && segment.text && segment.endUs > segment.startUs)
    .sort((left, right) => left.startUs - right.startUs || left.id.localeCompare(right.id));
  if (!segments.length) return [];
  const unchanged = segments.map((segment) => ({ ...segment, sourceSegmentId: segment.id }));

  const maxSceneDurationUs = finite(input.maxSceneDurationUs);
  if (maxSceneDurationUs <= 0 || segments.every((segment) => segment.endUs - segment.startUs <= maxSceneDurationUs)) {
    return unchanged;
  }

  const startUs = segments[0].startUs;
  const endUs = segments.at(-1)!.endUs;
  const totalDurationUs = endUs - startUs;
  const minSentenceDurationUs = Math.max(1, finite(input.minSentenceDurationUs ?? DEFAULT_MIN_SENTENCE_DURATION_US));
  const configuredMaxCount = Math.max(1, Math.floor(finite(input.maxSentenceCount ?? DEFAULT_MAX_SENTENCE_COUNT)));
  const maxSentenceCount = Math.min(configuredMaxCount, Math.max(1, Math.floor(finite(input.availableSceneCount))));
  const minimumGlobalCount = Math.max(1, Math.ceil(totalDurationUs / maxSceneDurationUs));
  const desiredCount = segments.reduce((sum, segment) => sum + Math.ceil((segment.endUs - segment.startUs) / maxSceneDurationUs), 0);
  const durationLimitedCount = Math.max(1, Math.floor(totalDurationUs / minSentenceDurationUs));
  const targetCount = Math.min(
    durationLimitedCount,
    configuredMaxCount,
    Math.max(minimumGlobalCount, Math.min(desiredCount, maxSentenceCount)),
  );
  if (targetCount <= 1 || targetCount < minimumGlobalCount) return unchanged;

  const words = input.wordTimings
    .map((word) => ({ ...word, text: word.text.trim(), startUs: finite(word.startUs), endUs: finite(word.endUs) }))
    .filter((word) => word.text && word.endUs > word.startUs && word.endUs > startUs && word.startUs < endUs)
    .sort((left, right) => left.startUs - right.startUs || left.endUs - right.endUs);
  if (!words.length) return unchanged;

  const boundaryPreference = new Map<number, number>();
  for (const segment of segments.slice(0, -1)) {
    if (segment.endUs > startUs && segment.endUs < endUs) boundaryPreference.set(segment.endUs, 0);
  }
  for (const word of words) {
    if (word.endUs <= startUs || word.endUs >= endUs) continue;
    const preference = naturalBoundaryText(word.text) ? 0 : 1;
    boundaryPreference.set(word.endUs, Math.min(boundaryPreference.get(word.endUs) ?? preference, preference));
  }
  const candidateBoundaries = [...boundaryPreference].map(([timeUs, preference]) => ({ timeUs, preference }));
  const boundaries = [startUs];
  for (let index = 1; index < targetCount; index += 1) {
    const previousUs = boundaries.at(-1)!;
    const remainingCount = targetCount - index;
    const idealUs = startUs + Math.round(totalDurationUs * index / targetCount);
    const lowerUs = Math.max(previousUs + minSentenceDurationUs, endUs - remainingCount * maxSceneDurationUs);
    const upperUs = Math.min(previousUs + maxSceneDurationUs, endUs - remainingCount * minSentenceDurationUs);
    if (lowerUs > upperUs) return unchanged;
    const candidates = candidateBoundaries
      .filter((candidate) => candidate.timeUs >= lowerUs && candidate.timeUs <= upperUs)
      .sort((left, right) => left.preference - right.preference
        || Math.abs(left.timeUs - idealUs) - Math.abs(right.timeUs - idealUs)
        || left.timeUs - right.timeUs);
    boundaries.push(candidates[0]?.timeUs ?? Math.max(lowerUs, Math.min(upperUs, idealUs)));
  }
  boundaries.push(endUs);

  return boundaries.slice(1).map((unitEndUs, index) => {
    const unitStartUs = boundaries[index];
    const overlappingSegments = segments
      .map((segment, sourceIndex) => ({ segment, sourceIndex, overlap: overlapUs(unitStartUs, unitEndUs, segment.startUs, segment.endUs) }))
      .filter((entry) => entry.overlap > 0)
      .sort((left, right) => right.overlap - left.overlap || left.sourceIndex - right.sourceIndex);
    const dominant = overlappingSegments[0]?.segment;
    const text = words
      .filter((word) => {
        const midpointUs = word.startUs + (word.endUs - word.startUs) / 2;
        return midpointUs >= unitStartUs && (index === targetCount - 1 ? midpointUs <= unitEndUs : midpointUs < unitEndUs);
      })
      .map((word) => word.text)
      .join('')
      .trim() || overlappingSegments.map((entry) => entry.segment.text).join('').trim();
    return {
      id: `${dominant?.id || 'segment'}-match-${index + 1}`,
      sourceSegmentId: dominant?.id || segments[0].id,
      ...(dominant?.shotId ? { shotId: dominant.shotId } : {}),
      text,
      startUs: unitStartUs,
      endUs: unitEndUs,
    };
  });
}

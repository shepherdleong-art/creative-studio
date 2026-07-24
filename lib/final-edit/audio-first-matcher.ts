export interface AudioFirstSentence {
  id: string;
  text: string;
  startUs: number;
  endUs: number;
  keywords: string[];
}

export interface AudioFirstScene {
  startUs: number;
  endUs: number;
  labels: string[];
  quality: number;
}

export interface AudioFirstAsset {
  assetKey: string;
  shotId?: string;
  durationUs: number;
  scenes: AudioFirstScene[];
  source: 'module4' | 'external';
}

export interface TimelineLock {
  sentenceId: string;
  assetKey: string;
  startUs: number;
  endUs: number;
}

export interface AudioFirstMatchInput {
  sentences: AudioFirstSentence[];
  assets: AudioFirstAsset[];
  semanticScores: number[][];
  hookScores: number[];
  beatPoints: number[];
  manualLocks: TimelineLock[];
  maxReuse: number;
  semanticFallback: boolean;
}

export interface TimelinePlanSegment {
  sentenceId: string;
  assetKey: string;
  startUs: number;
  endUs: number;
  sourceStartUs: number;
  sourceEndUs: number;
}

export interface TimelinePlan {
  segments: TimelinePlanSegment[];
}

export interface SnappedCut {
  previousSentenceId: string;
  nextSentenceId: string;
  originalCutUs: number;
  snappedCutUs: number;
  deltaUs: number;
}

export interface MatchGap {
  sentenceId: string;
  startUs: number;
  endUs: number;
  reason: 'no_material' | 'insufficient_duration' | 'reuse_limit';
}

export interface MatchIssue {
  sentenceId: string;
  code: 'invalid_lock' | 'material_gap';
  message: string;
}

export interface MatchDiagnostics {
  semanticFallback: boolean;
  backoffSentences: string[];
  snappedCuts: SnappedCut[];
  gaps: MatchGap[];
  issues: MatchIssue[];
}

export interface AudioFirstMatchResult {
  plan: TimelinePlan;
  diagnostics: MatchDiagnostics;
}

interface Candidate {
  asset: AudioFirstAsset;
  scene: AudioFirstScene;
  flatIndex: number;
}

interface SelectedCandidate {
  candidate: Candidate;
  belowFloor: boolean;
}

const RED_LINE = 0.35;
const SEMANTIC_FLOOR_ABS = 0.3;
const SEMANTIC_FLOOR_REL = 0.15;
const REUSE_PENALTY = 0.15;
const HOOK_WEIGHT = 0.2;
const BEAT_TOLERANCE_US = 200_000;
const MIN_SEGMENT_DURATION_US = 200_000;
const EPSILON = 1e-9;

function finiteNumber(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function clampScore(value: number | undefined): number {
  return Math.max(0, Math.min(1, finiteNumber(value ?? 0)));
}

function flattenCandidates(assets: AudioFirstAsset[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const asset of assets) {
    for (let sceneIndex = 0; sceneIndex < asset.scenes.length; sceneIndex += 1) {
      candidates.push({
        asset,
        scene: asset.scenes[sceneIndex],
        flatIndex: candidates.length,
      });
    }
  }
  return candidates;
}

function normalizeTerms(values: string[]): Set<string> {
  return new Set(
    values
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function keywordSimilarity(sentence: AudioFirstSentence, scene: AudioFirstScene): number {
  const keywords = normalizeTerms(sentence.keywords);
  const labels = normalizeTerms(scene.labels);
  if (keywords.size === 0 || labels.size === 0) return 0;

  let overlap = 0;
  for (const keyword of keywords) {
    if (labels.has(keyword)) overlap += 1;
  }
  return overlap / Math.max(keywords.size, labels.size);
}

function isLengthFeasible(candidate: Candidate, durationUs: number): boolean {
  const sceneStartUs = finiteNumber(candidate.scene.startUs);
  const sceneEndUs = finiteNumber(candidate.scene.endUs);
  const assetDurationUs = finiteNumber(candidate.asset.durationUs);
  return durationUs >= 0
    && sceneStartUs >= 0
    && sceneEndUs >= sceneStartUs
    && sceneEndUs - sceneStartUs >= durationUs
    && sceneStartUs + durationUs <= sceneEndUs
    && sceneStartUs + durationUs <= assetDurationUs;
}

function candidateScore(
  input: AudioFirstMatchInput,
  sentence: AudioFirstSentence,
  sentenceIndex: number,
  candidate: Candidate,
  usageByAsset: ReadonlyMap<string, number>,
  previousAssetKey: string | undefined,
): number {
  const semantic = clampScore(input.semanticScores[sentenceIndex]?.[candidate.flatIndex]);
  const keyword = keywordSimilarity(sentence, candidate.scene);
  const quality = clampScore(candidate.scene.quality);
  const usage = usageByAsset.get(candidate.asset.assetKey) ?? 0;
  const sameShotPrior = candidate.asset.shotId === sentence.id ? 0.1 : 0;
  const hook = sentenceIndex === 0 ? clampScore(input.hookScores[candidate.flatIndex]) * HOOK_WEIGHT : 0;
  const fallbackKeyword = input.semanticFallback ? keyword : keyword * 0.02;
  const adjacentPenalty = previousAssetKey === candidate.asset.assetKey ? 0.05 : 0;

  return semantic
    + sameShotPrior
    + fallbackKeyword
    + quality * 0.001
    + hook
    - usage * REUSE_PENALTY
    - adjacentPenalty;
}

function chooseCandidate(
  input: AudioFirstMatchInput,
  sentence: AudioFirstSentence,
  sentenceIndex: number,
  candidates: Candidate[],
  usageByAsset: ReadonlyMap<string, number>,
  previousAssetKey: string | undefined,
): SelectedCandidate | undefined {
  const durationUs = sentence.endUs - sentence.startUs;
  const lengthFeasible = candidates.filter((candidate) => isLengthFeasible(candidate, durationUs));
  if (lengthFeasible.length === 0) return undefined;

  const rawScores = lengthFeasible.map((candidate) =>
    clampScore(input.semanticScores[sentenceIndex]?.[candidate.flatIndex]));
  const bestSemantic = Math.max(0, ...rawScores);
  const semanticFloor = Math.max(
    SEMANTIC_FLOOR_ABS,
    RED_LINE,
    bestSemantic * (1 - SEMANTIC_FLOOR_REL),
  );
  const reuseLimit = Math.max(0, Math.floor(finiteNumber(input.maxReuse)));
  const reuseEligible = lengthFeasible.filter((candidate) =>
    (usageByAsset.get(candidate.asset.assetKey) ?? 0) < reuseLimit);
  if (reuseEligible.length === 0) return undefined;

  const acceptable = reuseEligible.filter((candidate) =>
    clampScore(input.semanticScores[sentenceIndex]?.[candidate.flatIndex]) >= semanticFloor - EPSILON);
  const pool = acceptable.length > 0 ? acceptable : reuseEligible;

  let best = pool[0];
  let bestScore = candidateScore(input, sentence, sentenceIndex, best, usageByAsset, previousAssetKey);
  for (const candidate of pool.slice(1)) {
    const score = candidateScore(input, sentence, sentenceIndex, candidate, usageByAsset, previousAssetKey);
    if (score > bestScore + EPSILON || (Math.abs(score - bestScore) <= EPSILON && candidate.flatIndex < best.flatIndex)) {
      best = candidate;
      bestScore = score;
    }
  }

  return { candidate: best, belowFloor: acceptable.length === 0 };
}

function sourceIntervalInsideAsset(
  asset: AudioFirstAsset,
  startUs: number,
  endUs: number,
): boolean {
  return startUs >= 0
    && endUs <= asset.durationUs
    && endUs >= startUs
    && asset.scenes.some((scene) => startUs >= scene.startUs && endUs <= scene.endUs);
}

function applyBeatSnapping(
  segments: TimelinePlanSegment[],
  input: AudioFirstMatchInput,
  candidateBySentence: ReadonlyMap<string, Candidate>,
  lockedSentences: ReadonlySet<string>,
): SnappedCut[] {
  const snappedCuts: SnappedCut[] = [];
  const usedBoundaryIndexes = new Set<number>();
  const beats = input.beatPoints
    .filter(Number.isFinite)
    .slice()
    .sort((left, right) => left - right);

  for (const beatUs of beats) {
    if (segments.length < 2) break;

    let boundaryIndex = -1;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < segments.length - 1; index += 1) {
      if (usedBoundaryIndexes.has(index)) continue;
      const distance = Math.abs(segments[index].endUs - beatUs);
      if (distance < closestDistance) {
        closestDistance = distance;
        boundaryIndex = index;
      }
    }
    if (boundaryIndex < 0 || closestDistance > BEAT_TOLERANCE_US) continue;

    const previous = segments[boundaryIndex];
    const next = segments[boundaryIndex + 1];
    if (previous.endUs !== next.startUs) continue;
    if (lockedSentences.has(previous.sentenceId) || lockedSentences.has(next.sentenceId)) continue;

    const deltaUs = beatUs - previous.endUs;
    const previousDurationUs = previous.endUs - previous.startUs + deltaUs;
    const nextDurationUs = next.endUs - next.startUs - deltaUs;
    if (previousDurationUs < MIN_SEGMENT_DURATION_US || nextDurationUs < MIN_SEGMENT_DURATION_US) continue;

    const previousCandidate = candidateBySentence.get(previous.sentenceId);
    const nextCandidate = candidateBySentence.get(next.sentenceId);
    if (!previousCandidate || !nextCandidate) continue;

    const previousSourceEndUs = previous.sourceEndUs + deltaUs;
    const nextSourceEndUs = next.sourceEndUs - deltaUs;
    if (!sourceIntervalInsideAsset(previousCandidate.asset, previous.sourceStartUs, previousSourceEndUs)) continue;
    if (!sourceIntervalInsideAsset(nextCandidate.asset, next.sourceStartUs, nextSourceEndUs)) continue;

    const originalCutUs = previous.endUs;
    previous.endUs = beatUs;
    previous.sourceEndUs = previousSourceEndUs;
    next.startUs = beatUs;
    next.sourceEndUs = nextSourceEndUs;
    usedBoundaryIndexes.add(boundaryIndex);
    snappedCuts.push({
      previousSentenceId: previous.sentenceId,
      nextSentenceId: next.sentenceId,
      originalCutUs,
      snappedCutUs: beatUs,
      deltaUs,
    });
  }

  return snappedCuts;
}

export function matchAudioFirst(input: AudioFirstMatchInput): AudioFirstMatchResult {
  const candidates = flattenCandidates(input.assets);
  const lockBySentence = new Map(input.manualLocks.map((lock) => [lock.sentenceId, lock]));
  const lockedSentences = new Set<string>();
  const usageByAsset = new Map<string, number>();
  const candidateBySentence = new Map<string, Candidate>();
  const segments: TimelinePlanSegment[] = [];
  const backoffSentences: string[] = [];
  const gaps: MatchGap[] = [];
  const issues: MatchIssue[] = [];
  let previousAssetKey: string | undefined;

  const orderedSentences = input.sentences
    .map((sentence, originalIndex) => ({ sentence, originalIndex }))
    .sort((left, right) => left.sentence.startUs - right.sentence.startUs || left.originalIndex - right.originalIndex);

  for (const { sentence, originalIndex } of orderedSentences) {
    const durationUs = sentence.endUs - sentence.startUs;
    const lock = lockBySentence.get(sentence.id);
    if (lock) {
      const asset = input.assets.find((item) => item.assetKey === lock.assetKey);
      const candidate = candidates.find((item) =>
        item.asset.assetKey === lock.assetKey
        && lock.startUs >= item.scene.startUs
        && lock.endUs <= item.scene.endUs);
      if (asset && candidate && lock.endUs - lock.startUs === durationUs && sourceIntervalInsideAsset(asset, lock.startUs, lock.endUs)) {
        segments.push({
          sentenceId: sentence.id,
          assetKey: lock.assetKey,
          startUs: sentence.startUs,
          endUs: sentence.endUs,
          sourceStartUs: lock.startUs,
          sourceEndUs: lock.endUs,
        });
        lockedSentences.add(sentence.id);
        candidateBySentence.set(sentence.id, candidate);
        usageByAsset.set(lock.assetKey, (usageByAsset.get(lock.assetKey) ?? 0) + 1);
        previousAssetKey = lock.assetKey;
        continue;
      }

      issues.push({
        sentenceId: sentence.id,
        code: 'invalid_lock',
        message: '锁定片段不存在、越界或与口播句段时长不一致。',
      });
    }

    const selection = chooseCandidate(
      input,
      sentence,
      originalIndex,
      candidates,
      usageByAsset,
      previousAssetKey,
    );
    if (!selection) {
      const hasLengthFeasible = candidates.some((candidate) => isLengthFeasible(candidate, durationUs));
      const reason: MatchGap['reason'] = candidates.length === 0
        ? 'no_material'
        : hasLengthFeasible
          ? 'reuse_limit'
          : 'insufficient_duration';
      gaps.push({ sentenceId: sentence.id, startUs: sentence.startUs, endUs: sentence.endUs, reason });
      issues.push({ sentenceId: sentence.id, code: 'material_gap', message: '没有满足时长与复用限制的可用场景。' });
      continue;
    }

    const { candidate, belowFloor } = selection;
    const sourceStartUs = candidate.scene.startUs;
    segments.push({
      sentenceId: sentence.id,
      assetKey: candidate.asset.assetKey,
      startUs: sentence.startUs,
      endUs: sentence.endUs,
      sourceStartUs,
      sourceEndUs: sourceStartUs + durationUs,
    });
    if (belowFloor) backoffSentences.push(sentence.id);
    candidateBySentence.set(sentence.id, candidate);
    usageByAsset.set(candidate.asset.assetKey, (usageByAsset.get(candidate.asset.assetKey) ?? 0) + 1);
    previousAssetKey = candidate.asset.assetKey;
  }

  const snappedCuts = applyBeatSnapping(segments, input, candidateBySentence, lockedSentences);
  return {
    plan: { segments },
    diagnostics: {
      semanticFallback: input.semanticFallback,
      backoffSentences,
      snappedCuts,
      gaps,
      issues,
    },
  };
}

export interface AudioFirstSentence {
  id: string;
  shotId?: string;
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
  severity: 'blocking' | 'warning';
  message: string;
}

export interface MatchSelectionReason {
  sentenceId: string;
  assetKey: string;
  startUs: number;
  score: number;
  reason: 'manual_lock' | 'semantic_primary' | 'semantic_backoff' | 'material_length_fallback' | 'scene_reuse_fallback';
}

export interface MatchDiagnostics {
  semanticFallback: boolean;
  backoffSentences: string[];
  snappedCuts: SnappedCut[];
  gaps: MatchGap[];
  issues: MatchIssue[];
  selectionReasons: MatchSelectionReason[];
  usedMaterials: string[];
  totalMaterials: number;
  feasible: boolean;
  redLine: number;
  coveragePenalty: number;
  candidateWindow: number;
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

const RED_LINE = 0.35;
const SEMANTIC_FLOOR_ABS = 0.3;
const SEMANTIC_FLOOR_REL = 0.15;
const REUSE_PENALTY = 0.15;
const CANDIDATE_WINDOW = 0.1;
const HOOK_WEIGHT = 0.2;
const BEAT_TOLERANCE_US = 200_000;
const MIN_SEGMENT_DURATION_US = 200_000;
const EPSILON = 1e-9;

// TODO(v1.1, 计划 §7.4.2 第 4/5 条的已知偏差，2026-07-24 评审确认接受)：
// 1) 「相邻视觉重复惩罚」未实现——最小费用流的边成本是逐句独立的，无法直接
//    表达相邻句之间的成对惩罚（等价于二次分配问题）。当前同素材不同场景可
//    相邻出现而不加价，仅靠 REUSE_PENALTY 递增抑制整体复用。若后续要补，
//    可在求解后加确定性的局部交换后处理，而不是破坏求解器的纯函数结构。
// 2) 「可用时长/裁剪损失」只有象征性权重（quality*0.001）——1:1 audio-first
//    段长恒定下裁剪损失难建模，V1 以质量分微扰替代。

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
  const keywords = normalizeTerms([...sentence.keywords, sentence.text.replace(/[\p{P}\p{S}\s]/gu, '')]);
  const labels = normalizeTerms(scene.labels);
  if (keywords.size === 0 || labels.size === 0) return 0;

  let matchedLabels = 0;
  for (const label of labels) {
    if (label.length < 2) continue;
    if ([...keywords].some((keyword) => keyword.length >= 2 && (keyword.includes(label) || label.includes(keyword)))) {
      matchedLabels += 1;
    }
  }
  return matchedLabels / labels.size;
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

function candidateBaseScore(
  input: AudioFirstMatchInput,
  sentence: AudioFirstSentence,
  sentenceIndex: number,
  candidate: Candidate,
): number {
  const semantic = clampScore(input.semanticScores[sentenceIndex]?.[candidate.flatIndex]);
  const keyword = keywordSimilarity(sentence, candidate.scene);
  const quality = clampScore(candidate.scene.quality);
  const sameShotPrior = Boolean(sentence.shotId && candidate.asset.shotId === sentence.shotId) ? 0.1 : 0;
  const hook = sentenceIndex === 0 ? clampScore(input.hookScores[candidate.flatIndex]) * HOOK_WEIGHT : 0;
  const fallbackKeyword = input.semanticFallback ? keyword : keyword * 0.02;

  return semantic
    + sameShotPrior
    + fallbackKeyword
    + quality * 0.001
    + hook;
}

interface FlowEdge {
  to: number;
  reverseIndex: number;
  capacity: number;
  cost: number;
}

function addFlowEdge(graph: FlowEdge[][], from: number, to: number, capacity: number, cost: number): FlowEdge {
  const forward = { to, reverseIndex: graph[to].length, capacity, cost };
  const reverse = { to: from, reverseIndex: graph[from].length, capacity: 0, cost: -cost };
  graph[from].push(forward);
  graph[to].push(reverse);
  return forward;
}

function solveGlobalAssignments(
  input: AudioFirstMatchInput,
  sentences: Array<{ sentence: AudioFirstSentence; originalIndex: number }>,
  candidates: Candidate[],
  reservedSceneIndexes: ReadonlySet<number>,
  lockedUsageByAsset: ReadonlyMap<string, number>,
): Map<string, { candidate: Candidate; belowFloor: boolean }> {
  const availableCandidates = candidates.filter((candidate) => !reservedSceneIndexes.has(candidate.flatIndex));
  const reuseLimit = Math.max(0, Math.floor(finiteNumber(input.maxReuse)));
  if (!sentences.length || !availableCandidates.length || reuseLimit === 0) return new Map();

  const source = 0;
  const sentenceOffset = 1;
  const sceneOffset = sentenceOffset + sentences.length;
  const assetOffset = sceneOffset + availableCandidates.length;
  const sink = assetOffset + input.assets.length;
  const graph: FlowEdge[][] = Array.from({ length: sink + 1 }, () => []);
  const sceneNodeByFlatIndex = new Map<number, number>();
  availableCandidates.forEach((candidate, index) => sceneNodeByFlatIndex.set(candidate.flatIndex, sceneOffset + index));
  const assetIndexByKey = new Map(input.assets.map((asset, index) => [asset.assetKey, index]));
  const candidateEdges = new Map<string, { edge: FlowEdge; candidate: Candidate; belowFloor: boolean }>();
  const COST_SCALE = 1_000_000;
  const BELOW_FLOOR_COST = 1_000_000_000;

  sentences.forEach(({ sentence, originalIndex }, sentenceListIndex) => {
    const sentenceNode = sentenceOffset + sentenceListIndex;
    addFlowEdge(graph, source, sentenceNode, 1, originalIndex);
    const durationUs = sentence.endUs - sentence.startUs;
    const feasible = availableCandidates.filter((candidate) => isLengthFeasible(candidate, durationUs));
    const bestSemantic = Math.max(0, ...feasible.map((candidate) => clampScore(input.semanticScores[originalIndex]?.[candidate.flatIndex])));
    const semanticFloor = Math.max(SEMANTIC_FLOOR_ABS, RED_LINE, bestSemantic * (1 - SEMANTIC_FLOOR_REL));
    for (const candidate of feasible) {
      const semantic = clampScore(input.semanticScores[originalIndex]?.[candidate.flatIndex]);
      const belowFloor = semantic < semanticFloor - EPSILON;
      const score = candidateBaseScore(input, sentence, originalIndex, candidate);
      const cost = Math.max(0, Math.round((2 - score) * COST_SCALE)) + (belowFloor ? BELOW_FLOOR_COST : 0) + candidate.flatIndex;
      const edge = addFlowEdge(graph, sentenceNode, sceneNodeByFlatIndex.get(candidate.flatIndex)!, 1, cost);
      candidateEdges.set(`${sentenceListIndex}:${candidate.flatIndex}`, { edge, candidate, belowFloor });
    }
  });
  availableCandidates.forEach((candidate) => {
    const assetIndex = assetIndexByKey.get(candidate.asset.assetKey);
    if (assetIndex == null) return;
    addFlowEdge(graph, sceneNodeByFlatIndex.get(candidate.flatIndex)!, assetOffset + assetIndex, 1, 0);
  });
  input.assets.forEach((asset, assetIndex) => {
    const lockedUsage = lockedUsageByAsset.get(asset.assetKey) ?? 0;
    for (let useIndex = lockedUsage; useIndex < reuseLimit; useIndex += 1) {
      addFlowEdge(graph, assetOffset + assetIndex, sink, 1, Math.round(REUSE_PENALTY * useIndex * COST_SCALE));
    }
  });

  while (true) {
    const distance = Array(graph.length).fill(Number.POSITIVE_INFINITY) as number[];
    const previousNode = Array(graph.length).fill(-1) as number[];
    const previousEdge = Array(graph.length).fill(-1) as number[];
    const queued = Array(graph.length).fill(false) as boolean[];
    const queue = [source];
    distance[source] = 0;
    queued[source] = true;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const node = queue[cursor];
      queued[node] = false;
      for (let edgeIndex = 0; edgeIndex < graph[node].length; edgeIndex += 1) {
        const edge = graph[node][edgeIndex];
        if (edge.capacity <= 0) continue;
        const nextDistance = distance[node] + edge.cost;
        if (nextDistance >= distance[edge.to]) continue;
        distance[edge.to] = nextDistance;
        previousNode[edge.to] = node;
        previousEdge[edge.to] = edgeIndex;
        if (!queued[edge.to]) {
          queued[edge.to] = true;
          queue.push(edge.to);
        }
      }
    }
    if (!Number.isFinite(distance[sink])) break;
    for (let node = sink; node !== source; node = previousNode[node]) {
      const edge = graph[previousNode[node]][previousEdge[node]];
      edge.capacity -= 1;
      graph[node][edge.reverseIndex].capacity += 1;
    }
  }

  const assignments = new Map<string, { candidate: Candidate; belowFloor: boolean }>();
  for (const [key, value] of candidateEdges) {
    if (value.edge.capacity !== 0) continue;
    const sentenceListIndex = Number(key.slice(0, key.indexOf(':')));
    assignments.set(sentences[sentenceListIndex].sentence.id, { candidate: value.candidate, belowFloor: value.belowFloor });
  }
  return assignments;
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
  const reservedSceneIndexes = new Set<number>();
  const candidateBySentence = new Map<string, Candidate>();
  const segments: TimelinePlanSegment[] = [];
  const backoffSentences: string[] = [];
  const gaps: MatchGap[] = [];
  const issues: MatchIssue[] = [];
  const selectionReasons: MatchSelectionReason[] = [];
  let usedConstraintFallback = false;

  const orderedSentences = input.sentences
    .map((sentence, originalIndex) => ({ sentence, originalIndex }))
    .sort((left, right) => left.sentence.startUs - right.sentence.startUs || left.originalIndex - right.originalIndex);

  const automaticSentences: typeof orderedSentences = [];
  const lockedSegments = new Map<string, TimelinePlanSegment>();
  for (const entry of orderedSentences) {
    const { sentence } = entry;
    const durationUs = sentence.endUs - sentence.startUs;
    const lock = lockBySentence.get(sentence.id);
    if (lock) {
      const asset = input.assets.find((item) => item.assetKey === lock.assetKey);
      const candidate = candidates.find((item) =>
        item.asset.assetKey === lock.assetKey
        && lock.startUs >= item.scene.startUs
        && lock.endUs <= item.scene.endUs);
      if (asset && candidate && lock.endUs - lock.startUs === durationUs && sourceIntervalInsideAsset(asset, lock.startUs, lock.endUs)) {
        lockedSegments.set(sentence.id, {
          sentenceId: sentence.id,
          assetKey: lock.assetKey,
          startUs: sentence.startUs,
          endUs: sentence.endUs,
          sourceStartUs: lock.startUs,
          sourceEndUs: lock.endUs,
        });
        lockedSentences.add(sentence.id);
        candidateBySentence.set(sentence.id, candidate);
        reservedSceneIndexes.add(candidate.flatIndex);
        usageByAsset.set(lock.assetKey, (usageByAsset.get(lock.assetKey) ?? 0) + 1);
        selectionReasons.push({ sentenceId: sentence.id, assetKey: lock.assetKey, startUs: sentence.startUs, score: 1, reason: 'manual_lock' });
        continue;
      }

      issues.push({
        sentenceId: sentence.id,
        code: 'invalid_lock',
        severity: 'blocking',
        message: '锁定片段不存在、越界或与口播句段时长不一致。',
      });
    }

    automaticSentences.push(entry);
  }

  const assignments = solveGlobalAssignments(input, automaticSentences, candidates, reservedSceneIndexes, usageByAsset);
  for (const { candidate } of assignments.values()) {
    usageByAsset.set(candidate.asset.assetKey, (usageByAsset.get(candidate.asset.assetKey) ?? 0) + 1);
  }
  for (const { sentence, originalIndex } of orderedSentences) {
    const lockedSegment = lockedSegments.get(sentence.id);
    if (lockedSegment) {
      segments.push(lockedSegment);
      continue;
    }
    const durationUs = sentence.endUs - sentence.startUs;
    const selection = assignments.get(sentence.id);
    if (!selection) {
      const hasLengthFeasible = candidates.some((candidate) => isLengthFeasible(candidate, durationUs));
      const localUsage = new Map(usageByAsset);
      const fallbackSegments: TimelinePlanSegment[] = [];
      let cursorUs = sentence.startUs;
      let remainingUs = durationUs;
      while (remainingUs > 0) {
        const candidate = candidates
          .filter((item) => {
            const sceneDurationUs = item.scene.endUs - item.scene.startUs;
            return sceneDurationUs >= MIN_SEGMENT_DURATION_US
              && (localUsage.get(item.asset.assetKey) ?? 0) < Math.max(0, Math.floor(finiteNumber(input.maxReuse)));
          })
          .sort((left, right) => {
            const leftScore = candidateBaseScore(input, sentence, originalIndex, left)
              - REUSE_PENALTY * (localUsage.get(left.asset.assetKey) ?? 0);
            const rightScore = candidateBaseScore(input, sentence, originalIndex, right)
              - REUSE_PENALTY * (localUsage.get(right.asset.assetKey) ?? 0);
            return rightScore - leftScore || left.flatIndex - right.flatIndex;
          })[0];
        if (!candidate) break;
        const sceneDurationUs = candidate.scene.endUs - candidate.scene.startUs;
        let chunkDurationUs = Math.min(sceneDurationUs, remainingUs);
        if (remainingUs > sceneDurationUs && remainingUs - chunkDurationUs < MIN_SEGMENT_DURATION_US) {
          chunkDurationUs = remainingUs - MIN_SEGMENT_DURATION_US;
        }
        if (chunkDurationUs < MIN_SEGMENT_DURATION_US) break;
        const useIndex = localUsage.get(candidate.asset.assetKey) ?? 0;
        const sourceStartUs = useIndex % 2 === 0
          ? candidate.scene.startUs
          : candidate.scene.endUs - chunkDurationUs;
        fallbackSegments.push({
          sentenceId: sentence.id,
          assetKey: candidate.asset.assetKey,
          startUs: cursorUs,
          endUs: cursorUs + chunkDurationUs,
          sourceStartUs,
          sourceEndUs: sourceStartUs + chunkDurationUs,
        });
        cursorUs += chunkDurationUs;
        remainingUs -= chunkDurationUs;
        localUsage.set(candidate.asset.assetKey, useIndex + 1);
      }
      if (remainingUs === 0 && fallbackSegments.length > 0) {
        segments.push(...fallbackSegments);
        for (const [assetKey, count] of localUsage) usageByAsset.set(assetKey, count);
        for (const segment of fallbackSegments) {
          const candidate = candidates.find((item) => item.asset.assetKey === segment.assetKey && segment.sourceStartUs >= item.scene.startUs && segment.sourceEndUs <= item.scene.endUs);
          if (candidate) {
            candidateBySentence.set(sentence.id, candidate);
            selectionReasons.push({
              sentenceId: sentence.id,
              assetKey: candidate.asset.assetKey,
              startUs: segment.startUs,
              score: Number(candidateBaseScore(input, sentence, originalIndex, candidate).toFixed(3)),
              reason: hasLengthFeasible ? 'scene_reuse_fallback' : 'material_length_fallback',
            });
          }
        }
        lockedSentences.add(sentence.id);
        backoffSentences.push(sentence.id);
        usedConstraintFallback = true;
        issues.push({
          sentenceId: sentence.id,
          code: 'material_gap',
          severity: 'warning',
          message: hasLengthFeasible
            ? '单场景分配容量不足，已在复用上限内拼接兜底素材。'
            : '素材短于口播句段，已拼接多个安全片段完整覆盖。',
        });
        continue;
      }
      const reason: MatchGap['reason'] = candidates.length === 0
        ? 'no_material'
        : hasLengthFeasible
          ? 'reuse_limit'
          : 'insufficient_duration';
      gaps.push({ sentenceId: sentence.id, startUs: sentence.startUs, endUs: sentence.endUs, reason });
      issues.push({ sentenceId: sentence.id, code: 'material_gap', severity: 'blocking', message: '没有满足时长与复用限制的可用场景。' });
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
    selectionReasons.push({
      sentenceId: sentence.id,
      assetKey: candidate.asset.assetKey,
      startUs: sentence.startUs,
      score: Number(candidateBaseScore(input, sentence, originalIndex, candidate).toFixed(3)),
      reason: belowFloor ? 'semantic_backoff' : 'semantic_primary',
    });
    candidateBySentence.set(sentence.id, candidate);
  }

  const snappedCuts = applyBeatSnapping(segments, input, candidateBySentence, lockedSentences);
  const usedMaterials = [...new Set(segments.map((segment) => segment.assetKey))].sort();
  return {
    plan: { segments },
    diagnostics: {
      semanticFallback: input.semanticFallback,
      backoffSentences,
      snappedCuts,
      gaps,
      issues,
      selectionReasons: selectionReasons.sort((left, right) => left.startUs - right.startUs || left.assetKey.localeCompare(right.assetKey)),
      usedMaterials,
      totalMaterials: input.assets.length,
      feasible: gaps.length === 0 && !usedConstraintFallback,
      redLine: RED_LINE,
      coveragePenalty: REUSE_PENALTY,
      candidateWindow: CANDIDATE_WINDOW,
    },
  };
}

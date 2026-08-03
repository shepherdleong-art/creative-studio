import { createHash } from 'node:crypto';
import path from 'node:path';
import { isNormalizedFingerprint, normalizeFingerprint } from './fingerprint.ts';

export const BATCH_NARRATION_SCHEMA_VERSION = 'batch-narration-v1';

export interface BatchNarrationSegment {
  id: string;
  sourceSegmentId: string;
  text: string;
  startUs: number;
  endUs: number;
  timingSource: 'estimated' | 'aligned';
}

interface BatchNarrationBase {
  schemaVersion: typeof BATCH_NARRATION_SCHEMA_VERSION;
  durationUs: number;
  segments: BatchNarrationSegment[];
}

export interface BatchSilentNarrationSnapshot extends BatchNarrationBase {
  mode: 'silent_placeholder';
  productionReady: false;
  warningCode: 'narration_provider_not_run';
}

export interface BatchLocalNarrationSnapshot extends BatchNarrationBase {
  mode: 'local_ready';
  productionReady: true;
  audioRelativePath: string;
  audioFingerprint: string;
}

export type BatchNarrationSnapshot = BatchSilentNarrationSnapshot | BatchLocalNarrationSnapshot;

export interface BatchLocalNarrationArtifact {
  audioRelativePath: string;
  audioFingerprint: string;
  durationUs: number;
  segmentTimings: Array<{
    sourceSegmentId: string;
    startUs: number;
    endUs: number;
  }>;
}

function stableSegmentId(scriptSnapshotId: string, index: number, text: string): string {
  const digest = createHash('sha256')
    .update(`${scriptSnapshotId}\u0000${index}\u0000${text}`)
    .digest('hex')
    .slice(0, 20);
  return `batch-segment-${digest}`;
}

function splitScript(bodyText: string): string[] {
  const normalized = bodyText.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  const sentences = normalized
    .split(/(?<=[。！？!?；;])|\n+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  return sentences.length > 0 ? sentences : [normalized];
}

function visibleWeight(text: string): number {
  return Math.max(1, Array.from(text.replace(/\s+/g, '')).length);
}

function assertPositiveDuration(durationUs: number): void {
  if (!Number.isSafeInteger(durationUs) || durationUs <= 0) {
    throw new Error('口播时长必须是正整数微秒');
  }
}

function isSafeStorageRelativePath(relativePath: string): boolean {
  if (!relativePath || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) return false;
  const segments = relativePath.split(/[\\/]+/);
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/**
 * 在未调用真实 TTS 时生成可审计的预计句段时间。它只为联合分配和本地视觉
 * 候选提供时间基准，productionReady 永远为 false，不能伪装成已生成口播。
 */
export function createSilentNarrationPlaceholder(input: {
  scriptSnapshotId: string;
  bodyText: string;
  targetDurationUs: number;
}): BatchSilentNarrationSnapshot {
  assertPositiveDuration(input.targetDurationUs);
  const texts = splitScript(input.bodyText);
  if (texts.length === 0) throw new Error('口播正文不能为空');
  const totalWeight = texts.reduce((sum, text) => sum + visibleWeight(text), 0);
  let cursorUs = 0;
  const segments = texts.map((text, index): BatchNarrationSegment => {
    const sourceSegmentId = stableSegmentId(input.scriptSnapshotId, index, text);
    const isLast = index === texts.length - 1;
    const endUs = isLast
      ? input.targetDurationUs
      : Math.max(cursorUs + 1, Math.round(cursorUs + input.targetDurationUs * visibleWeight(text) / totalWeight));
    const segment = {
      id: sourceSegmentId,
      sourceSegmentId,
      text,
      startUs: cursorUs,
      endUs,
      timingSource: 'estimated' as const,
    };
    cursorUs = endUs;
    return segment;
  });
  return {
    schemaVersion: BATCH_NARRATION_SCHEMA_VERSION,
    mode: 'silent_placeholder',
    productionReady: false,
    warningCode: 'narration_provider_not_run',
    durationUs: input.targetDurationUs,
    segments,
  };
}

/**
 * 把已由受信本地流程准备的音频和对齐结果固定成 renderer 可消费的快照。
 * 这里只接受 storage 相对路径与完整指纹，不允许任意绝对路径进入 arrangement。
 */
export function createLocalNarrationSnapshot(input: {
  scriptSnapshotId: string;
  bodyText: string;
  artifact: BatchLocalNarrationArtifact;
}): BatchLocalNarrationSnapshot {
  assertPositiveDuration(input.artifact.durationUs);
  if (!isSafeStorageRelativePath(input.artifact.audioRelativePath)) {
    throw new Error('口播音频必须使用安全的 storage 相对路径');
  }
  const fingerprint = normalizeFingerprint(input.artifact.audioFingerprint);
  if (!isNormalizedFingerprint(fingerprint)) throw new Error('口播音频指纹无效');
  const texts = splitScript(input.bodyText);
  if (texts.length === 0) throw new Error('口播正文不能为空');
  if (input.artifact.segmentTimings.length !== texts.length) {
    throw new Error('口播对齐句段数量与脚本不一致');
  }
  let previousEndUs = 0;
  const segments = texts.map((text, index): BatchNarrationSegment => {
    const expectedSourceSegmentId = stableSegmentId(input.scriptSnapshotId, index, text);
    const timing = input.artifact.segmentTimings[index];
    if (!timing || timing.sourceSegmentId !== expectedSourceSegmentId) {
      throw new Error('口播对齐句段身份与冻结脚本不一致');
    }
    if (
      !Number.isSafeInteger(timing.startUs)
      || !Number.isSafeInteger(timing.endUs)
      || timing.startUs < previousEndUs
      || timing.endUs <= timing.startUs
      || timing.endUs > input.artifact.durationUs
    ) {
      throw new Error('口播对齐时间非法或发生重叠');
    }
    previousEndUs = timing.endUs;
    return {
      id: expectedSourceSegmentId,
      sourceSegmentId: expectedSourceSegmentId,
      text,
      startUs: timing.startUs,
      endUs: timing.endUs,
      timingSource: 'aligned',
    };
  });
  return {
    schemaVersion: BATCH_NARRATION_SCHEMA_VERSION,
    mode: 'local_ready',
    productionReady: true,
    audioRelativePath: input.artifact.audioRelativePath,
    audioFingerprint: fingerprint,
    durationUs: input.artifact.durationUs,
    segments,
  };
}

export function assertNarrationPublishable(snapshot: BatchNarrationSnapshot): asserts snapshot is BatchLocalNarrationSnapshot {
  if (!snapshot.productionReady || snapshot.mode !== 'local_ready') {
    throw new Error('当前成片只有静音视觉候选，尚未准备可正式发布的口播音频');
  }
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { videoJobNotRejectedSql } from '../media-core/video-job-rejection.ts';
import { resolveImportedExternalAssetVideoPath } from './material-import.ts';
import { resolveStoragePath, toStorageRelativePath } from './storage-path.ts';
import { OUTPUT_PRESETS, type OutputPresetId } from './types.ts';
import { materializeVideoFrame } from './video-frame.ts';

const COVER_FRAME_FPS = 24;

export interface CoverFrameSource {
  canonicalSourceKey: string;
  absolutePath: string;
  fingerprint: string;
  durationUs: number;
}

export interface MaterializedCoverFrame {
  absolutePath: string;
  relativePath: string;
  sourceKey: string;
  frameTimeUs: number;
  durationUs: number;
  preset: OutputPresetId;
}

export class CoverFrameError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'CoverFrameError';
    this.code = code;
    this.status = status;
  }
}

function parseDurationUs(mediaJson: string): number {
  try {
    const durationUs = Number((JSON.parse(mediaJson || '{}') as { durationUs?: unknown }).durationUs);
    return Number.isFinite(durationUs) && durationUs > 0 ? Math.round(durationUs) : 0;
  } catch {
    return 0;
  }
}

function parseSourceKey(sourceKey: string): { kind: 'module4' | 'external'; id: string; canonical: string } {
  const value = String(sourceKey || '').trim();
  if (value.startsWith('module4:')) {
    const id = value.slice('module4:'.length);
    if (id) return { kind: 'module4', id, canonical: `module4:${id}` };
  } else if (value.startsWith('external:')) {
    const id = value.slice('external:'.length);
    if (id) return { kind: 'external', id, canonical: `external:${id}` };
  } else if (value.startsWith('external-asset-')) {
    const id = value.slice('external-asset-'.length);
    if (id) return { kind: 'external', id, canonical: `external:${id}` };
  } else if (value && !value.includes(':')) {
    return { kind: 'module4', id: value, canonical: `module4:${value}` };
  }
  throw new CoverFrameError('cover_source_not_found', '封面来源无效', 404);
}

function assertSafeRegularFile(storageRoot: string, sourcePath: string): string {
  let relativePath: string;
  let absolutePath: string;
  try {
    relativePath = toStorageRelativePath(storageRoot, sourcePath);
    absolutePath = resolveStoragePath(storageRoot, relativePath);
  } catch {
    throw new CoverFrameError('unsafe_path', '封面来源路径不安全', 400);
  }
  if (!fs.existsSync(absolutePath)) throw new CoverFrameError('cover_source_not_found', '封面来源文件不存在', 404);
  const root = path.resolve(storageRoot);
  let cursor = root;
  for (const segment of relativePath.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new CoverFrameError('unsafe_path', '封面来源路径包含符号链接', 400);
  }
  const stat = fs.lstatSync(absolutePath);
  if (!stat.isFile()) throw new CoverFrameError('unsafe_path', '封面来源不是普通文件', 400);
  const realRoot = fs.realpathSync(root);
  const realSource = fs.realpathSync(absolutePath);
  const relativeRealPath = path.relative(realRoot, realSource);
  if (!relativeRealPath || relativeRealPath === '..' || relativeRealPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRealPath)) {
    throw new CoverFrameError('unsafe_path', '封面来源路径越界', 400);
  }
  return absolutePath;
}

const fingerprintCache = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; digest: string }>();
const inFlightFingerprints = new Map<string, Promise<string>>();

function fileSha256(filePath: string): string {
  const stat = fs.statSync(filePath);
  const cached = fingerprintCache.get(filePath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs) return cached.digest;
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
  const digest = hash.digest('hex');
  if (fingerprintCache.size >= 64) fingerprintCache.delete(fingerprintCache.keys().next().value!);
  fingerprintCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, digest });
  return digest;
}

async function fileSha256Async(filePath: string): Promise<string> {
  const stat = fs.statSync(filePath);
  const cached = fingerprintCache.get(filePath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs) return cached.digest;
  const identity = `${filePath}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const existing = inFlightFingerprints.get(identity);
  if (existing) return existing;
  const task = (async () => {
    const hash = crypto.createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.once('error', reject);
      stream.once('end', resolve);
    });
    const digest = hash.digest('hex');
    if (fingerprintCache.size >= 64) fingerprintCache.delete(fingerprintCache.keys().next().value!);
    fingerprintCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, digest });
    return digest;
  })();
  inFlightFingerprints.set(identity, task);
  try { return await task; }
  finally { if (inFlightFingerprints.get(identity) === task) inFlightFingerprints.delete(identity); }
}

function resolveCoverFrameSourceRecord(input: {
  db: Database.Database;
  storageRoot: string;
  groupId: string;
  sourceKey: string;
}): CoverFrameSource {
  const parsed = parseSourceKey(input.sourceKey);
  if (parsed.kind === 'module4') {
    const row = input.db.prepare(`
      SELECT vj.localVideoPath, a.fileFingerprint, a.mediaJson
      FROM final_edit_groups g
      JOIN video_jobs vj
        ON vj.id=? AND vj.projectId=g.projectId AND vj.shotSetId=g.shotSetId AND vj.status='succeeded'
          AND ${videoJobNotRejectedSql(input.db, 'vj')}
      JOIN final_edit_asset_analysis a
        ON a.videoJobId=vj.id AND a.shotSetId=g.shotSetId AND a.status='succeeded'
      WHERE g.id=? AND g.status IN ('ready','partial')
    `).get(parsed.id, input.groupId) as { localVideoPath: string | null; fileFingerprint: string; mediaJson: string } | undefined;
    if (!row?.localVideoPath) throw new CoverFrameError('cover_source_not_found', '封面来源不存在或尚未就绪', 404);
    const durationUs = parseDurationUs(row.mediaJson);
    if (!durationUs) throw new CoverFrameError('cover_source_not_found', '封面来源时长无效', 404);
    const absolutePath = assertSafeRegularFile(input.storageRoot, row.localVideoPath);
    return { canonicalSourceKey: parsed.canonical, absolutePath, fingerprint: row.fileFingerprint, durationUs };
  }

  const analysisKey = `external-asset-${parsed.id}`;
  const row = input.db.prepare(`
    SELECT g.projectId, g.shotSetId, e.relativePath, e.durationUs, e.fileFingerprint,
           a.fileFingerprint AS analysisFingerprint, a.mediaJson
    FROM final_edit_groups g
    JOIN final_edit_external_assets e
      ON e.id=? AND e.projectId=g.projectId AND e.shotSetId=g.shotSetId
      AND e.status='ready' AND e.mediaKind='video'
    JOIN final_edit_asset_analysis a
      ON a.videoJobId=? AND a.shotSetId=g.shotSetId AND a.status='succeeded'
    WHERE g.id=? AND g.status IN ('ready','partial')
  `).get(parsed.id, analysisKey, input.groupId) as {
    projectId: string;
    shotSetId: string;
    relativePath: string;
    durationUs: number;
    fileFingerprint: string;
    analysisFingerprint: string;
    mediaJson: string;
  } | undefined;
  if (!row || row.fileFingerprint !== row.analysisFingerprint) throw new CoverFrameError('cover_source_not_found', '封面来源不存在、未就绪或分析已失效', 404);
  const analyzedDurationUs = parseDurationUs(row.mediaJson);
  const durationUs = Math.min(Math.max(0, Number(row.durationUs)), analyzedDurationUs);
  if (!durationUs) throw new CoverFrameError('cover_source_not_found', '封面来源时长无效', 404);
  let importedPath: string;
  try {
    importedPath = resolveImportedExternalAssetVideoPath(input.storageRoot, { projectId: row.projectId, shotSetId: row.shotSetId }, row.relativePath);
  } catch {
    throw new CoverFrameError('unsafe_path', '外部封面来源路径不安全', 400);
  }
  const absolutePath = assertSafeRegularFile(input.storageRoot, importedPath);
  return { canonicalSourceKey: parsed.canonical, absolutePath, fingerprint: row.fileFingerprint, durationUs };
}

export function resolveCoverFrameSource(input: Parameters<typeof resolveCoverFrameSourceRecord>[0]): CoverFrameSource {
  const source = resolveCoverFrameSourceRecord(input);
  if (fileSha256(source.absolutePath) !== source.fingerprint) throw new CoverFrameError('source_fingerprint_changed', '封面来源文件已经变化', 409);
  return source;
}

async function resolveCoverFrameSourceAsync(input: Parameters<typeof resolveCoverFrameSourceRecord>[0]): Promise<CoverFrameSource> {
  const source = resolveCoverFrameSourceRecord(input);
  if (await fileSha256Async(source.absolutePath) !== source.fingerprint) throw new CoverFrameError('source_fingerprint_changed', '封面来源文件已经变化', 409);
  return source;
}

function frameBucket(inputTimeUs: number, durationUs: number): { bucket: number; frameTimeUs: number } {
  const lastSafeBucket = Math.max(0, Math.ceil(durationUs * COVER_FRAME_FPS / 1_000_000) - 1);
  const requested = inputTimeUs === Number.POSITIVE_INFINITY
    ? durationUs
    : Number.isFinite(inputTimeUs)
      ? inputTimeUs
      : 0;
  const requestedBucket = Math.floor(Math.max(0, requested) * COVER_FRAME_FPS / 1_000_000);
  const bucket = Math.min(lastSafeBucket, requestedBucket);
  return { bucket, frameTimeUs: Math.round(bucket * 1_000_000 / COVER_FRAME_FPS) };
}

export async function materializeCoverFrame(input: {
  db: Database.Database;
  storageRoot: string;
  groupId: string;
  sourceKey: string;
  timeUs: number;
  preset: OutputPresetId;
}): Promise<MaterializedCoverFrame> {
  if (!(input.preset in OUTPUT_PRESETS)) throw new CoverFrameError('invalid_output_preset', '不支持的输出比例');
  const source = await resolveCoverFrameSourceAsync(input);
  const { bucket, frameTimeUs } = frameBucket(Number(input.timeUs), source.durationUs);
  const frame = await materializeVideoFrame({
    storageRoot: input.storageRoot,
    sourcePath: source.absolutePath,
    cacheNamespace: path.join('cover-frames', input.groupId),
    cacheKey: `${source.fingerprint}:${bucket}:${input.preset}`,
    frameUs: frameTimeUs,
    preserveSource: true,
  });
  return {
    ...frame,
    sourceKey: source.canonicalSourceKey,
    frameTimeUs,
    durationUs: source.durationUs,
    preset: input.preset,
  };
}

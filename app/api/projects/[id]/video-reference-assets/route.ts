import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { resolveFfprobePath } from '@/lib/ffmpeg';
import { validateUploadedImageBuffer } from '@/lib/image-upload-validation';
import { assertNoStorageSymlink } from '@/lib/media-core/storage-path';

export const runtime = 'nodejs';

const MIB = 1024 * 1024;
const MAX_BYTES = {
  image: 30 * MIB,
  video: 200 * MIB,
  audio: 15 * MIB,
} as const;
const MAX_DURATION_SEC = 30;
const execFileAsync = promisify(execFile);

type ReferenceKind = keyof typeof MAX_BYTES;
type DetectedReference = {
  kind: ReferenceKind;
  mimeType: string;
  extension: string;
  durationSec: number | null;
};

class UploadValidationError extends Error {}

interface ProbeOutput {
  streams?: Array<{ codec_type?: string; codec_name?: string; duration?: string }>;
  format?: { duration?: string; format_name?: string; tags?: { major_brand?: string } };
}

function detectImageMime(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

async function probeMedia(filePath: string, filename: string): Promise<ProbeOutput> {
  try {
    const { stdout } = await execFileAsync(resolveFfprobePath(), [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,duration:format=duration,format_name:format_tags=major_brand',
      '-of', 'json',
      filePath,
    ], { timeout: 10_000, windowsHide: true, maxBuffer: MIB, encoding: 'utf8' });
    return JSON.parse(stdout) as ProbeOutput;
  } catch {
    throw new UploadValidationError(`无法识别媒体内容: ${filename}`);
  }
}

function detectMedia(probe: ProbeOutput): DetectedReference | null {
  const streams = probe.streams ?? [];
  const hasAudio = streams.some((stream) => stream.codec_type === 'audio');
  const hasVideo = streams.some((stream) => stream.codec_type === 'video');
  const formats = new Set((probe.format?.format_name ?? '').split(',').map((value) => value.trim().toLowerCase()));
  const durationCandidates = [probe.format?.duration, ...streams.map((stream) => stream.duration)]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  const durationSec = durationCandidates.length > 0 ? Math.max(...durationCandidates) : null;

  if (hasAudio && formats.has('mp3')) return { kind: 'audio', mimeType: 'audio/mpeg', extension: '.mp3', durationSec };
  if (hasAudio && formats.has('wav')) return { kind: 'audio', mimeType: 'audio/wav', extension: '.wav', durationSec };
  if (hasVideo && (formats.has('mp4') || formats.has('mov'))) {
    const isQuickTime = probe.format?.tags?.major_brand?.trim().toLowerCase() === 'qt';
    return {
      kind: 'video',
      mimeType: isQuickTime ? 'video/quicktime' : 'video/mp4',
      extension: isQuickTime ? '.mov' : '.mp4',
      durationSec,
    };
  }
  return null;
}

function originalFilename(file: File): string {
  return path.basename(file.name.replace(/\\/g, '/')) || '未命名';
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const writtenPaths = new Set<string>();
  const insertedIds: string[] = [];
  let db: ReturnType<typeof getDb> | undefined;
  try {
    const { id: projectId } = await params;
    db = getDb();
    if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
    if (!/^[A-Za-z0-9_-]+$/.test(projectId)) {
      return NextResponse.json({ error: 'Invalid project id' }, { status: 400 });
    }

    const formData = await request.formData();
    const files = formData.getAll('files').filter((value): value is File => typeof value !== 'string');
    if (files.length === 0) return NextResponse.json({ error: 'No files uploaded' }, { status: 400 });

    const storageRoot = path.resolve(dataRoot(), 'storage');
    const projectDirectory = path.join(storageRoot, 'video-references', projectId);
    fs.mkdirSync(projectDirectory, { recursive: true });
    assertNoStorageSymlink(storageRoot, path.relative(storageRoot, projectDirectory));

    const insert = db.prepare(`INSERT INTO video_reference_assets
      (id, projectId, kind, filename, path, mimeType, byteSize, durationSec, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`);
    const results: Array<{
      id: string;
      kind: ReferenceKind;
      filename: string;
      mimeType: string;
      byteSize: number;
      durationSec: number | null;
      url: string;
    }> = [];

    for (const file of files) {
      const filename = originalFilename(file);
      const buffer = Buffer.from(await file.arrayBuffer());
      if (buffer.length === 0) throw new UploadValidationError(`文件为空: ${filename}`);

      const imageMime = detectImageMime(buffer);
      let detected: DetectedReference;
      let temporaryPath: string | null = null;
      if (imageMime) {
        if (buffer.length > MAX_BYTES.image) throw new UploadValidationError(`图片超过 30 MiB 上限: ${filename}`);
        if (!(await validateUploadedImageBuffer(buffer, imageMime))) {
          throw new UploadValidationError(`图片文件已损坏或不完整: ${filename}`);
        }
        detected = {
          kind: 'image',
          mimeType: imageMime,
          extension: imageMime === 'image/png' ? '.png' : imageMime === 'image/webp' ? '.webp' : '.jpg',
          durationSec: null,
        };
      } else {
        if (buffer.length > MAX_BYTES.video) throw new UploadValidationError(`文件超过 200 MiB 上限: ${filename}`);
        temporaryPath = path.join(projectDirectory, `.upload-${uuidv4()}.tmp`);
        writtenPaths.add(temporaryPath);
        fs.writeFileSync(temporaryPath, buffer, { flag: 'wx' });
        const media = detectMedia(await probeMedia(temporaryPath, filename));
        if (!media || media.durationSec === null) {
          throw new UploadValidationError(`仅支持 JPEG/PNG/WebP 图片、MP4/MOV 视频、MP3/WAV 音频: ${filename}`);
        }
        if (buffer.length > MAX_BYTES[media.kind]) {
          const limit = media.kind === 'video' ? 200 : 15;
          throw new UploadValidationError(`${media.kind === 'video' ? '视频' : '音频'}超过 ${limit} MiB 上限: ${filename}`);
        }
        if (media.durationSec > MAX_DURATION_SEC) {
          throw new UploadValidationError(`视频或音频时长不能超过 30 秒: ${filename}`);
        }
        detected = media;
      }

      const id = uuidv4();
      const savedPath = path.join(projectDirectory, `${id}${detected.extension}`);
      writtenPaths.add(savedPath);
      if (detected.kind === 'image') fs.writeFileSync(savedPath, buffer, { flag: 'wx' });
      else {
        if (!temporaryPath) throw new Error('Upload staging file is missing');
        fs.renameSync(temporaryPath, savedPath);
        writtenPaths.delete(temporaryPath);
      }

      insert.run(id, projectId, detected.kind, filename, savedPath, detected.mimeType, buffer.length, detected.durationSec);
      insertedIds.push(id);
      results.push({
        id,
        kind: detected.kind,
        filename,
        mimeType: detected.mimeType,
        byteSize: buffer.length,
        durationSec: detected.durationSec,
        url: `/api/video-reference-assets/${encodeURIComponent(id)}`,
      });
    }

    return NextResponse.json({ files: results });
  } catch (error) {
    if (db) {
      const remove = db.prepare('DELETE FROM video_reference_assets WHERE id = ?');
      for (const id of insertedIds) {
        try { remove.run(id); } catch { /* best-effort request rollback */ }
      }
    }
    for (const filePath of writtenPaths) {
      try { fs.unlinkSync(filePath); } catch { /* already renamed or absent */ }
    }
    if (error instanceof UploadValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

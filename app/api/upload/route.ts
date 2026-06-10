import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';
import { preprocessImage, DEFAULT_OPTIONS } from '@/lib/image-preprocess';
import fs from 'fs';
import path from 'path';

/** Allowed image MIME types and their extensions. */
const ALLOWED_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

/** Magic bytes for format validation. */
const MAGIC_BYTES: { bytes: number[]; mime: string }[] = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], mime: 'image/png' },
  { bytes: [0xff, 0xd8, 0xff], mime: 'image/jpeg' },
  { bytes: [0x52, 0x49, 0x46, 0x46], mime: 'image/webp' },
];

const MAX_INPUT_FILES = 50;
const MAX_REFERENCE_FILES = 3;

function detectMimeByMagic(buffer: Buffer): string | null {
  for (const magic of MAGIC_BYTES) {
    let match = true;
    for (let i = 0; i < magic.bytes.length; i++) {
      if (buffer[i] !== magic.bytes[i]) { match = false; break; }
    }
    if (match) {
      if (magic.mime === 'image/webp') {
        if (buffer.length >= 12 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
          return 'image/webp';
        }
        return null;
      }
      return magic.mime;
    }
  }
  return null;
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const files = formData.getAll('files') as File[];
    const role = (formData.get('role') as string) || 'input';
    const projectId = (formData.get('projectId') as string) || null;
    const preprocessEnabled = formData.get('preprocessEnabled') !== 'false'; // default true
    const targetMaxSide = parseInt(formData.get('targetMaxSide') as string) || DEFAULT_OPTIONS.targetMaxSide;
    const jpegQuality = parseInt(formData.get('jpegQuality') as string) || DEFAULT_OPTIONS.jpegQuality;

    if (!files || files.length === 0) {
      return NextResponse.json({ error: 'No files uploaded' }, { status: 400 });
    }

    if (!['input', 'reference'].includes(role)) {
      return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
    }

    const maxFiles = role === 'reference' ? MAX_REFERENCE_FILES : MAX_INPUT_FILES;
    if (files.length > maxFiles) {
      return NextResponse.json({ error: `最多上传 ${maxFiles} 张` }, { status: 400 });
    }

    const dirName = role === 'reference' ? 'references' : 'inputs';
    const storageRoot = path.join(/* turbopackIgnore: true */ process.cwd(), 'storage');
    const originalsDir = path.join(storageRoot, 'originals', dirName);
    const processedDir = path.join(storageRoot, 'processed', dirName);

    for (const d of [originalsDir, processedDir]) {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }

    const db = getDb();
    const insertAsset = db.prepare(`
      INSERT INTO image_assets
        (id, projectId, role, filename, path, originalPath, processedPath, mimeType,
         originalWidth, originalHeight, processedWidth, processedHeight,
         originalSizeBytes, processedSizeBytes, preprocessingEnabled, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const results: Array<{
      id: string;
      filename: string;
      mimeType: string;
      size: number;
      role: string;
      relativePath: string;
      imageUrl: string;
      originalSizeBytes?: number;
      processedSizeBytes?: number;
      originalWidth?: number;
      originalHeight?: number;
      processedWidth?: number;
      processedHeight?: number;
    }> = [];

    for (const file of files) {
      // Validate MIME
      const browserMime = file.type.toLowerCase();
      if (!ALLOWED_MIME[browserMime] && browserMime !== '') {
        return NextResponse.json({ error: `不支持的文件类型: ${file.type}` }, { status: 400 });
      }

      // Validate magic bytes
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const detectedMime = detectMimeByMagic(buffer);
      if (!detectedMime) {
        return NextResponse.json({ error: `无法识别的图片格式: ${file.name}` }, { status: 400 });
      }

      const mimeType = detectedMime;
      const ext = ALLOWED_MIME[mimeType];
      const id = uuidv4();
      const savedFilename = `${id}${ext}`;

      // ── Save original ──
      const originalPath = path.join(originalsDir, savedFilename);
      fs.writeFileSync(originalPath, buffer);

      // ── Preprocess for API calls ──
      const preprocessResult = await preprocessImage(
        originalPath,
        mimeType,
        processedDir,
        {
          enabled: preprocessEnabled,
          targetMaxSide,
          jpegQuality,
        }
      );

      // ── The "path" for preview is the smaller of the two ──
      const previewPath = preprocessEnabled ? preprocessResult.processedPath : originalPath;

      // ── Insert into DB ──
      insertAsset.run(
        id,
        projectId,
        role,
        file.name,
        previewPath,
        originalPath,
        preprocessEnabled ? preprocessResult.processedPath : null,
        preprocessResult.mimeType,
        preprocessResult.originalWidth || null,
        preprocessResult.originalHeight || null,
        preprocessResult.processedWidth || null,
        preprocessResult.processedHeight || null,
        preprocessResult.originalSizeBytes || null,
        preprocessResult.processedSizeBytes || null,
        preprocessEnabled ? 1 : 0
      );

      // Relative path for the preview image (will be used for imageUrl)
      const relToStorage = path.relative(storageRoot, previewPath);
      const normalizedRel = relToStorage.split(path.sep).join('/');

      results.push({
        id,
        filename: file.name,
        mimeType: preprocessResult.mimeType,
        size: preprocessResult.processedSizeBytes || buffer.length,
        role,
        relativePath: normalizedRel,
        imageUrl: `/api/images/${normalizedRel}`,
        originalSizeBytes: preprocessResult.originalSizeBytes,
        processedSizeBytes: preprocessResult.processedSizeBytes,
        originalWidth: preprocessResult.originalWidth,
        originalHeight: preprocessResult.originalHeight,
        processedWidth: preprocessResult.processedWidth,
        processedHeight: preprocessResult.processedHeight,
      });
    }

    return NextResponse.json({ files: results });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

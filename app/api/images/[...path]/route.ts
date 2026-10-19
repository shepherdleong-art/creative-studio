import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { dataRoot } from '@/lib/data-root';

/** Only these subdirectories under storage/ are allowed to be served. */
const ALLOWED_DIRS = ['inputs', 'outputs', 'references', 'originals', 'processed'];

/** Only these image extensions are allowed. */
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/** Block any filename matching these patterns (db files, logs, etc.) */
const BLOCKED_PATTERNS = [
  /\.db$/,
  /\.db-/,
  /\.db\./,
  /^logs\//,
  /^logs$/,
];

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path: pathSegments } = await params;
    const relativePath = pathSegments.join('/');

    // 1. Check: must be inside one of the allowed subdirectories
    const allowedPrefix = ALLOWED_DIRS.some((dir) =>
      relativePath === dir || relativePath.startsWith(dir + '/')
    );
    if (!allowedPrefix) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // 2. Check: block db files, log files, etc.
    if (BLOCKED_PATTERNS.some((p) => p.test(relativePath))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // 3. Check: extension must be an allowed image type
    const ext = path.extname(relativePath).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // 4. Resolve and prevent directory traversal
    const fullPath = path.join(dataRoot(), 'storage', relativePath);
    const resolvedPath = path.resolve(fullPath);
    const storagePath = path.resolve(path.join(dataRoot(), 'storage'));
    if (!resolvedPath.startsWith(storagePath)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (!fs.existsSync(resolvedPath)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    // Double-check: resolved path must still be in an allowed dir
    const relToStorage = path.relative(storagePath, resolvedPath);
    const stillAllowed = ALLOWED_DIRS.some((dir) =>
      relToStorage === dir || relToStorage.startsWith(dir + path.sep)
    );
    if (!stillAllowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const buffer = fs.readFileSync(resolvedPath);
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
    };

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

import { userFontDir } from '@/lib/media-core/packaging-font';
// 包装模板静态资源（包装界面 iframe 预览用）：gsap / 字体 / 模板页等。
// GET /api/packaging/templates/<template>/<相对路径>
// 字体找不到时回退共享字体目录（packaging/fonts），与 package-video.mjs 打包行为同源。

import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { resolvePackagingDir } from '@/lib/media-core/packaging-runtime';

const MIME_BY_EXTENSION: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function isSafeSegment(segment: string): boolean {
  return Boolean(segment) && segment !== '.' && segment !== '..' && !segment.includes('/') && !segment.includes('\\') && !/:/.test(segment);
}

function resolveWithin(root: string, segments: string[]): string | null {
  const resolved = path.resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  return resolved;
}

export async function GET(_request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await params;
  if (!segments?.length || segments.some((segment) => !isSafeSegment(segment))) {
    return NextResponse.json({ error: 'unsafe_path', message: '模板资源路径无效' }, { status: 400 });
  }
  const packagingDir = resolvePackagingDir();
  const templatesRoot = path.resolve(packagingDir, 'templates');
  let file = resolveWithin(templatesRoot, segments);
  if (file && !fs.existsSync(file) && segments.length > 2 && segments[1] === 'fonts') {
    // 共享字体回退：模板目录只在打包时才带上 fonts/，预览时从 packaging/fonts 取
    // segments = [<template>, 'fonts', <字体文件>...]
    const sharedFontsRoot = segments[2] === 'user' ? userFontDir() : path.resolve(packagingDir, 'fonts');
    const shared = resolveWithin(sharedFontsRoot, segments.slice(segments[2] === 'user' ? 3 : 2));
    if (shared && fs.existsSync(shared)) file = shared;
  }
  const stat = file ? fs.statSync(file, { throwIfNoEntry: false }) : undefined;
  if (!file || !stat?.isFile()) return NextResponse.json({ error: 'not_found', message: '模板资源不存在' }, { status: 404 });
  const extension = path.extname(file).toLowerCase();
  const contentType = MIME_BY_EXTENSION[extension];
  if (!contentType) return NextResponse.json({ error: 'unsupported_type', message: '不支持的模板资源类型' }, { status: 415 });
  const buffer = fs.readFileSync(file);
  return new Response(new Uint8Array(buffer), { headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=300' } });
}

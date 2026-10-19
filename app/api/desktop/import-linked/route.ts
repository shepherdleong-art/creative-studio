import { timingSafeEqual } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { registerLinkedSource } from '@/lib/batch-production/media-catalog';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };
const DESKTOP_SECRET_HEADER = 'x-creative-studio-desktop-secret';
const MAX_FILE_COUNT = 500;

function sameSecret(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const providedBytes = Buffer.from(provided, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return providedBytes.length === expectedBytes.length
    && timingSafeEqual(providedBytes, expectedBytes);
}

function denied(message: string): NextResponse {
  return NextResponse.json(
    { error: 'desktop_import_denied', message },
    { status: 403, headers: NO_STORE_HEADERS },
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (process.env.CREATIVE_STUDIO_DESKTOP !== '1') {
    return denied('当前运行方式不支持桌面原片导入');
  }
  if (!sameSecret(request.headers.get(DESKTOP_SECRET_HEADER), process.env.CREATIVE_STUDIO_DESKTOP_SECRET)) {
    return denied('桌面导入请求未通过本次启动校验');
  }

  const body = await request.json().catch(() => null) as {
    projectId?: unknown;
    filePaths?: unknown;
  } | null;
  const projectId = typeof body?.projectId === 'string' && body.projectId.trim()
    ? body.projectId.trim()
    : null;
  const filePaths = Array.isArray(body?.filePaths)
    && body.filePaths.every((value): value is string => typeof value === 'string')
    ? body.filePaths
    : null;

  if (!projectId || !filePaths || filePaths.length === 0 || filePaths.length > MAX_FILE_COUNT) {
    return NextResponse.json(
      { error: 'invalid_input', message: `projectId 与 1-${MAX_FILE_COUNT} 个 filePaths 为必填项` },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  if (filePaths.some((filePath) => !isAbsolute(filePath) || filePath.includes('\0'))) {
    return NextResponse.json(
      { error: 'invalid_file_path', message: 'filePaths 必须是绝对路径' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    await assertBatchApiReady();
    const db = getDb();
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) {
      return NextResponse.json(
        { error: 'project_not_found', message: '项目不存在' },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }

    const assetIds: string[] = [];
    const errors: Array<{ index: number; message: string }> = [];
    for (const [index, filePath] of filePaths.entries()) {
      try {
        assetIds.push(await registerLinkedSource(db, projectId, { filePath }));
      } catch {
        // 不把绝对路径或底层 stderr 回传给 renderer；主进程也只回传汇总数量。
        errors.push({ index, message: '原片登记失败' });
      }
    }

    return NextResponse.json(
      { assetIds, errors },
      { headers: NO_STORE_HEADERS },
    );
  } catch {
    return NextResponse.json(
      { error: 'desktop_import_failed', message: '原片登记服务暂不可用' },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
}

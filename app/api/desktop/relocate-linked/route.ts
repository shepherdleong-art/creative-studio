import { timingSafeEqual } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { relocateLinkedSource } from '@/lib/batch-production/media-catalog';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };
const DESKTOP_SECRET_HEADER = 'x-creative-studio-desktop-secret';

function sameSecret(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const providedBytes = Buffer.from(provided, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return providedBytes.length === expectedBytes.length
    && timingSafeEqual(providedBytes, expectedBytes);
}

function denied(message: string): NextResponse {
  return NextResponse.json(
    { error: 'desktop_relocate_denied', message },
    { status: 403, headers: NO_STORE_HEADERS },
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (process.env.CREATIVE_STUDIO_DESKTOP !== '1') {
    return denied('当前运行方式不支持桌面原片重新定位');
  }
  if (!sameSecret(request.headers.get(DESKTOP_SECRET_HEADER), process.env.CREATIVE_STUDIO_DESKTOP_SECRET)) {
    return denied('桌面重新定位请求未通过本次启动校验');
  }

  const body = await request.json().catch(() => null) as {
    projectId?: unknown;
    assetId?: unknown;
    sourceId?: unknown;
    filePath?: unknown;
  } | null;
  const projectId = typeof body?.projectId === 'string' && body.projectId.trim()
    ? body.projectId.trim()
    : null;
  const assetId = typeof body?.assetId === 'string' && body.assetId.trim()
    ? body.assetId.trim()
    : null;
  const sourceId = typeof body?.sourceId === 'string' && body.sourceId.trim()
    ? body.sourceId.trim()
    : null;
  const filePath = typeof body?.filePath === 'string' && body.filePath.trim()
    ? body.filePath
    : null;

  if (!projectId || !assetId || !sourceId || !filePath) {
    return NextResponse.json(
      { error: 'invalid_input', message: 'projectId、assetId、sourceId 与 filePath 为必填项' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  if (!isAbsolute(filePath) || filePath.includes('\0')) {
    return NextResponse.json(
      { error: 'invalid_file_path', message: 'filePath 必须是绝对路径' },
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

    await relocateLinkedSource(db, projectId, assetId, { sourceId, newFilePath: filePath });
    return NextResponse.json(
      { relocated: true },
      { headers: NO_STORE_HEADERS },
    );
  } catch {
    // Do not return the selected absolute path or lower-level media/ffprobe output.
    return NextResponse.json(
      { error: 'desktop_relocate_failed', message: '原片重新定位失败，请确认选择了同一份原片' },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
}

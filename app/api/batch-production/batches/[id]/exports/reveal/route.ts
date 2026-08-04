import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { NextRequest, NextResponse } from 'next/server';
import { dataRoot } from '@/lib/data-root';
import { assertNoStorageSymlink } from '@/lib/final-edit/storage-path';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function desktopRevealAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return process.env.CREATIVE_STUDIO_DESKTOP === '1' && (platform === 'darwin' || platform === 'win32');
}

function revealCommand(platform: NodeJS.Platform, directory: string): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [directory] };
  if (platform === 'win32') return { command: 'explorer.exe', args: [directory] };
  throw new Error('当前平台不支持在文件夹中查看');
}

/** 导出完成后在系统文件管理器中打开批次成品文件夹。 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({ error: 'missing_project_id', message: '缺少 projectId 参数' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  if (!desktopRevealAvailable()) {
    return NextResponse.json({
      error: 'desktop_reveal_unavailable',
      message: '当前运行方式不支持在文件夹中查看',
    }, { status: 403, headers: BATCH_NO_STORE_HEADERS });
  }
  if (request.headers.get('x-creative-studio-action') !== 'reveal') {
    return NextResponse.json({ error: 'invalid_reveal_request', message: '文件定位请求缺少工作台标记' }, {
      status: 403,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return NextResponse.json({ error: 'cross_origin_reveal_denied', message: '不允许跨站触发文件定位' }, {
      status: 403,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  try {
    await assertBatchApiReady();
    const storageRoot = path.join(dataRoot(), 'storage');
    const relativeDir = path.join('projects', projectId, '批量成片', id);
    const directory = assertNoStorageSymlink(storageRoot, relativeDir);
    const stat = fs.statSync(directory);
    if (!stat.isDirectory()) throw new Error('批次成品目录不存在');
    const invocation = revealCommand(process.platform, directory);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, { detached: true, stdio: 'ignore', shell: false });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
    return NextResponse.json({ revealed: true }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_reveal_failed', '打开成品文件夹失败');
  }
}

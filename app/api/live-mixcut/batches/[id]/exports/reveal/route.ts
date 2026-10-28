import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { isSameOriginRequest } from '@/lib/same-origin-request';
import { assertNoStorageSymlink } from '@/lib/media-core/storage-path';
import { getLiveMixcutBatchExportDirName } from '@/lib/live-mixcut/batches';
import { assertBatchApiReady } from '@/lib/live-mixcut/runtime-readiness';
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
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: 'cross_origin_reveal_denied', message: '不允许跨站触发文件定位' }, {
      status: 403,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  try {
    await assertBatchApiReady();
    // 成品目录已是项目级(与单条模式共用),路径里不再含 batchId,所以归属
    // 校验必须显式做一次,否则任何 projectId 都能被打开。
    const owned = getDb().prepare(`
      SELECT id FROM live_mixcut_productions WHERE id = ? AND projectId = ? AND deletedAt IS NULL
    `).get(id, projectId);
    if (!owned) {
      return NextResponse.json({ error: 'live_mixcut_not_found', message: '批次不存在' }, {
        status: 404,
        headers: BATCH_NO_STORE_HEADERS,
      });
    }
    const storageRoot = path.join(dataRoot(), 'storage');
    // 与正式发布、工作区和清单使用同一个任务级目录；一个任务只有一个「成片」文件夹。
    const exportDirName = getLiveMixcutBatchExportDirName(getDb(), projectId, id);
    const relativeDir = path.join('live-mixcut', 'exports', exportDirName, '成片');
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
    return batchRouteErrorResponse(error, 'live_mixcut_reveal_failed', '打开成品文件夹失败');
  }
}

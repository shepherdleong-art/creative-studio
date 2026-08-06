import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { desktopRevealAvailable, resolvePublishedVideoForReveal, revealPublishedVideo } from '@/lib/final-edit/desktop-reveal';
import { guardManagedWorkbench } from '@/app/api/managed-deployment/guard';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const managedGuard = await guardManagedWorkbench();
  if (managedGuard) return managedGuard;
  if (!desktopRevealAvailable()) return NextResponse.json({ error: 'desktop_reveal_unavailable', message: '当前运行方式不支持在文件夹中查看' }, { status: 403 });
  if (request.headers.get('x-creative-studio-action') !== 'reveal') return NextResponse.json({ error: 'invalid_reveal_request', message: '文件定位请求缺少工作台标记' }, { status: 403 });
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) return NextResponse.json({ error: 'cross_origin_reveal_denied', message: '不允许跨站触发文件定位' }, { status: 403 });
  const { id } = await params;
  const row = getDb().prepare(`SELECT status, outputJson FROM final_edit_jobs WHERE id=? AND kind='render'`).get(id) as { status: string; outputJson: string | null } | undefined;
  if (!row) return NextResponse.json({ error: 'job_not_found', message: '渲染任务不存在' }, { status: 404 });
  if (row.status !== 'succeeded' || !row.outputJson) return NextResponse.json({ error: 'job_not_published', message: '渲染任务尚未完成写回' }, { status: 409 });
  try {
    const absolutePath = resolvePublishedVideoForReveal(path.join(dataRoot(), 'storage'), row.outputJson);
    await revealPublishedVideo(absolutePath);
    return NextResponse.json({ revealed: true });
  } catch (error) {
    return NextResponse.json({ error: 'reveal_failed', message: error instanceof Error ? error.message : String(error) }, { status: 409 });
  }
}

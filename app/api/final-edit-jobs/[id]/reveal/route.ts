import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { isSameOriginRequest } from '@/lib/same-origin-request';
import { desktopRevealAvailable, resolvePublishedVideoForReveal, revealPublishedVideo } from '@/lib/final-edit/desktop-reveal';
import { verifyDeliveryDirectory } from '@/lib/final-edit/reassembled/delivery';
import { projectFile, sha256 } from '@/lib/film-render/files';
import type { FilmBinding } from '@/lib/final-edit/reassembled/types';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!desktopRevealAvailable()) return NextResponse.json({ error: 'desktop_reveal_unavailable', message: '当前运行方式不支持在文件夹中查看' }, { status: 403 });
  if (request.headers.get('x-creative-studio-action') !== 'reveal') return NextResponse.json({ error: 'invalid_reveal_request', message: '文件定位请求缺少工作台标记' }, { status: 403 });
  if (!isSameOriginRequest(request)) return NextResponse.json({ error: 'cross_origin_reveal_denied', message: '不允许跨站触发文件定位' }, { status: 403 });
  const { id } = await params;
  const row = getDb().prepare(`SELECT status, outputJson FROM final_edit_jobs WHERE id=? AND kind IN ('render','packaging')`).get(id) as { status: string; outputJson: string | null } | undefined;
  if (!row) return NextResponse.json({ error: 'job_not_found', message: '任务不存在' }, { status: 404 });
  if (row.status !== 'succeeded' || !row.outputJson) return NextResponse.json({ error: 'job_not_published', message: '任务尚未完成写回' }, { status: 409 });
  try {
    const delivery = getDb().prepare(`SELECT bindingId,version,videoFilename,videoSha256 FROM final_edit_film_deliveries WHERE jobId=? AND status='published'`).get(id) as {bindingId:string;version:number;videoFilename:string;videoSha256:string} | undefined;
    let absolutePath: string;
    if (delivery) {
      const binding = getDb().prepare('SELECT * FROM final_edit_film_bindings WHERE id=?').get(delivery.bindingId) as FilmBinding;
      verifyDeliveryDirectory(binding);
      absolutePath = projectFile(binding.deliveryDir, `${delivery.version < binding.deliveryVersion ? '旧版/' : ''}${delivery.videoFilename}`);
      if (sha256(absolutePath) !== delivery.videoSha256) throw new Error('交付文件已被修改');
    } else absolutePath = resolvePublishedVideoForReveal(path.join(dataRoot(), 'storage'), row.outputJson);
    await revealPublishedVideo(absolutePath);
    return NextResponse.json({ revealed: true });
  } catch (error) {
    return NextResponse.json({ error: 'reveal_failed', message: error instanceof Error ? error.message : String(error) }, { status: 409 });
  }
}

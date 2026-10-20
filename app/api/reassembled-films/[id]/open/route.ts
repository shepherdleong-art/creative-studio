import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { checkLocalRequest } from '@/lib/final-edit/reassembled/access';
import { FinalEditError } from '@/lib/final-edit/errors';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import type { FilmBinding } from '@/lib/final-edit/reassembled/types';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = checkLocalRequest(request, true), query = new URL(request.url).searchParams;
    const binding = getDb().prepare('SELECT * FROM final_edit_film_bindings WHERE id=?').get((await params).id) as FilmBinding | undefined;
    if (!binding || query.get('token') !== binding.reviewToken || query.get('instance') !== identity.instanceId || query.get('data') !== identity.dataIdentity) throw new FinalEditError('review_link_stale', '审片连接已过期或不属于当前数据，请重新运行 review 命令刷新连接', 409);
    const version = Number(query.get('version'));
    if (!Number.isSafeInteger(version) || version < 1 || version > binding.deliveryVersion) throw new FinalEditError('review_version_invalid', '交付版本无效', 409);
    const requestId = query.get('navigationRequest');
    if (requestId !== null && !/^[a-f0-9-]{36}$/.test(requestId)) throw new FinalEditError('review_request_invalid', '导航请求标识无效', 400);
    const marker = path.join(dataRoot(), 'storage/run/reassembled-navigation.json');
    const temporary = `${marker}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ instanceId: identity.instanceId, projectId: binding.projectId, groupId: binding.groupId, shotSetId: binding.shotSetId, deliveryVersion: version, createdAt: Date.now(), ...(requestId ? { requestId, bindingId: binding.id } : {}) }), { mode: 0o600 });
    fs.renameSync(temporary, marker);
    return new Response('已请求桌面工作台打开这条成片，可返回桌面窗口。', { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  } catch (error) { return finalEditErrorResponse(error); }
}

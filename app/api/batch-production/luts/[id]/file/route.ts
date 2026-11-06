import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { getLut, resolveManagedLutPath } from '@/lib/batch-production/lut-catalog';
import { BatchDomainError } from '@/lib/batch-production/errors';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../../batches/response';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { fileResponse } from '@/lib/media-core/file-response';


export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * LUT .cube 文件内容(只读)。供批量实时预览的 WebGL 3D 纹理加载:
 * 按 lutId + projectId 解析受管路径(拒绝越界/符号链接),返回纯文本内容。
 * 导入侧已验证过 8MB 上限与真实 lut3d 解码,这里不再重复校验。
 */
async function __teamRouteGET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id: lutId } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({
      error: 'missing_project_id',
      message: '缺少 projectId 参数',
    }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  }
  try {
    await assertBatchApiReady();
    const db = getDb();
    const lut = getLut(db, projectId, lutId);
    if (!lut) {
      throw new BatchDomainError('not_found', 'LUT 不存在');
    }
    let absolutePath: string;
    try {
      absolutePath = resolveManagedLutPath(lut.relativePath);
    } catch {
      throw new BatchDomainError('not_found', 'LUT 受管路径不可用');
    }
    const response = fileResponse(request, absolutePath, 'text/plain; charset=utf-8', {
      cacheControl: BATCH_NO_STORE_HEADERS['Cache-Control'],
    });
    response.headers.set('X-Lut-Fingerprint', lut.contentFingerprint);
    return response;
  } catch (error) {
    return batchRouteErrorResponse(error, 'lut_file_failed', 'LUT 文件读取失败');
  }
}
export const GET = withTeamRoute('/api/batch-production/luts/[id]/file', 'GET', __teamRouteGET);

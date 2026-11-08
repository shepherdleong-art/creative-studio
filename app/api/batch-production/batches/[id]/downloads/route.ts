import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  BATCH_NO_EXPORTED_FILMS_MESSAGE,
  buildBatchDownloadManifest,
  normalizeBatchDownloadScope,
} from '@/lib/batch-production/download-manifest';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../response';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 本批次「可下载文件清单」（11 号票）。
 *
 * `GET /api/batch-production/batches/[id]/downloads?projectId=…&scope=both|video|cover`
 *
 * - 只列**当前正式产物**；改过未重新导出的给**上一版正式产物**并标 `outdated`；
 * - 每项带文件名、相对名（按项目与导出版本分目录）、字节数与 sha256；
 * - 身份与归属由 `withTeamRoute` 的 `batch` scope 检查：别人的批次在进入 handler
 *   之前就被拒（403 / 404），这里拿不到任何数据；
 * - ZIP 路由复用同一个 builder，所以「ZIP 内容与清单一致」是结构性的。
 *
 * 响应形状（给 15 号票写文档）：
 * ```json
 * {
 *   "batchId": "…", "projectId": "…", "scope": "both",
 *   "exportDirName": "ACC-1-20261101", "outdated": false,
 *   "items": [{
 *     "planId": "…", "seq": 1, "scriptTitle": "…", "kind": "video",
 *     "filename": "ACC-1-01.mp4",
 *     "relativeName": "ACC-1-20261101/01-v1/ACC-1-01.mp4",
 *     "byteSize": 4096, "sha256": "…", "checksum": "sha256:…",
 *     "outputVersionNumber": 1, "outdated": false
 *   }],
 *   "totalBytes": 6144,
 *   "emptyMessage": "还没有导出过的成片"   // 仅在 items 为空时出现
 * }
 * ```
 */
async function __teamRouteGET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id: batchId } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({ error: 'missing_project_id', message: '缺少 projectId 参数' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  const scope = new URL(request.url).searchParams.get('scope');
  try {
    normalizeBatchDownloadScope(scope);
  } catch (error) {
    return batchRouteErrorResponse(error, 'invalid_download_scope', '下载范围无效');
  }
  try {
    await assertBatchApiReady();
    const manifest = buildBatchDownloadManifest(getDb(), projectId, batchId, { scope });
    return NextResponse.json(
      manifest.items.length === 0
        ? { ...manifest, emptyMessage: BATCH_NO_EXPORTED_FILMS_MESSAGE }
        : manifest,
      { headers: BATCH_NO_STORE_HEADERS },
    );
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_downloads_failed', '可下载文件清单读取失败');
  }
}

export const GET = withTeamRoute('/api/batch-production/batches/[id]/downloads', 'GET', __teamRouteGET);

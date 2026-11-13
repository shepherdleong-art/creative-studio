import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { readRuntimeConfig } from '@/lib/team-service/config';
import {
  BATCH_NO_EXPORTED_FILMS_MESSAGE,
  buildBatchDownloadManifest,
  normalizeBatchDownloadScope,
  registerBatchDownloadFiles,
} from '@/lib/batch-production/download-manifest';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { teamFileDeliveryManifest } from '@/lib/team-service/transfers/devices';
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
 * `GET /api/batch-production/batches/[id]/downloads?projectId=…&scope=both|video|cover[&delivery=1]`
 *
 * - 只列**当前正式产物**；改过未重新导出的给**上一版正式产物**并标 `outdated`；
 * - 每项带文件名、相对名（按项目与导出版本分目录）、字节数与 sha256；
 * - 身份与归属由 `withTeamRoute` 的 `batch` scope 检查：别人的批次在进入 handler
 *   之前就被拒（403 / 404），这里拿不到任何数据；
 * - ZIP 路由复用同一个 builder，所以「ZIP 内容与清单一致」是结构性的。
 *
 * `delivery=1` 是**轻客户端**要的那份：把清单里的正式产物登记为 `delivery` 引用，
 * 并返回现有交付下载的 `TeamFileManifest`（fileId / version / size / sha256 / etag）。
 * 客户端把它交给 `createDownloads` —— 下载、校验、回执全部复用现有链路；
 * 「本机已下载成功跳过」与「失败只补下载」由设备回执天然保证。
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
 *   "emptyMessage": "还没有导出过的成片",       // 仅在 items 为空时出现
 *   "deliveryManifests": [{                      // 仅 delivery=1 时出现
 *     "fileId": "…", "seriesId": "…", "version": 1, "size": 4096,
 *     "sha256": "…", "etag": "\"…\"", "displayName": "ACC-1-01.mp4", "relativeDirectory": "ACC-1-20261101/01-v1"
 *   }]
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
  const searchParams = new URL(request.url).searchParams;
  const scope = searchParams.get('scope');
  try {
    normalizeBatchDownloadScope(scope);
  } catch (error) {
    return batchRouteErrorResponse(error, 'invalid_download_scope', '下载范围无效');
  }
  try {
    await assertBatchApiReady();
    if (searchParams.get('delivery') === '1') {
      if (readRuntimeConfig().mode !== 'server') {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }
      const { manifest, files } = await registerBatchDownloadFiles(
        getDb(), projectId, batchId, { scope, references: 'delivery' },
      );
      if (files.length === 0) {
        return NextResponse.json(
          { ...manifest, emptyMessage: BATCH_NO_EXPORTED_FILMS_MESSAGE, deliveryManifests: [] },
          { headers: BATCH_NO_STORE_HEADERS },
        );
      }
      const actor = requireAccessContext().actor;
      const deliveryManifests = files.map((file) => {
        if (!file.fileId) throw new Error('交付文件登记失败');
        const delivered = teamFileDeliveryManifest(getDb(), actor, file.fileId);
        // 客户端分别校验单层文件名和相对子目录，不能把整个相对名当文件名。
        return {
          ...delivered,
          displayName: file.item.filename,
          relativeDirectory: file.item.relativeName.slice(0, -(file.item.filename.length + 1)),
        };
      });
      return NextResponse.json({ ...manifest, deliveryManifests }, { headers: BATCH_NO_STORE_HEADERS });
    }
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

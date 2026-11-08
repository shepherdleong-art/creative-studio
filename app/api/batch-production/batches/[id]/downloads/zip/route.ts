import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { buildGenericZipStream, type ZipImageEntry } from '@/lib/zip-download';
import {
  BATCH_NO_EXPORTED_FILMS_MESSAGE,
  normalizeBatchDownloadScope,
  registerBatchDownloadFiles,
} from '@/lib/batch-production/download-manifest';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../../response';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 只用浏览器时的「一键下载全部」（11 号票）：服务端把清单里的正式产物打成 ZIP。
 *
 * `GET /api/batch-production/batches/[id]/downloads/zip?projectId=…&scope=both|video|cover`
 *
 * **ZIP 内容与清单一致**：两者走同一个 builder，ZIP 每个 entry 名就是清单里的
 * `relativeName`（按项目与导出版本分目录），不存在第二套查询。
 * 打包前先把产物登记为受管文件（`export` 引用）—— `buildGenericZipStream`
 * 只允许打包已登记、且当前主体有权读取的文件。
 *
 * 没有可下载成片时返回 404 + `还没有导出过的成片`，不生成空 ZIP。
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
    const { manifest, files } = await registerBatchDownloadFiles(
      getDb(), projectId, batchId, { scope, references: 'export' },
    );    if (manifest.items.length === 0 || files.length === 0) {
      return NextResponse.json(
        { error: 'no_exported_films', message: BATCH_NO_EXPORTED_FILMS_MESSAGE },
        { status: 404, headers: BATCH_NO_STORE_HEADERS },
      );
    }
    const entries: ZipImageEntry[] = files.map((file) => ({
      filePath: file.absolutePath,
      filename: file.filename,
    }));
    const zipName = `${manifest.exportDirName}-成片${scope === 'both' ? '' : scope === 'video' ? '-视频' : '-封面'}.zip`;
    return new NextResponse(buildGenericZipStream(entries), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_download_zip_failed', '成片打包下载失败');
  }
}

export const GET = withTeamRoute('/api/batch-production/batches/[id]/downloads/zip', 'GET', __teamRouteGET);

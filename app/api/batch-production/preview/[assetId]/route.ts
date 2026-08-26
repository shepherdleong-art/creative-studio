import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { resolvePreviewSource } from '@/lib/batch-production/preview';
import { PROXY_PROFILE_VERSION } from '@/lib/batch-production/proxy-executor';
import { COLOR_PIPELINE_VERSION, upgradeColorSnapshot } from '@/lib/batch-production/color-pipeline';
import { acquireProxyReadLease, resolveControlledProxyPath } from '@/lib/batch-production/proxy-cache';
import { projectAssetMimeType } from '@/lib/batch-production/project-asset-media';
import { buildMediaEtag, projectAssetMediaResponse } from '@/lib/batch-production/project-asset-media-response';
import { BATCH_NO_STORE_HEADERS, batchProjectIdFromRequest } from '../../batches/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 预览来源解析 + 媒体服务合一的 route:
 * - 验证 projectId + batchId + batchVersionId + assetId.
 * - 素材必须属于该版本素材池.
 * - 色彩快照只从服务端批次版本读取,不接受任意 lutId(见 §7).
 * - 代理读取全程持有读取租约(释放前清理不会删除正在被读取的文件).
 * - 不接受任意路径,只接受 assetId + 已核验的项目/批次/版本归属.
 */

/** 预览媒体的缓存策略:同一 URL 的内容会随代理就绪从原片切到代理,必须每次条件请求校验。 */
const PREVIEW_MEDIA_CACHE_CONTROL = 'private, max-age=0, must-revalidate';

/**
 * 强 ETag:内容身份 = 来源种类 + 素材指纹 + 代理/色彩管线版本 + 色彩快照 + 文件 stat。
 * 代理 ready 的那一刻 source.kind/cacheItemId 变化 → ETag 变化,浏览器自动重新拉取;
 * 排在后面的代理工作不得把 ETag 简化成只依赖 contentFingerprint。
 */
function previewMediaEtag(parts: string[], stat: fs.Stats): string {
  return buildMediaEtag([...parts, String(stat.size), String(stat.mtimeMs)]);
}

export async function GET(request: NextRequest, context: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({
      error: 'missing_project_id',
      message: '缺少 projectId 参数',
    }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  }
  const batchId = request.nextUrl.searchParams.get('batchId');
  const batchVersionId = request.nextUrl.searchParams.get('batchVersionId');

  if (!batchId || !batchVersionId) {
    return NextResponse.json({
      error: 'missing_params',
      message: '缺少 batchId 或 batchVersionId 参数',
    }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  }

  try {
    await assertBatchApiReady();
    const db = getDb();

    // 验证批次存在且属于该项目
    const batch = db.prepare(`
      SELECT id FROM batch_productions WHERE id = ? AND projectId = ? AND deletedAt IS NULL
    `).get(batchId, projectId) as { id: string } | undefined;
    if (!batch) {
      return NextResponse.json({
        error: 'not_found',
        message: '批次不存在或不属于该项目',
      }, { status: 404, headers: BATCH_NO_STORE_HEADERS });
    }

    // 验证版本属于该批次
    const version = db.prepare(`
      SELECT id FROM batch_production_versions WHERE id = ? AND batchId = ?
    `).get(batchVersionId, batchId) as { id: string } | undefined;
    if (!version) {
      return NextResponse.json({
        error: 'not_found',
        message: '批次版本不存在或不属于该批次',
      }, { status: 404, headers: BATCH_NO_STORE_HEADERS });
    }

    // 素材必须属于该版本素材池,色彩快照只从服务端读取
    const poolItem = db.prepare(`
      SELECT pool.colorJson, assets.contentFingerprint
      FROM batch_asset_pool_items pool
      JOIN batch_assets assets ON assets.id = pool.assetId
      WHERE pool.batchVersionId = ? AND pool.assetId = ? AND assets.projectId = ?
    `).get(batchVersionId, assetId, projectId) as {
      colorJson: string;
      contentFingerprint: string;
    } | undefined;
    if (!poolItem) {
      return NextResponse.json({
        error: 'not_found',
        message: '素材不在该批次版本的素材池中',
      }, { status: 404, headers: BATCH_NO_STORE_HEADERS });
    }

    // 色彩快照从服务端批次版本读取,不接受任意 lutId
    const colorSnapshot = upgradeColorSnapshot(JSON.parse(poolItem.colorJson));

    const source = resolvePreviewSource(db, projectId, {
      assetId,
      contentFingerprint: poolItem.contentFingerprint,
      colorSnapshot,
      profileVersion: PROXY_PROFILE_VERSION,
      colorPipelineVersion: COLOR_PIPELINE_VERSION,
    });

    // 预览信息模式:只返回来源描述,供 UI 渲染来源徽标/警告/离线提示,不提供媒体。
    if (request.nextUrl.searchParams.get('previewInfo') === '1') {
      if (source.kind === 'proxy') {
        return NextResponse.json({
          kind: 'proxy',
          originalOnline: source.originalOnline,
          warning: source.originalOnline ? undefined : '原片离线,当前播放的是已生成代理;正式导出不可用',
        }, { headers: BATCH_NO_STORE_HEADERS });
      }
      if (source.kind === 'original') {
        return NextResponse.json({ kind: 'original', originalOnline: true }, { headers: BATCH_NO_STORE_HEADERS });
      }
      if (source.kind === 'original_pending_lut') {
        return NextResponse.json({
          kind: 'original_pending_lut',
          originalOnline: true,
          warning: source.warning,
        }, { headers: BATCH_NO_STORE_HEADERS });
      }
      return NextResponse.json({
        kind: 'unavailable',
        originalOnline: false,
        warning: source.reason,
      }, { status: 200, headers: BATCH_NO_STORE_HEADERS });
    }

    if (source.kind === 'unavailable') {
      return NextResponse.json({
        error: 'preview_unavailable',
        message: source.reason,
      }, { status: 404, headers: BATCH_NO_STORE_HEADERS });
    }
    if (source.kind === 'original' || source.kind === 'original_pending_lut') {
      if (!fs.existsSync(source.sourcePath)) {
        return NextResponse.json({
          error: 'preview_unavailable',
          message: '原片文件当前不可读',
        }, { status: 404, headers: BATCH_NO_STORE_HEADERS });
      }
      const stat = fs.statSync(source.sourcePath);
      const etagParts = [
        source.kind,
        poolItem.contentFingerprint,
        COLOR_PIPELINE_VERSION,
        PROXY_PROFILE_VERSION,
        poolItem.colorJson,
      ];
      const extraHeaders: Record<string, string> = { 'X-Preview-Kind': source.kind };
      if (source.kind === 'original_pending_lut') {
        extraHeaders['X-Preview-Warning'] = encodeURIComponent(source.warning);
      }
      return projectAssetMediaResponse(
        request,
        source.sourcePath,
        projectAssetMimeType(source.sourcePath),
        extraHeaders,
        undefined,
        {
          cacheControl: PREVIEW_MEDIA_CACHE_CONTROL,
          etag: previewMediaEtag(etagParts, stat),
        },
      );
    }
    // source.kind === 'proxy'
    const release = acquireProxyReadLease(source.cacheItemId, db);
    // 流式响应的租约必须活到流结束:引用归零时会直接删除还在被读的代理文件。
    // 200/206 经 onClose 在流 close/error 时释放;早退分支(404/304/416)与异常
    // 不经过流,由 finally 同步释放。注意 finally 在 return 的响应开始流动前就会
    // 执行,绝不能在这里无条件 release。
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      release();
    };
    let streaming = false;
    try {
      const absolutePath = resolveControlledProxyPath(source.relativePath);
      if (!fs.existsSync(absolutePath)) {
        return NextResponse.json({
          error: 'preview_unavailable',
          message: '代理文件当前不可读',
        }, { status: 404, headers: BATCH_NO_STORE_HEADERS });
      }
      const stat = fs.statSync(absolutePath);
      const response = projectAssetMediaResponse(
        request,
        absolutePath,
        projectAssetMimeType(absolutePath),
        {
          'X-Preview-Kind': 'proxy',
          'X-Preview-Original-Online': source.originalOnline ? '1' : '0',
        },
        undefined,
        {
          cacheControl: PREVIEW_MEDIA_CACHE_CONTROL,
          etag: buildMediaEtag([
            source.kind,
            poolItem.contentFingerprint,
            COLOR_PIPELINE_VERSION,
            PROXY_PROFILE_VERSION,
            poolItem.colorJson,
            source.cacheItemId,
            String(stat.size),
            String(stat.mtimeMs),
          ]),
          onClose: releaseOnce,
        },
      );
      // 只有真正带流生命周期的响应才把租约交给 onClose;304/416 等早退分支
      // 不触发 onClose,保持 streaming=false 让 finally 同步释放。
      streaming = response.status === 200 || response.status === 206;
      return response;
    } finally {
      if (!streaming) releaseOnce();
    }
  } catch {
    return NextResponse.json({
      error: 'preview_failed',
      message: '预览解析失败',
    }, { status: 500, headers: BATCH_NO_STORE_HEADERS });
  }
}

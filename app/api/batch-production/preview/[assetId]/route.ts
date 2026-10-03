import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { resolvePreviewSource } from '@/lib/batch-production/preview';
import { PROXY_PROFILE_VERSION } from '@/lib/batch-production/proxy-executor';
import { acquireProxyReadLease, resolveControlledProxyPath } from '@/lib/batch-production/proxy-cache';
import { projectAssetMimeType } from '@/lib/batch-production/project-asset-media';
import { buildMediaEtag, projectAssetMediaResponse } from '@/lib/batch-production/project-asset-media-response';
import { ensureBrowserPreview } from '@/lib/video-browser-preview';
import { BATCH_NO_STORE_HEADERS, batchProjectIdFromRequest } from '../../batches/response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 预览来源解析 + 媒体服务合一的 route:
 * - 验证 projectId + batchId + batchVersionId + assetId.
 * - 素材必须属于该版本素材池(归属校验;色彩快照不再参与预览解析,共识 9/13).
 * - 代理读取全程持有读取租约(释放前清理不会删除正在被读取的文件).
 * - 不接受任意路径,只接受 assetId + 已核验的项目/批次/版本归属.
 */

/** 预览媒体的缓存策略:同一 URL 的内容会随代理就绪从原片切到代理,必须每次条件请求校验。 */
const PREVIEW_MEDIA_CACHE_CONTROL = 'private, max-age=0, must-revalidate';

/**
 * 强 ETag:内容身份 = 来源种类 + 素材指纹 + 代理规格版本 + 文件 stat。
 * 色彩/LUT 是预览层实时效果(共识 9),不参与视频源内容身份;
 * 代理 ready 的那一刻 source.kind/cacheItemId 变化 → ETag 变化,浏览器自动重新拉取。
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

  try {
    await assertBatchApiReady();
    const db = getDb();

    // 两种模式(与素材卡/冻结池两个预览入口对应,解析逻辑同一条:
    // resolvePreviewSource 代理 → 原片 → 不可用):
    // - 批次级(带 batchId + batchVersionId):素材必须属于该版本素材池;
    // - 素材级(都不带):只校验素材属于该项目,不要求批次存在或已确认——
    //   素材级代理请求(共识 2)就是为这个入口服务的。
    let contentFingerprint: string;
    if (batchId !== null || batchVersionId !== null) {
      if (!batchId || !batchVersionId) {
        return NextResponse.json({
          error: 'missing_params',
          message: 'batchId 与 batchVersionId 必须同时提供',
        }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }

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

      // 素材必须属于该版本素材池
      const poolItem = db.prepare(`
        SELECT assets.contentFingerprint
        FROM batch_asset_pool_items pool
        JOIN batch_assets assets ON assets.id = pool.assetId
        WHERE pool.batchVersionId = ? AND pool.assetId = ? AND assets.projectId = ?
      `).get(batchVersionId, assetId, projectId) as {
        contentFingerprint: string;
      } | undefined;
      if (!poolItem) {
        return NextResponse.json({
          error: 'not_found',
          message: '素材不在该批次版本的素材池中',
        }, { status: 404, headers: BATCH_NO_STORE_HEADERS });
      }
      contentFingerprint = poolItem.contentFingerprint;
    } else {
      const asset = db.prepare(`
        SELECT projectId, contentFingerprint FROM batch_assets WHERE id = ?
      `).get(assetId) as { projectId: string; contentFingerprint: string } | undefined;
      if (!asset || asset.projectId !== projectId) {
        return NextResponse.json({
          error: 'not_found',
          message: '素材不存在或不属于该项目',
        }, { status: 404, headers: BATCH_NO_STORE_HEADERS });
      }
      contentFingerprint = asset.contentFingerprint;
    }

    const source = resolvePreviewSource(db, projectId, {
      assetId,
      contentFingerprint,
      profileVersion: PROXY_PROFILE_VERSION,
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
    if (source.kind === 'original') {
      if (!fs.existsSync(source.sourcePath)) {
        return NextResponse.json({
          error: 'preview_unavailable',
          message: '原片文件当前不可读',
        }, { status: 404, headers: BATCH_NO_STORE_HEADERS });
      }
      // 原片可能是 HEVC/10bit（Seedance 2.5 1080p），浏览器放不动：视频统一
      // 换（必要时懒生成的）H.264 预览衍生物，内容身份随切到衍生物（etag 加
      // 区分标记，衍生物就绪后浏览器自动重拉）；代理分支不受影响。
      const originalMime = projectAssetMimeType(source.sourcePath);
      const served = originalMime.startsWith('video/')
        ? await ensureBrowserPreview(source.sourcePath)
        : source.sourcePath;
      const stat = fs.statSync(served);
      const etagParts = [
        source.kind,
        contentFingerprint,
        PROXY_PROFILE_VERSION,
        served === source.sourcePath ? 'original-bytes' : 'h264-preview',
      ];
      const extraHeaders: Record<string, string> = { 'X-Preview-Kind': source.kind };
      if (served !== source.sourcePath) extraHeaders['X-Preview-Transcoded'] = 'h264';
      return projectAssetMediaResponse(
        request,
        served,
        served === source.sourcePath ? originalMime : 'video/mp4',
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
            contentFingerprint,
            PROXY_PROFILE_VERSION,
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

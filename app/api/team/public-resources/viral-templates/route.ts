import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertScriptStudioApiReady, errorResponse, readCatalogImportUpload } from '@/lib/script-studio/http';
import { previewViralTemplateImport } from '@/lib/script-studio/viral-templates';
import { getTeamViralTemplateView, publishTeamViralTemplate } from '@/lib/script-studio/viral-templates-team';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 团队公共爆文模板库的发布编排（票 01 / 规格 §3）。
 *
 * GET  当前团队版本 + 历史版本 + 可发布的既有修订候选（管理员）。
 * POST ?mode=preview  只解析并返回预览报告，不落库。
 * POST               原子发布：上传文件或既有修订（revisionId），
 *                    带 baseRevisionId 做并发 CAS。
 */
async function __teamRouteGET() {
  try {
    await assertScriptStudioApiReady();
    return NextResponse.json(getTeamViralTemplateView(getDb()), {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    const { status, body } = errorResponse(error);
    return NextResponse.json(body, { status });
  }
}

async function __teamRoutePOST(request: NextRequest) {
  try {
    await assertScriptStudioApiReady();
    const mode = request.nextUrl.searchParams.get('mode');
    if (mode === 'preview') {
      const upload = await readCatalogImportUpload(request);
      if ('error' in upload) return upload.error;
      const preview = await previewViralTemplateImport(Buffer.from(await upload.file.arrayBuffer()));
      // 预览只回报告：条目全文可能很大，且发布时才需要。
      const report = Object.fromEntries(Object.entries(preview).filter(([key]) => key !== 'entries'));
      return NextResponse.json({ preview: true, report }, { status: 200 });
    }
    const contentType = request.headers.get('content-type') ?? '';
    if (contentType.includes('multipart/form-data')) {
      const upload = await readCatalogImportUpload(request);
      if ('error' in upload) return upload.error;
      // 上传表单必须显式带上看到的当前版本（空串表示「认定团队尚无版本」），
      // 否则无法检测并发发布冲突，会无提示覆盖其他管理员刚发布的版本。
      if (!request.nextUrl.searchParams.has('baseRevisionId')) {
        return NextResponse.json({
          error: 'invalid_input',
          message: '缺少基准版本，请刷新页面后重新发布',
        }, { status: 400 });
      }
      const baseRevisionId = request.nextUrl.searchParams.get('baseRevisionId') || '';
      const outcome = await publishTeamViralTemplate(getDb(), {
        buffer: Buffer.from(await upload.file.arrayBuffer()),
        sourceFilename: upload.file.name,
        baseRevisionId: baseRevisionId === '' ? null : baseRevisionId,
      });
      return NextResponse.json(outcome, { status: outcome.created ? 201 : 200 });
    }
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const revisionId = typeof body?.revisionId === 'string' ? body.revisionId.trim() : '';
    if (!revisionId) {
      return NextResponse.json({ error: 'invalid_input', message: '缺少要发布的模板修订' }, { status: 400 });
    }
    const baseRevisionId = typeof body?.baseRevisionId === 'string' && body.baseRevisionId.trim()
      ? body.baseRevisionId.trim()
      : (body?.baseRevisionId === null ? null : undefined);
    if (baseRevisionId === undefined) {
      return NextResponse.json({ error: 'invalid_input', message: '缺少基准版本，无法检测并发发布冲突' }, { status: 400 });
    }
    const outcome = await publishTeamViralTemplate(getDb(), { revisionId, baseRevisionId });
    return NextResponse.json(outcome, { status: outcome.created ? 201 : 200 });
  } catch (error) {
    const { status, body } = errorResponse(error);
    return NextResponse.json(body, { status });
  }
}

export const GET = withTeamRoute('/api/team/public-resources/viral-templates', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/team/public-resources/viral-templates', 'POST', __teamRoutePOST);

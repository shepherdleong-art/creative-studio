import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { requirePrincipal } from '@/lib/team-service/auth/request';
import { publishTeamResource } from '@/lib/team-service/files/publication';
import { ResourceAccessError } from '@/lib/team-service/resource-scopes';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

const PUBLISHABLE = new Set(['bgm', 'video_prompt_template', 'title_preset', 'lut']);
const VERSIONED = new Set([
  'script_catalog', 'script_catalog_revision', 'script_template_asset',
  'viral_template_library', 'viral_template_revision', 'viral_template_entry',
]);

async function __teamRouteGET(request: Request) {
  if (readRuntimeConfig().mode !== 'server') return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const principal = requirePrincipal(request, { admin: true });
  const { listPublicResourceCandidates } = await import('@/lib/team-service/resource-candidates');
  return NextResponse.json({ candidates: listPublicResourceCandidates(getDb(), principal) }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

async function __teamRoutePOST(request: Request) {
  if (readRuntimeConfig().mode !== 'server') return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const principal = requirePrincipal(request, { admin: true });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.resourceType !== 'string' || typeof body.resourceId !== 'string'
    || !body.resourceId.trim()) {
    return NextResponse.json({ error: 'invalid_resource', message: '请从候选列表选择有效资源。' }, { status: 400 });
  }
  if (VERSIONED.has(body.resourceType)) {
    return NextResponse.json({
      error: 'versioned_publication_required',
      message: '知识库与模板库需要完整版本发布，当前版本尚不支持此操作。',
    }, { status: 409 });
  }
  if (!PUBLISHABLE.has(body.resourceType)) {
    return NextResponse.json({ error: 'invalid_resource', message: '请从候选列表选择有效资源。' }, { status: 400 });
  }
  try {
    const db = getDb();
    const { listPublicResourceCandidates } = await import('@/lib/team-service/resource-candidates');
    const candidate = listPublicResourceCandidates(db, principal).find((item) => item.resourceType === body.resourceType && item.resourceId === body.resourceId);
    if (!candidate) {
      const scope = db.prepare('SELECT 1 FROM team_resource_scopes WHERE resourceType = ? AND resourceId = ?').get(body.resourceType, body.resourceId);
      return NextResponse.json({
        error: scope ? 'candidate_unavailable' : 'resource_not_found',
        message: '资源不存在、文件已失效或当前不可发布，请刷新候选列表。',
      }, { status: scope ? 409 : 404 });
    }
    const result = publishTeamResource(db, principal, { resourceType: body.resourceType, resourceId: body.resourceId });
    return NextResponse.json({ published: true, ...result });
  } catch (error) {
    if (error instanceof ResourceAccessError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
    }
    return NextResponse.json({
      error: 'publish_failed',
      message: error instanceof Error ? error.message : '资源不存在或当前不可用，请刷新候选列表。',
    }, { status: 409 });
  }
}

export const GET = withTeamRoute('/api/team/public-resources', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/team/public-resources', 'POST', __teamRoutePOST);

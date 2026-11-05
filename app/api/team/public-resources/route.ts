import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { requirePrincipal } from '@/lib/team-service/auth/request';
import { publishTeamResource } from '@/lib/team-service/files/publication';
import { ResourceAccessError } from '@/lib/team-service/resource-scopes';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

const PUBLISHABLE = new Set([
  'bgm', 'video_prompt_template', 'title_preset', 'lut',
  'script_catalog', 'script_catalog_revision', 'script_template_asset',
]);

/**
 * 爆文模板库不走这个逐条发布入口：团队版本必须原子发布（修订 + 全部条目 +
 * 当前指针一次写入），否则会出现「只公开库根、条目仍私有」的撕裂状态。
 * 见 /api/team/public-resources/viral-templates。
 */
const VIRAL_TEMPLATE_TYPES = new Set(['viral_template_library', 'viral_template_revision', 'viral_template_entry']);

async function __teamRoutePOST(request: Request) {
  if (readRuntimeConfig().mode !== 'server') return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const principal = requirePrincipal(request, { admin: true });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.resourceType !== 'string' || typeof body.resourceId !== 'string'
    || !body.resourceId.trim()) {
    return NextResponse.json({ error: 'invalid_resource' }, { status: 400 });
  }
  if (VIRAL_TEMPLATE_TYPES.has(body.resourceType)) {
    return NextResponse.json({
      error: 'use_team_publish',
      message: '爆文模板库请使用「上传→预览→发布给团队」流程，保证版本与条目一起原子发布。',
      endpoint: '/api/team/public-resources/viral-templates',
    }, { status: 400 });
  }
  if (!PUBLISHABLE.has(body.resourceType)) {
    return NextResponse.json({ error: 'invalid_resource' }, { status: 400 });
  }
  try {
    publishTeamResource(getDb(), principal, { resourceType: body.resourceType, resourceId: body.resourceId });
    return NextResponse.json({ published: true });
  } catch (error) {
    if (error instanceof ResourceAccessError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: 'publish_failed' }, { status: 500 });
  }
}

export const POST = withTeamRoute('/api/team/public-resources', 'POST', __teamRoutePOST);

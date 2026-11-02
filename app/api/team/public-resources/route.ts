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
  'viral_template_library', 'viral_template_revision', 'viral_template_entry',
]);

async function __teamRoutePOST(request: Request) {
  if (readRuntimeConfig().mode !== 'server') return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const principal = requirePrincipal(request, { admin: true });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.resourceType !== 'string' || typeof body.resourceId !== 'string'
    || !PUBLISHABLE.has(body.resourceType) || !body.resourceId.trim()) {
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

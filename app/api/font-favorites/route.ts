import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { importFontFavorites, isFontFamily, listFontFavorites, setFontFavorite } from '@/lib/font-favorites';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


export const dynamic = 'force-dynamic';

function __teamRouteGET() {
  const access = requireAccessContext();
  return NextResponse.json({ favorites: listFontFavorites(getDb(), access.kind === 'team' ? access.actor.userId : undefined) }, { headers: { 'Cache-Control': 'no-store' } });
}

async function __teamRoutePOST(request: Request) {
  const input: unknown = await request.json().catch(() => null);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return NextResponse.json({ error: '收藏请求无效' }, { status: 400 });
  }
  const body = input as Record<string, unknown>;
  const access = requireAccessContext();
  const ownerUserId = access.kind === 'team' ? access.actor.userId : undefined;
  if (body.action === 'import' && Array.isArray(body.favorites) && body.favorites.length <= 1000 && body.favorites.every(isFontFamily)) {
    return NextResponse.json({ favorites: importFontFavorites(getDb(), body.favorites, ownerUserId) });
  }
  if (body.action === 'set' && isFontFamily(body.family) && typeof body.favorite === 'boolean') {
    return NextResponse.json({ favorites: setFontFavorite(getDb(), body.family, body.favorite, ownerUserId) });
  }
  return NextResponse.json({ error: '收藏请求无效' }, { status: 400 });
}
export const GET = withTeamRoute('/api/font-favorites', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/font-favorites', 'POST', __teamRoutePOST);

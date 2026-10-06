import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { importFontFavorites, isFontFamily, listFontFavorites, setFontFavorite } from '@/lib/font-favorites';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({ favorites: listFontFavorites(getDb()) }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  const input: unknown = await request.json().catch(() => null);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return NextResponse.json({ error: '收藏请求无效' }, { status: 400 });
  }
  const body = input as Record<string, unknown>;
  if (body.action === 'import' && Array.isArray(body.favorites) && body.favorites.length <= 1000 && body.favorites.every(isFontFamily)) {
    return NextResponse.json({ favorites: importFontFavorites(getDb(), body.favorites) });
  }
  if (body.action === 'set' && isFontFamily(body.family) && typeof body.favorite === 'boolean') {
    return NextResponse.json({ favorites: setFontFavorite(getDb(), body.family, body.favorite) });
  }
  return NextResponse.json({ error: '收藏请求无效' }, { status: 400 });
}

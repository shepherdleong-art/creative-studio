import { NextResponse } from 'next/server';
import { listSystemFonts } from '@/lib/final-edit/system-fonts';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


async function __teamRouteGET(request: Request) {
  const { searchParams } = new URL(request.url);
  const forceRefresh = searchParams.get('refresh') === '1';
  const fonts = listSystemFonts({ forceRefresh });
  if (requireAccessContext().kind === 'local') return NextResponse.json({ fonts });
  return NextResponse.json({ fonts: fonts.map(({ family, displayName, format, source, previewUrl }) => ({ family, displayName, format, source, previewUrl })) });
}
export const GET = withTeamRoute('/api/system-fonts', 'GET', __teamRouteGET);

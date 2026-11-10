import fs from 'node:fs';
import path from 'node:path';
import { resolveSystemFontFile } from '@/lib/media-core/system-fonts';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

async function __teamRouteGET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const file = resolveSystemFontFile(id);
  if (!file) return Response.json({ error: 'font_not_found' }, { status: 404 });
  const contentType = ({ '.otf': 'font/otf', '.ttf': 'font/ttf', '.ttc': 'font/collection' } as Record<string, string>)[path.extname(file).toLowerCase()];
  return new Response(new Uint8Array(fs.readFileSync(file)), { headers: {
    'Content-Type': contentType, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff',
  } });
}
export const GET = withTeamRoute('/api/system-fonts/[id]/file', 'GET', __teamRouteGET);

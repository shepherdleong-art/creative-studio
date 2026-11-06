import { withTeamRoute } from '@/lib/team-service/route-wrapper';
function __teamRouteGET(): Response {
  return Response.json(
    { live: true },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
export const GET = withTeamRoute('/api/team/health/live', 'GET', __teamRouteGET);

import { NextResponse } from 'next/server';
import { desktopRevealAvailable } from '@/lib/final-edit/desktop-reveal';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


async function __teamRouteGET() {
  return NextResponse.json({ revealInFolder: desktopRevealAvailable() });
}
export const GET = withTeamRoute('/api/final-edit/capabilities', 'GET', __teamRouteGET);

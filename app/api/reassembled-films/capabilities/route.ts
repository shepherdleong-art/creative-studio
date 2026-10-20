import { NextResponse } from 'next/server';
import { agentToken, checkLocalRequest } from '@/lib/final-edit/reassembled/access';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
export function GET(request: Request) {
  try { const identity = checkLocalRequest(request); agentToken(); return NextResponse.json({ ...identity, applicationRoot: process.env.CREATIVE_STUDIO_APPLICATION_ROOT, desktopUserData: process.env.CREATIVE_STUDIO_DESKTOP_USER_DATA, capabilities: ['import-completed-film/1', 'edit-film-shots/1', 'versioned-delivery/1', 'shot-rework-candidates/1', 'edit-film-content/1', 'film-content-proposals/1', 'film-production-sync/1', 'film-review-launch/1', 'film-fixed-duration-speed/1', 'film-external-candidates/1', 'film-ripple-duration/1'] }, { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return finalEditErrorResponse(error); }
}

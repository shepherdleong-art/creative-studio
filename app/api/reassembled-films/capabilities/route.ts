import { NextResponse } from 'next/server';
import { agentToken, checkLocalRequest } from '@/lib/final-edit/reassembled/access';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
export function GET(request: Request) {
  try { const identity = checkLocalRequest(request); agentToken(); return NextResponse.json({ ...identity, capabilities: ['import-completed-film/1', 'edit-film-shots/1', 'versioned-delivery/1'] }, { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return finalEditErrorResponse(error); }
}

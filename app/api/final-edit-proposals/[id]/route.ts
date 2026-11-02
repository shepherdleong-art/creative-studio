import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


async function __teamRouteGET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const row = getDb().prepare(`SELECT id, variantId, baseRevision, kind, proposalJson, issuesJson, status, createdAt, appliedAt FROM final_edit_proposals WHERE id=?`).get((await params).id);
  return row ? NextResponse.json(row) : NextResponse.json({ error: 'proposal_not_found' }, { status: 404 });
}
export const GET = withTeamRoute('/api/final-edit-proposals/[id]', 'GET', __teamRouteGET);

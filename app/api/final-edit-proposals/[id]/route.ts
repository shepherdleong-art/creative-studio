import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const row = getDb().prepare(`SELECT id, variantId, baseRevision, kind, proposalJson, issuesJson, status, createdAt, appliedAt FROM final_edit_proposals WHERE id=?`).get((await params).id);
  return row ? NextResponse.json(row) : NextResponse.json({ error: 'proposal_not_found' }, { status: 404 });
}

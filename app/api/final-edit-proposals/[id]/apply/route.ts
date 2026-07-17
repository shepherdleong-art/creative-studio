import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getFinalEditWorkspace } from '@/lib/final-edit/runtime';
import { finalEditErrorResponse } from '@/lib/final-edit/http';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const proposalId = (await params).id;
    const body = await request.json() as { expectedRevision?: number };
    const proposal = getDb().prepare(`SELECT variantId FROM final_edit_proposals WHERE id=?`).get(proposalId) as { variantId: string } | undefined;
    if (!proposal) return NextResponse.json({ error: 'proposal_not_found' }, { status: 404 });
    const result = getFinalEditWorkspace().apply({ scope: 'variant', variantId: proposal.variantId, expectedRevision: Number(body.expectedRevision), type: 'apply_proposal', proposalId });
    return NextResponse.json(result);
  } catch (error) { return finalEditErrorResponse(error); }
}

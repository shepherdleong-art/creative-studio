import { NextResponse } from 'next/server';
import { getFinalEditWorkspace } from '@/lib/final-edit/runtime';
import { finalEditErrorResponse } from '@/lib/final-edit/http';

// docs/superpowers/plans/2026-07-23-mixcut-technical-execution.md §5.1 /
// §3.1's app/api/projects/[id]/final-edit/context/route.ts. Thin wrapper per
// plan §2.1/§3.2: all query/aggregation logic lives behind
// FinalEditWorkspace.getMixcutContext (lib/final-edit/workspace.ts), which
// delegates to the pure, independently-testable lib/final-edit/mixcut-context.ts.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: projectId } = await params;
    const url = new URL(request.url);
    // JUDGMENT CALL (JC-1): optional ?shotSetId= query param — see
    // lib/final-edit/mixcut-context.ts's buildMixcutContext for the
    // fallback/echo rules.
    const requestedShotSetId = url.searchParams.get('shotSetId');
    const context = await getFinalEditWorkspace().getMixcutContext(projectId, requestedShotSetId);
    return NextResponse.json(context);
  } catch (error) {
    return finalEditErrorResponse(error);
  }
}

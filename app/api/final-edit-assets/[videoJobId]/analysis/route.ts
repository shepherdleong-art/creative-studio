import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function PATCH(request: Request, { params }: { params: Promise<{ videoJobId: string }> }) {
  const { videoJobId } = await params;
  const current = getDb().prepare(`SELECT manualOverrideJson, autoUseDisabled FROM final_edit_asset_analysis WHERE videoJobId=?`).get(videoJobId) as { manualOverrideJson: string; autoUseDisabled: number } | undefined;
  if (!current) return NextResponse.json({ error: 'analysis_not_found' }, { status: 404 });
  const body = await request.json() as { summary?: string; semanticTags?: string[]; qualityIssues?: string[]; usableRanges?: unknown[]; autoUseDisabled?: boolean };
  const previous = JSON.parse(current.manualOverrideJson || '{}') as Record<string, unknown>;
  const allowed: Record<string, unknown> = { ...previous };
  if (typeof body.summary === 'string') allowed.summary = body.summary.trim();
  if (Array.isArray(body.semanticTags)) allowed.semanticTags = body.semanticTags.filter((item): item is string => typeof item === 'string');
  if (Array.isArray(body.qualityIssues)) allowed.qualityIssues = body.qualityIssues.filter((item): item is string => typeof item === 'string');
  if (Array.isArray(body.usableRanges)) allowed.usableRanges = body.usableRanges;
  getDb().prepare(`UPDATE final_edit_asset_analysis SET manualOverrideJson=?, autoUseDisabled=?, updatedAt=? WHERE videoJobId=?`).run(JSON.stringify(allowed), body.autoUseDisabled == null ? current.autoUseDisabled : (body.autoUseDisabled ? 1 : 0), new Date().toISOString(), videoJobId);
  return NextResponse.json({ videoJobId, manualOverride: allowed, autoUseDisabled: body.autoUseDisabled == null ? Boolean(current.autoUseDisabled) : body.autoUseDisabled });
}

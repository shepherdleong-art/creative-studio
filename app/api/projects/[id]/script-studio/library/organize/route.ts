import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { completeJson } from '@/lib/script-providers';
import { assertScriptStudioApiReady, errorResponse, jsonOrNull } from '@/lib/script-studio/http';
import { ScriptStudioError } from '@/lib/script-studio/errors';
import { resolveRuntimeProviders } from '@/lib/script-studio/runtime';
import { createSellingPointOrganizer } from '@/lib/script-studio/selling-point-organizer';
import { reorganizeLibrary } from '@/lib/script-studio/reorganize-library';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await assertScriptStudioApiReady();
    const { id: projectId } = await params;
    const body = await jsonOrNull(request);
    if (typeof body?.baseRevisionId !== 'string' || typeof body?.providerId !== 'string' || !body.providerId) {
      throw new ScriptStudioError('invalid_input', '请选择整理卖点使用的模型，并提供当前卖点库版本');
    }
    const provider = resolveRuntimeProviders(body.providerId).text;
    const organizer = createSellingPointOrganizer((input) => completeJson({
      ...input, providerId: provider.id, model: provider.model,
      usageContext: { enabled: true, projectId, refType: 'script-studio-organize', refId: body.baseRevisionId as string },
    } as Parameters<typeof completeJson>[0]));
    const revision = await reorganizeLibrary(getDb(), projectId, body.baseRevisionId, organizer, {
      signal: request.signal, providerId: provider.id, model: provider.model,
    });
    return NextResponse.json({ revision }, { status: 201 });
  } catch (error) {
    const result = errorResponse(error);
    return NextResponse.json(result.body, { status: result.status });
  }
}

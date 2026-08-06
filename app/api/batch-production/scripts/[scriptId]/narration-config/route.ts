import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import { updateProjectScriptNarrationConfig } from '@/lib/batch-production/scripts';
import {
  BATCH_NO_STORE_HEADERS,
  batchRouteErrorResponse,
} from '../../../batches/response';
import { guardManagedWorkbench } from '@/app/api/managed-deployment/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 按脚本单独保存配音配置(服务商/音色/语速);快照确认时冻结这份配置。 */
export async function PUT(request: NextRequest, context: { params: Promise<{ scriptId: string }> }) {
  const managedGuard = await guardManagedWorkbench();
  if (managedGuard) return managedGuard;
  const { scriptId } = await context.params;
  const projectId = request.nextUrl.searchParams.get('projectId');
  if (!projectId) {
    return NextResponse.json({ error: 'missing_project_id', message: '缺少 projectId 参数' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  const body = await request.json().catch(() => null) as { providerId?: unknown; voice?: unknown; speed?: unknown } | null;
  const providerId = typeof body?.providerId === 'string' ? body.providerId : '';
  const voice = typeof body?.voice === 'string' ? body.voice : '';
  const speed = Number(body?.speed);
  if (!providerId || !voice || !Number.isFinite(speed)) {
    return NextResponse.json({ error: 'invalid_input', message: '配音配置需要 providerId、voice 与 speed' }, {
      status: 400,
      headers: BATCH_NO_STORE_HEADERS,
    });
  }
  try {
    await assertBatchApiReady();
    updateProjectScriptNarrationConfig(getDb(), projectId, scriptId, { providerId, voice, speed });
    return NextResponse.json({ scriptId, providerId, voice, speed }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'narration_config_save_failed', '配音配置保存失败');
  }
}

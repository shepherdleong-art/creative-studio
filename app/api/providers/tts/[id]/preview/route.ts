import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { dataRoot } from '@/lib/data-root';
import { getFinalEditTtsAdapter } from '@/lib/final-edit/adapters/tts-registry';
import { assertFinalEditTtsExecutionAvailable } from '@/lib/final-edit/runtime';
import { ProviderExecutionGateError } from '@/lib/provider-execution-gate';
import { mediaResponse } from '@/lib/final-edit/media-response';
import { guardManagedWorkbench } from '@/app/api/managed-deployment/guard';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const managedGuard = await guardManagedWorkbench();
  if (managedGuard) return managedGuard;
  try {
    const { id } = await params;
    const firstAuthorized = await assertFinalEditTtsExecutionAvailable(id);
    const adapter = getFinalEditTtsAdapter(id);
    const body = await request.json() as { voice?: string; speed?: number };
    const voice = String(body.voice || adapter.defaultVoice);
    const speed = Number(body.speed || 1);
    const key = crypto.createHash('sha256').update(JSON.stringify({
      id,
      voice,
      speed,
      text: adapter.previewText,
      baseUrl: firstAuthorized.provider.baseUrl,
      model: firstAuthorized.provider.model,
    })).digest('hex');
    const relativePath = path.join('final-edits', 'voice-previews', id, `${key}.wav`);
    const outputPath = path.join(dataRoot(), 'storage', relativePath);
    if (!fs.existsSync(outputPath)) {
      const authorized = await assertFinalEditTtsExecutionAvailable(id);
      await adapter.synthesizePreview({
        provider: authorized.provider,
        voice,
        speed,
        text: adapter.previewText,
        outputPath,
      });
    }
    return mediaResponse(request, relativePath, 'audio/wav');
  } catch (error) {
    if (error instanceof ProviderExecutionGateError) {
      const status = error.code === 'managed_workbench_locked' ? 423 : 409;
      return NextResponse.json({ error: error.code, message: error.message }, { status });
    }
    return NextResponse.json({ error: 'voice_preview_failed', message: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { getFinalEditTtsAdapter } from '@/lib/final-edit/adapters/tts-registry';
import { mediaResponse } from '@/lib/final-edit/media-response';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


async function __teamRoutePOST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const adapter = getFinalEditTtsAdapter(id);
    const body = await request.json() as { voice?: string; speed?: number };
    const voice = String(body.voice || adapter.defaultVoice);
    const speed = Number(body.speed || 1);
    const row = getDb().prepare(`SELECT id, name, type, baseUrl, apiKey, keyEnv, model, enabled FROM final_edit_tts_providers WHERE id=?`).get(id) as {
      id: string;
      name: string;
      type: string;
      baseUrl: string;
      apiKey: string;
      keyEnv: string;
      model: string;
      enabled: number;
    } | undefined;
    if (!row?.enabled) return NextResponse.json({ error: 'provider_unavailable', message: '口播配音供应商未启用' }, { status: 409 });
    const apiKey = row.apiKey.trim() || (row.keyEnv ? String(process.env[row.keyEnv] || '').trim() : '');
    if (!apiKey) return NextResponse.json({ error: 'api_key_missing', message: '口播配音 API Key 未配置' }, { status: 409 });
    const key = crypto.createHash('sha256').update(JSON.stringify({ id, voice, speed, text: adapter.previewText, model: row.model, baseUrl: row.baseUrl })).digest('hex');
    const relativePath = path.join('final-edits', 'voice-previews', id, `${key}.wav`);
    const outputPath = path.join(dataRoot(), 'storage', relativePath);
    if (!fs.existsSync(outputPath)) await adapter.synthesizePreview({
      provider: {
        providerId: row.id,
        providerName: row.name,
        providerType: row.type,
        configuredModel: row.model,
        requestModel: row.model,
        baseUrl: row.baseUrl,
        apiKey,
        model: row.model,
      },
      voice,
      speed,
      text: adapter.previewText,
      outputPath,
      execution: {
        taskId: `tts-preview:${key}`,
        step: 'preview:1',
        inputRevision: key,
        businessAttempt: { id: `tts-preview:${key}:attempt:1`, number: 1 },
        scope: { resourceType: 'tts_provider', resourceId: id },
      },
    });
    return mediaResponse(request, relativePath, 'audio/wav');
  } catch (error) {
    if (['llm_execution_deferred', 'media_resource_deferred'].includes(String((error as { code?: unknown } | null)?.code))) {
      return NextResponse.json({ error: 'voice_preview_pending', retryAfterMs: 1000 }, { status: 202 });
    }
    return NextResponse.json({ error: 'voice_preview_failed', message: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
export const POST = withTeamRoute('/api/providers/tts/[id]/preview', 'POST', __teamRoutePOST);

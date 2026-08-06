import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { getFinalEditTtsAdapter } from '@/lib/final-edit/adapters/tts-registry';
import { mediaResponse } from '@/lib/final-edit/media-response';
import { guardManagedWorkbench } from '@/app/api/managed-deployment/guard';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const managedGuard = await guardManagedWorkbench();
  if (managedGuard) return managedGuard;
  try {
    const { id } = await params;
    const adapter = getFinalEditTtsAdapter(id);
    const body = await request.json() as { voice?: string; speed?: number };
    const voice = String(body.voice || adapter.defaultVoice);
    const speed = Number(body.speed || 1);
    const row = getDb().prepare(`SELECT baseUrl, apiKey, keyEnv, model, enabled FROM final_edit_tts_providers WHERE id=?`).get(id) as { baseUrl: string; apiKey: string; keyEnv: string; model: string; enabled: number } | undefined;
    if (!row?.enabled) return NextResponse.json({ error: 'provider_unavailable', message: '口播配音供应商未启用' }, { status: 409 });
    const apiKey = row.apiKey.trim() || (row.keyEnv ? String(process.env[row.keyEnv] || '').trim() : '');
    if (!apiKey) return NextResponse.json({ error: 'api_key_missing', message: '口播配音 API Key 未配置' }, { status: 409 });
    const key = crypto.createHash('sha256').update(JSON.stringify({ id, voice, speed, text: adapter.previewText, model: row.model, baseUrl: row.baseUrl })).digest('hex');
    const relativePath = path.join('final-edits', 'voice-previews', id, `${key}.wav`);
    const outputPath = path.join(dataRoot(), 'storage', relativePath);
    if (!fs.existsSync(outputPath)) await adapter.synthesizePreview({ provider: { baseUrl: row.baseUrl, apiKey, model: row.model }, voice, speed, text: adapter.previewText, outputPath });
    return mediaResponse(request, relativePath, 'audio/wav');
  } catch (error) {
    return NextResponse.json({ error: 'voice_preview_failed', message: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

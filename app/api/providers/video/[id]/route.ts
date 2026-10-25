import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import type { VideoProviderEnvConfig } from '@/lib/video-auth';
import { describeVideoProvider } from '@/lib/video-model-capabilities';
import { getVideoProviderGatewayReadiness } from '@/lib/video-provider-schema-runtime';
import { parseVideoDuration, videoDurationError } from '@/lib/video-duration';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    const body = await request.json();
    const existing = db.prepare(`SELECT * FROM video_providers WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!existing) return NextResponse.json({ error: 'Video provider not found' }, { status: 404 });
    const durationSec = parseVideoDuration(body.defaultDurationSec === undefined ? existing.defaultDurationSec : body.defaultDurationSec);
    if (body.defaultDurationSec !== undefined || body.defaultModel !== undefined || body.type !== undefined) {
      const durationError = videoDurationError(
        String(body.type ?? existing.type ?? ''), String(body.defaultModel ?? existing.defaultModel ?? ''), durationSec,
      );
      if (durationError) return NextResponse.json({ error: durationError }, { status: 400 });
    }
    if (body.type === 'openai-video') {
      const readiness = await getVideoProviderGatewayReadiness();
      if (!readiness.available) {
        return NextResponse.json({
          error: 'video_provider_schema_unavailable',
          message: readiness.message,
        }, { status: 503 });
      }
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    for (const field of ['name', 'type', 'baseUrl', 'defaultModel'] as const) {
      if (body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(body[field]);
      }
    }
    if (body.enabled !== undefined) {
      updates.push('enabled = ?');
      values.push(body.enabled ? 1 : 0);
    }
    if (body.defaultDurationSec !== undefined) {
      updates.push('defaultDurationSec = ?');
      values.push(durationSec);
    }
    for (const secretField of ['apiKey', 'accessKey', 'secretKey'] as const) {
      if (body[secretField] !== undefined) {
        updates.push(`${secretField} = ?`);
        values.push(body[secretField]);
      }
    }
    if (updates.length === 0) return NextResponse.json({ error: 'No fields to update' }, { status: 400 });

    values.push(id);
    db.prepare(`UPDATE video_providers SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    const updated = db.prepare(`SELECT * FROM video_providers WHERE id = ?`).get(id) as Record<string, unknown>;
    return NextResponse.json(describeVideoProvider(updated as unknown as VideoProviderEnvConfig));
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    const usage = db.prepare(`SELECT COUNT(*) as count FROM video_jobs WHERE providerId = ?`).get(id) as { count: number };
    if (usage.count > 0) {
      return NextResponse.json({ error: `无法删除：有 ${usage.count} 个视频任务正在使用此供应商` }, { status: 400 });
    }

    db.prepare(`DELETE FROM video_providers WHERE id = ?`).run(id);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

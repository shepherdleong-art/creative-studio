import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { resolveVideoProviderRuntimeConfig } from '@/lib/video-auth';

function safeVideoProvider(provider: Record<string, unknown>) {
  const runtime = resolveVideoProviderRuntimeConfig(provider as never);
  return {
    id: provider.id,
    name: provider.name,
    category: 'video',
    type: provider.type,
    baseUrl: runtime.baseUrl,
    defaultModel: runtime.model,
    defaultDurationSec: runtime.durationSec,
    enabled: provider.enabled,
    configured: runtime.configured,
    missing: runtime.missing,
    hasApiKey: runtime.hasApiKey,
  };
}

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
      values.push(Number(body.defaultDurationSec) || 5);
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
    return NextResponse.json(safeVideoProvider(updated));
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

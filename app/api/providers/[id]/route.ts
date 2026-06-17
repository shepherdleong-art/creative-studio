import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { isPlaceholderValue } from '@/lib/video-auth';

function isRealKey(value: string | undefined | null): boolean {
  const s = (value || '').trim();
  return !!s && !isPlaceholderValue(s);
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();

    const provider = db.prepare(`SELECT * FROM providers WHERE id = ?`).get(id) as Record<string, unknown> | undefined;

    if (!provider) {
      return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
    }

    // Never expose apiKey
    const safe = {
      ...provider,
      category: 'image',
      configured: isRealKey(provider.apiKey as string),
      missing: isRealKey(provider.apiKey as string) ? [] : ['API Key'],
      apiKey: undefined,
      hasApiKey: isRealKey(provider.apiKey as string),
    };

    return NextResponse.json(safe);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    const body = await request.json();

    const provider = db.prepare(`SELECT * FROM providers WHERE id = ?`).get(id) as Record<string, unknown> | undefined;

    if (!provider) {
      return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    if (body.name !== undefined) {
      updates.push('name = ?');
      values.push(body.name);
    }
    if (body.baseUrl !== undefined) {
      updates.push('baseUrl = ?');
      values.push(body.baseUrl);
    }
    if (body.model !== undefined) {
      updates.push('model = ?');
      values.push(body.model);
    }
    if (body.type !== undefined) {
      updates.push('type = ?');
      values.push(body.type);
    }
    if (body.enabled !== undefined) {
      updates.push('enabled = ?');
      values.push(body.enabled ? 1 : 0);
    }
    if (body.defaultCostPerImage !== undefined) {
      updates.push('defaultCostPerImage = ?');
      values.push(body.defaultCostPerImage);
    }
    // Only update apiKey if explicitly provided (not empty string means set, empty means clear)
    if (body.apiKey !== undefined) {
      updates.push('apiKey = ?');
      values.push(body.apiKey);
    }

    if (updates.length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    values.push(id);
    db.prepare(`UPDATE providers SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare(`SELECT * FROM providers WHERE id = ?`).get(id) as Record<string, unknown>;
    const safe = {
      ...updated,
      category: 'image',
      configured: isRealKey(updated.apiKey as string),
      missing: isRealKey(updated.apiKey as string) ? [] : ['API Key'],
      apiKey: undefined,
      hasApiKey: isRealKey(updated.apiKey as string),
    };

    return NextResponse.json(safe);
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

    // Check if any projects use this provider
    const usageCount = db.prepare(`SELECT COUNT(*) as count FROM projects WHERE providerId = ?`).get(id) as { count: number };

    if (usageCount.count > 0) {
      return NextResponse.json({
        error: `无法删除：有 ${usageCount.count} 个项目正在使用此供应商`,
      }, { status: 400 });
    }

    db.prepare(`DELETE FROM providers WHERE id = ?`).run(id);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

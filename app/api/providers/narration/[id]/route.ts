import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { listNarrationProviderMeta } from '@/lib/narration-providers/store';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    const body = await request.json();
    const existing = db.prepare(`SELECT id FROM narration_providers WHERE id = ?`).get(id);
    if (!existing) return NextResponse.json({ error: 'Narration provider not found' }, { status: 404 });

    const updates: string[] = [];
    const values: unknown[] = [];

    for (const field of ['name', 'type', 'baseUrl', 'model', 'voices'] as const) {
      if (body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(body[field]);
      }
    }
    if (body.enabled !== undefined) {
      updates.push('enabled = ?');
      values.push(body.enabled ? 1 : 0);
    }
    if (body.apiKey !== undefined) {
      updates.push('apiKey = ?');
      values.push(body.apiKey);
    }
    if (updates.length === 0) return NextResponse.json({ error: 'No fields to update' }, { status: 400 });

    values.push(id);
    db.prepare(`UPDATE narration_providers SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    return NextResponse.json(listNarrationProviderMeta().find((p) => p.id === id));
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
    const row = db.prepare(`SELECT isBuiltin FROM narration_providers WHERE id = ?`).get(id) as { isBuiltin: number } | undefined;
    if (!row) return NextResponse.json({ error: 'Narration provider not found' }, { status: 404 });
    if (row.isBuiltin) return NextResponse.json({ error: '内置口播供应商不能删除，可以禁用' }, { status: 400 });

    db.prepare(`DELETE FROM narration_providers WHERE id = ?`).run(id);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

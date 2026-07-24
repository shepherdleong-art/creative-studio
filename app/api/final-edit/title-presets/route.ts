import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '@/lib/db';
import { normalizeCoverPreset } from '@/lib/final-edit/title-presets';

export async function GET() {
  const rows = getDb().prepare(`SELECT id, name, stylesByPresetJson, createdAt, updatedAt FROM final_edit_title_presets ORDER BY updatedAt DESC`).all() as Array<{ id: string; name: string; stylesByPresetJson: string; createdAt: string; updatedAt: string }>;
  return NextResponse.json(rows.map((row) => ({ id: row.id, name: row.name, ...normalizeCoverPreset(JSON.parse(row.stylesByPresetJson)), createdAt: row.createdAt, updatedAt: row.updatedAt })));
}
export async function POST(request: Request) {
  try {
    const body = await request.json() as { name?: string; version?: unknown; stylesByPreset?: unknown };
    const name = String(body.name || '').trim().slice(0, 80);
    if (!name) return NextResponse.json({ error: 'name_required' }, { status: 400 });
    const preset = normalizeCoverPreset({ version: body.version, stylesByPreset: body.stylesByPreset });
    const id = uuidv4(); const timestamp = new Date().toISOString();
    getDb().prepare(`INSERT INTO final_edit_title_presets (id, name, stylesByPresetJson, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)`).run(id, name, JSON.stringify(preset), timestamp, timestamp);
    return NextResponse.json({ id, name, ...preset, createdAt: timestamp, updatedAt: timestamp }, { status: 201 });
  } catch (error) { return NextResponse.json({ error: 'invalid_title_preset', message: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
}

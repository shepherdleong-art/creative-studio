import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { normalizeCoverPreset } from '@/lib/final-edit/title-presets';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const current = getDb().prepare(`SELECT name, stylesByPresetJson FROM final_edit_title_presets WHERE id=?`).get(id) as { name: string; stylesByPresetJson: string } | undefined;
    if (!current) return NextResponse.json({ error: 'preset_not_found' }, { status: 404 });
    const body = await request.json() as { name?: string; version?: unknown; stylesByPreset?: unknown };
    const name = body.name == null ? current.name : String(body.name).trim().slice(0, 80);
    if (!name) return NextResponse.json({ error: 'name_required' }, { status: 400 });
    const preset = body.stylesByPreset == null
      ? normalizeCoverPreset(JSON.parse(current.stylesByPresetJson))
      : normalizeCoverPreset({ version: body.version, stylesByPreset: body.stylesByPreset });
    const updatedAt = new Date().toISOString();
    getDb().prepare(`UPDATE final_edit_title_presets SET name=?, stylesByPresetJson=?, updatedAt=? WHERE id=?`).run(name, JSON.stringify(preset), updatedAt, id);
    return NextResponse.json({ id, name, ...preset, updatedAt });
  } catch (error) { return NextResponse.json({ error: 'invalid_title_preset', message: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
}
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const result = getDb().prepare(`DELETE FROM final_edit_title_presets WHERE id=?`).run((await params).id);
  return result.changes ? new NextResponse(null, { status: 204 }) : NextResponse.json({ error: 'preset_not_found' }, { status: 404 });
}

import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '@/lib/db';
import { normalizeCoverPreset } from '@/lib/final-edit/title-presets';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


async function __teamRouteGET() {
  const access = requireAccessContext();
  const visibility = access.kind === 'local' ? { sql: '', params: [] as string[] } : {
    sql: ` AND EXISTS (
      SELECT 1 FROM team_resource_scopes scope
      WHERE scope.resourceType = 'title_preset' AND scope.resourceId = final_edit_title_presets.id
        AND scope.deletedAt IS NULL AND (scope.visibility = 'public' ${access.actor.role === 'admin' ? 'OR 1 = 1' : 'OR scope.ownerUserId = ?'})
    )`,
    params: access.actor.role === 'admin' ? [] : [access.actor.userId],
  };
  const rows = getDb().prepare(`SELECT id, name, stylesByPresetJson, createdAt, updatedAt FROM final_edit_title_presets WHERE 1 = 1 ${visibility.sql} ORDER BY updatedAt DESC`).all(...visibility.params) as Array<{ id: string; name: string; stylesByPresetJson: string; createdAt: string; updatedAt: string }>;
  return NextResponse.json(rows.map((row) => ({ id: row.id, name: row.name, ...normalizeCoverPreset(JSON.parse(row.stylesByPresetJson)), createdAt: row.createdAt, updatedAt: row.updatedAt })));
}
async function __teamRoutePOST(request: Request) {
  try {
    const body = await request.json() as { name?: string; version?: unknown; stylesByPreset?: unknown };
    const name = String(body.name || '').trim().slice(0, 80);
    if (!name) return NextResponse.json({ error: 'name_required' }, { status: 400 });
    const preset = normalizeCoverPreset({ version: body.version, stylesByPreset: body.stylesByPreset });
    const id = uuidv4(); const timestamp = new Date().toISOString();
    const access = requireAccessContext();
    const db = getDb();
    const create = db.transaction(() => {
      db.prepare(`INSERT INTO final_edit_title_presets (id, name, stylesByPresetJson, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)`).run(id, name, JSON.stringify(preset), timestamp, timestamp);
      access.registerRootScope({
        resourceType: 'title_preset', resourceId: id,
        ownerUserId: access.actor.userId, visibility: 'private',
      });
    });
    create.immediate();
    return NextResponse.json({ id, name, ...preset, createdAt: timestamp, updatedAt: timestamp }, { status: 201 });
  } catch (error) { return NextResponse.json({ error: 'invalid_title_preset', message: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
}
export const GET = withTeamRoute('/api/final-edit/title-presets', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/final-edit/title-presets', 'POST', __teamRoutePOST);

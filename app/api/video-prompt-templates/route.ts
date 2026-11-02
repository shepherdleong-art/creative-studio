import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { normalizeVideoPromptTemplateInput } from '@/lib/video-prompt-template';
import { v4 as uuidv4 } from 'uuid';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';


// 内置模板排在前面（seed 维护、界面只读），自建的按创建时间跟在后面。
const LIST_SQL = `
  SELECT id, name, description, prompt, category, isBuiltin, inRandomPool, lower(openingCode) AS openingCode, createdAt
  FROM video_prompt_templates
  ORDER BY isBuiltin DESC, createdAt
`;

async function __teamRouteGET() {
  try {
    const db = getDb();
    const access = requireAccessContext();
    if (access.kind === 'local') return NextResponse.json(db.prepare(LIST_SQL).all());
    const visible = db.prepare(`
      SELECT id, name, description, prompt, category, isBuiltin, inRandomPool, lower(openingCode) AS openingCode, createdAt
      FROM video_prompt_templates
      WHERE EXISTS (
        SELECT 1 FROM team_resource_scopes scope
        WHERE scope.resourceType = 'video_prompt_template' AND scope.resourceId = video_prompt_templates.id
          AND scope.deletedAt IS NULL AND (scope.visibility = 'public' ${access.actor.role === 'admin' ? 'OR 1 = 1' : 'OR scope.ownerUserId = ?'})
      )
      ORDER BY isBuiltin DESC, createdAt
    `).all(...(access.actor.role === 'admin' ? [] : [access.actor.userId]));
    return NextResponse.json(visible);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

async function __teamRoutePOST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const normalized = normalizeVideoPromptTemplateInput(body);
    if (!normalized.ok) {
      return NextResponse.json({ error: normalized.error }, { status: 400 });
    }

    const db = getDb();
    const access = requireAccessContext();
    const ownerKey = access.kind === 'team' ? access.actor.userId : 'local';
    const { name, description, prompt, inRandomPool, openingCode = '' } = normalized.value;

    // 同名只在当前所有者的私人命名空间拦截，公开模板不阻塞员工个人模板。
    const duplicate = db.prepare(
      `SELECT id FROM video_prompt_templates WHERE name = ? AND ownerKey = ?`,
    ).get(name, ownerKey) as { id: string } | undefined;
    if (duplicate) {
      return NextResponse.json({ error: `已有同名模板「${name}」` }, { status: 409 });
    }

    if (openingCode && db.prepare('SELECT 1 FROM video_prompt_templates WHERE openingCode=? COLLATE NOCASE AND ownerKey=?').get(openingCode, ownerKey)) {
      return NextResponse.json({ error: `开头编号 ${openingCode} 已被其他模板使用` }, { status: 409 });
    }
    const id = uuidv4();
    const create = db.transaction(() => {
      db.prepare(`
        INSERT INTO video_prompt_templates
          (id, name, description, prompt, category, isBuiltin, inRandomPool, openingCode, ownerKey)
        VALUES (?, ?, ?, ?, 'camera_motion', 0, ?, ?, ?)
      `).run(id, name, description, prompt, inRandomPool ? 1 : 0, openingCode, ownerKey);
      access.registerRootScope({
        resourceType: 'video_prompt_template', resourceId: id,
        ownerUserId: access.actor.userId, visibility: 'private',
      });
    });
    create.immediate();

    const created = db.prepare(`
      SELECT id, name, description, prompt, category, isBuiltin, inRandomPool, lower(openingCode) AS openingCode, createdAt
      FROM video_prompt_templates WHERE id = ?
    `).get(id);
    return NextResponse.json({ template: created, warnings: normalized.warnings }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
export const GET = withTeamRoute('/api/video-prompt-templates', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/video-prompt-templates', 'POST', __teamRoutePOST);

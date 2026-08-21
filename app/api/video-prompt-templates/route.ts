import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { normalizeVideoPromptTemplateInput } from '@/lib/video-prompt-template';
import { v4 as uuidv4 } from 'uuid';

// 内置模板排在前面（seed 维护、界面只读），自建的按创建时间跟在后面。
const LIST_SQL = `
  SELECT id, name, description, prompt, category, isBuiltin, inRandomPool, createdAt
  FROM video_prompt_templates
  ORDER BY isBuiltin DESC, createdAt
`;

export async function GET() {
  try {
    const db = getDb();
    return NextResponse.json(db.prepare(LIST_SQL).all());
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const normalized = normalizeVideoPromptTemplateInput(body);
    if (!normalized.ok) {
      return NextResponse.json({ error: normalized.error }, { status: 400 });
    }

    const db = getDb();
    const { name, description, prompt, inRandomPool } = normalized.value;

    // 同名会让批量检查列表里的下拉完全没法分辨，直接挡掉。
    const duplicate = db.prepare(
      `SELECT id FROM video_prompt_templates WHERE name = ?`,
    ).get(name) as { id: string } | undefined;
    if (duplicate) {
      return NextResponse.json({ error: `已有同名模板「${name}」` }, { status: 409 });
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO video_prompt_templates
        (id, name, description, prompt, category, isBuiltin, inRandomPool)
      VALUES (?, ?, ?, ?, 'camera_motion', 0, ?)
    `).run(id, name, description, prompt, inRandomPool ? 1 : 0);

    const created = db.prepare(`
      SELECT id, name, description, prompt, category, isBuiltin, inRandomPool, createdAt
      FROM video_prompt_templates WHERE id = ?
    `).get(id);
    return NextResponse.json({ template: created, warnings: normalized.warnings }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

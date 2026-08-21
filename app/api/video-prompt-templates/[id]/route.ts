import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { normalizeVideoPromptTemplateInput } from '@/lib/video-prompt-template';

const SELECT_ONE = `
  SELECT id, name, description, prompt, category, isBuiltin, inRandomPool, createdAt
  FROM video_prompt_templates WHERE id = ?
`;

interface TemplateRow {
  id: string;
  name: string;
  isBuiltin: number;
}

/**
 * 改一条模板。
 *
 * 内置模板由 seed 维护、每次启动都会被写回官方措辞，所以界面上是只读的——
 * 想改先「复制一份」。唯一的例外是 inRandomPool：它不在 seed 的 upsert 列里，
 * 用户对内置模板的入池选择能安全地存活到下次播种，因此允许单独改。
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const db = getDb();
    const row = db.prepare(`SELECT id, name, isBuiltin FROM video_prompt_templates WHERE id = ?`)
      .get(id) as TemplateRow | undefined;
    if (!row) return NextResponse.json({ error: '模板不存在' }, { status: 404 });

    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: '请求内容不是有效对象' }, { status: 400 });

    const touchesContent = ['name', 'description', 'prompt']
      .some((key) => body[key] !== undefined);

    if (row.isBuiltin === 1) {
      if (touchesContent) {
        return NextResponse.json(
          { error: '内置模板不可编辑，请先「复制一份」再改' },
          { status: 400 },
        );
      }
      db.prepare(`UPDATE video_prompt_templates SET inRandomPool = ? WHERE id = ?`)
        .run(body.inRandomPool ? 1 : 0, id);
      return NextResponse.json({ template: db.prepare(SELECT_ONE).get(id), warnings: [] });
    }

    // 只翻开关、不动内容时不必跑内容校验，否则前端得把全部字段回传一遍。
    if (!touchesContent) {
      db.prepare(`UPDATE video_prompt_templates SET inRandomPool = ? WHERE id = ?`)
        .run(body.inRandomPool ? 1 : 0, id);
      return NextResponse.json({ template: db.prepare(SELECT_ONE).get(id), warnings: [] });
    }

    const normalized = normalizeVideoPromptTemplateInput(body);
    if (!normalized.ok) {
      return NextResponse.json({ error: normalized.error }, { status: 400 });
    }
    const { name, description, prompt, inRandomPool } = normalized.value;

    const duplicate = db.prepare(
      `SELECT id FROM video_prompt_templates WHERE name = ? AND id != ?`,
    ).get(name, id) as { id: string } | undefined;
    if (duplicate) {
      return NextResponse.json({ error: `已有同名模板「${name}」` }, { status: 409 });
    }

    db.prepare(`
      UPDATE video_prompt_templates
      SET name = ?, description = ?, prompt = ?, inRandomPool = ?
      WHERE id = ?
    `).run(name, description, prompt, inRandomPool ? 1 : 0, id);

    return NextResponse.json({
      template: db.prepare(SELECT_ONE).get(id),
      warnings: normalized.warnings,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * 删一条自建模板。
 *
 * 内置的删不掉——下次启动 seed 会原样补回来，删了只是制造困惑。
 * 已被视频任务引用的也删不掉：video_jobs.templateId 是外键，那条模板是那些
 * 视频的出处，删掉历史记录就断了。两种情况都给出能照着做的说明。
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const db = getDb();
    const row = db.prepare(`SELECT id, name, isBuiltin FROM video_prompt_templates WHERE id = ?`)
      .get(id) as TemplateRow | undefined;
    if (!row) return NextResponse.json({ error: '模板不存在' }, { status: 404 });

    if (row.isBuiltin === 1) {
      return NextResponse.json(
        { error: '内置模板不能删除。不想让它参与随机填充的话，关掉「参与随机」开关即可。' },
        { status: 400 },
      );
    }

    const used = db.prepare(`SELECT COUNT(*) AS count FROM video_jobs WHERE templateId = ?`)
      .get(id) as { count: number };
    if (used.count > 0) {
      return NextResponse.json(
        {
          error: `模板「${row.name}」已被 ${used.count} 个视频任务引用，删除会让那些任务失去出处。`
            + '可以先关掉「参与随机」开关，它就不会再被自动填进新片段。',
        },
        { status: 409 },
      );
    }

    db.prepare(`DELETE FROM video_prompt_templates WHERE id = ?`).run(id);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

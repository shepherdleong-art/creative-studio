import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import path from 'path';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();

    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Get images with computed imageUrl
    const images = (db.prepare(
      `SELECT * FROM image_assets WHERE projectId = ? ORDER BY role, createdAt`
    ).all(id) as Array<Record<string, unknown>>).map((img) => {
      const filePath = img.path as string;
      const storageRoot = path.resolve(path.join(process.cwd(), 'storage'));
      const resolvedFile = path.resolve(filePath);
      const relativePath = path.relative(storageRoot, resolvedFile).split(path.sep).join('/');
      return {
        ...img,
        relativePath,
        imageUrl: `/api/images/${relativePath}`,
      };
    });

    // Get jobs with input filenames
    const jobs = db.prepare(`
      SELECT j.*, ia.filename as inputFilename, oa.filename as outputFilename
      FROM jobs j
      LEFT JOIN image_assets ia ON j.inputImageId = ia.id
      LEFT JOIN image_assets oa ON j.outputImageId = oa.id
      WHERE j.projectId = ?
      ORDER BY j.id
    `).all(id);

    // Get provider info
    const provider = db.prepare(`SELECT * FROM providers WHERE id = ?`).get(project.providerId as string) as Record<string, unknown> | undefined;

    return NextResponse.json({
      ...project,
      images,
      jobs,
      provider: provider ? {
        ...provider,
        apiKeyEnv: undefined,
        apiKey: undefined,
        hasApiKey: !!(provider.apiKey as string) || !!process.env[provider.apiKeyEnv as string],
      } : null,
    });
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
    db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const updates: string[] = [];
    const values: unknown[] = [];

    if (typeof body.shotPrompt === 'string') { updates.push('shotPrompt = ?'); values.push(body.shotPrompt.trim()); }
    if (typeof body.targetAudience === 'string') { updates.push('targetAudience = ?'); values.push(body.targetAudience); }
    if (typeof body.scriptTone === 'string') { updates.push('scriptTone = ?'); values.push(body.scriptTone); }
    if (typeof body.scriptPlatform === 'string') { updates.push('scriptPlatform = ?'); values.push(body.scriptPlatform); }
    if (typeof body.sellingPointsJson === 'string') { updates.push('sellingPointsJson = ?'); values.push(body.sellingPointsJson); }

    if (updates.length === 0) return NextResponse.json({ error: 'No fields to update' }, { status: 400 });

    values.push(id);
    const result = db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    if (result.changes !== 1) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

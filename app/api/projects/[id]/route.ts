import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import path from 'path';
import fs from 'fs';
import { dataRoot } from '@/lib/data-root';
import { parseProjectInfoUpdate, ProjectInfoValidationError } from '@/lib/project-info';
import { sortProjectJobsByCreation, type ProjectJobOrderRow } from '@/lib/project-job-order';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();

    const projectExists = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(id);
    if (!projectExists) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }
    db.prepare(`
      UPDATE projects
      SET lastOpenedAt = datetime('now')
      WHERE id = ? AND (lastOpenedAt IS NULL OR lastOpenedAt < datetime('now', '-60 seconds'))
    `).run(id);
    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Record<string, unknown>;

    // Get images with computed imageUrl
    const images = (db.prepare(
      `SELECT * FROM image_assets WHERE projectId = ? ORDER BY role, createdAt`
    ).all(id) as Array<Record<string, unknown>>).map((img) => {
      const filePath = img.path as string;
      const storageRoot = path.resolve(path.join(dataRoot(), 'storage'));
      const resolvedFile = path.resolve(filePath);
      const relativePath = path.relative(storageRoot, resolvedFile).split(path.sep).join('/');
      return {
        ...img,
        relativePath,
        imageUrl: `/api/images/${relativePath}`,
      };
    });

    // Get jobs with input filenames。排序交给共享纯函数（lib/project-job-order.ts）：
    // 最新创建批次在前、批内按提交顺序、历史行按旧时间列回退；creationSequence
    // 是 rowid 的历史兼容投影，不是任务身份。UUID 与状态一律不参与排序。
    const jobs = sortProjectJobsByCreation(db.prepare(`
      SELECT j.*, ia.filename as inputFilename, oa.filename as outputFilename, j.rowid AS creationSequence
      FROM jobs j
      LEFT JOIN image_assets ia ON j.inputImageId = ia.id
      LEFT JOIN image_assets oa ON j.outputImageId = oa.id
      WHERE j.projectId = ?
    `).all(id) as Array<ProjectJobOrderRow & Record<string, unknown>>);

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
        hasApiKey: !!(provider.apiKey as string),
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

    const assetRows = db.prepare(`
      SELECT id, path, originalPath, processedPath
      FROM image_assets
      WHERE projectId = ?
    `).all(id) as Array<{
      id: string;
      path: string;
      originalPath: string | null;
      processedPath: string | null;
    }>;

    const deleteProject = db.transaction(() => {
      const result = db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
      if (result.changes !== 1) return result.changes;
      if (assetRows.length > 0) {
        const deleteAsset = db.prepare(`DELETE FROM image_assets WHERE id = ?`);
        for (const asset of assetRows) deleteAsset.run(asset.id);
      }
      return result.changes;
    });

    const deletedCount = deleteProject();
    if (deletedCount !== 1) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const pathsToDelete = new Set<string>();
    for (const asset of assetRows) {
      for (const filePath of [asset.path, asset.originalPath, asset.processedPath]) {
        if (typeof filePath === 'string' && filePath.length > 0) pathsToDelete.add(filePath);
      }
    }

    for (const filePath of pathsToDelete) {
      try {
        fs.unlinkSync(filePath);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT') {
          console.error(`[DELETE /api/projects] Failed to unlink ${filePath}:`, err);
        }
      }
    }

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

    const projectInfoUpdate = parseProjectInfoUpdate(body);
    for (const key of ['name', 'productName', 'productCode', 'productCategory'] as const) {
      const value = projectInfoUpdate[key];
      if (value !== undefined) {
        updates.push(`${key} = ?`);
        values.push(value);
      }
    }

    if (typeof body.shotPrompt === 'string') { updates.push('shotPrompt = ?'); values.push(body.shotPrompt.trim()); }
    if (typeof body.targetAudience === 'string') { updates.push('targetAudience = ?'); values.push(body.targetAudience); }
    if (typeof body.scriptTone === 'string') { updates.push('scriptTone = ?'); values.push(body.scriptTone); }
    if (typeof body.scriptPlatform === 'string') { updates.push('scriptPlatform = ?'); values.push(body.scriptPlatform); }
    if (typeof body.sellingPointsJson === 'string') { updates.push('sellingPointsJson = ?'); values.push(body.sellingPointsJson); }
    if (typeof body.sellingPointAnalysisJson === 'string') { updates.push('sellingPointAnalysisJson = ?'); values.push(body.sellingPointAnalysisJson); }
    if (Number.isFinite(Number(body.videoConcurrency))) {
      updates.push('videoConcurrency = ?');
      values.push(Math.max(1, Math.min(10, Math.floor(Number(body.videoConcurrency)))));
    }

    if (updates.length === 0) return NextResponse.json({ error: 'No fields to update' }, { status: 400 });

    values.push(id);
    const result = db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    if (result.changes !== 1) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    const responseShotPrompt = typeof body.shotPrompt === 'string' ? body.shotPrompt.trim() : '';
    const updatedProjectRow = db.prepare(`
      SELECT id, name, productName, productCode, productCategory FROM projects WHERE id = ?
    `).get(id) as {
      id: string;
      name: string;
      productName: string | null;
      productCode: string | null;
      productCategory: string | null;
    } | undefined;
    if (!updatedProjectRow) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    const updatedProject = {
      id: updatedProjectRow.id,
      name: updatedProjectRow.name,
      productName: updatedProjectRow.productName || '',
      productCode: updatedProjectRow.productCode || '',
      productCategory: updatedProjectRow.productCategory || '',
    };

    return NextResponse.json({ success: true, shotPrompt: responseShotPrompt, project: updatedProject });
  } catch (err) {
    if (err instanceof ProjectInfoValidationError) {
      return NextResponse.json({ error: 'invalid_project_info', message: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

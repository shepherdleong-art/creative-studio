import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import path from 'path';
import fs from 'fs';
import { dataRoot } from '@/lib/data-root';
import { parseProjectInfoUpdate, ProjectInfoValidationError } from '@/lib/project-info';
import {
  parseProductionIdentityUpdate,
  parseProductionIdentityInput,
  buildProjectBaseName,
  resolveUniqueProjectBaseName,
  readProductionIdentityFields,
  deriveProjectNamingDate,
  projectHasProductionIdentity,
  ENABLE_NEW_EXPORT_IDENTITY_KEY,
} from '@/lib/project-production-identity';
import { hasExportIdentity, createExportIdentity, activateNewExportIdentity } from '@/lib/project-export-identity';
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

    const project = db.prepare(`
      SELECT id, name, productName, productCode, productCategory, createdAt,
        storeCode, productSubmodel, productionType, editorName, namingDate
      FROM projects WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    // ── 生产身份更新：PATCH 只接收领域字段，项目名由服务端重新生成 ──
    const identityUpdate = parseProductionIdentityUpdate(body);
    if (Object.keys(identityUpdate).length > 0) {
      const frozen = hasExportIdentity(db, id);
      const namingDate = deriveProjectNamingDate({
        namingDate: typeof project.namingDate === 'string' ? project.namingDate : '',
        createdAt: typeof project.createdAt === 'string' ? project.createdAt : null,
      });

      if (frozen) {
        // 已有正式导出产物：普通编辑不得静默改变导出身份，必须显式确认「启用新的导出名称」。
        if (body[ENABLE_NEW_EXPORT_IDENTITY_KEY] !== true) {
          return NextResponse.json({
            error: 'export_identity_frozen',
            message: '项目已有正式导出产物，修改店铺/型号/生产类型/剪辑师将启用新的导出名称；如需继续请显式确认',
            requiresConfirmation: true,
          }, { status: 409 });
        }
        const full = parseProductionIdentityInput({ ...readProductionIdentityFields(project), ...identityUpdate });
        activateNewExportIdentity(db, { projectId: id, identity: { ...full, namingDate } });
        for (const key of ['storeCode', 'productCode', 'productSubmodel', 'productionType', 'editorName'] as const) {
          updates.push(`${key} = ?`);
          values.push(full[key]);
        }
      } else {
        const full = parseProductionIdentityInput({ ...readProductionIdentityFields(project), ...identityUpdate });
        const historicalCompletion = !projectHasProductionIdentity(project);
        if (historicalCompletion && namingDate) {
          // 历史项目补齐身份：日期取原 createdAt（上海时区），并冻结第一版导出身份。
          createExportIdentity(db, { projectId: id, identity: { ...full, namingDate } });
        } else {
          // 新建项目（尚未正式导出）：只更新字段并重新生成唯一名称。
          const baseName = resolveUniqueProjectBaseName(db, buildProjectBaseName({ ...full, namingDate }), id);
          updates.push('name = ?');
          values.push(baseName);
        }
        for (const key of ['storeCode', 'productCode', 'productSubmodel', 'productionType', 'editorName'] as const) {
          updates.push(`${key} = ?`);
          values.push(full[key]);
        }
        updates.push('namingDate = ?');
        values.push(namingDate);
      }
    }

    // ── 旧项目兼容字段：productName / productCategory 保留给历史数据，项目名由服务端生成 ──
    const legacyUpdate = parseProjectInfoUpdate(body);
    for (const key of ['productName', 'productCategory'] as const) {
      const value = legacyUpdate[key];
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

    if (updates.length > 0) {
      values.push(id);
      const result = db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      if (result.changes !== 1) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const responseShotPrompt = typeof body.shotPrompt === 'string' ? body.shotPrompt.trim() : '';
    const updatedProjectRow = db.prepare(`
      SELECT id, name, productName, productCode, productCategory, storeCode, productSubmodel, productionType, editorName, namingDate FROM projects WHERE id = ?
    `).get(id) as {
      id: string;
      name: string;
      productName: string | null;
      productCode: string | null;
      productCategory: string | null;
      storeCode: string | null;
      productSubmodel: string | null;
      productionType: string | null;
      editorName: string | null;
      namingDate: string | null;
    } | undefined;
    if (!updatedProjectRow) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    const updatedProject = {
      id: updatedProjectRow.id,
      name: updatedProjectRow.name,
      productName: updatedProjectRow.productName || '',
      productCode: updatedProjectRow.productCode || '',
      productCategory: updatedProjectRow.productCategory || '',
      storeCode: updatedProjectRow.storeCode || '',
      productSubmodel: updatedProjectRow.productSubmodel || '',
      productionType: updatedProjectRow.productionType || '',
      editorName: updatedProjectRow.editorName || '',
      namingDate: updatedProjectRow.namingDate || '',
      hasExportIdentity: hasExportIdentity(db, id),
    };

    return NextResponse.json({ success: true, shotPrompt: responseShotPrompt, project: updatedProject });
  } catch (err) {
    if (err instanceof ProjectInfoValidationError) {
      return NextResponse.json({ error: 'invalid_project_info', message: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

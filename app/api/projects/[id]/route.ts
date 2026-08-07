import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import path from 'path';
import fs from 'fs';
import { dataRoot } from '@/lib/data-root';
import { parseProjectInfoUpdate, ProjectInfoValidationError } from '@/lib/project-info';
import { guardManagedWorkbench } from '@/app/api/managed-deployment/guard';
import { isManagedDeployment } from '@/lib/managed-deployment';
import { filterManagedProviders, loadManagedProviderAllowlist } from '@/lib/managed-provider-policy';

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

    // A retained legacy project may still point at a historical provider row.
    // In managed mode reject before loading jobs/assets or returning any
    // provider/model metadata; never substitute a different provider.
    const providerIdentity = db.prepare(`
      SELECT id, type, baseUrl, apiKeyEnv FROM providers WHERE id = ?
    `).get(project.providerId as string) as {
      id: string;
      type: string;
      baseUrl: string;
      apiKeyEnv: string;
    } | undefined;
    const managed = isManagedDeployment();
    const managedAllowlist = managed ? loadManagedProviderAllowlist() : null;
    if (managed
      && (!providerIdentity || filterManagedProviders('image', [providerIdentity], managedAllowlist).length !== 1)) {
      return NextResponse.json(
        {
          error: 'managed_provider_not_allowed',
          code: 'managed_provider_not_allowed',
          message: '该供应商不在公司受管配置中',
        },
        { status: 403, headers: { 'Cache-Control': 'no-store' } },
      );
    }

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

    // Get jobs with input filenames
    const rawJobs = db.prepare(`
      SELECT j.*, ia.filename as inputFilename, oa.filename as outputFilename
      FROM jobs j
      LEFT JOIN image_assets ia ON j.inputImageId = ia.id
      LEFT JOIN image_assets oa ON j.outputImageId = oa.id
      WHERE j.projectId = ?
      ORDER BY j.id
    `).all(id) as Array<Record<string, unknown>>;
    const jobs = managed
      ? (() => {
        const providerRows = db.prepare(`
          SELECT id, type, baseUrl, apiKeyEnv FROM providers
        `).all() as Array<{ id: string; type: string; baseUrl: string; apiKeyEnv: string }>;
        const allowedProviderIds = new Set(
          filterManagedProviders('image', providerRows, managedAllowlist).map((item) => item.id),
        );
        return rawJobs.map((job) => {
          const providerId = typeof job.providerId === 'string' ? job.providerId : '';
          if (!providerId || allowedProviderIds.has(providerId)) return job;
          return {
            ...job,
            providerId: undefined,
            providerTaskId: undefined,
            remoteImageUrl: undefined,
            model: undefined,
            providerRawResponse: undefined,
            providerStatus: 'managed_provider_not_allowed',
          };
        });
      })()
      : rawJobs;

    // Only an allowed provider reaches the full read used by the legacy
    // unrestricted response shape.
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
  const managedGuard = await guardManagedWorkbench();
  if (managedGuard) return managedGuard;
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
  const managedGuard = await guardManagedWorkbench();
  if (managedGuard) return managedGuard;
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

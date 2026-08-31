import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  assertScriptStudioApiReady,
  errorResponse,
  jsonOrNull,
  unavailableResponse,
} from '@/lib/script-studio/http';
import {
  createOrFindSourceSet,
  getSourceSet,
  loadSourceSetImageRows,
} from '@/lib/script-studio/source-sets';
import { getCurrentLibraryRevision } from '@/lib/script-studio/libraries';
import { ScriptStudioError } from '@/lib/script-studio/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await assertScriptStudioApiReady();
    const { id: projectId } = await params;
    const sourceSetId = new URL(request.url).searchParams.get('sourceSetId');
    const db = getDb();
    if (sourceSetId) {
      const sourceSet = getSourceSet(db, projectId, sourceSetId);
      if (!sourceSet) throw new ScriptStudioError('not_found', '详情页来源集不存在');
      return NextResponse.json({ sourceSet });
    }
    const rows = db.prepare(`
      SELECT id, projectId, contentFingerprint, imageAssetIdsJson, createdAt
      FROM script_studio_source_sets WHERE projectId = ?
      ORDER BY createdAt DESC LIMIT 100
    `).all(projectId);
    return NextResponse.json({ sourceSets: rows });
  } catch (error) {
    return NextResponse.json(errorResponse(error).body, { status: errorResponse(error).status });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await assertScriptStudioApiReady();
    const { id: projectId } = await params;
    const body = await jsonOrNull(request);
    const imageAssetIds = Array.isArray(body?.imageAssetIds)
      ? body!.imageAssetIds.map(String).filter(Boolean)
      : [];
    if (imageAssetIds.length === 0) {
      throw new ScriptStudioError('invalid_input', '请至少选择一张详情页图片');
    }
    const db = getDb();
    const project = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(projectId);
    if (!project) throw new ScriptStudioError('not_found', '项目不存在');
    const rows = loadSourceSetImageRows(db, projectId, imageAssetIds);
    if (rows.length !== imageAssetIds.length) {
      throw new ScriptStudioError('invalid_input', '存在不属于当前项目的详情页图片或图片不存在');
    }
    const result = createOrFindSourceSet(db, projectId, imageAssetIds);
    const currentLibrary = getCurrentLibraryRevision(db, projectId);
    return NextResponse.json({
      ...result,
      matchesCurrentLibrary: currentLibrary?.sourceFingerprint === result.contentFingerprint,
      currentLibraryRevisionId: currentLibrary?.id || null,
    });
  } catch (error) {
    return NextResponse.json(errorResponse(error).body, { status: errorResponse(error).status });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertScriptStudioApiReady, errorResponse, jsonOrNull } from '@/lib/script-studio/http';
import { getCurrentLibraryRevision, getLibraryRevision } from '@/lib/script-studio/libraries';
import { isSellingPointEvidenceUsable } from '@/lib/script-studio/selling-point-normalize';
import { recommendViralTemplates } from '@/lib/script-studio/viral-templates';

export const runtime = 'nodejs';

/**
 * 爆文模板本地推荐（迁移方案 §3.1）：同类目优先，其次子类目与卖点关键词匹配；
 * 排序稳定、原因真实，不返回人群标签/转化率等杜撰指标。
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await assertScriptStudioApiReady();
    const { id: projectId } = await context.params;
    const body = await jsonOrNull(request);
    const db = getDb();
    const libraryRevisionId = typeof body?.libraryRevisionId === 'string' ? body.libraryRevisionId : '';
    const libraryRevision = libraryRevisionId
      ? getLibraryRevision(db, projectId, libraryRevisionId)
      : getCurrentLibraryRevision(db, projectId);
    if (!libraryRevision) {
      return NextResponse.json({ error: 'not_found', message: '当前项目没有可用的卖点库，请先从详情页提取卖点' }, { status: 404 });
    }
    const sellingPointTexts = libraryRevision.sellingPoints
      .filter(isSellingPointEvidenceUsable)
      .map((point) => [point.title, point.factText].filter(Boolean).join(' '))
      .filter(Boolean);
    const result = recommendViralTemplates(db, {
      sellingPointTexts,
      productCategory: libraryRevision.category,
      expandBeyondCategory: body?.expandBeyondCategory === true,
      ...(typeof body?.limit === 'number' ? { limit: body.limit } : {}),
    });
    return NextResponse.json({
      libraryRevisionId: libraryRevision.id,
      ...result,
    });
  } catch (error) {
    const { status, body } = errorResponse(error);
    return NextResponse.json(body, { status });
  }
}

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertScriptStudioApiReady, errorResponse } from '@/lib/script-studio/http';
import {
  findCatalog,
  getCatalogCurrentRevisionId,
  listCatalogRevisions,
  getCatalogRevisionView,
} from '@/lib/script-studio/catalogs';

export const runtime = 'nodejs';

export async function GET() {
  try {
    await assertScriptStudioApiReady();
    const db = getDb();
    const kinds = ['strategy', 'template'] as const;
    const catalogs = kinds.map((kind) => {
      const catalog = findCatalog(db, kind);
      // 尚未导入时仍返回空条目，让设置页渲染空状态（“尚未导入 + 上传按钮”）
      if (!catalog) {
        return {
          id: '',
          kind,
          currentRevisionId: null,
          createdAt: '',
          updatedAt: '',
          current: null,
          revisions: [],
        };
      }
      const currentId = getCatalogCurrentRevisionId(db, kind);
      const revisions = listCatalogRevisions(db, catalog.id);
      const current = currentId ? getCatalogRevisionView(db, currentId) : null;
      // 版本状态摘要（方案 §6.3：设置页显示有效/草稿/冲突数量及具体行号）。
      const revisionStatus = (view: NonNullable<typeof current>): Record<string, unknown> => {
        if (view.kind === 'strategy') {
          const conflict = view.strategyEntries.filter((entry) => entry.status === 'conflict');
          return {
            strategyStatus: {
              active: view.strategyEntries.filter((entry) => entry.status === 'active').length,
              conflict: conflict.length,
              conflictRows: conflict.flatMap((entry) => entry.sourceRows),
            },
          };
        }
        const draftInvalid = view.visualHookTemplates.filter((hook) => hook.status === 'draft_invalid');
        return {
          templateStatus: {
            framework: view.frameworkTemplates.length,
            copyHook: view.copyHookTemplates.length,
            visualHook: view.visualHookTemplates.length,
            draftInvalid: draftInvalid.length,
            draftRows: draftInvalid.map((hook) => hook.sourceRow),
            assetCount: view.visualHookTemplates.reduce((sum, hook) => sum + (hook.assetIds?.length ?? 0), 0),
          },
        };
      };
      return {
        id: catalog.id,
        kind,
        currentRevisionId: catalog.currentRevisionId,
        createdAt: catalog.createdAt,
        updatedAt: catalog.updatedAt,
        current: current ? {
          id: current.id,
          revisionNumber: current.revisionNumber,
          sourceFilename: current.sourceFilename,
          importReport: current.importReport,
          createdAt: current.createdAt,
          strategyEntryCount: current.strategyEntries.length,
          frameworkCount: current.frameworkTemplates.length,
          copyHookCount: current.copyHookTemplates.length,
          visualHookCount: current.visualHookTemplates.length,
          ...revisionStatus(current),
        } : null,
        revisions: revisions.map((revision) => {
          const view = getCatalogRevisionView(db, revision.id);
          return {
            id: revision.id,
            revisionNumber: revision.revisionNumber,
            sourceFilename: revision.sourceFilename,
            createdAt: revision.createdAt,
            current: revision.current,
            ...(view ? revisionStatus(view) : {}),
          };
        }),
      };
    });
    return NextResponse.json({ catalogs });
  } catch (error) {
    const { status, body } = errorResponse(error);
    return NextResponse.json(body, { status });
  }
}

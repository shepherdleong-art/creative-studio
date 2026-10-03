import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { getDb } from '@/lib/db';
import { ScriptStudioError } from '@/lib/script-studio/errors';
import { assertScriptStudioApiReady, errorResponse, jsonOrNull } from '@/lib/script-studio/http';
import type { ScriptStudioScriptContent } from '@/lib/script-studio/types';
import { getLibraryRevision, getCurrentLibraryRevision } from '@/lib/script-studio/libraries';
import { getProjectScript } from '@/lib/script-studio/scripts';
import { createTask, getTaskByRequestKey } from '@/lib/script-studio/tasks';
import { resolveKnowledgeContext, serializeKnowledgeContext } from '@/lib/script-studio/knowledge-context';
import { toTaskSnapshot } from '@/lib/script-studio/snapshot';
import { resolveRuntimeProviders } from '@/lib/script-studio/runtime';
import { templatePlanFingerprint } from '@/lib/script-studio/template-rewrite';
import type { FrozenViralTemplateSpec } from '@/lib/script-studio/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; scriptId: string }> },
) {
  try {
    await assertScriptStudioApiReady();
    const { id: projectId, scriptId } = await params;
    const db = getDb();
    const script = getProjectScript(db, projectId, scriptId);
    if (!script) throw new ScriptStudioError('not_found', '项目脚本不存在');
    const priorContent = JSON.parse(script.currentRevision?.contentJson || '{}') as Partial<ScriptStudioScriptContent>;
    const pain = priorContent.productionMode === 'pain_solving_15s' ? priorContent.painSolving : undefined;
    // 爆文模板改写脚本：从内容快照重建该模板的冻结计划（含完整参考文案），
    // 再生成一版仍绑定原模板与原卖点库修订，不读当前模板库。
    const rewrite = priorContent.productionMode === 'template_rewrite' ? priorContent.templateRewrite : undefined;
    const rewriteTemplatePlan = rewrite
      ? {
          templates: [{
            entryId: rewrite.entryId,
            revisionId: rewrite.revisionId,
            sourceTemplateId: rewrite.sourceTemplateId,
            name: rewrite.templateName,
            title: rewrite.templateTitle,
            category: rewrite.category,
            subCategory: rewrite.subCategory,
            refText: rewrite.refText,
            structure: rewrite.structure,
            structureOrigin: rewrite.structureOrigin,
            contentHash: rewrite.contentHash,
          }] satisfies FrozenViralTemplateSpec[],
        }
      : undefined;
    const rewritePlan = rewriteTemplatePlan
      ? { ...rewriteTemplatePlan, fingerprint: templatePlanFingerprint(rewriteTemplatePlan.templates) }
      : undefined;
    const library = (pain || rewrite) && script.currentRevision?.libraryRevisionId
      ? getLibraryRevision(db, projectId, script.currentRevision.libraryRevisionId)
      : getCurrentLibraryRevision(db, projectId);
    if (!library) throw new ScriptStudioError('not_found', '当前项目没有可复用的卖点库');
    const body = await jsonOrNull(request) ?? {};
    const requestedProviderId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
    const providers = resolveRuntimeProviders(requestedProviderId);
    const modeSuffix = pain ? `|${script.currentRevisionId}|pain_solving_15s` : rewrite ? `|${script.currentRevisionId}|template_rewrite|${rewritePlan!.fingerprint}` : '';
    const requestKey = `regenerate:${scriptId}:${createHash('sha256').update(`${projectId}|${library.id}|${providers.text.id}|${providers.text.model}${modeSuffix}`).digest('hex')}`;
    const existing = getTaskByRequestKey(db, projectId, requestKey);
    if (existing) return NextResponse.json({ task: toTaskSnapshot(existing), created: false }, { status: 202 });
    const { ensureScriptStudioSchedulerStarted } = await import('@/lib/script-studio/bootstrap');
    try {
      await ensureScriptStudioSchedulerStarted();
    } catch {
      // 调度器不可用时仍保存 queued 任务，等待下次启动恢复。
    }
    const currentDuration = script.currentRevision?.targetDurationSec || 15;
    const identity = db.prepare('SELECT productCode, productSubmodel FROM projects WHERE id = ?').get(projectId) as { productCode: string; productSubmodel: string };
    const knowledgeContext = resolveKnowledgeContext(db, {
      modelKey: identity.productCode || '',
      submodel: identity.productSubmodel || '',
      requestedCount: 1,
      pointTypes: library.sellingPoints.filter((point) => point.usable && !point.disabledByUser && point.evidenceGate !== 'failed').map((point) => point.pointType),
    });
    const created = createTask(db, {
      projectId,
      requestKey,
      mode: 'reuse',
      libraryRevisionId: library.id,
      inputSnapshot: {
        targetDurationSec: currentDuration,
        requestedCount: 1,
        creativeBrief: pain ? priorContent.creativeBrief || '' : '',
        ...(pain ? { productionMode: 'pain_solving_15s', painRetryOpportunities: [pain] } : {}),
        ...(rewrite ? { productionMode: 'template_rewrite', templatePlan: rewritePlan } : {}),
        targetScriptId: scriptId,
        knowledgeContext: serializeKnowledgeContext(knowledgeContext),
        providerId: providers.text.id,
        providerModel: providers.text.model,
      },
      requestedCount: 1,
    });
    return NextResponse.json({ task: toTaskSnapshot(created.task), created: created.created }, { status: 202 });
  } catch (error) {
    const result = errorResponse(error);
    return NextResponse.json(result.body, { status: result.status });
  }
}

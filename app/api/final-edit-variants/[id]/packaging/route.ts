import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '@/lib/db';
import { FinalEditError } from '@/lib/final-edit/errors';
import { finalEditErrorResponse } from '@/lib/final-edit/http';
import { previewPackagingVars, resolvePackagingDir, resolvePackagingTemplateDir, type FinalEditPackagingSnapshot } from '@/lib/final-edit/packaging';
import { PACKAGING_TEMPLATE_IDS, sanitizePackagingVarsOverrides, type PackagingVars } from '@/lib/final-edit/packaging-vars';
import { wakeFinalEditWorker } from '@/lib/final-edit/worker';

/** 包装文案覆盖层白名单：只收 v2 模板键的字符串（空串=隐藏元素），超长截断。 */
function sanitizeVarsOverrides(input: unknown): Partial<PackagingVars> | undefined {
  const sanitized = sanitizePackagingVarsOverrides(input);
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

/** 模板标识校验：v2 四套 + v1 遗留 overlay-basic（兼容旧任务重跑）。 */
function resolveTemplateId(input: unknown): string | undefined {
  if (typeof input !== 'string' || !input.trim()) return undefined;
  const name = input.trim();
  if (![...PACKAGING_TEMPLATE_IDS, 'overlay-basic'].includes(name)) throw new FinalEditError('packaging_template_invalid', '包装模板标识无效', 400);
  return name;
}

function resolveRenderJob(variantId: string, renderJobId?: string): { id: string } {
  const db = getDb();
  if (renderJobId) {
    const row = db.prepare(`SELECT id, variantId FROM final_edit_jobs WHERE id=? AND kind='render' AND status='succeeded'`).get(renderJobId) as { id: string; variantId: string | null } | undefined;
    if (!row) throw new FinalEditError('render_required', '指定的渲染任务不存在或尚未成功', 409);
    if (row.variantId !== variantId) throw new FinalEditError('render_job_mismatch', '渲染任务不属于当前成片草稿', 409);
    return row;
  }
  const latest = db.prepare(`SELECT id FROM final_edit_jobs WHERE variantId=? AND kind='render' AND status='succeeded' ORDER BY createdAt DESC LIMIT 1`).get(variantId) as { id: string } | undefined;
  if (!latest) throw new FinalEditError('render_required', '请先完成一次导出渲染，再使用包装', 409);
  return latest;
}

/** 创建包装任务（幂等：同一渲染任务已有排队/运行中的包装任务则复用）。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: variantId } = await params;
    const body = await request.json().catch(() => ({})) as { renderJobId?: string; template?: unknown; varsOverrides?: unknown };
    const db = getDb();
    const variant = db.prepare(`SELECT v.id, v.groupId, g.projectId FROM final_edit_variants v JOIN final_edit_groups g ON g.id=v.groupId WHERE v.id=?`).get(variantId) as { id: string; groupId: string; projectId: string } | undefined;
    if (!variant) throw new FinalEditError('variant_not_found', '成片草稿不存在', 404);
    const renderJob = resolveRenderJob(variantId, body.renderJobId);
    const template = resolveTemplateId(body.template);
    if (template) resolvePackagingTemplateDir(resolvePackagingDir(), template);
    const varsOverrides = sanitizeVarsOverrides(body.varsOverrides);
    const existing = db.prepare(`SELECT id, status FROM final_edit_jobs WHERE kind='packaging' AND status IN ('queued','running') AND json_extract(inputSnapshotJson, '$.renderJobId')=? LIMIT 1`).get(renderJob.id) as { id: string; status: string } | undefined;
    if (existing) {
      // 复用 queued 任务时必须补唤醒：worker 可能空闲或刚重启（恢复的任务不会自启）。
      wakeFinalEditWorker();
      return NextResponse.json({ id: existing.id, groupId: variant.groupId, variantId, kind: 'packaging', status: existing.status }, { status: 202 });
    }
    const snapshot: FinalEditPackagingSnapshot = { renderJobId: renderJob.id, variantId, ...(template ? { template } : {}), ...(varsOverrides ? { varsOverrides } : {}) };
    const id = uuidv4();
    const requestKey = crypto.createHash('sha256').update(JSON.stringify({ id, snapshot })).digest('hex');
    db.prepare(`INSERT INTO final_edit_jobs (id, projectId, groupId, variantId, kind, status, phase, progress, requestKey, inputSnapshotJson, estimatedCost, costCurrency, createdAt) VALUES (?, ?, ?, ?, 'packaging', 'queued', 'queued', 0, ?, ?, 0, 'CNY', ?)`).run(id, variant.projectId, variant.groupId, variantId, requestKey, JSON.stringify(snapshot), new Date().toISOString());
    wakeFinalEditWorker();
    return NextResponse.json({ id, groupId: variant.groupId, variantId, kind: 'packaging', status: 'queued' }, { status: 202 });
  } catch (error) { return finalEditErrorResponse(error); }
}

/** 包装文案预览：确定性自动组装，供包装界面只读展示。 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: variantId } = await params;
    const renderJobId = new URL(request.url).searchParams.get('renderJobId') || undefined;
    const renderJob = resolveRenderJob(variantId, renderJobId);
    const vars = previewPackagingVars(getDb(), renderJob.id);
    return NextResponse.json({
      renderJobId: renderJob.id,
      vars,
      videoUrl: `/api/final-edit-jobs/${encodeURIComponent(renderJob.id)}/video`,
    });
  } catch (error) { return finalEditErrorResponse(error); }
}

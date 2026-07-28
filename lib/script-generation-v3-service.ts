import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  generateScriptV3,
  type CompleteJsonRequest,
  type ScriptGenerationV3Dependencies,
} from './script-generation-v3.ts';
import { buildScriptDurationBudget } from './script-duration-policy.ts';
import type { ProviderMeta, SelectedSellingPoint } from './script-providers/types.ts';
import { getScriptTemplate } from './script-templates.ts';

export interface GenerateScriptV3ServiceDependencies {
  db: Database.Database;
  completeJson(providerId: string, request: CompleteJsonRequest): Promise<unknown>;
  providerMeta(providerId: string): ProviderMeta | undefined;
  generate?: typeof generateScriptV3;
  createId?: () => string;
}

export async function generateAndPersistScriptV3(
  input: {
    projectId: string;
    project: Record<string, unknown>;
    body: Record<string, unknown>;
  },
  dependencies: GenerateScriptV3ServiceDependencies,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { projectId, project, body } = input;
  const shotSetId = typeof body.shotSetId === 'string' ? body.shotSetId : '';
  if (!shotSetId) return { status: 400, body: { error: '请选择要生成脚本的分镜组' } };

  const shotSet = dependencies.db.prepare(
    `SELECT id, name FROM shot_sets WHERE id = ? AND projectId = ?`,
  ).get(shotSetId, projectId) as { id: string; name: string } | undefined;
  if (!shotSet) return { status: 400, body: { error: '分镜组不存在或不属于当前项目' } };

  let selectedSellingPoints: SelectedSellingPoint[] = [];
  if (Array.isArray(body.selectedSellingPoints)) {
    selectedSellingPoints = body.selectedSellingPoints as SelectedSellingPoint[];
  } else {
    try {
      const stored = JSON.parse(String(project.sellingPointsJson || '[]')) as Array<{ title: string; priority?: number }>;
      selectedSellingPoints = stored.map((point) => ({
        title: point.title,
        priority: point.priority?.toString() || 'medium',
        reason: '',
      }));
    } catch { /* malformed legacy project input becomes an empty selection */ }
  }

  const template = getScriptTemplate(typeof body.templateId === 'string' ? body.templateId : 'scene_seeding');
  if (!template) return { status: 400, body: { error: '脚本模板不存在' } };
  const targetDurationSec = Number(body.targetDurationSec) > 0 ? Number(body.targetDurationSec) : 20;
  let budget;
  try {
    budget = buildScriptDurationBudget(targetDurationSec);
  } catch {
    return { status: 400, body: { error: '目标时长仅支持 15、20、30、45 或 60 秒' } };
  }

  const providerId = typeof body.providerId === 'string' ? body.providerId : 'gemini';
  const tone = typeof body.tone === 'string' ? body.tone : String(project.scriptTone || '种草');
  const platform = typeof body.platform === 'string' ? body.platform : String(project.scriptPlatform || '通用');
  const generationInput = {
    projectName: String(project.name || ''),
    productName: String(project.productName || ''),
    productCode: String(project.productCode || ''),
    productCategory: String(project.productCategory || ''),
    targetAudience: String(project.targetAudience || ''),
    tone,
    platform,
    selectedSellingPoints,
    templateId: template.id,
    templateName: template.name,
    targetDurationSec,
    shotSetId,
  };
  const generatorDependencies: ScriptGenerationV3Dependencies = {
    completeJson: (request) => dependencies.completeJson(providerId, request),
  };
  const result = await (dependencies.generate || generateScriptV3)(generationInput, generatorDependencies);
  const model = dependencies.providerMeta(providerId)?.model || '';
  const draftId = (dependencies.createId || uuidv4)();
  dependencies.db.prepare(`
    INSERT INTO script_drafts (id, projectId, provider, model, inputSnapshot, outputJson)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    draftId,
    projectId,
    providerId,
    model,
    JSON.stringify({
      projectName: project.name,
      shotSetId,
      shotSetName: shotSet.name,
      selectedSellingPoints,
      templateId: template.id,
      templateName: template.name,
      targetDurationSec,
      targetAudience: project.targetAudience,
      tone,
      platform,
      providerId,
      durationPolicyVersion: budget.policyVersion,
      targetNarrationSec: budget.targetNarrationSec,
      targetCharacterRange: [budget.minContentCharacters, budget.maxContentCharacters],
      attempts: result.attempts,
    }),
    JSON.stringify(result.script),
  );
  return {
    status: 200,
    body: { draftId, script: result.script, provider: providerId, model, attempts: result.attempts },
  };
}

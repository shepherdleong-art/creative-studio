import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  generateScriptV3,
  ScriptGenerationV3Error,
  type CompleteJsonRequest,
  type ScriptGenerationV3Dependencies,
  type ScriptGenerationProgress,
  type ScriptVisualContext,
} from './script-generation-v3.ts';
import { dataRoot } from './data-root.ts';
import { assertNoStorageSymlink } from './final-edit/storage-path.ts';
import { buildScriptDurationBudget } from './script-duration-policy.ts';
import type { ProviderMeta, SelectedSellingPoint } from './script-providers/types.ts';
import { getScriptTemplate } from './script-templates.ts';
import {
  prepareScriptVisionImage,
  SCRIPT_VISION_IMAGE_MAX_BYTES,
  SCRIPT_VISION_TOTAL_BASE64_CHARACTERS,
  SCRIPT_VISION_TOTAL_RAW_BYTES,
  type PrepareScriptVisionImageInput,
  type PreparedScriptVisionImage,
} from './script-vision-image.ts';

export interface GenerateScriptV3ServiceDependencies {
  db: Database.Database;
  completeJson(providerId: string, request: CompleteJsonRequest): Promise<unknown>;
  providerMeta(providerId: string): ProviderMeta | undefined;
  storageRoot?: string;
  generate?: typeof generateScriptV3;
  createId?: () => string;
  prepareVisualImage?: (input: PrepareScriptVisionImageInput) => Promise<PreparedScriptVisionImage>;
  signal?: AbortSignal;
  onProgress?(progress: ScriptGenerationProgress): void;
}

interface ShotVisualRow {
  shotId: string;
  indexNum: number;
  sourceImageAssetId: string;
  sourceFilename: string;
  sourceImagePath: string;
  sourceMimeType: string;
  generatedImageAssetId: string | null;
  generatedFilename: string | null;
  generatedImagePath: string | null;
  generatedMimeType: string | null;
}

const SUPPORTED_SCRIPT_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function fallbackImageMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  return 'image/png';
}

async function readShotVisuals(
  rows: ShotVisualRow[],
  storageRoot: string,
  prepareVisualImage: (input: PrepareScriptVisionImageInput) => Promise<PreparedScriptVisionImage>,
  signal?: AbortSignal,
  onPrepared?: (completed: number, total: number) => void,
): Promise<ScriptVisualContext[]> {
  const visuals: ScriptVisualContext[] = [];
  const maxBytesPerImage = Math.min(
    SCRIPT_VISION_IMAGE_MAX_BYTES,
    Math.floor(SCRIPT_VISION_TOTAL_RAW_BYTES / Math.max(1, rows.length)),
  );
  for (const row of rows) {
    if (signal?.aborted) throw new DOMException('脚本生成已取消', 'AbortError');
    const candidates = [
      row.generatedImageAssetId && row.generatedImagePath && row.generatedFilename ? {
        imageAssetId: row.generatedImageAssetId,
        filename: row.generatedFilename,
        imagePath: row.generatedImagePath,
        mimeType: row.generatedMimeType,
      } : null,
      {
        imageAssetId: row.sourceImageAssetId,
        filename: row.sourceFilename,
        imagePath: row.sourceImagePath,
        mimeType: row.sourceMimeType,
      },
    ].filter((candidate): candidate is {
      imageAssetId: string;
      filename: string;
      imagePath: string;
      mimeType: string | null;
    } => Boolean(candidate));

    for (const candidate of candidates) {
      try {
        const imagePath = assertNoStorageSymlink(storageRoot, candidate.imagePath, { allowAbsolute: true });
        if (!fs.existsSync(imagePath) || !fs.statSync(imagePath).isFile()) continue;
        const mimeType = SUPPORTED_SCRIPT_IMAGE_MIME_TYPES.has(String(candidate.mimeType || ''))
          ? String(candidate.mimeType)
          : fallbackImageMimeType(imagePath);
        const prepared = await prepareVisualImage({
          imageBuffer: fs.readFileSync(imagePath),
          mimeType,
          maxBytes: maxBytesPerImage,
        });
        if (signal?.aborted) throw new DOMException('脚本生成已取消', 'AbortError');
        visuals.push({
          shotId: row.shotId,
          shotIndex: row.indexNum,
          imageAssetId: candidate.imageAssetId,
          sourceFilename: candidate.filename,
          mimeType: prepared.mimeType,
          imageBase64: prepared.imageBuffer.toString('base64'),
        });
        onPrepared?.(visuals.length, rows.length);
        break;
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
        // Unsafe, missing or unreadable candidates fall back to the next image.
      }
    }
  }
  return visuals;
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
  const provider = dependencies.providerMeta(providerId);
  if (!provider?.supportsVision) {
    return { status: 400, body: { error: '所选生成模型不支持图片理解，请选择已启用视觉能力的脚本模型' } };
  }

  const shotRows = dependencies.db.prepare(`
    SELECT
      s.id AS shotId,
      s.indexNum,
      source.id AS sourceImageAssetId,
      source.filename AS sourceFilename,
      source.path AS sourceImagePath,
      source.mimeType AS sourceMimeType,
      generated.id AS generatedImageAssetId,
      generated.filename AS generatedFilename,
      generated.path AS generatedImagePath,
      generated.mimeType AS generatedMimeType
    FROM shots s
    JOIN shot_sets ss ON ss.id = s.shotSetId
    JOIN image_assets source ON source.id = s.sourceImageId
    LEFT JOIN image_assets generated ON generated.id = s.latestGeneratedImageId
    WHERE ss.projectId = ? AND ss.id = ?
    ORDER BY s.indexNum
  `).all(projectId, shotSetId) as ShotVisualRow[];
  dependencies.onProgress?.({
    phase: 'preparing', percent: 5, message: '正在准备分镜图片',
  });
  const storageRoot = dependencies.storageRoot || path.join(dataRoot(), 'storage');
  const visuals = await readShotVisuals(
    shotRows,
    storageRoot,
    dependencies.prepareVisualImage || prepareScriptVisionImage,
    dependencies.signal,
    (completed, total) => dependencies.onProgress?.({
      phase: 'preparing',
      percent: Math.round(5 + ((completed / Math.max(1, total)) * 22)),
      message: `正在处理分镜图片（${completed}/${total}）`,
    }),
  );
  if (visuals.length === 0) {
    return { status: 400, body: { error: '所选分镜组中没有可读取的分镜图片' } };
  }
  const visualPayloadBase64Characters = visuals.reduce(
    (total, visual) => total + visual.imageBase64.length,
    0,
  );
  if (visualPayloadBase64Characters > SCRIPT_VISION_TOTAL_BASE64_CHARACTERS) {
    return { status: 400, body: { error: '分镜图片总量过大，请减少分镜数量后重试' } };
  }

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
    visuals,
  };
  const generatorDependencies: ScriptGenerationV3Dependencies = {
    completeJson: (request) => dependencies.completeJson(providerId, request),
    signal: dependencies.signal,
    onProgress: dependencies.onProgress,
  };
  let result;
  try {
    result = await (dependencies.generate || generateScriptV3)(generationInput, generatorDependencies);
  } catch (error) {
    if (error instanceof ScriptGenerationV3Error) {
      // 领域错误转成带稳定错误码与 details 的 422 body，否则 manager 会吞成 script_generation_error。
      return { status: 422, body: { error: error.code, message: error.message, details: error.details } };
    }
    throw error; // AbortError / 其它异常必须原样往上抛，不能吞。
  }
  // 迟到结果门禁：上游忽略 abort 稍后才返回时，不得继续落库。
  if (dependencies.signal?.aborted) throw new DOMException('脚本生成已取消', 'AbortError');
  // 项目在生成中可能已被删除：持久化前重验，避免写入已删除项目或触发外键级联。
  const projectStillExists = dependencies.db.prepare(
    `SELECT id FROM projects WHERE id = ?`,
  ).get(projectId);
  if (!projectStillExists) {
    return { status: 422, body: { error: 'project_deleted', message: '项目已被删除，脚本未保存' } };
  }
  dependencies.onProgress?.({ phase: 'saving', percent: 92, message: '正在保存脚本草稿' });
  const model = provider.model || '';
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
      visualCount: visuals.length,
      visualImageAssetIds: visuals.map((visual) => visual.imageAssetId),
      visualPayloadBase64Characters,
      attempts: result.attempts,
    }),
    JSON.stringify(result.script),
  );
  dependencies.onProgress?.({ phase: 'completed', percent: 100, message: '脚本生成完成' });
  return {
    status: 200,
    body: { draftId, script: result.script, provider: providerId, model, attempts: result.attempts },
  };
}

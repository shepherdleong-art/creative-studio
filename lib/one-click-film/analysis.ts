import type Database from 'better-sqlite3';
import { getDb } from '../db.ts';
import { completeJson, getAvailableProviders } from '../script-providers/index.ts';
import { tileSourceImages } from '../script-studio/tiling.ts';
import { normalizeSellingPointDraft, type SellingPointDraft } from './selling-points.ts';
import {
  getAnalysis,
  markAnalysisFailed,
  markAnalysisSucceeded,
  type OneClickFilmAnalysis,
} from './store.ts';

/**
 * 素材分析：把本项目选中的场景图/详情页切成视觉模型可读的切片，
 * 解析成「带来源的卖点」并落库。
 *
 * 只有一张场景图也能分析：外观与可观察的使用动作可以入稿，
 * 具体功能主张仍需要对应证据——解析时按来源图片数量收紧要求。
 */

interface VisionPoint {
  text: string;
  kind: 'appearance' | 'usage' | 'claim';
  sourcePageIndex: number | null;
  tileRefs: string[];
}

interface VisionResult {
  productName: string;
  appearance: string;
  sceneClues: string;
  points: VisionPoint[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseVisionResult(value: unknown): VisionResult {
  const record = asRecord(value);
  const points: VisionPoint[] = [];
  const rawPoints = Array.isArray(record.points) ? record.points : Array.isArray(record.sellingPoints) ? record.sellingPoints : [];
  for (const raw of rawPoints) {
    const item = asRecord(raw);
    const text = asString(item.text) || asString(item.factText) || asString(item.title);
    if (!text) continue;
    const kindRaw = asString(item.kind).toLowerCase();
    const kind = kindRaw === 'appearance' || kindRaw === 'usage' ? kindRaw : 'claim';
    const tileRefs = Array.isArray(item.tileRefs)
      ? item.tileRefs.map((ref) => asString(ref)).filter(Boolean)
      : [];
    points.push({
      text,
      kind,
      sourcePageIndex: typeof item.sourcePageIndex === 'number' && Number.isInteger(item.sourcePageIndex)
        ? item.sourcePageIndex : null,
      tileRefs,
    });
  }
  return {
    productName: asString(record.productName),
    appearance: asString(record.appearance),
    sceneClues: asString(record.sceneClues),
    points,
  };
}

function pickVisionProvider(db: Database.Database, requestedProviderId?: string) {
  const providers = getAvailableProviders();
  const usable = providers.filter((provider) => provider.configured && provider.supportsVision);
  if (requestedProviderId) {
    const requested = providers.find((provider) => provider.id === requestedProviderId);
    if (!requested) throw new Error(`未知的脚本模型 ${requestedProviderId}`);
    if (!requested.configured) throw new Error(`${requested.name} 未配置完整：${(requested.missing ?? []).join(', ')}`);
    if (!requested.supportsVision) throw new Error(`${requested.name} 不支持图片识别`);
    return requested;
  }
  if (usable.length === 0) throw new Error('没有已配置且支持图片识别的脚本模型，请先在设置里配置');
  return usable[0]!;
}

export async function runOneClickFilmAnalysis(input: {
  analysisId: string;
  providerId?: string;
  signal?: AbortSignal;
  db?: Database.Database;
}): Promise<OneClickFilmAnalysis> {
  const db = input.db ?? getDb();
  const analysis = getAnalysis(db, input.analysisId);
  if (!analysis) throw new Error('分析任务不存在');

  try {
    const provider = pickVisionProvider(db, input.providerId);
    const tileSet = await tileSourceImages(db, analysis.projectId, analysis.sourceImageIds, {
      signal: input.signal,
      directVision: true,
    });
    const tiles = tileSet.pages.flatMap((page) => page.tiles.map((tile) => ({
      mimeType: tile.mimeType,
      imageBase64: tile.imageBase64,
    })));
    if (tiles.length === 0) throw new Error('没有可读取的素材图片');

    const singleSceneImage = tileSet.pages.length === 1;
    const raw = await completeJson<unknown>({
      providerId: provider.id,
      systemPrompt: '你是电商种草素材分析器。只返回一个 JSON 对象，不输出解释。只写图片中能直接看到或可合理观察到的内容，不得编造参数、材质、认证或功效。',
      userPrompt: JSON.stringify({
        task: 'analyze_product_material_for_short_video',
        imageCount: tileSet.pages.length,
        tileCount: tiles.length,
        requirements: [
          '识别产品名称、外观特征（颜色、结构、场景线索）与可用于短视频的卖点',
          '每条卖点给出 text、kind、sourcePageIndex、tileRefs',
          'kind=appearance 表示外观特征；kind=usage 表示可从画面推断的使用动作或体验；kind=claim 表示具体功能主张',
          'kind=claim 必须能在图片中找到明确证据（文字或可辨认结构）；找不到证据时不要输出该条',
          singleSceneImage
            ? '本次只有一张场景图：只输出外观与可观察的使用动作，不要输出具体功能主张'
            : '详情页可用于支撑具体功能主张；tileRefs 使用 1 起的整页切片编号',
          '不要输出价格、促销、限时活动、赠品、销量排名等时效信息',
          'sourcePageIndex 是图片在本次素材列表中的 0 起序号',
        ],
        output: {
          productName: 'string',
          appearance: 'string',
          sceneClues: 'string',
          points: [{ text: 'string', kind: 'appearance|usage|claim', sourcePageIndex: 'number', tileRefs: ['string'] }],
        },
      }),
      temperature: 0.4,
      maxTokens: 4000,
      images: tiles,
      signal: input.signal,
      usageContext: {
        enabled: true, projectId: analysis.projectId, refType: 'one-click-film-analysis', refId: analysis.id,
      },
      executionContext: {
        taskId: analysis.id, step: 'analyze',
        scope: { resourceType: 'project', resourceId: analysis.projectId },
        inputRevision: analysis.sourceFingerprint,
      },
    });

    const parsed = parseVisionResult(raw);
    const pageByIndex = new Map(tileSet.pages.map((page) => [page.pageIndex, page]));
    const points: SellingPointDraft[] = [];
    const seen = new Set<string>();
    for (const point of parsed.points) {
      const page = point.sourcePageIndex === null ? tileSet.pages[0] : pageByIndex.get(point.sourcePageIndex);
      const draft = normalizeSellingPointDraft({
        text: point.text,
        kind: singleSceneImage && point.kind === 'claim' ? 'usage' : point.kind,
        sourceImageId: page?.imageAssetId ?? analysis.sourceImageIds[0] ?? null,
        sourceLabel: page ? `${page.filename}${point.tileRefs.length ? ` · 切片 ${point.tileRefs.join('、')}` : ''}` : '',
        evidenceRefs: page ? [{
          imageId: page.imageAssetId,
          label: page.filename,
          locator: point.tileRefs.join('、'),
        }] : [],
        selected: true,
      });
      if (!draft) continue;
      const key = draft.text.replace(/\s/g, '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      points.push(draft);
    }
    if (points.length === 0) throw new Error('没有从素材中识别到可用卖点，请换一张更清晰的图片');

    markAnalysisSucceeded(db, {
      analysisId: analysis.id,
      productName: parsed.productName || '',
      appearance: parsed.appearance || parsed.sceneClues || '',
      sceneClues: parsed.sceneClues || '',
      points,
      raw,
      providerId: provider.id,
      model: provider.model ?? '',
    });
    return getAnalysis(db, analysis.id)!;
  } catch (error) {
    markAnalysisFailed(db, {
      analysisId: analysis.id,
      code: error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'analysis_failed',
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

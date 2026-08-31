import type { LibrarySellingPointInput } from '../libraries.ts';
import {
  normalizeEvidenceRefs,
  normalizeHierarchyRole,
  normalizeImportance,
} from '../selling-point-normalize.ts';
import type { ScriptStudioPointType } from '../types.ts';
import type { ScriptStudioCompleteJson } from '../llm-contract.ts';

export interface VisionExtractInput {
  productName?: string;
  category?: string;
  brand?: string;
  pages: Array<{
    pageIndex: number;
    imageAssetId: string;
    filename: string;
    sourceWidth: number;
    sourceHeight: number;
    tiles: Array<{ mimeType: string; imageBase64: string }>;
  }>;
}

export interface VisionExtractionResult {
  productName: string;
  category: string;
  brand: string;
  sellingPoints: LibrarySellingPointInput[];
  providerId: string;
  model: string;
  promptContractVersion: number;
  pageIdentities?: Array<{
    pageIndex: number;
    productName: string;
    category: string;
    brand: string;
  }>;
  /** 非敏感的批级性能记录，用于区分固定内容慢与上游随机长尾。 */
  batchMetrics?: VisionExtractionBatchMetric[];
}

export interface VisionExtractionBatchMetric {
  pageIndex: number;
  start: number;
  end: number;
  imageCount: number;
  attempts: number;
  elapsedMs: number;
  attemptElapsedMs: number[];
}

export interface VisionExtractor {
  extract(input: VisionExtractInput, signal?: AbortSignal): Promise<VisionExtractionResult>;
}

const POINT_TYPES = new Set<ScriptStudioPointType>([
  'appearance', 'structure', 'scenario', 'spec', 'material', 'certification', 'efficacy', 'other',
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toPointType(value: unknown): ScriptStudioPointType {
  const raw = asString(value).toLowerCase();
  return POINT_TYPES.has(raw as ScriptStudioPointType) ? raw as ScriptStudioPointType : 'other';
}

function parsePoints(value: unknown): LibrarySellingPointInput[] {
  const values = Array.isArray(value) ? value : [];
  const result: LibrarySellingPointInput[] = [];
  for (const item of values) {
    const raw = asRecord(item);
    const title = asString(raw.title);
    const factText = asString(raw.factText);
    const pointType = toPointType(raw.pointType);
    if (!title || !factText) continue;
    const tileRefs = Array.isArray(raw.tileRefs)
      ? raw.tileRefs.map((ref) => asString(ref)).filter(Boolean)
      : [];
    result.push({
      title,
      factText,
      pointType,
      evidenceQuote: asString(raw.evidenceQuote) || asString(raw.evidence) || asString(raw.quote),
      sourcePageIndex: typeof raw.sourcePageIndex === 'number' ? raw.sourcePageIndex : undefined,
      tileRefs,
      modelConfidence: asString(raw.confidence || raw.modelConfidence) || 'medium',
      riskLevel: asString(raw.riskLevel) === 'high' ? 'high' : 'low',
      evidenceGate: 'skipped',
      usable: true,
      // 模型 themeKey 只作辅助信息透传；修订级稳定键由本地在入库时按页码+规范化标题生成。
      themeKey: asString(raw.themeKey),
      themeTitle: asString(raw.themeTitle),
      hierarchyRole: normalizeHierarchyRole(asString(raw.hierarchyRole).toLowerCase()),
      importance: normalizeImportance(raw.importance),
    });
  }
  return result;
}

export function createVisionExtractor(
  completeJson: ScriptStudioCompleteJson,
  provider: { id: string; model: string },
  options: {
    maxTokens?: number;
    tileBatchSize?: number;
    concurrency?: number;
    requestTimeoutMs?: number;
    maxAttempts?: number;
  } = {},
): VisionExtractor {
  return {
    async extract(input, signal) {
      // 按页合并语义不变；页内切片按 tileBatchSize 分批、有界并发调用，遵守单请求 50 张的供应商硬限制。
      const batchSize = Math.max(1, Math.floor(options.tileBatchSize ?? 6));
      const concurrency = Math.max(1, Math.floor(options.concurrency ?? 3));
      const requestTimeoutMs = Math.max(1, Math.floor(options.requestTimeoutMs ?? 120_000));
      const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 2));
      let productName = '';
      let category = '';
      let brand = '';
      const pageIdentities: Array<{ pageIndex: number; productName: string; category: string; brand: string }> = [];
      const sellingPoints: LibrarySellingPointInput[] = [];
      const batchMetrics: VisionExtractionBatchMetric[] = [];
      for (const page of input.pages) {
        const batches: Array<{ start: number; tiles: Array<{ mimeType: string; imageBase64: string }> }> = [];
        for (let start = 0; start < page.tiles.length; start += batchSize) {
          batches.push({ start, tiles: page.tiles.slice(start, start + batchSize) });
        }
        if (batches.length === 0) batches.push({ start: 0, tiles: [] });
        const batchRecords: Array<Record<string, unknown> | undefined> = new Array(batches.length);
        const batchMetricRecords: Array<VisionExtractionBatchMetric | undefined> = new Array(batches.length);
        let cursor = 0;
        const worker = async (): Promise<void> => {
          while (cursor < batches.length) {
            if (signal?.aborted) throw new DOMException('视觉提取已取消', 'AbortError');
            const index = cursor;
            cursor += 1;
            const batch = batches[index]!;
            // 单批失败（网关抖动/模型偶发非 JSON）重试一次。75s/3 次的提前重试
            // 在同图真机实验中从 144s 回退到 175s，因此保留供应商 120s 阈值。
            let lastError: unknown;
            const attemptElapsedMs: number[] = [];
            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
              const attemptStartedAt = Date.now();
              try {
                batchRecords[index] = asRecord(await completeJson({
                  systemPrompt: '你是电商详情页卖点提取器。只返回一个 JSON 对象，不输出解释。逐字证据优先，不得编造图片中没有的事实。',
                  userPrompt: JSON.stringify({
                    task: 'extract_detail_page_selling_points',
                    page: {
                      pageIndex: page.pageIndex,
                      filename: page.filename,
                      sourceWidth: page.sourceWidth,
                      sourceHeight: page.sourceHeight,
                      tileCount: page.tiles.length,
                    },
                    tileRange: { start: batch.start + 1, end: batch.start + batch.tiles.length },
                    imageCount: input.pages.length,
                    requirements: [
                      '先基于图片内容识别商品名称、品类和品牌；无法确定时留空',
                      '每条卖点给出 title、factText、pointType、evidenceQuote、sourcePageIndex、tileRefs、confidence、riskLevel、themeKey、themeTitle、hierarchyRole、importance',
                      'evidenceQuote 必须是图片中的原文；tileRefs 用于定位该卖点出自哪张切片，二次核验只会查看这些切片',
                      `随附图片是该详情页（共 ${page.tiles.length} 张切片，按从上到下顺序）的第 ${batch.start + 1} 到第 ${batch.start + batch.tiles.length} 张；tileRefs 必须使用整页编号（本批从 tile_${batch.start + 1} 起），只填卖点文字实际出现的切片`,
                      '不要输出价格、促销、限时活动、赠品、销量排名等时效信息',
                      'pointType 只能是 appearance|structure|scenario|spec|material|certification|efficacy|other',
                      'themeTitle 是该卖点所属信息区域的大标题原文（没有明确大标题时留空）；themeKey 是同一页内同一信息区域共享的稳定分组键（用大标题的简写拼音或英文短词，无法判断时留空）',
                      'hierarchyRole 标记该卖点在所属区域中的角色：primary=区域主卖点，supporting=支撑卖点，detail=补充细节；importance 是 1-100 的页内相对重要度，越大越重要',
                      '大标题只用于分组与排序；factText 与 evidenceQuote 仍必须来自图片中可逐字定位的事实',
                    ],
                    output: {
                      productName: 'string',
                      category: 'string',
                      brand: 'string',
                      sellingPoints: [{
                        title: 'string', factText: 'string', pointType: 'string',
                        evidenceQuote: 'string', sourcePageIndex: 'number', tileRefs: ['string'],
                        confidence: 'low|medium|high', riskLevel: 'low|high',
                        themeKey: 'string', themeTitle: 'string',
                        hierarchyRole: 'primary|supporting|detail', importance: 'number',
                      }],
                    },
                  }),
                  temperature: 1,
                  maxTokens: options.maxTokens ?? 8000,
                  timeoutMs: requestTimeoutMs,
                  images: batch.tiles,
                  signal,
                }));
                attemptElapsedMs.push(Math.max(0, Date.now() - attemptStartedAt));
                lastError = undefined;
                break;
              } catch (error) {
                attemptElapsedMs.push(Math.max(0, Date.now() - attemptStartedAt));
                if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
                lastError = error;
              }
            }
            batchMetricRecords[index] = {
              pageIndex: page.pageIndex,
              start: batch.start + 1,
              end: batch.start + batch.tiles.length,
              imageCount: batch.tiles.length,
              attempts: attemptElapsedMs.length,
              elapsedMs: attemptElapsedMs.reduce((sum, value) => sum + value, 0),
              attemptElapsedMs,
            };
            if (lastError) {
              const message = lastError instanceof Error ? lastError.message : String(lastError);
              throw new Error(
                `详情页第 ${batch.start + 1}-${batch.start + batch.tiles.length} 张切片提取失败`
                + `（${attemptElapsedMs.length} 次尝试，分别 ${attemptElapsedMs.join('/')}ms）：${message}`,
              );
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));
        batchMetrics.push(...batchMetricRecords.filter((metric): metric is VisionExtractionBatchMetric => Boolean(metric)));
        // 按批序合并：身份信息取首个非空，卖点保持页内自上而下顺序。
        let pageProductName = '';
        let pageCategory = '';
        let pageBrand = '';
        for (const record of batchRecords) {
          if (!record) continue;
          pageProductName ||= asString(record.productName);
          pageCategory ||= asString(record.category);
          pageBrand ||= asString(record.brand);
          const batchPoints = parsePoints(record.sellingPoints).map((point) => {
            const pageIndex = point.sourcePageIndex ?? page.pageIndex;
            return {
              ...point,
              sourcePageIndex: pageIndex,
              // 每条证据引用从解析起就带上自己的 pageIndex + tileRef 配对，跨页去重不丢定位。
              evidenceRefs: normalizeEvidenceRefs({ sourcePageIndex: pageIndex, tileRefs: point.tileRefs }),
            };
          });
          sellingPoints.push(...batchPoints);
        }
        productName ||= pageProductName;
        category ||= pageCategory;
        brand ||= pageBrand;
        pageIdentities.push({ pageIndex: page.pageIndex, productName: pageProductName, category: pageCategory, brand: pageBrand });
      }
      return {
        productName,
        category,
        brand,
        sellingPoints,
        providerId: provider.id,
        model: provider.model,
        promptContractVersion: 3,
        pageIdentities,
        batchMetrics,
      };
    },
  };
}

import type { EvidenceReprobe, EvidenceTile } from './adapters/reprobe.ts';
import type { LibrarySellingPointInput } from './libraries.ts';
import { normalizeEvidenceRefs } from './selling-point-normalize.ts';
import { parseTileRefIndex } from './tiling.ts';
import type { ScriptStudioEvidenceGate, ScriptStudioPointType } from './types.ts';

const MATERIAL_WORDS = /\b(?:真皮|实木|棉麻|铝合金|不锈钢|岩板|金属|玻璃|陶瓷|尼龙|橡胶|钛|碳纤维|食品级|环保材质)\b/u;
const CERT_WORDS = /\b(?:认证|证书|国标|标准|检测报告|专利|质检|CE|RoHS|FDA|CCC|ISO)\b/u;
const EFFICACY_WORDS = /\b(?:有效|显著|改善|解决|提升|降低|修复|抑菌|防水|防污|耐磨|抗压|承重|保鲜|省电|节能)\b/u;
const ABSOLUTE_WORDS = /\b(?:最|第一|唯一|绝对|百分百|100%|永久|彻底|全能|顶级|最强)\b/u;
const PROMOTION_WORDS = /\b(?:促销|限时|优惠|赠品|折扣|秒杀|包邮|券|满减|特价|销量|热卖|爆款|好评|回购|立减|拼团)\b/u;
const PRICE_PATTERN = /(?:¥|￥|\b\d+(?:\.\d+)?\s*(?:元|块|折|%|％)\b)/u;

export interface EvidenceGateResult {
  points: LibrarySellingPointInput[];
  excludedPromotion: number;
  excludedHighRiskUnverified: number;
  excludedStructural: number;
  verifiedHighRisk: number;
  highRiskCandidateCount: number;
  reprobeRequestCount: number;
}

export interface EvidenceGateDeps {
  reprobe?: EvidenceReprobe;
  evidenceTiles?: (point: LibrarySellingPointInput) => EvidenceTile[];
  signal?: AbortSignal;
  /** 高风险卖点二次核验的请求并发度。 */
  concurrency?: number;
  /** 单次视觉请求最多携带的封闭问题数。 */
  batchSize?: number;
  /** 单次视觉请求的图片预算；超出时自动切新批。 */
  maxImagesPerBatch?: number;
  /** 来源页数；提供时页码越界的引用判定为非法证据位置。 */
  pageCount?: number;
  /** 每页切片数；提供时切片引用越界同样判定为非法证据位置。 */
  pageTileCounts?: number[];
}

interface ReprobeBatchItem {
  index: number;
  claim: string;
  imageIndexes: number[];
}

interface ReprobeBatch {
  items: ReprobeBatchItem[];
  tiles: EvidenceTile[];
}

function evidenceTileKey(tile: EvidenceTile): string {
  return `${tile.mimeType}\u0000${tile.imageBase64}`;
}

function buildReprobeBatches(
  queue: number[],
  input: LibrarySellingPointInput[],
  deps: EvidenceGateDeps,
): ReprobeBatch[] {
  const maxClaims = deps.reprobe?.verifyMany
    ? Math.max(1, Math.floor(deps.batchSize ?? 4))
    : 1;
  const maxImages = Math.max(1, Math.floor(deps.maxImagesPerBatch ?? 6));
  const batches: ReprobeBatch[] = [];
  let batch: ReprobeBatch = { items: [], tiles: [] };
  let tileIndexByKey = new Map<string, number>();

  const flush = () => {
    if (batch.items.length > 0) batches.push(batch);
    batch = { items: [], tiles: [] };
    tileIndexByKey = new Map<string, number>();
  };

  for (const index of queue) {
    const point = input[index]!;
    const claim = point.evidenceQuote?.trim() || point.factText.trim();
    const pointTiles = deps.evidenceTiles?.(point) || [];
    const uniquePointTiles = [...new Map(pointTiles.map((tile) => [evidenceTileKey(tile), tile])).values()];
    const unseenCount = uniquePointTiles.reduce(
      (count, tile) => count + (tileIndexByKey.has(evidenceTileKey(tile)) ? 0 : 1),
      0,
    );
    if (batch.items.length > 0 && (batch.items.length >= maxClaims || batch.tiles.length + unseenCount > maxImages)) {
      flush();
    }

    const imageIndexes: number[] = [];
    for (const tile of uniquePointTiles) {
      const key = evidenceTileKey(tile);
      let imageIndex = tileIndexByKey.get(key);
      if (imageIndex === undefined) {
        batch.tiles.push(tile);
        imageIndex = batch.tiles.length;
        tileIndexByKey.set(key, imageIndex);
      }
      imageIndexes.push(imageIndex);
    }
    batch.items.push({ index, claim, imageIndexes });
  }
  flush();
  return batches;
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/[\s\u3000]+/g, '')
    .toLowerCase()
    .replace(/([0-9]+)\s*([a-zA-Z]+)/g, '$1$2');
}

export function isPromotionPoint(point: Pick<LibrarySellingPointInput, 'title' | 'factText'>): boolean {
  const text = `${point.title} ${point.factText}`;
  return PROMOTION_WORDS.test(text) || PRICE_PATTERN.test(text);
}

export function classifyRisk(point: Pick<LibrarySellingPointInput, 'title' | 'factText' | 'pointType'>): 'low' | 'high' {
  const text = `${point.title} ${point.factText}`;
  if (point.pointType === 'material' || point.pointType === 'certification' || point.pointType === 'efficacy'
    || MATERIAL_WORDS.test(text) || CERT_WORDS.test(text) || EFFICACY_WORDS.test(text) || ABSOLUTE_WORDS.test(text)
    || /[0-9]/.test(text)) {
    return 'high';
  }
  return 'low';
}

export function structuralGatePassed(
  point: Pick<LibrarySellingPointInput, 'title' | 'factText' | 'evidenceQuote' | 'sourcePageIndex' | 'tileRefs' | 'evidenceRefs'>,
  options: { pageCount?: number; pageTileCounts?: number[] } = {},
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!point.title?.trim()) issues.push('title_required');
  if (!point.factText?.trim()) issues.push('fact_text_required');
  if (!point.evidenceQuote?.trim()) issues.push('evidence_quote_required');
  // 证据定位 fail closed：至少一条引用带页码；提供来源范围时页码不得越界；
  // 非空切片引用必须能按 tile_N/数字解析且不得越过该页切片数。
  // pageIndex=999、tileRef=not_a_tile 这类非法位置不得被当作可用证据。
  const refs = normalizeEvidenceRefs(point);
  if (!refs.some((ref) => ref.pageIndex !== null)) {
    issues.push('tile_location_required');
  }
  const locationInvalid = refs.some((ref) => {
    if (ref.tileRef && parseTileRefIndex(ref.tileRef) === null) return true;
    if (typeof options.pageCount === 'number' && ref.pageIndex !== null && ref.pageIndex >= options.pageCount) return true;
    if (Array.isArray(options.pageTileCounts) && ref.pageIndex !== null && ref.tileRef) {
      const tileIndex = parseTileRefIndex(ref.tileRef);
      const tileCount = options.pageTileCounts[ref.pageIndex];
      if (tileIndex !== null && tileCount !== undefined && tileIndex >= tileCount) return true;
    }
    return false;
  });
  if (locationInvalid) issues.push('tile_location_invalid');
  return { ok: issues.length === 0, issues };
}

export function claimVerifiedByQuote(claim: string, quote: string): boolean {
  return Boolean(claim.trim() && quote.trim() && normalizeText(quote).includes(normalizeText(claim)));
}

export async function runEvidenceGate(
  input: LibrarySellingPointInput[],
  deps: EvidenceGateDeps = {},
): Promise<EvidenceGateResult> {
  const points: Array<LibrarySellingPointInput | undefined> = new Array(input.length);
  let excludedPromotion = 0;
  let excludedHighRiskUnverified = 0;
  let excludedStructural = 0;
  let verifiedHighRisk = 0;
  let reprobeRequestCount = 0;

  // 第一遍同步判定：结构门禁与促销排除不需要模型调用，只有高风险卖点进入二次核验队列。
  const reprobeQueue: number[] = [];
  input.forEach((point, index) => {
    const structural = structuralGatePassed(point, {
      pageCount: deps.pageCount,
      pageTileCounts: deps.pageTileCounts,
    });
    const isPromotion = isPromotionPoint(point);
    const riskLevel = classifyRisk(point);
    if (!structural.ok || isPromotion) {
      if (!structural.ok) excludedStructural += 1;
      if (isPromotion) excludedPromotion += 1;
      points[index] = { ...point, evidenceGate: 'failed', usable: false, riskLevel };
      return;
    }
    if (riskLevel === 'high') {
      reprobeQueue.push(index);
      return;
    }
    points[index] = { ...point, evidenceGate: 'skipped', usable: true, riskLevel };
  });

  // 高风险卖点以小批封闭问题有界并发核验；每条仅看它的证据图，
  // 且模型回传摘录后仍由服务端按 id 逐条字符串匹配。旧适配器无 verifyMany 时自动回退逐条请求。
  const reprobeBatches = buildReprobeBatches(reprobeQueue, input, deps);
  const processed = new Set<number>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < reprobeBatches.length) {
      if (!deps.reprobe || deps.signal?.aborted) break;
      const batch = reprobeBatches[cursor]!;
      cursor += 1;
      reprobeRequestCount += 1;
      let quotes = new Map<number, string | null>();
      if (deps.reprobe.verifyMany) {
        const result = await deps.reprobe.verifyMany({
          claims: batch.items.map((item) => ({
            id: String(item.index),
            claim: item.claim,
            imageIndexes: item.imageIndexes,
          })),
          tiles: batch.tiles,
          signal: deps.signal,
        }).catch(() => ({ results: [] }));
        const byId = new Map(result.results.map((item) => [item.id, item.quote]));
        quotes = new Map(batch.items.map((item) => [item.index, byId.get(String(item.index)) ?? null]));
      } else {
        const item = batch.items[0]!;
        const result = await deps.reprobe.verify({
          claim: item.claim,
          tiles: batch.tiles,
          signal: deps.signal,
        }).catch(() => ({ quote: null }));
        quotes.set(item.index, result.quote);
      }

      for (const item of batch.items) {
        const point = input[item.index]!;
        const quote = quotes.get(item.index);
        processed.add(item.index);
        if (quote && claimVerifiedByQuote(item.claim, quote)) {
          verifiedHighRisk += 1;
          points[item.index] = { ...point, evidenceGate: 'passed', usable: true, riskLevel: 'high' };
        } else {
          excludedHighRiskUnverified += 1;
          points[item.index] = { ...point, evidenceGate: 'failed', usable: false, riskLevel: 'high' };
        }
      }
    }
  };
  const concurrency = Math.max(1, Math.floor(deps.concurrency ?? 3));
  await Promise.all(Array.from({ length: Math.min(concurrency, reprobeBatches.length) }, () => worker()));

  // 无 reprobe 或中途取消时，所有尚未处理的高风险卖点按「未核验」排除。
  for (const index of reprobeQueue) {
    if (processed.has(index)) continue;
    excludedHighRiskUnverified += 1;
    points[index] = { ...input[index]!, evidenceGate: 'failed', usable: false, riskLevel: 'high' };
  }

  return {
    points: points.map((point) => point!),
    excludedPromotion,
    excludedHighRiskUnverified,
    excludedStructural,
    verifiedHighRisk,
    highRiskCandidateCount: reprobeQueue.length,
    reprobeRequestCount,
  };
}

export function usableSellingPoints(points: LibrarySellingPointInput[]): LibrarySellingPointInput[] {
  return points.filter((point) => point.usable !== false && point.evidenceGate !== 'failed');
}

export function evidenceGateSummary(
  points: LibrarySellingPointInput[],
  result?: Pick<EvidenceGateResult, 'highRiskCandidateCount' | 'reprobeRequestCount'>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    total: points.length,
    usable: usableSellingPoints(points).length,
    failed: points.filter((point) => point.evidenceGate === 'failed').length,
    highRiskVerified: points.filter((point) => point.riskLevel === 'high' && point.evidenceGate === 'passed').length,
  };
  if (result) {
    summary.highRiskCandidates = result.highRiskCandidateCount;
    summary.reprobeRequests = result.reprobeRequestCount;
  }
  return summary;
}

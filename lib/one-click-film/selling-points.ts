import { OneClickFilmError } from './errors.ts';

/**
 * 分析结果的卖点规范化与确认校验（纯函数）。
 *
 * 红线：具体功能主张必须能定位到本项目来源图片；只有外观依据时只能写可观察的
 * 外观/使用动作。没有来源的候选卖点不可选入，也不许在确认时被静默保留。
 */

export type SellingPointKind = 'appearance' | 'usage' | 'claim';

export interface EvidenceRef {
  imageId: string;
  label: string;
  /** 详情页分片/位置描述；没有时为空串。 */
  locator?: string;
}

export interface SellingPointDraft {
  text: string;
  originalText?: string;
  sourceImageId: string | null;
  sourceLabel: string;
  evidenceRefs: EvidenceRef[];
  kind: SellingPointKind;
  selected: boolean;
  edited?: boolean;
}

const KINDS: readonly SellingPointKind[] = ['appearance', 'usage', 'claim'];

export function normalizeKind(value: unknown): SellingPointKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value)
    ? value as SellingPointKind
    : 'claim';
}

export function normalizeSellingPointText(value: unknown): string {
  return (typeof value === 'string' ? value : '')
    .normalize('NFKC')
    .replace(/^[\s"'“”‘’]+/, '')
    .replace(/[\s"'“”‘’]+$/, '')
    .replace(/^\d{1,2}\s*[.、．:：]\s*/, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 120);
}

export function normalizeEvidenceRefs(value: unknown): EvidenceRef[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const refs: EvidenceRef[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const imageId = typeof record.imageId === 'string' ? record.imageId.trim() : '';
    if (!imageId || seen.has(imageId)) continue;
    seen.add(imageId);
    refs.push({
      imageId,
      label: typeof record.label === 'string' ? record.label.trim().slice(0, 120) : '',
      locator: typeof record.locator === 'string' ? record.locator.trim().slice(0, 120) : '',
    });
  }
  return refs;
}

export function normalizeSellingPointDraft(value: unknown): SellingPointDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const text = normalizeSellingPointText(record.text);
  if (!text) return null;
  const evidenceRefs = normalizeEvidenceRefs(record.evidenceRefs);
  const sourceImageId = typeof record.sourceImageId === 'string' && record.sourceImageId.trim()
    ? record.sourceImageId.trim()
    : evidenceRefs[0]?.imageId ?? null;
  return {
    text,
    originalText: normalizeSellingPointText(record.originalText) || text,
    sourceImageId,
    sourceLabel: typeof record.sourceLabel === 'string' ? record.sourceLabel.trim().slice(0, 120) : '',
    evidenceRefs,
    kind: normalizeKind(record.kind),
    selected: record.selected !== false,
    edited: record.edited === true,
  };
}

/** 有来源：图片身份存在，或至少有一条带图片的证据定位。 */
export function hasSource(point: Pick<SellingPointDraft, 'sourceImageId' | 'evidenceRefs'>): boolean {
  return Boolean(point.sourceImageId) || point.evidenceRefs.length > 0;
}

export interface ConfirmationInput {
  productName: string;
  points: Array<Pick<SellingPointDraft, 'text' | 'selected' | 'sourceImageId' | 'evidenceRefs'>>;
}

export interface ConfirmedContent {
  productName: string;
  points: string[];
}

/**
 * 确认内容：产品名有效且至少勾选一项「有内容、有来源」的卖点。
 * 勾选但无来源的条目直接拒绝，不静默降级成空确认。
 */
export function validateConfirmation(input: ConfirmationInput): ConfirmedContent {
  const productName = input.productName.trim();
  if (!productName) throw new OneClickFilmError('invalid_input', '产品名称不能为空');
  const selected = input.points.filter((point) => point.selected && point.text.trim());
  if (selected.length === 0) {
    throw new OneClickFilmError('invalid_input', '至少勾选一项有内容的卖点才能生成脚本');
  }
  const unsourced = selected.filter((point) => !hasSource(point));
  if (unsourced.length > 0) {
    throw new OneClickFilmError(
      'invalid_input',
      `这些卖点缺少来源图片，不能确认：${unsourced.map((point) => point.text).join('、')}`,
    );
  }
  return { productName, points: selected.map((point) => point.text.trim()) };
}

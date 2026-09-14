/**
 * 证据之上的卖点提炼层（方案 §3，验收 B1-B9）：
 * - 原始事实/证据与提炼卖点保持两个独立概念：派生结果绑定来源事实修订、提炼规则版本
 *   与模型信息，绝不覆盖 evidenceQuote 或抹掉原始限定条件；
 * - 提炼只把已核验事实转成购买理由、推荐短句与 5/8/10 字符标签，不创造新功能、功效或承诺；
 * - 本地校验 fail closed：包外/失败/禁用事实不得被提炼；输出中的数字、材质、功效、认证
 *   与范围扩大词必须能回到来源事实，否则进入 needs_review，不自动通过；
 * - 同一来源修订 + 规则版本 + 模型身份的结果可复用（缓存不提升确认状态）；
 *   draft → approved 只能由用户显式确认触发。
 */
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { LibraryRevisionView } from './libraries.ts';
import { isSellingPointEvidenceUsable } from './selling-point-normalize.ts';
import type { SellingPointRecord } from './types.ts';
import type { ScriptStudioCompleteJson } from './llm-contract.ts';

export const SELLING_POINT_DISTILL_RULE_VERSION = 'distill-rules-v1';

export type DistilledPointRole = 'core' | 'supporting' | 'spec' | 'atmosphere';
export type DistilledReviewStatus = 'draft' | 'approved' | 'needs_review';

export interface DistilledSellingPointRecord {
  id: string;
  projectId: string;
  sourceLibraryRevisionId: string;
  sourceFactIds: string[];
  ruleVersion: string;
  providerId: string;
  model: string;
  title: string;
  benefitText: string;
  shortCopy: string;
  tags: { max5: string | null; max8: string | null; max10: string | null };
  role: DistilledPointRole;
  priority: number;
  scope: string;
  limitations: string[];
  reviewStatus: DistilledReviewStatus;
  /** needs_review 的具体原因（审查返工：持久化并展示给用户，不再只留在内存）。 */
  reviewIssues: string[];
  /** 手动编辑历史（追加版本，最新在前）；编辑后回到 draft。 */
  editHistory: Array<{ shortCopy: string; benefitText: string; reviewStatus: string; editedAt: string }>;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
}

/** 提炼提示词的输入事实（已通过证据门禁且可用）。 */
export interface DistillableFact {
  id: string;
  title: string;
  factText: string;
  evidenceQuote: string;
  pointType: string;
  riskLevel: string;
}

export function distillableFacts(revision: LibraryRevisionView): DistillableFact[] {
  return revision.sellingPoints
    .filter(isSellingPointEvidenceUsable)
    .map((point) => ({
      id: point.id,
      title: point.title,
      factText: point.factText,
      evidenceQuote: point.evidenceQuote || '',
      pointType: point.pointType,
      riskLevel: point.riskLevel,
    }));
}

export function buildDistillationPrompt(input: {
  facts: DistillableFact[];
  productName: string;
}): { systemPrompt: string; userPrompt: string } {
  const requirements = [
    '合并描述同一购买理由的事实；数字、适用部位、型号与颜色条件不同的事实不得合并',
    '把有证据的产品特征转成用户价值（购买理由），不得创造新功能、功效或承诺',
    '为每条提炼卖点写出独立的推荐短句（可直接用于字幕与便签），再生成 5/8/10 字符以内的标签',
    '标签计数包含数字、字母、标点与表情，逐个字符计入；无法在字符上限内保留关键范围时对应标签返回 null，不得截断或偷偷扩大承诺（如「框架20年质保」不可写成「20年质保」）',
    'role 取值：core=核心购买理由，supporting=支撑理由，spec=规格参数，atmosphere=氛围观感；氛围词默认归 atmosphere，不与具体功能事实混同',
    'sourceFactIds 必须且只能引用输入事实的 id，为空或包含未知 id 的条目会被整条丢弃',
    '输出的数字、材质、认证与功效措辞必须能在来源事实中找到；范围限定词（如「框架」「接触面」）不得扩大为整件商品',
  ];
  return {
    systemPrompt: '你是电商卖点编辑。只返回一个 JSON 对象（含 distilledPoints 数组），不输出解释。',
    userPrompt: JSON.stringify({
      task: 'distill_selling_points_v1',
      productName: input.productName,
      facts: input.facts.map((fact) => ({
        id: fact.id,
        title: fact.title,
        factText: fact.factText,
        evidenceQuote: fact.evidenceQuote,
        pointType: fact.pointType,
        riskLevel: fact.riskLevel,
      })),
      output: {
        distilledPoints: [{
          title: 'string；提炼卖点标题',
          benefitText: 'string；用户价值/购买理由，来自来源事实',
          shortCopy: 'string；推荐短句，可直接用于字幕与便签',
          tags: { max5: 'string|null；≤5 字符', max8: 'string|null；≤8 字符', max10: 'string|null；≤10 字符' },
          role: 'core|supporting|spec|atmosphere',
          priority: 'number；0-100，core 优先',
          scope: 'string；适用范围（如「框架」「接触面」「整件」），必须与来源事实一致',
          limitations: ['string；来源事实的限定条件'],
          sourceFactIds: ['string；输入事实 id'],
        }],
      },
      requirements,
    }),
  };
}

// ── 本地校验：声明落地、范围保护、标签字数、限定条件丢失、合并冲突 ──────

/** 范围扩大词：来源没有却出现在提炼结果里 → 不得自动通过（B5）。 */
const SCOPE_EXPANSION_TERMS = ['整件', '全件', '整体', '全部商品', '终身', '永久'];
/** 材质/功效/认证声明词：必须能在来源事实文本中找到（B5：鹅毛≠鹅绒、耐折≠防猫抓）。 */
const CLAIM_TERMS = [
  '鹅绒', '鸭绒', '羽绒', '真皮', '头层牛皮', '实木', '乳胶', '记忆棉', '食品级',
  '婴幼儿级', '抗菌', '抑菌', '防螨', '防霉', '防水', '阻燃', '防猫抓', '耐抓',
  '防滑', '耐磨', '抗皱', '认证', '专利', '零甲醛', '无甲醛', 'e0级', 'enf级',
];
/**
 * 范围限定词（审查 R3）：来源事实带限定词（如「框架质保」的「框架」）而提炼输出
 * 提到相关承诺（质保/材质/功效）却丢掉全部限定词 → 限定条件丢失，不得自动通过。
 */
const QUALIFIER_TERMS = [
  '框架', '接触面', '靠背', '腰托', '扶手', '座包', '坐垫', '座垫', '头枕', '颈枕',
  '脚凳', '内芯', '填充', '外罩', '外套', '面料', '底部', '底盘', '腿部', '门板',
  '抽屉', '层板', '背板', '侧板', '台面', '柜体', '椅背', '座框', '弹簧', '五金',
];
/** 触发限定词检查的承诺词：输出提到质保/材质/功效等承诺时才要求保留来源限定。 */
const COMMITMENT_PATTERN = /(质保|保修|包换|材质|牛皮|实木|乳胶|记忆棉|羽绒|鹅毛|鹅绒|抗菌|防螨|防水|阻燃|防猫抓|耐折|耐磨|防滑|承重|认证|甲醛)/;
const TAG_LIMITS = { max5: 5, max8: 8, max10: 10 } as const;

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/[\s\p{P}]+/gu, '').toLowerCase();
}

function digitsOf(value: string): string[] {
  return (value.match(/\d+(?:\.\d+)?/g) ?? []).sort();
}

/** 标签字符上限：所有字符逐个计入（数字、字母、标点、表情），不复用口播的忽略标点计数。 */
function fitTag(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return Array.from(trimmed).length <= limit ? trimmed : null;
}

export interface ValidatedDistilledPoint {
  title: string;
  benefitText: string;
  shortCopy: string;
  tags: { max5: string | null; max8: string | null; max10: string | null };
  role: DistilledPointRole;
  priority: number;
  scope: string;
  limitations: string[];
  sourceFactIds: string[];
  reviewStatus: DistilledReviewStatus;
  /** needs_review 的具体原因（不进入通过路径）。 */
  reviewIssues: string[];
}

export interface DistillationValidationResult {
  points: ValidatedDistilledPoint[];
  /** 因引用非法事实被整条丢弃的条数（B3：失败/禁用事实不得被提炼）。 */
  rejectedCount: number;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asString).filter(Boolean) : [];
}

/**
 * 解析并本地校验模型提炼输出：
 * - sourceFactIds 必须非空且全部属于可用事实集合，否则整条丢弃；
 * - 标签超出字符上限 → 置 null（范围不能安全保留时输出 null，不截断）；
 * - 数字/材质/功效/认证/范围扩大词无法回到来源事实 → needs_review，不自动通过（B5/B7）；
 * - 合并了「同名但数字不同」的来源事实 → needs_review（B1）。
 */
export function parseAndValidateDistilledPoints(
  raw: unknown,
  facts: DistillableFact[],
): DistillationValidationResult {
  const factById = new Map(facts.map((fact) => [fact.id, fact]));
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const items = Array.isArray(record.distilledPoints) ? record.distilledPoints : [];
  const points: ValidatedDistilledPoint[] = [];
  const seenShortCopy = new Set<string>();
  let rejectedCount = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const value = item as Record<string, unknown>;
    const sourceFactIds = [...new Set(asStringArray(value.sourceFactIds))];
    const title = asString(value.title);
    const benefitText = asString(value.benefitText);
    const shortCopy = asString(value.shortCopy);
    // 引用必须全部命中可用事实：失败证据、用户禁用与包外 ID 一律整条丢弃（B3）。
    if (!title || !benefitText || !shortCopy || sourceFactIds.length === 0) {
      rejectedCount += 1;
      continue;
    }
    if (!sourceFactIds.every((id) => factById.has(id))) {
      rejectedCount += 1;
      continue;
    }
    // 同一购买理由的重复短句只保留首条。
    const dedupeKey = normalizeText(shortCopy);
    if (seenShortCopy.has(dedupeKey)) continue;
    seenShortCopy.add(dedupeKey);

    // 标签先按字符上限归一（超限置 null，不截断），再与正文字段一起参与核验（R3）。
    const tags = {
      max5: fitTag((value.tags as Record<string, unknown> | undefined)?.max5, TAG_LIMITS.max5),
      max8: fitTag((value.tags as Record<string, unknown> | undefined)?.max8, TAG_LIMITS.max8),
      max10: fitTag((value.tags as Record<string, unknown> | undefined)?.max10, TAG_LIMITS.max10),
    };
    const sourceTexts = sourceFactIds.map((id) => {
      const fact = factById.get(id)!;
      return `${fact.title} ${fact.factText} ${fact.evidenceQuote}`;
    });
    const sourceJoined = normalizeText(sourceTexts.join(' '));
    // 审查 R3：可独立展示的标签与正文字段一样参与事实核验——
    // 「终身质保」「整件质保99年」这类标签不得绕过数字/承诺/范围检查。
    const tagTexts = [tags.max5, tags.max8, tags.max10].filter(Boolean).join(' ');
    const outputText = `${title} ${benefitText} ${shortCopy} ${tagTexts} ${asString(value.scope)}`;
    const reviewIssues: string[] = [];
    // 数字落地（B7）：提炼文本（含标签）中的数字必须出现在来源事实里。
    const outputDigits = digitsOf(normalizeText(outputText));
    const sourceDigitSet = new Set(digitsOf(sourceJoined));
    const unsupportedDigits = outputDigits.filter((digit) => !sourceDigitSet.has(digit));
    if (unsupportedDigits.length) reviewIssues.push(`数字未受来源支持：${[...new Set(unsupportedDigits)].join('、')}`);
    // 声明词落地（B5）。
    for (const term of CLAIM_TERMS) {
      if (outputText.includes(term) && !sourceJoined.includes(term)) {
        reviewIssues.push(`声明未受来源支持：${term}`);
      }
    }
    // 范围扩大（B5）：整件/终身等范围词来源没有 → 不得自动通过。
    for (const term of SCOPE_EXPANSION_TERMS) {
      if (outputText.includes(term) && !sourceJoined.includes(term)) {
        reviewIssues.push(`范围被扩大：${term}`);
      }
    }
    // 限定条件丢失（R3）：来源带范围限定词、输出提到相关承诺却丢掉全部限定 → 不得自动通过。
    // 例：「框架质保20年」的短句/标签写成「质保20年」，不得默认 scope 字段能补救。
    const sourceQualifiers = QUALIFIER_TERMS.filter((term) => sourceTexts.join(' ').includes(term));
    if (sourceQualifiers.length > 0 && COMMITMENT_PATTERN.test(outputText)) {
      const retained = sourceQualifiers.filter((term) => outputText.includes(term));
      if (retained.length === 0) {
        reviewIssues.push(`限定条件丢失：来源限定「${sourceQualifiers.join('、')}」在短句/标签中全部缺失`);
      }
    }
    // 合并冲突（B1）：同名但数字不同的来源事实不得被合并成一条购买理由。
    const byTitle = new Map<string, string[]>();
    for (const id of sourceFactIds) {
      const fact = factById.get(id)!;
      const key = normalizeText(fact.title);
      byTitle.set(key, [...(byTitle.get(key) ?? []), digitsOf(`${fact.title}${fact.factText}`).join(',')].sort());
    }
    for (const [key, digitSets] of byTitle) {
      if (digitSets.length > 1 && new Set(digitSets).size > 1) {
        reviewIssues.push(`合并了同名但参数不同的事实：${key}`);
      }
    }
    const role = ['core', 'supporting', 'spec', 'atmosphere'].includes(asString(value.role))
      ? asString(value.role) as DistilledPointRole
      : 'supporting';
    points.push({
      title,
      benefitText,
      shortCopy,
      tags,
      role,
      priority: Number.isFinite(Number(value.priority)) ? Math.max(0, Math.min(100, Math.round(Number(value.priority)))) : 50,
      scope: asString(value.scope),
      limitations: asStringArray(value.limitations),
      sourceFactIds,
      reviewStatus: reviewIssues.length ? 'needs_review' : 'draft',
      reviewIssues,
    });
  }
  return { points, rejectedCount };
}

// ── 持久化与缓存 ─────────────────────────────────────────────────────

export function distillationFingerprint(input: {
  projectId: string;
  sourceLibraryRevisionId: string;
  ruleVersion: string;
  providerId: string;
  model: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      projectId: input.projectId,
      sourceLibraryRevisionId: input.sourceLibraryRevisionId,
      ruleVersion: input.ruleVersion,
      providerId: input.providerId,
      model: input.model,
    }))
    .digest('hex');
}

function rowToRecord(row: Record<string, unknown>): DistilledSellingPointRecord {
  return {
    id: String(row.id),
    projectId: String(row.projectId),
    sourceLibraryRevisionId: String(row.sourceLibraryRevisionId),
    sourceFactIds: JSON.parse(String(row.sourceFactIdsJson || '[]')) as string[],
    ruleVersion: String(row.ruleVersion),
    providerId: String(row.providerId),
    model: String(row.model),
    title: String(row.title),
    benefitText: String(row.benefitText),
    shortCopy: String(row.shortCopy),
    tags: {
      max5: row.tagMax5 ? String(row.tagMax5) : null,
      max8: row.tagMax8 ? String(row.tagMax8) : null,
      max10: row.tagMax10 ? String(row.tagMax10) : null,
    },
    role: String(row.role) as DistilledPointRole,
    priority: Number(row.priority),
    scope: String(row.scope || ''),
    limitations: JSON.parse(String(row.limitationsJson || '[]')) as string[],
    reviewStatus: String(row.reviewStatus) as DistilledReviewStatus,
    reviewIssues: JSON.parse(String(row.reviewIssuesJson || '[]')) as string[],
    editHistory: JSON.parse(String(row.editHistoryJson || '[]')) as DistilledSellingPointRecord['editHistory'],
    fingerprint: String(row.fingerprint),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

export function saveDistilledPoints(
  db: Database.Database,
  input: {
    projectId: string;
    sourceLibraryRevisionId: string;
    providerId: string;
    model: string;
    fingerprint: string;
    points: ValidatedDistilledPoint[];
  },
  now: () => Date,
): DistilledSellingPointRecord[] {
  const createdAt = now().toISOString();
  const records = input.points.map((point) => ({
    id: randomUUID(),
    projectId: input.projectId,
    sourceLibraryRevisionId: input.sourceLibraryRevisionId,
    sourceFactIds: point.sourceFactIds,
    ruleVersion: SELLING_POINT_DISTILL_RULE_VERSION,
    providerId: input.providerId,
    model: input.model,
    title: point.title,
    benefitText: point.benefitText,
    shortCopy: point.shortCopy,
    tagMax5: point.tags.max5,
    tagMax8: point.tags.max8,
    tagMax10: point.tags.max10,
    role: point.role,
    priority: point.priority,
    scope: point.scope,
    limitationsJson: JSON.stringify(point.limitations),
    reviewStatus: point.reviewStatus,
    reviewIssuesJson: JSON.stringify(point.reviewIssues),
    editHistoryJson: '[]',
    fingerprint: input.fingerprint,
    createdAt,
    updatedAt: createdAt,
  }));
  const insert = db.prepare(`
    INSERT INTO script_studio_distilled_points
      (id, projectId, sourceLibraryRevisionId, sourceFactIdsJson, ruleVersion, providerId, model,
       title, benefitText, shortCopy, tagMax5, tagMax8, tagMax10, role, priority, scope,
       limitationsJson, reviewStatus, reviewIssuesJson, editHistoryJson, fingerprint, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (const record of records) {
      insert.run(
        record.id, record.projectId, record.sourceLibraryRevisionId,
        JSON.stringify(record.sourceFactIds), record.ruleVersion, record.providerId, record.model,
        record.title, record.benefitText, record.shortCopy,
        record.tagMax5, record.tagMax8, record.tagMax10,
        record.role, record.priority, record.scope,
        record.limitationsJson, record.reviewStatus, record.reviewIssuesJson, record.editHistoryJson,
        record.fingerprint,
        record.createdAt, record.updatedAt,
      );
    }
  }).immediate();
  return records.map((record) => rowToRecord(record as unknown as Record<string, unknown>));
}

/**
 * 手动编辑派生文案（方案 §3.3 / 审查补齐）：旧值追加进编辑历史（不丢失模型原始结果），
 * 应用新值后回到 draft——人工修改不保留旧批准，需重新显式确认。
 */
export function editDistilledPoint(
  db: Database.Database,
  projectId: string,
  distilledPointId: string,
  input: { shortCopy?: string; benefitText?: string },
  now: () => Date,
): DistilledSellingPointRecord | null {
  const row = db.prepare(`
    SELECT * FROM script_studio_distilled_points WHERE id = ? AND projectId = ?
  `).get(distilledPointId, projectId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const shortCopy = typeof input.shortCopy === 'string' && input.shortCopy.trim() ? input.shortCopy.trim() : undefined;
  const benefitText = typeof input.benefitText === 'string' && input.benefitText.trim() ? input.benefitText.trim() : undefined;
  if (!shortCopy && !benefitText) return null;
  const current = rowToRecord(row);
  const editedAt = now().toISOString();
  const historyEntry = {
    shortCopy: current.shortCopy,
    benefitText: current.benefitText,
    reviewStatus: current.reviewStatus,
    editedAt,
  };
  db.prepare(`
    UPDATE script_studio_distilled_points
    SET shortCopy = ?, benefitText = ?, reviewStatus = 'draft',
        editHistoryJson = ?, updatedAt = ?
    WHERE id = ? AND projectId = ?
  `).run(
    shortCopy ?? current.shortCopy,
    benefitText ?? current.benefitText,
    JSON.stringify([historyEntry, ...current.editHistory].slice(0, 20)),
    editedAt,
    distilledPointId,
    projectId,
  );
  const updated = db.prepare(`SELECT * FROM script_studio_distilled_points WHERE id = ?`).get(distilledPointId) as Record<string, unknown>;
  return rowToRecord(updated);
}

/** 缓存命中：同一项目 + 同一指纹的整批结果；复用不提升确认状态（B9）。 */
export function findCachedDistilledPoints(
  db: Database.Database,
  projectId: string,
  fingerprint: string,
): DistilledSellingPointRecord[] {
  const rows = db.prepare(`
    SELECT * FROM script_studio_distilled_points
    WHERE projectId = ? AND fingerprint = ?
    ORDER BY priority DESC, rowid
  `).all(projectId, fingerprint) as Array<Record<string, unknown>>;
  return rows.map(rowToRecord);
}

/** 某来源修订最新一批提炼结果（同指纹整批）。 */
export function listDistilledPointsForRevision(
  db: Database.Database,
  projectId: string,
  sourceLibraryRevisionId: string,
): DistilledSellingPointRecord[] {
  const latest = db.prepare(`
    SELECT fingerprint FROM script_studio_distilled_points
    WHERE projectId = ? AND sourceLibraryRevisionId = ?
    ORDER BY createdAt DESC, rowid DESC LIMIT 1
  `).get(projectId, sourceLibraryRevisionId) as { fingerprint: string } | undefined;
  if (!latest) return [];
  return findCachedDistilledPoints(db, projectId, latest.fingerprint);
}

export function listApprovedDistilledPoints(
  db: Database.Database,
  projectId: string,
  sourceLibraryRevisionId: string,
): DistilledSellingPointRecord[] {
  return listDistilledPointsForRevision(db, projectId, sourceLibraryRevisionId)
    .filter((point) => point.reviewStatus === 'approved');
}

/** 用户显式确认：draft/needs_review → approved（B8）。 */
export function approveDistilledPoint(
  db: Database.Database,
  projectId: string,
  distilledPointId: string,
  now: () => Date,
): DistilledSellingPointRecord | null {
  const result = db.prepare(`
    UPDATE script_studio_distilled_points
    SET reviewStatus = 'approved', updatedAt = ?
    WHERE id = ? AND projectId = ?
  `).run(now().toISOString(), distilledPointId, projectId);
  if (result.changes !== 1) return null;
  const row = db.prepare(`SELECT * FROM script_studio_distilled_points WHERE id = ?`).get(distilledPointId) as Record<string, unknown>;
  return rowToRecord(row);
}

export function countDistilledStatus(points: DistilledSellingPointRecord[]): {
  total: number;
  core: number;
  approved: number;
  needsReview: number;
  draft: number;
} {
  return {
    total: points.length,
    core: points.filter((point) => point.role === 'core').length,
    approved: points.filter((point) => point.reviewStatus === 'approved').length,
    needsReview: points.filter((point) => point.reviewStatus === 'needs_review').length,
    draft: points.filter((point) => point.reviewStatus === 'draft').length,
  };
}

// ── 提炼器适配（生产路径） ───────────────────────────────────────────

export interface SellingPointDistiller {
  readonly providerId: string;
  readonly model: string;
  /** signal 贯通到 completeJson（审查 R5）：用户停止/停机时提炼请求一并取消。 */
  distill(input: { facts: DistillableFact[]; productName: string; signal?: AbortSignal }): Promise<unknown>;
}

export function createSellingPointDistiller(
  completeJson: ScriptStudioCompleteJson,
  provider: { id: string; model: string },
  options: { maxTokens?: number } = {},
): SellingPointDistiller {
  return {
    providerId: provider.id,
    model: provider.model,
    async distill(input) {
      const prompt = buildDistillationPrompt(input);
      return completeJson({
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        temperature: 1,
        maxTokens: options.maxTokens ?? 8000,
        signal: input.signal,
      });
    },
  };
}

/** 生成提示词使用的已确认提炼表达（短句只是表达参考，不是新的事实来源）。 */
export interface DistilledExpressionRef {
  id: string;
  sourceFactIds: string[];
  shortCopy: string;
  benefitText: string;
  scope: string;
  limitations: string[];
}

export function distilledExpressionRefs(
  points: DistilledSellingPointRecord[],
): DistilledExpressionRef[] {
  return points
    .filter((point) => point.reviewStatus === 'approved')
    .sort((a, b) => b.priority - a.priority)
    .map((point) => ({
      id: point.id,
      sourceFactIds: point.sourceFactIds,
      shortCopy: point.shortCopy,
      benefitText: point.benefitText,
      scope: point.scope,
      limitations: point.limitations,
    }));
}

/** 事实可用性与提炼输入一致性守卫（供测试与 runner 共用）。 */
export function distillableFactIds(revision: LibraryRevisionView): Set<string> {
  return new Set(revision.sellingPoints.filter(isSellingPointEvidenceUsable).map((point) => point.id));
}

export type { SellingPointRecord };

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  ScriptStudioError,
} from './errors.ts';
import {
  canonicalThemeKey,
  evidenceRefsOfRecord,
  normalizeEvidenceRefs,
  normalizeHierarchyRole,
  normalizeImportance,
  primaryPageIndexOf,
} from './selling-point-normalize.ts';
import type {
  LibraryRecord,
  LibraryRevisionRecord,
  SellingPointEvidenceRef,
  SellingPointRecord,
  ScriptStudioEvidenceGate,
  ScriptStudioHierarchyRole,
  ScriptStudioPointType,
  ScriptStudioRiskLevel,
} from './types.ts';

export interface LibrarySellingPointInput {
  title: string;
  factText: string;
  pointType: ScriptStudioPointType;
  evidenceQuote?: string;
  sourcePageIndex?: number | null;
  tileRefs?: string[];
  modelConfidence?: string;
  riskLevel?: ScriptStudioRiskLevel;
  evidenceGate?: ScriptStudioEvidenceGate;
  usable?: boolean;
  disabledByUser?: boolean;
  themeKey?: string;
  themeTitle?: string;
  hierarchyRole?: ScriptStudioHierarchyRole;
  importance?: number;
  evidenceRefs?: SellingPointEvidenceRef[];
}

export interface CreateLibraryRevisionInput {
  projectId: string;
  sourceSetId: string;
  sourceFingerprint: string;
  productName?: string;
  category?: string;
  brand?: string;
  extractProviderId?: string;
  extractModel?: string;
  promptContractVersion?: number;
  origin?: 'extraction' | 'manual_edit';
  sellingPoints: LibrarySellingPointInput[];
}

export interface LibraryRevisionView extends LibraryRevisionRecord {
  sellingPoints: SellingPointRecord[];
}

function nowIso(now?: () => Date): string {
  const clock = typeof now === 'function' ? now : () => new Date();
  return clock().toISOString();
}

export function getOrCreateLibrary(
  db: Database.Database,
  projectId: string,
  now?: () => Date,
): LibraryRecord {
  const existing = db.prepare(`
    SELECT id, projectId, currentRevisionId, createdAt, updatedAt
    FROM script_studio_libraries WHERE projectId = ?
    ORDER BY createdAt LIMIT 1
  `).get(projectId) as LibraryRecord | undefined;
  if (existing) return existing;
  const createdAt = nowIso(now);
  const library: LibraryRecord = {
    id: randomUUID(),
    projectId,
    currentRevisionId: null,
    createdAt,
    updatedAt: createdAt,
  };
  db.prepare(`
    INSERT INTO script_studio_libraries (id, projectId, currentRevisionId, createdAt, updatedAt)
    VALUES (?, ?, NULL, ?, ?)
  `).run(library.id, projectId, createdAt, createdAt);
  return library;
}

export function createLibraryRevision(
  db: Database.Database,
  input: CreateLibraryRevisionInput,
  now?: () => Date,
): LibraryRevisionView {
  const library = getOrCreateLibrary(db, input.projectId, now);
  if (input.sellingPoints.length === 0) {
    throw new ScriptStudioError('invalid_input', '卖点库修订至少需要一条卖点');
  }
  return db.transaction(() => {
    const revisionRow = db.prepare(`
      SELECT COALESCE(MAX(revisionNumber), 0) AS revisionNumber
      FROM script_studio_library_revisions WHERE libraryId = ?
    `).get(library.id) as { revisionNumber: number };
    const revisionNumber = Number(revisionRow.revisionNumber) + 1;
    const id = randomUUID();
    const createdAt = nowIso(now);
    db.prepare(`
      INSERT INTO script_studio_library_revisions
        (id, libraryId, revisionNumber, sourceSetId, sourceFingerprint, productName, category, brand,
         extractProviderId, extractModel, promptContractVersion, origin, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      library.id,
      revisionNumber,
      input.sourceSetId,
      input.sourceFingerprint,
      input.productName || '',
      input.category || '',
      input.brand || '',
      input.extractProviderId || '',
      input.extractModel || '',
      Number(input.promptContractVersion || 1),
      input.origin || 'extraction',
      createdAt,
    );
    input.sellingPoints.forEach((point, index) => {
      const title = point.title.trim();
      // 证据定位以 pageIndex + tileRef 配对结构持久化；旧 sourcePageIndex/tileRefsJson
      // 两列由配对结构派生，仅供老读取方兼容，不再作为权威来源。
      const evidenceRefs = normalizeEvidenceRefs(point);
      const primaryPage = primaryPageIndexOf(evidenceRefs);
      const themeTitle = point.themeTitle?.trim() || title;
      // themeKey 一律由本地按 pageIndex + 规范化标题生成；模型 themeKey 仅作辅助输入。
      const themeKey = canonicalThemeKey({
        pageIndex: primaryPage,
        themeTitle,
        modelThemeKey: point.themeKey,
        pointType: point.pointType,
      });
      db.prepare(`
        INSERT INTO script_studio_selling_points
          (id, revisionId, seq, title, factText, pointType, evidenceQuote, sourcePageIndex,
           tileRefsJson, modelConfidence, riskLevel, evidenceGate, usable, disabledByUser,
           themeKey, themeTitle, hierarchyRole, importance, evidenceRefsJson)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        id,
        index + 1,
        title,
        point.factText.trim(),
        point.pointType,
        point.evidenceQuote || '',
        primaryPage,
        JSON.stringify(evidenceRefs.map((ref) => ref.tileRef).filter(Boolean)),
        point.modelConfidence || '',
        point.riskLevel || 'low',
        point.evidenceGate || 'skipped',
        point.usable === false ? 0 : 1,
        point.disabledByUser === true ? 1 : 0,
        themeKey,
        themeTitle,
        normalizeHierarchyRole(point.hierarchyRole),
        normalizeImportance(point.importance),
        JSON.stringify(evidenceRefs),
      );
    });
    db.prepare(`
      UPDATE script_studio_libraries SET currentRevisionId = ?, updatedAt = ? WHERE id = ?
    `).run(id, createdAt, library.id);
    return getLibraryRevision(db, input.projectId, id)!;
  }).immediate();
}

export function getLibraryRevision(
  db: Database.Database,
  projectId: string,
  revisionId: string,
): LibraryRevisionView | undefined {
  const row = db.prepare(`
    SELECT r.* FROM script_studio_library_revisions r
    JOIN script_studio_libraries l ON l.id = r.libraryId
    WHERE r.id = ? AND l.projectId = ?
  `).get(revisionId, projectId) as LibraryRevisionRecord | undefined;
  if (!row) return undefined;
  const sellingPoints = db.prepare(`
    SELECT * FROM script_studio_selling_points
    WHERE revisionId = ? ORDER BY seq
  `).all(revisionId) as SellingPointRecord[];
  return { ...row, sellingPoints };
}

export function getCurrentLibraryRevision(
  db: Database.Database,
  projectId: string,
): LibraryRevisionView | undefined {
  const library = db.prepare(`
    SELECT id, currentRevisionId FROM script_studio_libraries WHERE projectId = ?
  `).get(projectId) as { id: string; currentRevisionId: string | null } | undefined;
  if (!library?.currentRevisionId) return undefined;
  return getLibraryRevision(db, projectId, library.currentRevisionId);
}

export function manualEditLibraryRevision(
  db: Database.Database,
  projectId: string,
  edits: Array<{
    sellingPointId: string;
    usable?: boolean;
    disabledByUser?: boolean;
    factText?: string;
    title?: string;
  }>,
  options: { now?: () => Date } = {},
): LibraryRevisionView {
  const current = getCurrentLibraryRevision(db, projectId);
  if (!current) throw new ScriptStudioError('not_found', '当前项目没有可编辑的卖点库');
  const byId = new Map(current.sellingPoints.map((point) => [point.id, point]));
  const nextPoints = current.sellingPoints.map((point) => {
    const edit = edits.find((item) => item.sellingPointId === point.id);
    if (!edit) return point;
    const target = byId.get(point.id)!;
    return {
      ...target,
      title: typeof edit.title === 'string' ? edit.title : target.title,
      factText: typeof edit.factText === 'string' ? edit.factText : target.factText,
      usable: typeof edit.usable === 'boolean' ? (edit.usable ? 1 : 0) : target.usable,
      disabledByUser: typeof edit.disabledByUser === 'boolean' ? (edit.disabledByUser ? 1 : 0) : target.disabledByUser,
    };
  });
  return createLibraryRevision(db, {
    projectId,
    sourceSetId: current.sourceSetId,
    sourceFingerprint: current.sourceFingerprint,
    productName: current.productName,
    category: current.category,
    brand: current.brand,
    extractProviderId: current.extractProviderId,
    extractModel: current.extractModel,
    promptContractVersion: current.promptContractVersion,
    origin: 'manual_edit',
    sellingPoints: nextPoints.map((point) => ({
      title: point.title,
      factText: point.factText,
      pointType: point.pointType,
      evidenceQuote: point.evidenceQuote,
      sourcePageIndex: point.sourcePageIndex,
      tileRefs: Array.isArray(JSON.parse(point.tileRefsJson || '[]')) ? JSON.parse(point.tileRefsJson) : [],
      modelConfidence: point.modelConfidence,
      riskLevel: point.riskLevel,
      evidenceGate: point.evidenceGate,
      usable: point.usable === 1,
      disabledByUser: point.disabledByUser === 1,
      themeKey: point.themeKey,
      themeTitle: point.themeTitle,
      hierarchyRole: point.hierarchyRole,
      importance: point.importance,
      evidenceRefs: evidenceRefsOfRecord(point),
    })),
  }, options.now);
}

export function listLibraryRevisions(
  db: Database.Database,
  projectId: string,
  options: { cursor?: string; limit?: number } = {},
): { revisions: Array<Pick<LibraryRevisionRecord, 'id' | 'revisionNumber' | 'createdAt'>>; nextCursor: string | null } {
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 50));
  const rows = db.prepare(`
    SELECT r.id, r.revisionNumber, r.createdAt
    FROM script_studio_library_revisions r
    JOIN script_studio_libraries l ON l.id = r.libraryId
    WHERE l.projectId = ? AND (? = '' OR r.id > ?)
    ORDER BY r.revisionNumber DESC
    LIMIT ?
  `).all(projectId, options.cursor || '', options.cursor || '', limit) as Array<{ id: string; revisionNumber: number; createdAt: string }>;
  return {
    revisions: rows,
    nextCursor: rows.length === limit ? rows[rows.length - 1]!.id : null,
  };
}

export function libraryHasRevisionForFingerprint(
  db: Database.Database,
  projectId: string,
  contentFingerprint: string,
): { current: LibraryRevisionView } | null {
  const current = getCurrentLibraryRevision(db, projectId);
  if (!current || current.sourceFingerprint !== contentFingerprint) return null;
  return { current };
}

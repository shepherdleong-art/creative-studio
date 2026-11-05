import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { requireAccessContext } from '../media-core/access-context.ts';
import { ScriptStudioError } from './errors.ts';
import { assertXlsxBuffer } from './catalog-import/index.ts';
import { loadWorkbook, sheetToWorkbookSheet } from './catalog-import/workbook.ts';
import {
  parseViralTemplateWorkbook,
  type ViralTemplateImportReport,
} from './catalog-import/viral-templates.ts';
import {
  findTeamViralTemplateLibrary,
  TEAM_VIRAL_TEMPLATE_OWNER_KEY,
  type ViralTemplateLibraryRecord,
  type ViralTemplateRevisionRecord,
} from './viral-templates.ts';

/**
 * 团队公共爆文模板库的发布编排（票 01 / 规格 §3）。
 *
 * 与个人导入（importViralTemplateLibrary）的关键差异：
 * - 团队库身份唯一且显式（ownerKey = TEAM_VIRAL_TEMPLATE_OWNER_KEY），
 *   绝不把「管理员当前个人库」当团队库；
 * - 发布是**原子单事务**：修订 + 全部条目 + 当前指针一次写入；
 *   任何一步失败都不会留下半个版本，旧团队版本仍完整可用；
 * - 支持三种来源：上传文件、既有团队修订重激活、既有个人修订复制发布；
 * - 用 sourceSha256 与条目内容指纹去重；旧内容重导时明确激活该版本
 *   （activated=true），不只回 created:false 就误报完成；
 * - baseRevisionId 做当前指针 CAS，并发发布冲突可见（conflict）。
 */

export const TEAM_VIRAL_TEMPLATE_MAX_BYTES = 32 * 1024 * 1024;

/** 团队模板库唯一发布入口（前端与旧个人导入路由此端点引导管理员）。 */
export const TEAM_VIRAL_TEMPLATE_PUBLISH_ENDPOINT = '/api/team/public-resources/viral-templates';

function nowIso(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}

function requireManageableAccess(resourceId: string, action: 'read' | 'write'): void {
  const access = requireAccessContext();
  if (access.kind === 'local') return;
  if (access.actor.role !== 'admin') {
    throw new ScriptStudioError('forbidden', '只有管理员可以维护团队公共爆文模板库。');
  }
  access.assertAccess('viral_template_library', resourceId, action);
}

/** 团队库（不存在就创建）。唯一性由 schema v13 的部分唯一索引保证。 */
export function ensureTeamViralTemplateLibrary(db: Database.Database, now?: () => Date): ViralTemplateLibraryRecord {
  const access = requireAccessContext();
  if (access.kind === 'team' && access.actor.role !== 'admin') {
    throw new ScriptStudioError('forbidden', '只有管理员可以创建团队公共爆文模板库。');
  }
  const existing = findTeamViralTemplateLibrary(db);
  if (existing) return existing;
  const id = randomUUID();
  const ts = nowIso(now);
  const create = db.transaction(() => {
    db.prepare(`
      INSERT INTO script_studio_viral_tpl_libraries (id, currentRevisionId, ownerKey, createdAt, updatedAt)
      VALUES (?, NULL, ?, ?, ?)
    `).run(id, TEAM_VIRAL_TEMPLATE_OWNER_KEY, ts, ts);
    if (access.kind === 'team') {
      access.registerRootScope({
        resourceType: 'viral_template_library', resourceId: id,
        ownerUserId: access.actor.userId, visibility: 'public',
      });
    }
  });
  create.immediate();
  return findTeamViralTemplateLibrary(db)!;
}

export interface TeamViralTemplateRevisionView extends ViralTemplateRevisionRecord {
  current: boolean;
  entryCount: number;
  entryCounts: { total: number; usable: number; unusable: number; review: number };
}

export interface TeamViralTemplateLibraryView {
  libraryId: string;
  current: TeamViralTemplateRevisionView | null;
  revisions: TeamViralTemplateRevisionView[];
  /**
   * 可发布但尚未进入团队库的既有修订（历史个人修订等）。
   * 管理员按文件名/版本/条目数识别并显式发布，不需要手填资源 ID。
   */
  candidates: Array<{
    revisionId: string;
    sourceFilename: string;
    revisionNumber: number;
    entryCount: number;
    createdAt: string;
    libraryOwner: 'personal' | 'team';
  }>;
}

function entryCountsFor(db: Database.Database, revisionId: string): TeamViralTemplateRevisionView['entryCounts'] {
  const counts = db.prepare(`
    SELECT status, COUNT(*) AS count FROM script_studio_viral_tpl_entries WHERE revisionId = ? GROUP BY status
  `).all(revisionId) as Array<{ status: 'usable' | 'unusable' | 'review'; count: number }>;
  const entryCounts = { total: 0, usable: 0, unusable: 0, review: 0 };
  for (const row of counts) {
    entryCounts[row.status] = Number(row.count);
    entryCounts.total += Number(row.count);
  }
  return entryCounts;
}

/** 管理视图：当前团队版本、全部历史版本，以及可发布的既有修订候选。 */
export function getTeamViralTemplateView(db: Database.Database): TeamViralTemplateLibraryView {
  const library = findTeamViralTemplateLibrary(db);
  if (!library) {
    return { libraryId: '', current: null, revisions: [], candidates: buildCandidates(db, null) };
  }
  requireManageableAccess(library.id, 'read');
  const revisions = (db.prepare(`
    SELECT r.*, (SELECT COUNT(*) FROM script_studio_viral_tpl_entries e WHERE e.revisionId = r.id) AS entryCount
    FROM script_studio_viral_tpl_revisions r WHERE r.libraryId = ? ORDER BY r.revisionNumber DESC
  `).all(library.id) as Array<ViralTemplateRevisionRecord & { current: boolean; entryCount: number }>)
    .map((row) => ({
      ...row,
      current: row.id === library.currentRevisionId,
      entryCount: Number(row.entryCount),
      entryCounts: entryCountsFor(db, row.id),
    }));
  return {
    libraryId: library.id,
    current: revisions.find((revision) => revision.current) ?? null,
    revisions,
    candidates: buildCandidates(db, library.id),
  };
}

function buildCandidates(db: Database.Database, teamLibraryId: string | null): TeamViralTemplateLibraryView['candidates'] {
  const rows = db.prepare(`
    SELECT r.id AS revisionId, r.sourceFilename, r.revisionNumber, r.createdAt,
           l.ownerKey AS ownerKey, l.id AS libraryId,
           (SELECT COUNT(*) FROM script_studio_viral_tpl_entries e WHERE e.revisionId = r.id) AS entryCount
    FROM script_studio_viral_tpl_revisions r
    JOIN script_studio_viral_tpl_libraries l ON l.id = r.libraryId
    WHERE (? IS NULL OR l.id <> ?)
    ORDER BY r.createdAt DESC, r.revisionNumber DESC
    LIMIT 200
  `).all(teamLibraryId, teamLibraryId) as Array<{
    revisionId: string; sourceFilename: string; revisionNumber: number; createdAt: string;
    ownerKey: string; libraryId: string; entryCount: number;
  }>;
  return rows.map((row) => ({
    revisionId: row.revisionId,
    sourceFilename: row.sourceFilename,
    revisionNumber: Number(row.revisionNumber),
    entryCount: Number(row.entryCount),
    createdAt: row.createdAt,
    libraryOwner: row.ownerKey === TEAM_VIRAL_TEMPLATE_OWNER_KEY ? 'team' : 'personal',
  }));
}

export interface PublishTeamViralTemplateInput {
  /** 上传的新文件（与 revisionId 二选一）。 */
  buffer?: Buffer;
  sourceFilename?: string;
  /** 从既有修订发布（历史个人修订或旧团队修订）；内部 ID 由程序传递。 */
  revisionId?: string;
  /** 管理员看到的当前团队版本；用于并发 CAS。null/undefined 表示「认定团队尚无版本」。 */
  baseRevisionId?: string | null;
  now?: () => Date;
}

export interface PublishTeamViralTemplateResult {
  libraryId: string;
  revisionId: string;
  revisionNumber: number;
  sourceFilename: string;
  created: boolean;
  /** true 表示本次调用改变了团队当前指针（含「旧内容重导后明确激活」）。 */
  activated: boolean;
  report: ViralTemplateImportReport;
}

/**
 * 原子发布：一个 immediate 事务内完成「校验基准 → 写入修订与条目 → 切换当前指针」。
 * 失败时整体回滚，旧团队版本保持完整可用。
 */
export async function publishTeamViralTemplate(
  db: Database.Database,
  input: PublishTeamViralTemplateInput,
): Promise<PublishTeamViralTemplateResult> {
  const access = requireAccessContext();
  if (access.kind === 'team' && access.actor.role !== 'admin') {
    throw new ScriptStudioError('forbidden', '只有管理员可以发布团队公共爆文模板库。');
  }
  const hasBuffer = Buffer.isBuffer(input.buffer);
  const revisionIdInput = typeof input.revisionId === 'string' ? input.revisionId.trim() : '';
  if (hasBuffer === Boolean(revisionIdInput)) {
    throw new ScriptStudioError('invalid_input', '发布必须提供上传文件或既有修订之一。');
  }

  // ---- 事务外：解析/读取源内容（失败不触碰数据库） ----
  let parsed: { report: ViralTemplateImportReport; sourceFilename: string; sourceSha256: string;
    entries: Array<{
      sourceTemplateId: string; scriptCode?: string; category: string; subCategory: string; name: string;
      title: string; refText: string; structureRaw: string; structureSummary: string; structure: string;
      structureOrigin: 'source' | 'fallback'; rawColumns: Record<string, string>; sourceSheet: string;
      sourceRow: number; contentHash: string; status: 'usable' | 'unusable' | 'review'; statusReason: string;
    }> } | null = null;
  let sourceRevision: ViralTemplateRevisionRecord | null = null;

  if (hasBuffer) {
    const buffer = input.buffer!;
    if (buffer.byteLength > TEAM_VIRAL_TEMPLATE_MAX_BYTES) {
      throw new ScriptStudioError('invalid_input', `模板文件超过 ${Math.round(TEAM_VIRAL_TEMPLATE_MAX_BYTES / 1024 / 1024)} MiB 上限`);
    }
    assertXlsxBuffer(buffer);
    const workbook = await loadWorkbook(buffer);
    const sheets = workbook.worksheets.map((worksheet) => sheetToWorkbookSheet(worksheet));
    const result = parseViralTemplateWorkbook(sheets);
    if (!result.report.canActivate) {
      throw new ScriptStudioError('invalid_input',
        result.report.issues.map((issue) => issue.message).join('；') || '没有可发布的模板');
    }
    if (result.entries.length === 0) {
      throw new ScriptStudioError('invalid_input', '文件里没有可用的模板条目，团队当前版本保持不变。');
    }
    if (!result.entries.some((entry) => entry.status === 'usable')) {
      throw new ScriptStudioError('invalid_input', '文件里没有可推荐的模板条目（全为占位或待检查），团队当前版本保持不变。');
    }
    const { createHash } = await import('node:crypto');
    parsed = {
      report: result.report,
      sourceFilename: input.sourceFilename?.trim() || '爆文模板库.xlsx',
      sourceSha256: createHash('sha256').update(buffer).digest('hex'),
      entries: result.entries,
    };
  } else {
    sourceRevision = (db.prepare(`
      SELECT r.*, l.ownerKey AS libraryOwnerKey FROM script_studio_viral_tpl_revisions r
      JOIN script_studio_viral_tpl_libraries l ON l.id = r.libraryId WHERE r.id = ?
    `).get(revisionIdInput) as (ViralTemplateRevisionRecord & { libraryOwnerKey: string }) | undefined) ?? null;
    if (!sourceRevision) throw new ScriptStudioError('not_found', '要发布的模板修订不存在。');
    // 只能发布自己能读到的修订；跨员工私人修订一律不可见。
    try {
      access.assertAccess('viral_template_revision', sourceRevision.id, 'read');
    } catch {
      throw new ScriptStudioError('not_found', '要发布的模板修订不存在。');
    }
    const entries = db.prepare(`
      SELECT * FROM script_studio_viral_tpl_entries WHERE revisionId = ? ORDER BY sourceRow, id
    `).all(sourceRevision.id) as Array<{
      sourceTemplateId: string; category: string; subCategory: string; name: string; title: string;
      refText: string; structureRaw: string; structureSummary: string; structure: string;
      structureOrigin: 'source' | 'fallback'; rawColumnsJson: string; sourceSheet: string; sourceRow: number;
      contentHash: string; status: 'usable' | 'unusable' | 'review'; statusReason: string;
    }>;
    if (entries.length === 0) {
      throw new ScriptStudioError('invalid_input', '该修订没有条目，团队当前版本保持不变。');
    }
    if (!entries.some((entry) => entry.status === 'usable')) {
      throw new ScriptStudioError('invalid_input', '该修订没有可用条目，团队当前版本保持不变。');
    }
    let report = {} as ViralTemplateImportReport;
    try { report = JSON.parse(sourceRevision.importReportJson) as ViralTemplateImportReport; } catch { /* 空报告 */ }
    parsed = {
      report,
      sourceFilename: sourceRevision.sourceFilename,
      sourceSha256: sourceRevision.sourceSha256,
      entries: entries.map((entry) => ({
        sourceTemplateId: entry.sourceTemplateId,
        category: entry.category,
        subCategory: entry.subCategory,
        name: entry.name,
        title: entry.title,
        refText: entry.refText,
        structureRaw: entry.structureRaw,
        structureSummary: entry.structureSummary,
        structure: entry.structure,
        structureOrigin: entry.structureOrigin,
        rawColumns: JSON.parse(entry.rawColumnsJson || '{}') as Record<string, string>,
        sourceSheet: entry.sourceSheet,
        sourceRow: entry.sourceRow,
        contentHash: entry.contentHash,
        status: entry.status,
        statusReason: entry.statusReason,
      })),
    };
  }

  const ts = nowIso(input.now);

  // ---- 事务内：全部校验与写入，任何失败整体回滚 ----
  const publish = db.transaction((): PublishTeamViralTemplateResult => {
    const library = findTeamViralTemplateLibrary(db) ?? ensureTeamViralTemplateLibraryInTransaction(db, access, ts);
    requireManageableAccessInTransaction(access, library.id, 'write');
    const baseRevisionId = input.baseRevisionId ?? null;
    if ((library.currentRevisionId ?? null) !== (baseRevisionId ?? null)) {
      throw new ScriptStudioError(
        'conflict',
        '团队模板版本已被其他管理员更新，请刷新后重新确认发布。',
      );
    }

    // 同内容去重：已在团队库里的同一指纹不新增修订。
    const existing = db.prepare(`
      SELECT id FROM script_studio_viral_tpl_revisions WHERE libraryId = ? AND sourceSha256 = ?
    `).get(library.id, parsed!.sourceSha256) as { id: string } | undefined;
    if (existing) {
      const changed = (library.currentRevisionId ?? null) !== existing.id;
      if (changed) activateRevision(db, library.id, existing.id, ts);
      return {
        libraryId: library.id,
        revisionId: existing.id,
        revisionNumber: revisionNumberFor(db, existing.id),
        sourceFilename: sourceRevisionFilename(db, existing.id) ?? parsed!.sourceFilename,
        created: false,
        activated: changed,
        report: parsed!.report,
      };
    }

    const revisionId = randomUUID();
    const numberRow = db.prepare(`
      SELECT COALESCE(MAX(revisionNumber), 0) + 1 AS next FROM script_studio_viral_tpl_revisions WHERE libraryId = ?
    `).get(library.id) as { next: number };
    db.prepare(`
      INSERT INTO script_studio_viral_tpl_revisions
        (id, libraryId, revisionNumber, sourceFilename, sourceSha256, importReportJson, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      revisionId, library.id, Number(numberRow.next), parsed!.sourceFilename,
      parsed!.sourceSha256, JSON.stringify(parsed!.report), ts,
    );
    if (access.kind === 'team') {
      access.registerInheritedScope({
        resourceType: 'viral_template_revision', resourceId: revisionId,
        parent: { resourceType: 'viral_template_library', resourceId: library.id },
        visibility: 'public',
      });
    }
    const insertEntry = db.prepare(`
      INSERT INTO script_studio_viral_tpl_entries
        (id, revisionId, sourceTemplateId, category, subCategory, name, title, refText,
         structureRaw, structureSummary, structure, structureOrigin, rawColumnsJson,
         sourceSheet, sourceRow, sourceFileSha256, contentHash, status, statusReason, statusUpdatedBy, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?)
    `);
    for (const entry of parsed!.entries) {
      const entryId = randomUUID();
      insertEntry.run(
        entryId, revisionId, entry.sourceTemplateId, entry.category, entry.subCategory,
        entry.name, entry.title, entry.refText, entry.structureRaw, entry.structureSummary,
        entry.structure, entry.structureOrigin, JSON.stringify(entry.rawColumns),
        entry.sourceSheet, entry.sourceRow, parsed!.sourceSha256, entry.contentHash,
        entry.status, entry.statusReason, ts,
      );
      if (access.kind === 'team') {
        access.registerInheritedScope({
          resourceType: 'viral_template_entry', resourceId: entryId,
          parent: { resourceType: 'viral_template_revision', resourceId: revisionId },
          visibility: 'public',
        });
      }
    }
    activateRevision(db, library.id, revisionId, ts);
    return {
      libraryId: library.id,
      revisionId,
      revisionNumber: Number(numberRow.next),
      sourceFilename: parsed!.sourceFilename,
      created: true,
      activated: true,
      report: parsed!.report,
    };
  });
  return publish.immediate();
}

/** 事务内首次建库（避免并发首发布各建一个团队库）。 */
function ensureTeamViralTemplateLibraryInTransaction(
  db: Database.Database,
  access: ReturnType<typeof requireAccessContext>,
  ts: string,
): ViralTemplateLibraryRecord {
  const existing = findTeamViralTemplateLibrary(db);
  if (existing) return existing;
  const id = randomUUID();
  db.prepare(`
    INSERT INTO script_studio_viral_tpl_libraries (id, currentRevisionId, ownerKey, createdAt, updatedAt)
    VALUES (?, NULL, ?, ?, ?)
  `).run(id, TEAM_VIRAL_TEMPLATE_OWNER_KEY, ts, ts);
  if (access.kind === 'team') {
    access.registerRootScope({
      resourceType: 'viral_template_library', resourceId: id,
      ownerUserId: access.actor.userId, visibility: 'public',
    });
  }
  return findTeamViralTemplateLibrary(db)!;
}

function requireManageableAccessInTransaction(
  access: ReturnType<typeof requireAccessContext>,
  libraryId: string,
  action: 'read' | 'write',
): void {
  if (access.kind === 'local') return;
  if (access.actor.role !== 'admin') {
    throw new ScriptStudioError('forbidden', '只有管理员可以维护团队公共爆文模板库。');
  }
  access.assertAccess('viral_template_library', libraryId, action);
}

function activateRevision(db: Database.Database, libraryId: string, revisionId: string, ts: string): void {
  db.prepare(`
    UPDATE script_studio_viral_tpl_libraries SET currentRevisionId = ?, updatedAt = ? WHERE id = ?
  `).run(revisionId, ts, libraryId);
}

function revisionNumberFor(db: Database.Database, revisionId: string): number {
  const row = db.prepare('SELECT revisionNumber FROM script_studio_viral_tpl_revisions WHERE id = ?')
    .get(revisionId) as { revisionNumber: number } | undefined;
  return Number(row?.revisionNumber ?? 0);
}

function sourceRevisionFilename(db: Database.Database, revisionId: string): string | null {
  const row = db.prepare('SELECT sourceFilename FROM script_studio_viral_tpl_revisions WHERE id = ?')
    .get(revisionId) as { sourceFilename: string } | undefined;
  return row?.sourceFilename ?? null;
}

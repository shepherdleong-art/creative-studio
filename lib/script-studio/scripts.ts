import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ScriptStudioError } from './errors.ts';
import type {
  ProjectScriptOrigin,
  ProjectScriptRecord,
  ProjectScriptRevisionRecord,
} from './types.ts';

export interface ProjectScriptRevisionInput {
  generationTaskId?: string | null;
  libraryRevisionId?: string | null;
  templateId?: string;
  templateVersion?: number;
  templateRationale?: string;
  origin: ProjectScriptOrigin;
  contentJson: Record<string, unknown>;
  targetDurationSec: number;
  estimatedDurationSec?: number | null;
  validationJson?: Record<string, unknown>;
  /** 知识/模板目录来源追溯（方案 §2.8 / §5.2）。 */
  strategyCatalogRevisionId?: string;
  strategyEntryId?: string;
  templateCatalogRevisionId?: string;
  recommendationJson?: Record<string, unknown>;
}

export interface ProjectScriptWithRevision extends ProjectScriptRecord {
  currentRevision: ProjectScriptRevisionRecord | null;
}

function nowIso(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}

function insertRevision(
  db: Database.Database,
  scriptId: string,
  input: ProjectScriptRevisionInput,
  createdAt: string,
): ProjectScriptRevisionRecord {
  const row = db.prepare(`
    SELECT COALESCE(MAX(revisionNumber), 0) AS revisionNumber
    FROM project_script_revisions WHERE scriptId = ?
  `).get(scriptId) as { revisionNumber: number };
  const revisionNumber = Number(row.revisionNumber) + 1;
  const id = randomUUID();
  db.prepare(`
    INSERT INTO project_script_revisions
      (id, scriptId, revisionNumber, generationTaskId, libraryRevisionId, templateId, templateVersion,
       templateRationale, origin, contentJson, targetDurationSec, estimatedDurationSec, validationJson, createdAt,
       strategyCatalogRevisionId, strategyEntryId, templateCatalogRevisionId, recommendationJson)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    scriptId,
    revisionNumber,
    input.generationTaskId || null,
    input.libraryRevisionId || null,
    input.templateId || '',
    Number(input.templateVersion || 1),
    input.templateRationale || '',
    input.origin,
    JSON.stringify(input.contentJson),
    Number(input.targetDurationSec),
    input.estimatedDurationSec == null ? null : Number(input.estimatedDurationSec),
    JSON.stringify(input.validationJson || {}),
    createdAt,
    input.strategyCatalogRevisionId || '',
    input.strategyEntryId || '',
    input.templateCatalogRevisionId || '',
    JSON.stringify(input.recommendationJson || {}),
  );
  return db.prepare(`
    SELECT * FROM project_script_revisions WHERE id = ? AND scriptId = ? AND revisionNumber = ?
  `).get(id, scriptId, revisionNumber) as ProjectScriptRevisionRecord;
}

export function createProjectScript(
  db: Database.Database,
  projectId: string,
  input: ProjectScriptRevisionInput & { shotSetId?: string | null; generationTaskId?: string | null },
  now?: () => Date,
): ProjectScriptWithRevision {
  return db.transaction(() => {
    const createdAt = nowIso(now);
    const id = randomUUID();
    db.prepare(`
      INSERT INTO project_scripts
        (id, projectId, shotSetId, currentRevisionId, generationTaskId, archivedAt, createdAt, updatedAt)
      VALUES (?, ?, ?, NULL, ?, NULL, ?, ?)
    `).run(
      id,
      projectId,
      input.shotSetId || null,
      input.generationTaskId || null,
      createdAt,
      createdAt,
    );
    const revision = insertRevision(db, id, { ...input, generationTaskId: input.generationTaskId }, createdAt);
    db.prepare(`
      UPDATE project_scripts SET currentRevisionId = ?, updatedAt = ? WHERE id = ?
    `).run(revision.id, createdAt, id);
    return getProjectScript(db, projectId, id)!;
  }).immediate();
}

export function addProjectScriptRevision(
  db: Database.Database,
  projectId: string,
  scriptId: string,
  input: ProjectScriptRevisionInput,
  now?: () => Date,
): ProjectScriptWithRevision {
  return db.transaction(() => {
    const script = getProjectScript(db, projectId, scriptId);
    if (!script) throw new ScriptStudioError('not_found', '项目脚本不存在或不属于当前项目');
    const createdAt = nowIso(now);
    const revision = insertRevision(db, scriptId, input, createdAt);
    db.prepare(`
      UPDATE project_scripts SET currentRevisionId = ?, updatedAt = ? WHERE id = ?
    `).run(revision.id, createdAt, scriptId);
    return getProjectScript(db, projectId, scriptId)!;
  }).immediate();
}

export function getProjectScript(
  db: Database.Database,
  projectId: string,
  scriptId: string,
): ProjectScriptWithRevision | undefined {
  const script = db.prepare(`
    SELECT * FROM project_scripts WHERE id = ? AND projectId = ?
  `).get(scriptId, projectId) as ProjectScriptRecord | undefined;
  if (!script) return undefined;
    const currentRevision: ProjectScriptRevisionRecord | null = script.currentRevisionId
      ? db.prepare(`
          SELECT * FROM project_script_revisions WHERE id = ? AND scriptId = ?
        `).get(script.currentRevisionId, scriptId) as ProjectScriptRevisionRecord | undefined ?? null
      : null;
  return { ...script, currentRevision };
}

export function getProjectScriptRevision(
  db: Database.Database,
  projectId: string,
  scriptId: string,
  revisionId: string,
): ProjectScriptRevisionRecord | undefined {
  const script = getProjectScript(db, projectId, scriptId);
  if (!script) return undefined;
  return db.prepare(`
    SELECT * FROM project_script_revisions WHERE id = ? AND scriptId = ?
  `).get(revisionId, scriptId) as ProjectScriptRevisionRecord | undefined;
}

export function listProjectScripts(
  db: Database.Database,
  projectId: string,
  options: { cursor?: string; limit?: number; includeArchived?: boolean } = {},
): { scripts: ProjectScriptWithRevision[]; nextCursor: string | null } {
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 50));
  const rows = db.prepare(`
    SELECT * FROM project_scripts
    WHERE projectId = ?
      AND (? = '' OR id > ?)
      AND (? = 1 OR archivedAt IS NULL)
    ORDER BY updatedAt DESC, id DESC
    LIMIT ?
  `).all(
    projectId,
    options.cursor || '',
    options.cursor || '',
    options.includeArchived ? 1 : 0,
    limit,
  ) as ProjectScriptRecord[];
  const scripts = rows.map((script) => {
    const currentRevision: ProjectScriptRevisionRecord | null = script.currentRevisionId
      ? db.prepare(`
          SELECT * FROM project_script_revisions WHERE id = ? AND scriptId = ?
        `).get(script.currentRevisionId, script.id) as ProjectScriptRevisionRecord | undefined ?? null
      : null;
    return { ...script, currentRevision };
  });
  return {
    scripts,
    nextCursor: scripts.length === limit ? scripts[scripts.length - 1]!.id : null,
  };
}

export function listProjectScriptRevisions(
  db: Database.Database,
  projectId: string,
  scriptId: string,
  options: { cursor?: string; limit?: number } = {},
): { revisions: ProjectScriptRevisionRecord[]; nextCursor: string | null } {
  if (!getProjectScript(db, projectId, scriptId)) {
    throw new ScriptStudioError('not_found', '项目脚本不存在或不属于当前项目');
  }
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 50));
  const rows = db.prepare(`
    SELECT * FROM project_script_revisions
    WHERE scriptId = ? AND (? = '' OR id > ?)
    ORDER BY revisionNumber DESC
    LIMIT ?
  `).all(scriptId, options.cursor || '', options.cursor || '', limit) as ProjectScriptRevisionRecord[];
  return {
    revisions: rows,
    nextCursor: rows.length === limit ? rows[rows.length - 1]!.id : null,
  };
}

export function setProjectScriptCurrentRevision(
  db: Database.Database,
  projectId: string,
  scriptId: string,
  revisionId: string,
  now?: () => Date,
): ProjectScriptWithRevision {
  const script = getProjectScript(db, projectId, scriptId);
  if (!script) throw new ScriptStudioError('not_found', '项目脚本不存在或不属于当前项目');
  const revision = getProjectScriptRevision(db, projectId, scriptId, revisionId);
  if (!revision) throw new ScriptStudioError('not_found', '项目脚本版本不存在');
  db.prepare(`
    UPDATE project_scripts SET currentRevisionId = ?, updatedAt = ? WHERE id = ?
  `).run(revisionId, nowIso(now), scriptId);
  return getProjectScript(db, projectId, scriptId)!;
}

export function createManualRevision(
  db: Database.Database,
  projectId: string,
  scriptId: string,
  input: {
    contentJson: Record<string, unknown>;
    targetDurationSec: number;
    libraryRevisionId?: string | null;
    templateId?: string;
    templateVersion?: number;
    estimatedDurationSec?: number | null;
  },
  now?: () => Date,
): ProjectScriptWithRevision {
  return addProjectScriptRevision(db, projectId, scriptId, {
    origin: 'manual_edit',
    contentJson: input.contentJson,
    targetDurationSec: input.targetDurationSec,
    libraryRevisionId: input.libraryRevisionId || null,
    templateId: input.templateId || '',
    templateVersion: input.templateVersion || 0,
    estimatedDurationSec: input.estimatedDurationSec ?? null,
  }, now);
}

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { splitCoverTitle } from '../media-core/cover-domain.ts';
import { BatchDomainError } from './errors.ts';
import { normalizeManualScriptInput, type ManualScriptDraftInput } from './manual-script-import.ts';
import { assertBatchVersionEditable } from './versions.ts';

export type BatchScriptSourceKind = 'script_draft' | 'external';

export interface BatchScriptRow {
  id: string;
  projectId: string;
  sourceKind: BatchScriptSourceKind;
  sourceId: string;
  title: string;
  bodyText: string;
  sourceVersion: string;
  targetDurationSec: number;
  narrationConfigJson: string;
  coverTitleJson: string;
  shotSetId: string;
  contentRevision: string;
  sourceAvailable: number;
  catalogManaged: number;
  ownerBatchVersionId: string | null;
  externalSourceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BatchScriptSnapshotRow {
  id: string;
  batchVersionId: string;
  sourceScriptId: string;
  title: string;
  bodyText: string;
  sourceVersion: string;
  targetDurationSec: number;
  narrationConfigJson: string;
  coverTitleJson: string;
  shotSetId: string;
  contentRevision: string;
  copyCount: number;
  createdAt: string;
}

/** 脚本同步元数据:结构化封面标题、分镜组归属、内容修订身份与目标时长 */
export interface BatchScriptMetadata {
  coverTitleJson?: unknown;
  shotSetId?: string;
  contentRevision?: string;
  targetDurationSec?: number;
  narrationConfigJson?: unknown;
}

function nowIso(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString();
}

/**
 * 登记第 3 步保存的项目脚本。同一来源在项目内只保留一份;
 * 批次内外部文案必须走 createBatchExternalScript，不能借此进入项目目录。
 */
export function createProjectScript(
  db: Database.Database,
  projectId: string,
  input: {
    sourceKind: 'script_draft';
    sourceId: string;
    title: string;
    bodyText: string;
    sourceVersion: string;
    metadata?: BatchScriptMetadata;
    /** 仅 script-catalog 同步上游 script_drafts 时设为 true。 */
    catalogManaged?: boolean;
    now?: () => Date;
  },
): string {
  const updatedAt = nowIso(input.now);
  const coverTitleJson = JSON.stringify(input.metadata?.coverTitleJson ?? {});
  const shotSetId = input.metadata?.shotSetId ?? '';
  const contentRevision = input.metadata?.contentRevision ?? '';
  const targetDurationSec = Math.max(1, Math.round(input.metadata?.targetDurationSec ?? 15));
  const narrationConfigJson = JSON.stringify(input.metadata?.narrationConfigJson ?? {});
  const catalogManaged = input.catalogManaged ? 1 : 0;
  if (input.sourceKind !== 'script_draft') {
    throw new Error('外部文案必须在批次版本内创建');
  }
  const existing = db.prepare(`
    SELECT id FROM batch_scripts
    WHERE projectId = ? AND sourceId = ? AND sourceKind = 'script_draft' AND ownerBatchVersionId IS NULL
  `).get(projectId, input.sourceId) as { id: string } | undefined;
  if (existing) {
    db.prepare(`
      UPDATE batch_scripts
      SET title = ?, bodyText = ?, sourceVersion = ?, coverTitleJson = ?, shotSetId = ?, contentRevision = ?,
          targetDurationSec = ?, narrationConfigJson = ?, sourceAvailable = 1, catalogManaged = ?, updatedAt = ?
      WHERE id = ?
    `).run(input.title, input.bodyText, input.sourceVersion, coverTitleJson, shotSetId, contentRevision, targetDurationSec, narrationConfigJson, catalogManaged, updatedAt, existing.id);
    return existing.id;
  }
  const id = randomUUID();
  db.prepare(`
    INSERT INTO batch_scripts
      (id, projectId, sourceKind, sourceId, title, bodyText, sourceVersion,
       targetDurationSec, narrationConfigJson, coverTitleJson, shotSetId, contentRevision,
       sourceAvailable, catalogManaged, ownerBatchVersionId, externalSourceId, createdAt, updatedAt)
    VALUES (?, ?, 'script_draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, ?, ?)
  `).run(
    id,
    projectId,
    input.sourceId,
    input.title,
    input.bodyText,
    input.sourceVersion,
    targetDurationSec,
    narrationConfigJson,
    coverTitleJson,
    shotSetId,
    contentRevision,
    catalogManaged,
    updatedAt,
    updatedAt,
  );
  return id;
}

/** 在一个尚未冻结的批次版本内登记外部文案；它不会进入项目脚本目录。 */
export function createBatchExternalScript(
  db: Database.Database,
  batchVersionId: string,
  input: {
    sourceId: string;
    title: string;
    bodyText: string;
    sourceVersion: string;
    now?: () => Date;
  },
): string {
  const updatedAt = nowIso(input.now);
  return db.transaction(() => {
    const owner = assertBatchVersionEditable(db, batchVersionId);
    const existing = db.prepare(`
      SELECT id FROM batch_scripts
      WHERE ownerBatchVersionId = ? AND externalSourceId = ? AND sourceKind = 'external'
    `).get(batchVersionId, input.sourceId) as { id: string } | undefined;
    if (existing) {
      db.prepare(`
        UPDATE batch_scripts
        SET title = ?, bodyText = ?, sourceVersion = ?, updatedAt = ?
        WHERE id = ?
      `).run(input.title, input.bodyText, input.sourceVersion, updatedAt, existing.id);
      return existing.id;
    }
    const id = randomUUID();
    db.prepare(`
      INSERT INTO batch_scripts
        (id, projectId, sourceKind, sourceId, title, bodyText, sourceVersion,
         ownerBatchVersionId, externalSourceId, createdAt, updatedAt)
      VALUES (?, ?, 'external', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      owner.projectId,
      `external:${id}`,
      input.title,
      input.bodyText,
      input.sourceVersion,
      batchVersionId,
      input.sourceId,
      updatedAt,
      updatedAt,
    );
    return id;
  })();
}

/**
 * 登记一条手动导入的项目脚本(自定义脚本)。
 * 它直接成为项目级脚本:sourceKind 复用 'script_draft',sourceId 使用独立的
 * 'manual:' 命名空间——这是承重设计,保证 syncProjectScripts 的认领语句
 * (按 sourceId 是否是真草稿提权 catalogManaged)永远扫不到它,手动脚本
 * 不会被同步器软删。shotSetId 与 contentRevision 留空:手动脚本没有分镜组
 * 归属,也没有上游草稿修订身份。
 */
export function createManualProjectScript(
  db: Database.Database,
  projectId: string,
  input: ManualScriptDraftInput & { now?: () => Date },
): string {
  const normalized = normalizeManualScriptInput(input);
  return createProjectScript(db, projectId, {
    sourceKind: 'script_draft',
    sourceId: `manual:${randomUUID()}`,
    title: normalized.title,
    bodyText: normalized.bodyText,
    sourceVersion: '1',
    metadata: {
      coverTitleJson: splitCoverTitle(normalized.title),
      shotSetId: '',
      contentRevision: '',
      targetDurationSec: normalized.targetDurationSec,
    },
    now: input.now,
  });
}

/**
 * 编辑一条手动脚本。单条 UPDATE 同时写封面标题拆分与目标时长(两者都参与
 * matchesCurrentInput 输入身份比对,且封面标题会烤进 20 帧片头),不碰
 * narrationConfigJson(用户已配置的音色必须保留)。sourceVersion 递增 1。
 * 只允许改 manual: 命名空间的项目脚本;已被软删的目标报 conflict。
 */
export function updateManualProjectScript(
  db: Database.Database,
  projectId: string,
  scriptId: string,
  input: ManualScriptDraftInput & { now?: () => Date },
): void {
  const normalized = normalizeManualScriptInput(input);
  const result = db.prepare(`
    UPDATE batch_scripts
    SET title = ?, bodyText = ?, coverTitleJson = ?, targetDurationSec = ?,
        sourceVersion = CAST(sourceVersion AS INTEGER) + 1, updatedAt = ?
    WHERE id = ? AND projectId = ?
      AND sourceId LIKE 'manual:%' AND sourceKind = 'script_draft' AND ownerBatchVersionId IS NULL
      AND sourceAvailable = 1
  `).run(
    normalized.title,
    normalized.bodyText,
    JSON.stringify(splitCoverTitle(normalized.title)),
    normalized.targetDurationSec,
    nowIso(input.now),
    scriptId,
    projectId,
  );
  if (result.changes > 0) return;
  const existing = db.prepare(`
    SELECT id FROM batch_scripts
    WHERE id = ? AND projectId = ?
      AND sourceId LIKE 'manual:%' AND sourceKind = 'script_draft' AND ownerBatchVersionId IS NULL
  `).get(scriptId, projectId);
  if (existing) {
    throw new BatchDomainError('conflict', '该脚本已被删除');
  }
  throw new BatchDomainError('not_found', '手动脚本不存在');
}

/**
 * 删除一条手动脚本。整体包在 immediate 事务内(身份校验 + 引用查询 + 删除):
 * batch_script_snapshots.sourceScriptId 外键 ON DELETE RESTRICT,已被批次快照
 * 引用的脚本不能物理删除,只能软删(sourceAvailable = 0,从列表消失,历史快照保留);
 * 未被引用的物理删。
 */
export function deleteManualProjectScript(
  db: Database.Database,
  projectId: string,
  scriptId: string,
): { mode: 'hard' | 'soft' } {
  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM batch_scripts
      WHERE id = ? AND projectId = ?
        AND sourceId LIKE 'manual:%' AND sourceKind = 'script_draft' AND ownerBatchVersionId IS NULL
        AND sourceAvailable = 1
    `).get(scriptId, projectId) as { id: string } | undefined;
    if (!existing) {
      throw new BatchDomainError('not_found', '手动脚本不存在');
    }
    const referenced = db.prepare(`
      SELECT 1 FROM batch_script_snapshots WHERE sourceScriptId = ? LIMIT 1
    `).get(scriptId);
    if (!referenced) {
      db.prepare(`DELETE FROM batch_scripts WHERE id = ?`).run(scriptId);
      return { mode: 'hard' as const };
    }
    db.prepare(`
      UPDATE batch_scripts SET sourceAvailable = 0, updatedAt = ? WHERE id = ?
    `).run(nowIso(), scriptId);
    return { mode: 'soft' as const };
  }).immediate();
}

export function getProjectScript(
  db: Database.Database,
  projectId: string,
  scriptId: string,
): BatchScriptRow | undefined {
  return db.prepare(`
    SELECT * FROM batch_scripts
    WHERE id = ? AND projectId = ? AND sourceKind = 'script_draft'
      AND ownerBatchVersionId IS NULL AND sourceAvailable = 1
  `).get(scriptId, projectId) as BatchScriptRow | undefined;
}

export function getBatchExternalScript(
  db: Database.Database,
  batchVersionId: string,
  scriptId: string,
): BatchScriptRow | undefined {
  return db.prepare(`
    SELECT * FROM batch_scripts
    WHERE id = ? AND ownerBatchVersionId = ? AND sourceKind = 'external'
  `).get(scriptId, batchVersionId) as BatchScriptRow | undefined;
}

/** 项目脚本列表只展示第 3 步保存的项目脚本;批次内外部文案默认不出现在这里 */
export function listProjectScripts(db: Database.Database, projectId: string): BatchScriptRow[] {
  return db.prepare(`
    SELECT * FROM batch_scripts
    WHERE projectId = ? AND sourceKind = 'script_draft'
      AND ownerBatchVersionId IS NULL AND sourceAvailable = 1
    ORDER BY createdAt, id
  `).all(projectId) as BatchScriptRow[];
}

/** 项目脚本可以继续修改；此接口绝不改变脚本来源身份。 */
export function updateProjectScript(
  db: Database.Database,
  projectId: string,
  scriptId: string,
  input: {
    title: string;
    bodyText: string;
    sourceVersion: string;
    now?: () => Date;
  },
): void {
  const result = db.prepare(`
    UPDATE batch_scripts SET title = ?, bodyText = ?, sourceVersion = ?, updatedAt = ?
    WHERE id = ? AND projectId = ? AND sourceKind = 'script_draft' AND ownerBatchVersionId IS NULL
  `).run(
    input.title,
    input.bodyText,
    input.sourceVersion,
    nowIso(input.now),
    scriptId,
    projectId,
  );
  if (result.changes === 0) {
    throw new Error('项目脚本不存在');
  }
}

export interface BatchNarrationConfig {
  providerId: string;
  voice: string;
  speed: number;
}

/**
 * 更新项目脚本的口播配置(服务商/音色/语速),按脚本单独存储。
 * 批次快照会在确认时冻结这份配置;开跑刷新也会把最新配置带进快照,
 * 因此同一脚本的 N 条成片共用同一音色,改动只影响该脚本。
 */
export function updateProjectScriptNarrationConfig(
  db: Database.Database,
  projectId: string,
  scriptId: string,
  config: BatchNarrationConfig,
  now?: () => Date,
): void {
  if (!config.providerId || !config.voice) {
    throw new Error('配音配置必须包含服务商与音色');
  }
  const speed = Number(config.speed);
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) {
    throw new Error('语速必须在 0.5x–2.0x 之间');
  }
  const provider = db.prepare(`
    SELECT id FROM final_edit_tts_providers WHERE id = ? AND enabled = 1
  `).get(config.providerId) as { id: string } | undefined;
  if (!provider) {
    throw new Error('口播配音供应商未启用或不存在');
  }
  const result = db.prepare(`
    UPDATE batch_scripts
    SET narrationConfigJson = ?, updatedAt = ?
    WHERE id = ? AND projectId = ? AND sourceKind = 'script_draft' AND ownerBatchVersionId IS NULL
  `).run(
    JSON.stringify({ providerId: config.providerId, voice: config.voice, speed }),
    nowIso(now),
    scriptId,
    projectId,
  );
  if (result.changes === 0) {
    throw new Error('项目脚本不存在');
  }
}

/** 从脚本行的 narrationConfigJson 解析出可用的配音配置;无配置或损坏时返回 null。 */
export function parseStoredNarrationConfig(raw: string | null | undefined): BatchNarrationConfig | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const providerId = typeof record.providerId === 'string' ? record.providerId : '';
    const voice = typeof record.voice === 'string' ? record.voice : '';
    const speed = typeof record.speed === 'number' && Number.isFinite(record.speed) ? record.speed : 1;
    if (!providerId || !voice) return null;
    return { providerId, voice, speed };
  } catch {
    return null;
  }
}

/** 只修改所属批次版本内、尚未冻结的外部文案。 */
export function updateBatchExternalScript(
  db: Database.Database,
  batchVersionId: string,
  scriptId: string,
  input: {
    title: string;
    bodyText: string;
    sourceVersion: string;
    now?: () => Date;
  },
): void {
  db.transaction(() => {
    assertBatchVersionEditable(db, batchVersionId);
    const result = db.prepare(`
      UPDATE batch_scripts
      SET title = ?, bodyText = ?, sourceVersion = ?, updatedAt = ?
      WHERE id = ? AND ownerBatchVersionId = ? AND sourceKind = 'external'
    `).run(
      input.title,
      input.bodyText,
      input.sourceVersion,
      nowIso(input.now),
      scriptId,
      batchVersionId,
    );
    if (result.changes === 0) {
      throw new Error('外部文案不属于该批次版本');
    }
  })();
}

/** 显式把批次内外部文案复制成项目脚本，原外部文案的身份和快照引用保持不变。 */
export function saveExternalScriptAsProjectScript(
  db: Database.Database,
  batchVersionId: string,
  scriptId: string,
  input: { sourceId: string; now?: () => Date },
): string {
  return db.transaction(() => {
    const owner = assertBatchVersionEditable(db, batchVersionId);
    const script = db.prepare(`
      SELECT title, bodyText, sourceVersion
      FROM batch_scripts
      WHERE id = ? AND ownerBatchVersionId = ? AND sourceKind = 'external'
    `).get(scriptId, batchVersionId) as Pick<BatchScriptRow, 'title' | 'bodyText' | 'sourceVersion'> | undefined;
    if (!script) {
      throw new Error('外部文案不属于该批次版本');
    }
    return createProjectScript(db, owner.projectId, {
      sourceKind: 'script_draft',
      sourceId: input.sourceId,
      title: script.title,
      bodyText: script.bodyText,
      sourceVersion: script.sourceVersion,
      now: input.now,
    });
  })();
}

/**
 * 把一份脚本连同其正文、标题、来源版本和生成份数固化为批次版本的脚本快照。
 * 快照一旦创建,上游脚本更新不会改写它;同一批次版本不能重复快照同一来源脚本;
 * 脚本必须与批次属于同一项目;批次版本一旦开跑就永久冻结,不能再快照。
 */
export function snapshotScriptIntoBatch(
  db: Database.Database,
  batchVersionId: string,
  input: {
    scriptId: string;
    copyCount: number;
    now?: () => Date;
  },
): string {
  const createdAt = nowIso(input.now);
  return db.transaction(() => {
    const owner = assertBatchVersionEditable(db, batchVersionId);
    const script = db.prepare(`
      SELECT id, projectId, sourceKind, ownerBatchVersionId, title, bodyText, sourceVersion,
             targetDurationSec, narrationConfigJson, coverTitleJson, shotSetId, contentRevision, sourceAvailable
      FROM batch_scripts WHERE id = ?
    `).get(input.scriptId) as Pick<
      BatchScriptRow,
      | 'id' | 'projectId' | 'sourceKind' | 'ownerBatchVersionId' | 'title'
      | 'bodyText' | 'sourceVersion' | 'targetDurationSec' | 'narrationConfigJson'
      | 'coverTitleJson' | 'shotSetId' | 'contentRevision'
      | 'sourceAvailable'
    > | undefined;
    if (!script) {
      throw new Error('项目脚本不存在');
    }
    if (script.projectId !== owner.projectId) {
      throw new Error('脚本不属于该批次所在项目');
    }
    if (script.sourceKind === 'external' && script.ownerBatchVersionId !== batchVersionId) {
      throw new Error('外部文案不属于该批次版本');
    }
    if (script.sourceKind === 'script_draft' && script.sourceAvailable !== 1) {
      throw new Error('项目脚本的上游来源已不可用');
    }
    const duplicate = db.prepare(`
      SELECT 1 FROM batch_script_snapshots WHERE batchVersionId = ? AND sourceScriptId = ?
    `).get(batchVersionId, input.scriptId);
    if (duplicate) {
      throw new Error('同一批次版本不能重复快照同一来源脚本');
    }
    const id = randomUUID();
    db.prepare(`
      INSERT INTO batch_script_snapshots
        (id, batchVersionId, sourceScriptId, title, bodyText, sourceVersion,
         targetDurationSec, narrationConfigJson, coverTitleJson, shotSetId, contentRevision, copyCount, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      batchVersionId,
      script.id,
      script.title,
      script.bodyText,
      script.sourceVersion,
      script.targetDurationSec,
      script.narrationConfigJson,
      script.coverTitleJson,
      script.shotSetId,
      script.contentRevision,
      input.copyCount,
      createdAt,
    );
    return id;
  })();
}

export function getScriptSnapshot(
  db: Database.Database,
  batchVersionId: string,
  snapshotId: string,
): BatchScriptSnapshotRow | undefined {
  return db.prepare(`
    SELECT * FROM batch_script_snapshots WHERE id = ? AND batchVersionId = ?
  `).get(snapshotId, batchVersionId) as BatchScriptSnapshotRow | undefined;
}

export function listScriptSnapshots(db: Database.Database, batchVersionId: string): BatchScriptSnapshotRow[] {
  return db.prepare(`
    SELECT * FROM batch_script_snapshots WHERE batchVersionId = ? ORDER BY createdAt, id
  `).all(batchVersionId) as BatchScriptSnapshotRow[];
}

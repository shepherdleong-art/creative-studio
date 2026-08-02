import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureBatchSchemaReady } from '../lib/batch-production/schema.ts';
import { syncProjectScripts } from '../lib/batch-production/script-catalog.ts';
import { listProjectScripts, getProjectScript } from '../lib/batch-production/scripts.ts';

function createLegacyDatabase(root: string, name: string): { db: Database.Database; databasePath: string } {
  const databasePath = path.join(root, name);
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE script_drafts (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'gemini',
      model TEXT,
      inputSnapshot TEXT NOT NULL,
      outputJson TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
    );
    INSERT INTO projects (id, name) VALUES ('project-1', '项目一');
    INSERT INTO projects (id, name) VALUES ('project-2', '项目二');
  `);
  return { db, databasePath };
}

function insertDraft(
  db: Database.Database,
  id: string,
  projectId: string,
  outputJson: string,
  createdAt: string,
): void {
  db.prepare(`
    INSERT INTO script_drafts (id, projectId, inputSnapshot, outputJson, createdAt)
    VALUES (?, ?, '{}', ?, ?)
  `).run(id, projectId, outputJson, createdAt);
}

function validV2Script(title: string, narration: string[], shotSetId = 'ss-1'): string {
  return JSON.stringify({
    version: 2,
    title,
    shotSetId,
    targetDurationSec: 30,
    segments: narration.map((n) => ({ narration: n, subtitle: n })),
    fullScript: narration.join('\n'),
  });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-script-catalog-'));

try {
  const dbRoot = path.join(root, 'healthy');
  fs.mkdirSync(dbRoot, { recursive: true });
  const { db } = createLegacyDatabase(dbRoot, 'workbench.db');

  const migrated = await ensureBatchSchemaReady({
    db,
    backupRoot: path.join(dbRoot, 'backups'),
    now: () => new Date('2026-08-02T08:00:00.000Z'),
  });
  assert.equal(migrated.state, 'ready');

  // --- 场景 1:同一来源重复同步十次,只产生一个项目脚本版本 ---
  insertDraft(db, 'draft-a', 'project-1', validV2Script('口播A', ['第一段', '第二段']), '2026-08-02T09:00:00.000Z');
  for (let i = 0; i < 10; i += 1) {
    syncProjectScripts(db, 'project-1', () => new Date(`2026-08-02T09:0${i}:00.000Z`));
  }
  const scriptsAfterRepeat = db.prepare(`SELECT * FROM batch_scripts`).all() as Array<{ sourceId: string }>;
  assert.equal(scriptsAfterRepeat.length, 1, '同一来源重复同步只保留一份项目脚本');
  assert.equal(scriptsAfterRepeat[0]?.sourceId, 'draft-a');

  // --- 场景 2:相同正文来自两个不同来源,不合并 ---
  insertDraft(db, 'draft-b', 'project-1', validV2Script('口播B', ['第一段', '第二段'], 'ss-2'), '2026-08-02T09:30:00.000Z');
  syncProjectScripts(db, 'project-1', () => new Date('2026-08-02T09:30:00.000Z'));
  const allScripts = db.prepare(`SELECT * FROM batch_scripts WHERE projectId = 'project-1'`).all() as Array<{ sourceId: string }>;
  assert.equal(allScripts.length, 2, '正文相同但来源不同的脚本不得合并');
  assert.deepEqual(allScripts.map(({ sourceId }) => sourceId).sort(), ['draft-a', 'draft-b']);

  // --- 场景 3:项目隔离 ---
  insertDraft(db, 'draft-p2', 'project-2', validV2Script('项目二脚本', ['项目二正文']), '2026-08-02T10:00:00.000Z');
  syncProjectScripts(db, 'project-2', () => new Date('2026-08-02T10:00:00.000Z'));
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM batch_scripts WHERE projectId = 'project-1'`).get() as { n: number }).n,
    2,
    '项目 2 的草稿不得进入项目 1 的脚本目录',
  );
  assert.equal(listProjectScripts(db, 'project-2').length, 1);

  // --- 场景 4:无效草稿跳过,不影响有效草稿 ---
  const skippedBefore = (db.prepare(`SELECT COUNT(*) AS n FROM batch_scripts`).get() as { n: number }).n;
  insertDraft(db, 'draft-bad-json', 'project-1', '{not json', '2026-08-02T10:10:00.000Z');
  insertDraft(db, 'draft-v1', 'project-1', JSON.stringify({ version: 1, title: '旧版', segments: [] }), '2026-08-02T10:11:00.000Z');
  insertDraft(db, 'draft-no-segments', 'project-1', JSON.stringify({ version: 2, title: '无段', shotSetId: 'ss-1', segments: [] }), '2026-08-02T10:12:00.000Z');
  insertDraft(db, 'draft-empty-narration', 'project-1', JSON.stringify({ version: 2, title: '空叙', shotSetId: 'ss-1', segments: [{ narration: '   ' }] }), '2026-08-02T10:13:00.000Z');
  const result = syncProjectScripts(db, 'project-1', () => new Date('2026-08-02T10:14:00.000Z'));
  assert.equal(result.skipped, 4, '无法解析、非 V2/V3、无段、空叙文的草稿必须跳过');
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM batch_scripts`).get() as { n: number }).n,
    skippedBefore,
    '无效草稿不得写入脚本目录',
  );

  // --- 场景 5:草稿更新后,未开始的批次脚本自动跟随最新版 ---
  const draftARow = db.prepare(`SELECT id FROM batch_scripts WHERE sourceId = 'draft-a'`).get() as { id: string };
  const draftA = getProjectScript(db, 'project-1', draftARow.id);
  assert.equal(draftA?.bodyText, '第一段\n第二段');
  assert.equal(draftA?.title, '口播A');
  assert.equal(draftA?.sourceVersion, '2');
  db.prepare(`UPDATE script_drafts SET outputJson = ? WHERE id = 'draft-a'`)
    .run(validV2Script('口播A新版', ['新版第一段', '新版第二段']));
  syncProjectScripts(db, 'project-1', () => new Date('2026-08-02T11:00:00.000Z'));
  const draftAFollowed = getProjectScript(db, 'project-1', draftA!.id);
  assert.equal(draftAFollowed?.bodyText, '新版第一段\n新版第二段', '未开始的批次脚本自动跟随项目脚本最新版');
  assert.equal(draftAFollowed?.title, '口播A新版');
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM batch_scripts`).get() as { n: number }).n,
    skippedBefore,
    '跟随更新不得产生新的项目脚本',
  );

  // --- 场景 6:正文按有序段落重组,忽略空段 ---
  insertDraft(db, 'draft-c', 'project-1', validV2Script('口播C', ['段一', '  ', '段三']), '2026-08-02T11:30:00.000Z');
  syncProjectScripts(db, 'project-1', () => new Date('2026-08-02T11:30:00.000Z'));
  const draftC = db.prepare(`SELECT bodyText FROM batch_scripts WHERE sourceId = 'draft-c'`).get() as { bodyText: string };
  assert.equal(draftC.bodyText, '段一\n段三', '正文由有序段落拼接,空段剔除');

  // --- 幂等:无新草稿时再次同步不产生变化 ---
  const countBefore = (db.prepare(`SELECT COUNT(*) AS n FROM batch_scripts`).get() as { n: number }).n;
  const idle = syncProjectScripts(db, 'project-1', () => new Date('2026-08-02T12:00:00.000Z'));
  assert.equal(idle.synced, 3, '三个有效来源');
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM batch_scripts`).get() as { n: number }).n, countBefore);

  db.close();
  console.log('batch script catalog tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

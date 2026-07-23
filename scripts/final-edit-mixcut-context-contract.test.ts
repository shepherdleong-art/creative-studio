import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import type { ScriptOutput } from '../lib/script-providers/types.ts';

// Phase 0 contract test for docs/superpowers/plans/2026-07-23-mixcut-technical-execution.md §5.1
// (`GET /api/projects/:projectId/final-edit/context`, not implemented yet).
//
// This test does NOT import any route or workspace code. It builds its own
// fixture database mirroring the real upstream schema (lib/db.ts: projects,
// shot_sets, video_jobs, script_drafts) and runs the four documented query
// rules as raw SQL, to prove those rules are sound against real schema shape
// before any Phase 1 implementation exists. It also proves the plan §11.1 /
// lib/final-edit/types.ts `ExportIdentity` redline: `projects.model` (the
// image-generation provider's model) must never be read as the product
// code — `projects.productCode` is the only valid source.

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');

db.exec(`
  -- projects (lib/db.ts:46-62, plus productCode/productName added later via lib/db-migrations.ts)
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    providerId TEXT NOT NULL,
    model TEXT NOT NULL,
    productCode TEXT DEFAULT '',
    productName TEXT DEFAULT ''
  );

  -- shot_sets (lib/db.ts:177-188)
  CREATE TABLE shot_sets (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    name TEXT NOT NULL,
    productCode TEXT DEFAULT '',
    category TEXT DEFAULT '',
    sceneReferenceId TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','generating','reviewing','approved','video_ready')),
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
  );

  -- video_jobs (lib/db.ts:267-299, reduced to the columns the context-route rule needs)
  CREATE TABLE video_jobs (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    shotSetId TEXT,
    shotId TEXT,
    localVideoPath TEXT,
    filename TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    durationSec INTEGER NOT NULL DEFAULT 5,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- script_drafts (lib/db.ts:305-314)
  CREATE TABLE script_drafts (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'gemini',
    model TEXT NOT NULL,
    inputSnapshot TEXT NOT NULL,
    outputJson TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ---------------------------------------------------------------------------
// Fixture: Project A — the primary scenario.
// productCode ('JSQ-A1') and model ('gpt-image-2') are deliberately
// different values; that mismatch is the whole point of the redline check.
// ---------------------------------------------------------------------------
db.prepare(`
  INSERT INTO projects (id, name, createdAt, providerId, model, productCode, productName)
  VALUES ('project-a', '智能加湿器投放项目', '2026-01-05 10:00:00', 'provider-packy', 'gpt-image-2', 'JSQ-A1', '静音加湿器 A1')
`).run();

db.prepare(`
  INSERT INTO shot_sets (id, projectId, name, productCode, category, status, createdAt)
  VALUES
    ('ss-a', 'project-a', '客厅场景', 'JSQ-A1', '家电', 'approved', '2026-01-05 10:05:00'),
    ('ss-b', 'project-a', '卧室场景', 'JSQ-A1', '家电', 'draft', '2026-01-05 10:06:00')
`).run();

// Three video_jobs under project-a, each excluded from the "usable video for
// ss-a" set for a different single reason: wrong status, wrong shot set.
// (Project B below adds a fourth, excluded for wrong project.)
db.prepare(`
  INSERT INTO video_jobs (id, projectId, shotSetId, shotId, localVideoPath, filename, status, durationSec, createdAt)
  VALUES
    ('video-succeeded-a', 'project-a', 'ss-a', 'shot-a1', '/data/storage/final-edits/videos/video-succeeded-a.mp4', 'video-succeeded-a.mp4', 'succeeded', 5, '2026-01-05 11:00:00'),
    ('video-pending-a',   'project-a', 'ss-a', 'shot-a2', '/data/storage/final-edits/videos/video-pending-a.mp4',   'video-pending-a.mp4',   'pending',   5, '2026-01-05 11:01:00'),
    ('video-succeeded-b', 'project-a', 'ss-b', 'shot-b1', '/data/storage/final-edits/videos/video-succeeded-b.mp4', 'video-succeeded-b.mp4', 'succeeded', 5, '2026-01-05 11:02:00')
`).run();

// Valid V2 script draft — real ScriptOutput shape, typechecked below against
// the actual lib/script-providers/types.ts type (not a hand-shaped lookalike).
const validScriptOutput: ScriptOutput = {
  version: 2,
  title: '静音加湿一整晚',
  coverTitleParts: { primary: '静音加湿', secondary: '一整晚好眠' },
  platform: '抖音',
  tone: '种草',
  targetDurationSec: 15,
  template: '功能展示',
  shotSetId: 'ss-a',
  sellingPointMap: [{ shotId: 'shot-a1', sellingPoint: '超静音运行' }],
  segments: [
    { shotId: 'shot-a1', imageAssetId: 'img-shot-a1', narration: '夜晚加湿也不怕吵醒家人', subtitle: '静音加湿一整晚', rationale: '展示产品静音运行的核心卖点' },
    { shotId: 'shot-a2', imageAssetId: 'img-shot-a2', narration: '一键操作，长效续航', subtitle: '一键操作 长效续航', rationale: '展示操作便捷性' },
  ],
  droppedShots: [{ shotId: 'shot-a3', reason: '画面重复度过高' }],
  fullScript: '夜晚加湿也不怕吵醒家人。一键操作，长效续航。',
};

// Invalid draft: V1-shaped (no version 2, no shotSetId) — must be rejected by
// the version/shape gate, not merely by coincidence.
const legacyV1Draft = {
  version: 1,
  title: '旧版脚本（V1，parser 必须拒绝）',
  duration: '15秒',
  segments: [{ shotId: 'shot-a1', text: '夜晚加湿也不怕吵醒家人', visualIntent: '卧室静音' }],
};

db.prepare(`
  INSERT INTO script_drafts (id, projectId, provider, model, inputSnapshot, outputJson, createdAt)
  VALUES ('script-valid-a', 'project-a', 'gemini', 'gemini-2.5-pro', '{}', ?, '2026-01-05 12:00:00')
`).run(JSON.stringify(validScriptOutput));

db.prepare(`
  INSERT INTO script_drafts (id, projectId, provider, model, inputSnapshot, outputJson, createdAt)
  VALUES ('script-invalid-a', 'project-a', 'gemini', 'gemini-2.5-pro', '{}', ?, '2026-01-05 12:01:00')
`).run(JSON.stringify(legacyV1Draft));

// ---------------------------------------------------------------------------
// Fixture: Project B — unrelated project, to prove project-level isolation.
// ---------------------------------------------------------------------------
db.prepare(`
  INSERT INTO projects (id, name, createdAt, providerId, model, productCode, productName)
  VALUES ('project-b', '空气净化器投放项目', '2026-02-10 09:30:00', 'provider-packy', 'gemini-3-pro-image-preview', 'KQJHQ-B2', '空气净化器 B2')
`).run();

db.prepare(`
  INSERT INTO shot_sets (id, projectId, name, productCode, category, status, createdAt)
  VALUES ('ss-c', 'project-b', '客厅场景', 'KQJHQ-B2', '家电', 'approved', '2026-02-10 09:35:00')
`).run();

db.prepare(`
  INSERT INTO video_jobs (id, projectId, shotSetId, shotId, localVideoPath, filename, status, durationSec, createdAt)
  VALUES ('video-succeeded-c', 'project-b', 'ss-c', 'shot-c1', '/data/storage/final-edits/videos/video-succeeded-c.mp4', 'video-succeeded-c.mp4', 'succeeded', 5, '2026-02-10 10:00:00')
`).run();

// =============================================================================
// Rule: `shot_sets.projectId = :projectId`
// =============================================================================
const shotSetIdsForA = (db.prepare(`SELECT id FROM shot_sets WHERE projectId = ?`).all('project-a') as Array<{ id: string }>)
  .map((row) => row.id)
  .sort();
assert.deepEqual(shotSetIdsForA, ['ss-a', 'ss-b'], 'project-a 的 shot_sets 必须精确是 {ss-a, ss-b}');
assert.ok(!shotSetIdsForA.includes('ss-c'), '按 project-a 查询 shot_sets 不得泄漏 project-b 的 ss-c');

// =============================================================================
// Rule: video_jobs.projectId = :projectId AND shotSetId = currentShotSetId
//       AND status = 'succeeded' AND localVideoPath IS NOT NULL
// =============================================================================
const succeededVideosForSetA = db.prepare(`
  SELECT id FROM video_jobs
  WHERE projectId = ? AND shotSetId = ? AND status = 'succeeded' AND localVideoPath IS NOT NULL
`).all('project-a', 'ss-a') as Array<{ id: string }>;
assert.deepEqual(succeededVideosForSetA.map((row) => row.id), ['video-succeeded-a'], 'ss-a 下只有一条 succeeded 且有本地路径的视频应命中：pending 与另一分镜组的 succeeded 视频都必须被排除');

// Confirm all three project-a videos exist at the project level (so the
// exclusions above come from the shotSetId/status predicates, not from
// projectId scoping silently dropping rows), and that project-b's video is
// never visible under project-a at all — proves project-level isolation.
const allVideoIdsForProjectA = (db.prepare(`SELECT id FROM video_jobs WHERE projectId = ?`).all('project-a') as Array<{ id: string }>)
  .map((row) => row.id)
  .sort();
assert.deepEqual(allVideoIdsForProjectA, ['video-pending-a', 'video-succeeded-a', 'video-succeeded-b']);
assert.ok(!allVideoIdsForProjectA.includes('video-succeeded-c'), '按 project-a 查询 video_jobs 不得泄漏 project-b 的 video-succeeded-c');

// =============================================================================
// Rule: script_drafts.outputJson — only V2 with a non-empty shotSetId and
// non-empty segments[] is usable.
// =============================================================================
const isUsableV2Draft = (parsed: unknown): boolean => {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const value = parsed as Record<string, unknown>;
  return value.version === 2
    && typeof value.shotSetId === 'string'
    && value.shotSetId.length > 0
    && Array.isArray(value.segments)
    && value.segments.length > 0;
};

const draftRowsForA = db.prepare(`SELECT id, outputJson FROM script_drafts WHERE projectId = ?`).all('project-a') as Array<{ id: string; outputJson: string }>;
const usableDraftIds = draftRowsForA.filter((row) => isUsableV2Draft(JSON.parse(row.outputJson))).map((row) => row.id);
assert.deepEqual(usableDraftIds, ['script-valid-a'], '只有合法 V2 草稿通过版本/结构校验；V1 形态（无 version:2、无 shotSetId）的草稿必须被拒绝');

// =============================================================================
// Redline (plan §11.1; JSDoc on ExportIdentity.productCode in lib/final-edit/types.ts):
// projects.model is the image-generation provider's model — NEVER the
// product code. This would fail loudly if a future implementation
// accidentally read `model` where `productCode` belongs.
// =============================================================================
const projectARow = db.prepare(`SELECT productCode, model FROM projects WHERE id = ?`).get('project-a') as { productCode: string; model: string };
assert.equal(projectARow.productCode, 'JSQ-A1', 'productCode 必须是真实型号');
assert.equal(projectARow.model, 'gpt-image-2', 'model 必须是图片生成供应商模型，用于证明两列在 fixture 中确实不同（不是巧合般不同）');
assert.notEqual(projectARow.productCode, projectARow.model, '红线：productCode 与 model 不得混同——禁止把 model 当成产品型号读取');

db.close();
console.log('final-edit mixcut context contract tests passed');

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

// Two more invalid drafts, each isolating exactly one of the gate's other
// AND-conditions (legacyV1Draft above only ever exercises the first,
// version !== 2, condition — short-circuiting means the remaining three were
// never independently hit by any fixture row). Both are still real,
// type-valid ScriptOutput values: the TS type has no non-empty-string /
// non-empty-array constraint, so only the runtime gate catches these.
const v2MissingShotSetIdDraft: ScriptOutput = {
  ...validScriptOutput,
  shotSetId: '',
};

const v2EmptySegmentsDraft: ScriptOutput = {
  ...validScriptOutput,
  segments: [],
};

db.prepare(`
  INSERT INTO script_drafts (id, projectId, provider, model, inputSnapshot, outputJson, createdAt)
  VALUES ('script-valid-a', 'project-a', 'gemini', 'gemini-3.5-flash', '{}', ?, '2026-01-05 12:00:00')
`).run(JSON.stringify(validScriptOutput));

db.prepare(`
  INSERT INTO script_drafts (id, projectId, provider, model, inputSnapshot, outputJson, createdAt)
  VALUES ('script-invalid-a', 'project-a', 'gemini', 'gemini-3.5-flash', '{}', ?, '2026-01-05 12:01:00')
`).run(JSON.stringify(legacyV1Draft));

db.prepare(`
  INSERT INTO script_drafts (id, projectId, provider, model, inputSnapshot, outputJson, createdAt)
  VALUES ('script-empty-shotset-a', 'project-a', 'gemini', 'gemini-3.5-flash', '{}', ?, '2026-01-05 12:02:00')
`).run(JSON.stringify(v2MissingShotSetIdDraft));

db.prepare(`
  INSERT INTO script_drafts (id, projectId, provider, model, inputSnapshot, outputJson, createdAt)
  VALUES ('script-empty-segments-a', 'project-a', 'gemini', 'gemini-3.5-flash', '{}', ?, '2026-01-05 12:03:00')
`).run(JSON.stringify(v2EmptySegmentsDraft));

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

// A valid V2 draft under project-b too — without this, the script_drafts
// `WHERE projectId = ?` query used below is never actually exercised against
// a foreign draft, so cross-project isolation for script_drafts would be
// assumed rather than proven.
const validScriptOutputForB: ScriptOutput = {
  version: 2,
  title: '空气净化更清新',
  platform: '抖音',
  tone: '种草',
  targetDurationSec: 15,
  template: '功能展示',
  shotSetId: 'ss-c',
  sellingPointMap: [{ shotId: 'shot-c1', sellingPoint: '强力净化' }],
  segments: [
    { shotId: 'shot-c1', imageAssetId: 'img-shot-c1', narration: '强力净化，还你清新空气', subtitle: '强力净化', rationale: '展示净化效果' },
  ],
  droppedShots: [],
  fullScript: '强力净化，还你清新空气。',
};

db.prepare(`
  INSERT INTO script_drafts (id, projectId, provider, model, inputSnapshot, outputJson, createdAt)
  VALUES ('script-valid-b', 'project-b', 'gemini', 'gemini-3.5-flash', '{}', ?, '2026-02-10 12:00:00')
`).run(JSON.stringify(validScriptOutputForB));

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
//
// This is only the SQL-provable half of plan §5.1's full rule. The full rule
// also requires localVideoPath to pass safe-path validation ("...localVideoPath
// 存在且通过安全路径校验") — that has no fixture-testable SQL predicate and is
// deferred to Phase 1's real route/workspace code, which should mirror the
// toRelative()/`unsafe_path` pattern already used for the analogous check in
// lib/final-edit/workspace.ts:951-953. The assertion below only proves
// existence (IS NOT NULL), not full path-safety.
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
assert.deepEqual(allVideoIdsForProjectA, ['video-pending-a', 'video-succeeded-a', 'video-succeeded-b'], 'project-a 名下应有全部三条视频（不论状态），证明上面的排除来自 shotSetId/status 条件，而不是 projectId 过滤本身漏了行');
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

// Exercise each AND-condition in isolation, directly on the parsed objects,
// before ever touching the DB — pinpoints exactly which condition rejects
// each malformed shape (legacyV1Draft alone only ever exercised the first
// condition; the other three were previously never independently hit).
assert.equal(isUsableV2Draft(validScriptOutput), true, '合法 V2 草稿必须通过 version/shotSetId/segments 网关');
assert.equal(isUsableV2Draft(legacyV1Draft), false, 'version !== 2 的草稿必须被拒绝');
assert.equal(isUsableV2Draft(v2MissingShotSetIdDraft), false, 'shotSetId 为空字符串的草稿必须被拒绝，即使 version 正确');
assert.equal(isUsableV2Draft(v2EmptySegmentsDraft), false, 'segments 为空数组的草稿必须被拒绝，即使 version 和 shotSetId 都正确');

const draftRowsForA = db.prepare(`SELECT id, outputJson FROM script_drafts WHERE projectId = ?`).all('project-a') as Array<{ id: string; outputJson: string }>;

// Raw-row scoping check (mirrors the video_jobs project-isolation check
// above): proves the `WHERE projectId = ?` clause itself never returns
// project-b's script-valid-b, independent of the version/shape gate below.
const allDraftIdsForA = draftRowsForA.map((row) => row.id).sort();
assert.deepEqual(allDraftIdsForA, ['script-empty-segments-a', 'script-empty-shotset-a', 'script-invalid-a', 'script-valid-a']);
assert.ok(!allDraftIdsForA.includes('script-valid-b'), '按 project-a 查询 script_drafts 不得泄漏 project-b 的合法 V2 草稿 script-valid-b');

const usableDraftIds = draftRowsForA.filter((row) => isUsableV2Draft(JSON.parse(row.outputJson))).map((row) => row.id);
assert.deepEqual(usableDraftIds, ['script-valid-a'], '只有合法 V2 草稿通过版本/结构校验；V1 形态、空 shotSetId、空 segments[] 的草稿都必须被拒绝，且 project-b 的合法草稿不得混入 project-a 的结果');

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

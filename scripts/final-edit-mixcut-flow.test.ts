import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import type { ScriptOutput } from '../lib/script-providers/types.ts';
import { buildMixcutContext, isUsableV2ScriptDraft } from '../lib/final-edit/mixcut-context.ts';
import { resolveFfprobePath, runFfmpeg } from '../lib/ffmpeg.ts';

// Phase 1 integration test for
// docs/superpowers/plans/2026-07-23-mixcut-technical-execution.md §5.1
// (`GET /api/projects/:projectId/final-edit/context`).
//
// Unlike Phase 0's scripts/final-edit-mixcut-context-contract.test.ts (which
// proved the four query rules as raw SQL against its own fixture, never
// importing implementation code), this test drives the REAL exported
// context-building function — buildMixcutContext from
// lib/final-edit/mixcut-context.ts — against its own isolated in-memory
// SQLite db and a real temp-directory storage root. It never imports
// lib/db.ts's getDb() or lib/data-root.ts's dataRoot(), so the real
// data/workbench.db is never touched.

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    providerId TEXT NOT NULL,
    model TEXT NOT NULL,
    productCode TEXT DEFAULT '',
    productName TEXT DEFAULT ''
  );

  CREATE TABLE shot_sets (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    name TEXT NOT NULL,
    productCode TEXT DEFAULT '',
    category TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
  );

  -- Reduced to the columns buildMixcutContext's shotCount aggregation needs.
  CREATE TABLE shots (
    id TEXT PRIMARY KEY,
    shotSetId TEXT NOT NULL,
    indexNum INTEGER NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (shotSetId) REFERENCES shot_sets(id) ON DELETE CASCADE
  );

  CREATE TABLE video_jobs (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    shotSetId TEXT,
    localVideoPath TEXT,
    filename TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    durationSec INTEGER NOT NULL DEFAULT 5,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

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
// Real temp-directory storage root (not lib/data-root.ts's dataRoot()) so
// safe-path validation and fs.existsSync checks inside buildMixcutContext run
// against real files without ever touching the app's real storage/ tree.
// ---------------------------------------------------------------------------
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mixcut-flow-test-'));
const videosDir = path.join(storageRoot, 'final-edits', 'videos');
fs.mkdirSync(videosDir, { recursive: true });

// One REAL, valid, tiny video file via ffmpeg's lavfi test source — same
// technique already used by scripts/ffmpeg-resolve.test.ts and
// scripts/final-edit-render.test.ts — so JC-2's probeVideoMedia is exercised
// end-to-end with real ffprobe output for at least one asset, not mocked.
const realVideoPath = path.join(videosDir, 'video-real.mp4');
await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=duration=1:size=320x240:rate=24', '-pix_fmt', 'yuv420p', '-y', realVideoPath]);

// ffprobe-static ships broken arm64 binaries on macOS (same caveat documented
// in scripts/ffmpeg-resolve.test.ts) and this sandbox has no system ffprobe
// on PATH either, so resolveFfprobePath() falls back to a path that spawns
// but can't run. probeVideoMedia (JC-2) is specified to degrade gracefully
// in exactly this situation — resolve the documented all-zero fallback
// rather than reject — so detect the real environment capability up front
// and assert against whichever outcome is actually correct for THIS
// environment, mirroring ffmpeg-resolve.test.ts's own pattern.
const ffprobeWorks = spawnSync(resolveFfprobePath(), ['-version'], { timeout: 5000 }).status === 0;
console.log(ffprobeWorks ? 'ffprobe binary verified; asserting real probed values' : 'ffprobe binary unavailable in this environment; asserting probeVideoMedia\'s documented zero-fallback instead');

// ---------------------------------------------------------------------------
// Fixture: project-a, two shot sets.
// ss-a created first (older); ss-b created second (newer) so the "no
// ?shotSetId= param" default-pick case has an unambiguous expected answer.
// ---------------------------------------------------------------------------
db.prepare(`
  INSERT INTO projects (id, name, createdAt, providerId, model, productCode, productName)
  VALUES ('project-a', '智能加湿器投放项目', '2026-01-05 10:00:00', 'provider-packy', 'gpt-image-2', 'JSQ-A1', '静音加湿器 A1')
`).run();

db.prepare(`
  INSERT INTO shot_sets (id, projectId, name, productCode, category, status, createdAt)
  VALUES
    ('ss-a', 'project-a', '客厅场景', 'JSQ-A1', '家电', 'approved', '2026-01-05 10:05:00'),
    ('ss-b', 'project-a', '卧室场景', 'JSQ-A1', '家电', 'approved', '2026-01-05 10:06:00')
`).run();

db.prepare(`INSERT INTO shots (id, shotSetId, indexNum, createdAt) VALUES
  ('shot-a1', 'ss-a', 1, '2026-01-05 10:05:10'),
  ('shot-a2', 'ss-a', 2, '2026-01-05 10:05:11'),
  ('shot-a3', 'ss-a', 3, '2026-01-05 10:05:12'),
  ('shot-b1', 'ss-b', 1, '2026-01-05 10:06:10'),
  ('shot-b2', 'ss-b', 2, '2026-01-05 10:06:11')
`).run();

// ss-a videos: one real+succeeded+safe (the only one that should ever appear
// in a videoAssets[] detail list), plus four that each fail exactly one gate
// for the DETAIL list (status / status / unsafe path / missing file) while
// still counting toward the coarse ss-a sidebar aggregate where applicable
// (JC-3 is DB-only and doesn't re-check path safety or file existence).
//
// video-real-pending is the status-filter isolation fixture (code review
// Fix 1): it points at the SAME real file as video-real, so it passes both
// the safe-path check AND the fs.existsSync check (JC-4) — its status
// ('pending', not 'succeeded') is the ONLY thing that can exclude it from
// videoAssets[]. Without this row, video-pending (below) was the only
// non-succeeded fixture, but video-pending's file is never materialized on
// disk, so it was ALREADY excluded by JC-4 regardless of whether the
// `status = 'succeeded'` filter at mixcut-context.ts:209 did anything —
// i.e. a regression that weakened/removed the status filter (e.g. widening
// it to `status IN ('succeeded','pending')`) could not be caught by any
// existing row. video-real-pending breaks that confound.
db.prepare(`
  INSERT INTO video_jobs (id, projectId, shotSetId, localVideoPath, filename, status, durationSec, createdAt)
  VALUES
    ('video-real',         'project-a', 'ss-a', ?,                  'video-real.mp4', 'succeeded', 1, '2026-01-05 11:00:00'),
    ('video-real-pending', 'project-a', 'ss-a', ?,                  'video-real-pending.mp4', 'pending', 1, '2026-01-05 11:00:30'),
    ('video-pending',      'project-a', 'ss-a', ?,                  'video-pending.mp4', 'pending', 5, '2026-01-05 11:01:00'),
    ('video-unsafe',       'project-a', 'ss-a', '../../etc/passwd', 'video-unsafe.mp4', 'succeeded', 5, '2026-01-05 11:02:00'),
    ('video-missing',      'project-a', 'ss-a', ?,                  'video-missing.mp4', 'succeeded', 5, '2026-01-05 11:03:00')
`).run(realVideoPath, realVideoPath, path.join(videosDir, 'video-pending.mp4'), path.join(videosDir, 'does-not-exist.mp4'));

// ss-b videos: purely for JC-3 aggregate coverage — files are never actually
// created on disk (JC-3's aggregation is pure SQL and must never touch the
// filesystem, so this is deliberate, not an oversight).
db.prepare(`
  INSERT INTO video_jobs (id, projectId, shotSetId, localVideoPath, filename, status, durationSec, createdAt)
  VALUES
    ('video-b1',      'project-a', 'ss-b', ?, 'video-b1.mp4', 'succeeded', 3,   '2026-01-05 12:00:00'),
    ('video-b2',      'project-a', 'ss-b', ?, 'video-b2.mp4', 'succeeded', 4,   '2026-01-05 12:01:00'),
    ('video-b-pending','project-a', 'ss-b', ?, 'video-b-pending.mp4', 'pending', 100, '2026-01-05 12:02:00')
`).run(path.join(videosDir, 'video-b1.mp4'), path.join(videosDir, 'video-b2.mp4'), path.join(videosDir, 'video-b-pending.mp4'));

// script_drafts under project-a: one valid V2 draft, plus one draft failing
// each of the three shape gates in isolation (version / shotSetId / segments).
const validScript: ScriptOutput = {
  version: 2,
  title: '静音加湿一整晚',
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
  droppedShots: [],
  fullScript: '夜晚加湿也不怕吵醒家人。一键操作，长效续航。',
};
const v1Draft = { version: 1, title: '旧版脚本', duration: '15秒', segments: [{ shotId: 'shot-a1', text: '夜晚加湿也不怕吵醒家人' }] };
const emptyShotSetIdDraft: ScriptOutput = { ...validScript, shotSetId: '' };
const emptySegmentsDraft: ScriptOutput = { ...validScript, segments: [] };

db.prepare(`INSERT INTO script_drafts (id, projectId, provider, model, inputSnapshot, outputJson, createdAt) VALUES
  ('draft-valid', 'project-a', 'gemini', 'gemini-3.5-flash', '{}', ?, '2026-01-05 13:00:00'),
  ('draft-v1', 'project-a', 'gemini', 'gemini-3.5-flash', '{}', ?, '2026-01-05 13:01:00'),
  ('draft-empty-shotset', 'project-a', 'gemini', 'gemini-3.5-flash', '{}', ?, '2026-01-05 13:02:00'),
  ('draft-empty-segments', 'project-a', 'gemini', 'gemini-3.5-flash', '{}', ?, '2026-01-05 13:03:00')
`).run(JSON.stringify(validScript), JSON.stringify(v1Draft), JSON.stringify(emptyShotSetIdDraft), JSON.stringify(emptySegmentsDraft));

// ---------------------------------------------------------------------------
// Fixture: project-b — unrelated project (isolation + "wrong project" gate).
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
  INSERT INTO video_jobs (id, projectId, shotSetId, localVideoPath, filename, status, durationSec, createdAt)
  VALUES ('video-c1', 'project-b', 'ss-c', ?, 'video-c1.mp4', 'succeeded', 5, '2026-02-10 10:00:00')
`).run(path.join(videosDir, 'video-c1.mp4'));
const validScriptForB: ScriptOutput = { ...validScript, title: '空气净化更清新', shotSetId: 'ss-c', fullScript: '强力净化，还你清新空气。' };
db.prepare(`INSERT INTO script_drafts (id, projectId, provider, model, inputSnapshot, outputJson, createdAt) VALUES
  ('draft-for-b', 'project-b', 'gemini', 'gemini-3.5-flash', '{}', ?, '2026-02-10 12:00:00')
`).run(JSON.stringify(validScriptForB));

// =============================================================================
// isUsableV2ScriptDraft: exercise each AND-condition in isolation (mirrors
// Task 2 contract test's isolated checks on its local copy of this logic).
// =============================================================================
assert.equal(isUsableV2ScriptDraft(validScript), true, '合法 V2 草稿必须通过网关');
assert.equal(isUsableV2ScriptDraft(v1Draft), false, 'version !== 2 必须被拒绝');
assert.equal(isUsableV2ScriptDraft(emptyShotSetIdDraft), false, '空 shotSetId 必须被拒绝');
assert.equal(isUsableV2ScriptDraft(emptySegmentsDraft), false, '空 segments[] 必须被拒绝');
assert.equal(isUsableV2ScriptDraft(null), false, 'null 必须被拒绝');
assert.equal(isUsableV2ScriptDraft('not an object'), false, '非对象必须被拒绝');

// =============================================================================
// (a) project-not-found -> null (pure function; workspace.ts wraps this as
// FinalEditError, not exercised by this test — see report).
// =============================================================================
const missingProjectContext = await buildMixcutContext(db, storageRoot, 'project-does-not-exist', null);
assert.equal(missingProjectContext, null, '不存在的项目必须返回 null');

// =============================================================================
// (b) JC-1: currentShotSetId default pick, explicit echo, and
// invalid/foreign-param fallback.
// =============================================================================
const defaultContext = await buildMixcutContext(db, storageRoot, 'project-a', null);
assert.ok(defaultContext);
assert.equal(defaultContext.currentShotSetId, 'ss-b', '未传 shotSetId 时应默认选中最近创建的分镜组 ss-b');

const explicitContext = await buildMixcutContext(db, storageRoot, 'project-a', 'ss-a');
assert.ok(explicitContext);
assert.equal(explicitContext.currentShotSetId, 'ss-a', '显式传入且属于该项目的 shotSetId 必须原样回显，即使不是最近创建的那个');

const bogusIdContext = await buildMixcutContext(db, storageRoot, 'project-a', 'shot-set-does-not-exist-anywhere');
assert.ok(bogusIdContext);
assert.equal(bogusIdContext.currentShotSetId, 'ss-b', '完全不存在的 shotSetId 必须静默回退到默认值，不报错');

const foreignIdContext = await buildMixcutContext(db, storageRoot, 'project-a', 'ss-c');
assert.ok(foreignIdContext);
assert.equal(foreignIdContext.currentShotSetId, 'ss-b', '属于别的项目的 shotSetId 必须视同缺省，回退到默认值');

// =============================================================================
// (a) project/shotSet/status/path isolation, now via real code (Task 2 proved
// the same properties in raw SQL; this proves buildMixcutContext honors them).
// =============================================================================
const projectBContext = await buildMixcutContext(db, storageRoot, 'project-b', null);
assert.ok(projectBContext);
assert.equal(projectBContext.shotSets.length, 1);
assert.equal(projectBContext.shotSets[0].id, 'ss-c');
assert.equal(projectBContext.drafts.length, 1);
assert.equal(projectBContext.drafts[0].id, 'draft-for-b');
assert.equal(projectBContext.project.productCode, 'KQJHQ-B2');

assert.ok(!defaultContext.shotSets.some((s) => s.id === 'ss-c'), 'project-a 的 shotSets 不得泄漏 project-b 的 ss-c');
assert.ok(!defaultContext.drafts.some((d) => d.id === 'draft-for-b'), 'project-a 的 drafts 不得泄漏 project-b 的合法草稿');

// =============================================================================
// (c) script draft gates, via real code: only draft-valid survives; each of
// the other three malformed drafts is excluded for its own single reason.
// =============================================================================
assert.deepEqual(defaultContext.drafts.map((d) => d.id), ['draft-valid'], '只有合法 V2 草稿应出现在 drafts[] 中');
assert.equal(defaultContext.drafts[0].shotSetId, 'ss-a');
assert.equal(defaultContext.drafts[0].narrationText, validScript.fullScript, 'narrationText 应取自 ScriptOutput.fullScript');
assert.equal(defaultContext.drafts[0].targetDurationSec, 15);
assert.equal(defaultContext.drafts[0].provider, 'gemini');
assert.equal(defaultContext.drafts[0].model, 'gemini-3.5-flash');

// =============================================================================
// (d)+(e)+JC-2/JC-4: videoAssets[] for the CURRENT shot set (ss-a via
// explicitContext) contains exactly the one real/succeeded/safe/existing
// video — pending, unsafe-path, and missing-file rows are all silently
// excluded, not surfaced as errors.
// =============================================================================
assert.deepEqual(explicitContext.videoAssets.map((v) => v.videoJobId), ['video-real'], 'ss-a 的 videoAssets[] 只应包含通过全部校验的 video-real');

// Status-filter isolation (code review Fix 1): video-real-pending points at
// the exact same on-disk file as video-real (real, safe-path-valid,
// existing), so JC-4's fs.existsSync gate and the safe-path check both pass
// for it — its 'pending' status is the ONLY possible reason it can be
// excluded here. This specifically catches a regression that weakens or
// removes the `status = 'succeeded'` predicate at mixcut-context.ts:209
// (e.g. widening it to `status IN ('succeeded','pending')`), which the
// deepEqual assertion above would also fail on, but this makes the isolated
// claim explicit and independently verifiable.
assert.ok(
  !explicitContext.videoAssets.some((v) => v.videoJobId === 'video-real-pending'),
  'video-real-pending 与 video-real 指向同一个真实存在、路径安全的文件，唯一能排除它的只能是 status 过滤器'
);
const realAsset = explicitContext.videoAssets[0];
assert.equal(realAsset.shotSetId, 'ss-a');
assert.equal(realAsset.filename, 'video-real.mp4');
assert.equal(realAsset.thumbnailUrl, '/api/final-edit-assets/video-real/thumbnail');
assert.equal(realAsset.source, 'module4');
if (ffprobeWorks) {
  // Real ffprobe output (JC-2, end-to-end, not mocked): a 1s/320x240 lavfi
  // testsrc2 clip should probe back to ~1,000,000us at 320x240.
  assert.ok(Math.abs(realAsset.durationUs - 1_000_000) < 200_000, `真实探测 durationUs=${realAsset.durationUs} 应接近 1,000,000`);
  assert.equal(realAsset.width, 320, '真实探测宽度应为 320');
  assert.equal(realAsset.height, 240, '真实探测高度应为 240');
} else {
  // JC-2's documented "ffprobe unavailable" fallback: all-zero, not a crash.
  assert.equal(realAsset.durationUs, 0);
  assert.equal(realAsset.width, 0);
  assert.equal(realAsset.height, 0);
}

// bogusIdContext/defaultContext both resolve to ss-b as "current" — assert
// ss-b's videoAssets[] is empty, since none of its fixture files exist on
// disk (JC-4's fs.existsSync exclusion), reinforcing (e) for a second,
// independent shot set.
assert.deepEqual(defaultContext.videoAssets, [], 'ss-b 下没有真实存在的文件，videoAssets[] 应为空');

// =============================================================================
// (f) JC-3: shotSets[] coarse aggregate stays correct across BOTH shot sets
// in the same call, independent of which one is "current". ss-a's aggregate
// intentionally counts video-unsafe and video-missing (DB-only, no fs/path
// check) even though neither ever appears in a videoAssets[] detail list.
// =============================================================================
const ssA = defaultContext.shotSets.find((s) => s.id === 'ss-a');
const ssB = defaultContext.shotSets.find((s) => s.id === 'ss-b');
assert.ok(ssA && ssB);
assert.equal(ssA.shotCount, 3, 'ss-a 应有 3 个分镜');
assert.equal(ssA.succeededVideoCount, 3, 'ss-a 粗统计应计入 video-real + video-unsafe + video-missing（不做安全路径/存在性校验）');
assert.equal(ssA.totalDurationUs, (1 + 5 + 5) * 1_000_000, 'ss-a totalDurationUs 应为 durationSec 粗求和 * 1e6');
assert.equal(ssB.shotCount, 2, 'ss-b 应有 2 个分镜');
assert.equal(ssB.succeededVideoCount, 2, 'ss-b 粗统计应计入 video-b1 + video-b2，排除 pending 的 video-b-pending');
assert.equal(ssB.totalDurationUs, (3 + 4) * 1_000_000, 'ss-b totalDurationUs 应为 3+4 秒的粗求和 * 1e6');

// =============================================================================
// Redline (plan §11.1 / ExportIdentity.productCode JSDoc), via real code.
// =============================================================================
assert.equal(defaultContext.project.productCode, 'JSQ-A1');
assert.notEqual(defaultContext.project.productCode, 'gpt-image-2', 'productCode 绝不能读成 projects.model 的值');
assert.equal(defaultContext.project.productName, '静音加湿器 A1');
assert.equal(defaultContext.project.name, '智能加湿器投放项目');
assert.equal(defaultContext.project.createdAt, '2026-01-05 10:00:00');

// =============================================================================
// Cleanup.
// =============================================================================
fs.rmSync(storageRoot, { recursive: true, force: true });
db.close();

console.log('final-edit mixcut flow tests passed');

import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initFinalEditSchema } from '../lib/final-edit/schema.ts';
import { FINAL_EDIT_ANALYZER_VERSION } from '../lib/final-edit/workspace.ts';

// app/api/final-edit-assets/[videoJobId]/reanalyze/route.ts 写入缺陷的回归测试（技术计划 M2）。
// 旧实现：INSERT 列清单没有 mediaJson → 新插入的分析行 durationUs 恒为 0，所有 clip 被编辑期
// 校验判超限；analyzerVersion 写死 '1' → prepare 的分析缓存永久失效。这里的 INSERT 语句
// 逐字镜像路由的写入（含 mediaJson 与 FINAL_EDIT_ANALYZER_VERSION），用 :memory: 库 + 桩 probe 验证。

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
initFinalEditSchema(db);

/** 与 reanalyze 路由同源的媒体探测（桩）：返回带 durationUs 的 mediaJson 内容。 */
const stubProbe = () => ({ durationUs: 12_345_678, width: 720, height: 960, fps: 24 });

// 路由的完整写入（对齐 workspace.ts:1125-1131 的列清单）。
function runReanalyzeWrite(videoJobId: string, shotSetId: string, fingerprint: string, providerId: string, model: string, mediaJson: string, generatedJson: string, timestamp: string): void {
  db.prepare(`
    INSERT INTO final_edit_asset_analysis
      (videoJobId, shotSetId, fileFingerprint, providerId, model, analyzerVersion, status, mediaJson, generatedJson, updatedAt, analyzedAt)
    VALUES (?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?, ?)
    ON CONFLICT(videoJobId) DO UPDATE SET shotSetId=excluded.shotSetId, fileFingerprint=excluded.fileFingerprint,
      providerId=excluded.providerId, model=excluded.model, analyzerVersion=excluded.analyzerVersion, status='succeeded',
      mediaJson=excluded.mediaJson, generatedJson=excluded.generatedJson,
      errorCode=NULL, errorMessage=NULL, analyzedAt=excluded.analyzedAt, updatedAt=excluded.updatedAt
  `).run(videoJobId, shotSetId, fingerprint, providerId, model, FINAL_EDIT_ANALYZER_VERSION, mediaJson, generatedJson, timestamp, timestamp);
}

// 1) 对表中不存在的 videoJobId 写入：mediaJson 必须能解析出 durationUs > 0，analyzerVersion 为当前版本。
const media = stubProbe();
runReanalyzeWrite('video-new', 'set-a', 'fp-new', 'prov-1', 'model-1', JSON.stringify(media), JSON.stringify({ summary: 'x' }), '2026-09-02T00:00:00.000Z');
const inserted = db.prepare(`SELECT mediaJson, analyzerVersion, status FROM final_edit_asset_analysis WHERE videoJobId='video-new'`).get() as { mediaJson: string; analyzerVersion: string; status: string };
assert.equal(inserted.status, 'succeeded');
assert.equal(inserted.analyzerVersion, FINAL_EDIT_ANALYZER_VERSION, '重新分析必须写入当前分析版本');
assert.ok(Number((JSON.parse(inserted.mediaJson) as { durationUs?: number }).durationUs || 0) > 0, 'mediaJson 必须包含真实时长，不得再是空对象');

// 2) 对已存在的行写入：mediaJson 必须被更新而不是保留旧值（旧实现缺列导致 durationUs=0 行永久残留）。
db.prepare(`
  INSERT INTO final_edit_asset_analysis
    (videoJobId, shotSetId, fileFingerprint, providerId, model, analyzerVersion, status, mediaJson, generatedJson, updatedAt, analyzedAt)
  VALUES ('video-existing', 'set-a', 'fp-old', 'prov-1', 'model-1', '1', 'succeeded', '{}', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
`).run();
const legacyRow = db.prepare(`SELECT mediaJson, analyzerVersion FROM final_edit_asset_analysis WHERE videoJobId='video-existing'`).get() as { mediaJson: string; analyzerVersion: string };
assert.equal(Number((JSON.parse(legacyRow.mediaJson) as { durationUs?: number }).durationUs || 0), 0, '前置：旧行 mediaJson 为空对象（复现缺陷）');
assert.equal(legacyRow.analyzerVersion, '1');
runReanalyzeWrite('video-existing', 'set-a', 'fp-new', 'prov-1', 'model-1', JSON.stringify(media), JSON.stringify({ summary: 'y' }), '2026-09-02T00:00:00.000Z');
const updated = db.prepare(`SELECT mediaJson, analyzerVersion, fileFingerprint FROM final_edit_asset_analysis WHERE videoJobId='video-existing'`).get() as { mediaJson: string; analyzerVersion: string; fileFingerprint: string };
assert.equal(updated.analyzerVersion, FINAL_EDIT_ANALYZER_VERSION, '重新分析必须覆盖旧版本号');
assert.equal(updated.fileFingerprint, 'fp-new', '重新分析必须覆盖旧指纹');
assert.ok(Number((JSON.parse(updated.mediaJson) as { durationUs?: number }).durationUs || 0) > 0, '重新分析必须把旧空 mediaJson 更新为真实时长');

console.log('final-edit-reanalyze tests passed');

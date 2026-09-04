/**
 * 成片时间线可编辑性诊断工具（取证用，只读，不接 CI、不是测试）。
 *
 * 背景：`lib/final-edit/workspace.ts` 的每一条编辑命令在落库前都会遍历整条时间线的
 * 所有 clip 做源校验；只要任意一个 clip 不过，本次命令（删除/替换/移动/修剪/换 BGM/
 * 换封面）整条被拒，界面弹回原样——用户看到的就是「素材删不掉、换不了」。
 *
 * 本脚本在只读库上**完整复刻**该判定的各类失败条件，把每个锁死 variant 归类到具体成因，
 * 用于判断测试用户遇到的到底是哪一条（见执行方案 §2.2 的五类）：
 *   - analysis 行不存在 / analysis 未成功:<status>
 *   - 指纹不匹配
 *   - mediaJson 缺 durationUs
 *   - 尾帧超限 out=<n> floor=<n> ceil=<n> dur=<n>s
 *   - 源文件不存在（外部素材）
 *   - 结构校验失败（负帧 / 超出 bodyFrames / 短于最小帧数）
 *
 * 只读承诺：仅以 `readonly` 打开 `dataRoot()/data/workbench.db`，绝不写入；
 * 输出不含 API Key 或任何鉴权信息，只含文件路径与时间线数据。
 *
 * 用法：
 *   node scripts/final-edit-timeline-diagnose.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { dataRoot } from '../lib/data-root.ts';

const FPS = 24;
const MIN_CLIP_FRAMES = 12;

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** 复刻 workspace.ts 里 editableVideoSource 的判定，返回 { analysis?, reason? }。 */
function inspectSource(db, storageRoot, group, clip) {
  const videoJobId = clip.videoJobId;
  const externalId = videoJobId.startsWith('external-asset-') ? videoJobId.slice('external-asset-'.length) : null;
  if (externalId !== null) {
    const external = db
      .prepare(
        `SELECT e.relativePath, e.status, e.originalFilename
           FROM final_edit_external_assets e
          WHERE e.projectId=? AND e.shotSetId=? AND e.id=?`,
      )
      .get(group.projectId, group.shotSetId, externalId);
    if (!external) return { analysis: null, reason: '外部素材记录不存在' };
    if (external.status !== 'ready') return { analysis: null, reason: `外部素材未就绪:${external.status}` };
    // 复刻 resolveImportedExternalAssetVideoPath 的文件存在性检查（只读，不重复安全校验）。
    const absolutePath = path.resolve(storageRoot, external.relativePath);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      return { analysis: null, reason: '源文件不存在', filePath: absolutePath };
    }
    const analysis = db
      .prepare(`SELECT fileFingerprint, mediaJson, status FROM final_edit_asset_analysis WHERE videoJobId=?`)
      .get(videoJobId);
    if (!analysis) return { analysis: null, reason: 'analysis 行不存在' };
    if (analysis.status !== 'succeeded') return { analysis: null, reason: `analysis 未成功:${analysis.status}` };
    return { analysis };
  }
  const job = db
    .prepare(`SELECT vj.status FROM video_jobs vj WHERE vj.id=? AND vj.projectId=? AND vj.shotSetId=?`)
    .get(videoJobId, group.projectId, group.shotSetId);
  if (!job) return { analysis: null, reason: '视频任务不存在' };
  if (job.status !== 'succeeded') return { analysis: null, reason: `视频任务未成功:${job.status}` };
  const analysis = db
    .prepare(`SELECT fileFingerprint, mediaJson, status FROM final_edit_asset_analysis WHERE videoJobId=?`)
    .get(videoJobId);
  if (!analysis) return { analysis: null, reason: 'analysis 行不存在' };
  if (analysis.status !== 'succeeded') return { analysis: null, reason: `analysis 未成功:${analysis.status}` };
  return { analysis };
}

/** 复刻 workspace.ts:1893-1898 的判定，返回该 clip 的失败原因（通过则返回 null）。 */
function checkClip(db, storageRoot, group, timeline, clip) {
  const structuralBad =
    clip.timelineInFrame < 0 ||
    clip.timelineOutFrame > timeline.bodyFrames ||
    clip.timelineOutFrame - clip.timelineInFrame < MIN_CLIP_FRAMES ||
    clip.sourceInFrame < 0 ||
    clip.sourceOutFrame - clip.sourceInFrame < MIN_CLIP_FRAMES;
  if (structuralBad) return '结构校验失败（负帧 / 超出正文 / 短于最小帧数）';

  const { analysis, reason } = inspectSource(db, storageRoot, group, clip);
  if (!analysis) return reason;

  const media = parseJson(analysis.mediaJson || '{}', {});
  const durationUs = Number(media.durationUs || 0);
  if (!durationUs || !Number.isFinite(durationUs)) return 'mediaJson 缺 durationUs';

  const floorFrames = Math.floor((durationUs * FPS) / 1_000_000);
  const ceilFrames = Math.ceil((durationUs * FPS) / 1_000_000);
  if (analysis.fileFingerprint !== clip.sourceFingerprint) return '指纹不匹配';
  if (clip.sourceOutFrame > floorFrames) {
    return `尾帧超限 out=${clip.sourceOutFrame} floor=${floorFrames} ceil=${ceilFrames} dur=${(durationUs / 1_000_000).toFixed(3)}s`;
  }
  return null;
}

function main() {
  const dbPath = path.join(dataRoot(), 'data', 'workbench.db');
  if (!fs.existsSync(dbPath)) throw new Error(`找不到数据库：${dbPath}`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const storageRoot = path.join(dataRoot(), 'storage');

  const variants = db
    .prepare(
      `SELECT v.id, v.groupId, v.indexNum, v.outputPreset, v.timelineJson, v.revision,
              g.projectId, g.shotSetId
         FROM final_edit_variants v
         JOIN final_edit_groups g ON g.id = v.groupId`,
    )
    .all();

  const lockedVariants = [];
  const causeCount = new Map();
  let variantWithClips = 0;
  const margins = [];

  for (const variant of variants) {
    const timeline = parseJson(variant.timelineJson || '{}', { bodyFrames: 0, clips: [] });
    const clips = Array.isArray(timeline.clips) ? timeline.clips : [];
    if (clips.length === 0) continue;
    variantWithClips += 1;

    const group = { id: variant.groupId, projectId: variant.projectId, shotSetId: variant.shotSetId };
    const badClips = [];
    for (const clip of clips) {
      const reason = checkClip(db, storageRoot, group, timeline, clip);
      if (reason !== null) {
        badClips.push({ clipId: clip.id, videoJobId: clip.videoJobId, reason, outFrame: clip.sourceOutFrame });
        causeCount.set(reason, (causeCount.get(reason) || 0) + 1);
      } else {
        // 边界余量统计：只统计能读到真实时长的通过 clip。
        const media = parseJson(
          (inspectSource(db, storageRoot, group, clip).analysis || {}).mediaJson || '{}',
          {},
        );
        const durationUs = Number(media.durationUs || 0);
        if (durationUs && Number.isFinite(durationUs)) {
          const floorFrames = Math.floor((durationUs * FPS) / 1_000_000);
          margins.push(floorFrames - clip.sourceOutFrame);
        }
      }
    }
    if (badClips.length > 0) {
      lockedVariants.push({ id: variant.id, revision: variant.revision, outputPreset: variant.outputPreset, badClips: badClips.slice(0, 3), totalBad: badClips.length });
    }
  }

  const header = '='.repeat(72);
  console.log(header);
  console.log('成片时间线可编辑性诊断（只读，未修改任何数据）');
  console.log(`数据库：${dbPath}`);
  console.log(`有片段的 variant 总数：${variantWithClips}`);
  console.log(`被锁死的 variant 数：${lockedVariants.length}`);
  console.log('');

  if (lockedVariants.length > 0) {
    console.log('--- 坏 clip 成因分布 ---');
    for (const [reason, count] of [...causeCount.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${count}\t${reason}`);
    }
    console.log('');
    console.log('--- 被锁死的 variant 明细（每个展示前 3 个坏 clip）---');
    for (const locked of lockedVariants) {
      console.log(`  variant ${locked.id}  revision=${locked.revision}  preset=${locked.outputPreset}  坏 clip=${locked.totalBad}`);
      for (const clip of locked.badClips) {
        console.log(`    - clip ${clip.clipId}  素材 ${clip.videoJobId}  sourceOutFrame=${clip.outFrame}\n      原因：${clip.reason}`);
      }
    }
    console.log('');
  } else {
    console.log('没有锁死的 variant。');
    console.log('');
  }

  console.log('--- 边界余量统计（floor(durationUs*24/1e6) - sourceOutFrame，仅通过 clip）---');
  if (margins.length === 0) {
    console.log('  无数据');
  } else {
    const sorted = [...margins].sort((a, b) => a - b);
    const p10 = sorted[Math.max(0, Math.floor(sorted.length * 0.1) - 1)];
    const median = sorted[Math.floor(sorted.length / 2)];
    const atRisk = sorted.filter((m) => m <= 0).length;
    console.log(`  样本数：${sorted.length}`);
    console.log(`  最小值：${sorted[0]}`);
    console.log(`  P10：${p10}`);
    console.log(`  中位数：${median}`);
    console.log(`  余量 <= 0 的个数：${atRisk}`);
    console.log(`  余量 <= 1 的个数：${sorted.filter((m) => m <= 1).length}`);
  }
  console.log(header);

  db.close();
}

try {
  main();
} catch (error) {
  console.error(`诊断失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

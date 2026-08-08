/**
 * 批量成片「封面片头」自查工具（一次性排查用，不接 CI、不是测试）。
 *
 * 背景：成片开头应该是 20 帧带标题的封面（FINAL_EDIT_INTRO_DURATION_US，与单条
 * 剪辑同一契约）。渲染器改动之后如果没重启 dev server，长驻调度器会继续用旧的
 * renderer 闭包——产物没有片头，但任务一切显示成功。肉眼看片太慢，这里做像素判定。
 *
 * 判据（实测标定）：抽 t=0.2s 的一帧与该次渲染的 cover 图比对，48×48 灰度化后的
 * 平均绝对差 —— 有片头约 1.65/255（就是 JPEG/H.264 压缩噪声），没片头 32~45。
 * 阈值取 8。
 *
 * 用法：
 *   node scripts/batch-intro-audit.mjs                # 审计最近 20 条候选
 *   node scripts/batch-intro-audit.mjs <projectId>    # 限定某个项目
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { resolveFfmpegPath } from '../lib/ffmpeg.ts';
import { dataRoot } from '../lib/data-root.ts';
import { FINAL_EDIT_INTRO_DURATION_US } from '../lib/final-edit/types.ts';

const run = promisify(execFile);
const INTRO_SEC = FINAL_EDIT_INTRO_DURATION_US / 1_000_000;
/** 平均绝对差阈值：低于此值判定"这一帧就是封面"。 */
const SAME_FRAME_THRESHOLD = 8;
const PROBE_AT_SEC = 0.2;

function openReadOnlyDb() {
  const file = path.join(dataRoot(), 'data', 'workbench.db');
  if (!fs.existsSync(file)) throw new Error(`找不到数据库：${file}`);
  return new Database(file, { readonly: true, fileMustExist: true });
}

async function meanAbsoluteDifference(leftPath, rightPath) {
  const normalize = async (file) => sharp(file).resize(48, 48, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const [left, right] = await Promise.all([normalize(leftPath), normalize(rightPath)]);
  if (left.length !== right.length) throw new Error('两图归一化后尺寸不一致');
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += Math.abs(left[index] - right[index]);
  return total / left.length;
}

async function probeDurationSec(ffmpeg, file) {
  // 只用 ffmpeg（ffprobe 在 macOS 打包里被有意移除），从 stderr 读 Duration。
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' }).catch((error) => error);
  const matched = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/u.exec(stderr ?? '');
  if (!matched) return null;
  return Number(matched[1]) * 3600 + Number(matched[2]) * 60 + Number(matched[3]);
}

async function auditOne(ffmpeg, workDir, row) {
  const videoPath = path.resolve(row.videoPath);
  const coverPath = path.resolve(row.coverPath);
  if (!fs.existsSync(videoPath)) return { ...row, verdict: 'missing', note: '视频文件不存在' };
  if (!fs.existsSync(coverPath)) return { ...row, verdict: 'missing', note: '封面文件不存在' };

  const framePath = path.join(workDir, `${randomUUID()}.png`);
  await run(ffmpeg, [
    '-loglevel', 'error', '-ss', PROBE_AT_SEC.toFixed(3), '-i', videoPath,
    '-frames:v', '1', '-y', framePath,
  ]);
  const difference = await meanAbsoluteDifference(framePath, coverPath);
  fs.rmSync(framePath, { force: true });

  const durationSec = await probeDurationSec(ffmpeg, videoPath);
  const expectedSec = row.narrationDurationUs ? row.narrationDurationUs / 1_000_000 + INTRO_SEC : null;
  return {
    ...row,
    difference,
    durationSec,
    expectedSec,
    verdict: difference < SAME_FRAME_THRESHOLD ? 'intro' : 'no-intro',
  };
}

async function main() {
  const projectId = process.argv[2] ?? null;
  const db = openReadOnlyDb();
  // 口播时长的解析优先级与渲染器一致（resolveNarrationFromArrangement）：
  // 先看 arrangement 里冻结的 seam，取不到再看权威表 batch_script_narrations
  // ——口播先于分配之后，arrangement 里往往还是占位，但成片是有声的。
  const rows = db.prepare(`
    SELECT v.id AS outputVersionId, p.seq AS planSeq, b.projectId,
           COALESCE(
             json_extract(v.arrangementJson, '$.narration.durationUs'),
             json_extract(n.narrationJson, '$.durationUs')
           ) AS narrationDurationUs
    FROM batch_output_versions v
    JOIN batch_output_plans p ON p.id = v.planId
    JOIN batch_production_versions pv ON pv.id = p.batchVersionId
    JOIN batch_productions b ON b.id = pv.batchId
    LEFT JOIN batch_script_narrations n ON n.scriptSnapshotId = p.scriptSnapshotId
    WHERE (? IS NULL OR b.projectId = ?)
    ORDER BY v.createdAt DESC
    LIMIT 20
  `).all(projectId, projectId);
  db.close();

  const renderRoot = path.join(dataRoot(), 'storage', 'batch-renders');
  // 渲染目录名是 `<outputVersionId>-<uuid>`，同一版本重渲会有多个，取最新那个。
  const directories = fs.existsSync(renderRoot)
    ? fs.readdirSync(renderRoot).map((name) => ({
      name,
      fullPath: path.join(renderRoot, name),
      modifiedAt: fs.statSync(path.join(renderRoot, name)).mtimeMs,
    })).sort((left, right) => right.modifiedAt - left.modifiedAt)
    : [];

  const targets = [];
  for (const row of rows) {
    const directory = directories.find(({ name }) => name.startsWith(`${row.outputVersionId}-`));
    if (!directory) continue;
    targets.push({
      ...row,
      videoPath: path.join(directory.fullPath, 'video.mp4'),
      coverPath: path.join(directory.fullPath, 'cover.jpg'),
      renderedAt: new Date(directory.modifiedAt).toLocaleString('zh-CN'),
    });
  }

  if (targets.length === 0) {
    console.log('没有找到任何已渲染的候选产物。先在第 3 步渲染或点「重新生成」。');
    return;
  }

  const ffmpeg = resolveFfmpegPath();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-intro-audit-'));
  try {
    console.log(`阈值：平均绝对差 < ${SAME_FRAME_THRESHOLD} 判定有片头（片头时长 ${INTRO_SEC.toFixed(3)}s）\n`);
    let withIntro = 0;
    for (const target of targets) {
      const result = await auditOne(ffmpeg, workDir, target);
      if (result.verdict === 'missing') {
        console.log(`❔ 成片 ${String(result.planSeq).padStart(2, '0')}  ${result.note}`);
        continue;
      }
      if (result.verdict === 'intro') withIntro += 1;
      const durationText = result.durationSec == null ? '时长未知' : `${result.durationSec.toFixed(2)}s`;
      const expectText = result.expectedSec == null
        ? '（查不到口播时长，只按片头判定）'
        : `预期 ${result.expectedSec.toFixed(2)}s（口播 ${(result.narrationDurationUs / 1_000_000).toFixed(2)}s + 片头 ${INTRO_SEC.toFixed(3)}s）`;
      console.log(
        `${result.verdict === 'intro' ? '✅ 有片头' : '❌ 无片头'}  成片 ${String(result.planSeq).padStart(2, '0')}`
        + `  平均差 ${result.difference.toFixed(2)}  时长 ${durationText}  ${expectText}  渲染于 ${result.renderedAt}`,
      );
    }
    console.log(`\n合计 ${targets.length} 条，有片头 ${withIntro} 条。`);
    if (withIntro < targets.length) {
      console.log('无片头的条目：确认 dev server 已在渲染器改动之后重启，然后在第 3 步点「重新生成」重跑。');
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

await main();

import { resolvePackagingDir, resolvePackagingNode, resolvePackagingTemplateDir, buildTimelineVars, runPackagingPipeline } from '../media-core/packaging-runtime.ts';
export { resolvePackagingDir, resolvePackagingNode, resolvePackagingTemplateDir, buildTimelineVars } from '../media-core/packaging-runtime.ts';
// 包装任务执行器（HyperFrames 包装层 · 独立包装任务）
// 职责：读渲染任务的快照与内部产物 → 组装包装文案 → spawn packaging/package-video.mjs
//       渲染透明包装层并与成片叠加 → 以「xxx-包装.mp4」独立产物发布（原片不动）。
// 失败语义：仅当前包装任务失败，已发布的原片不受影响；中止（停机）时杀整棵进程树。

import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { probeDurationSec, runFfmpeg } from '../ffmpeg.ts';
import { writeLog } from '../logger.ts';
import { FINAL_EDIT_INTRO_DURATION_US } from '../media-core/render-contract.ts';
import { OUTPUT_PRESETS } from '../media-core/cover-types.ts';
import { FinalEditError } from './errors.ts';
import { completeExportReservation, publishReservedSingleFile, reserveProjectExportTarget, releaseReservedExportTarget, type ReservedProjectExportTarget } from './export-naming.ts';
import { packagingCode } from '../media-core/production-codes.ts';
import type { ExportIdentity } from './types.ts';
import { ensurePackagingPointCues, type PointCue } from './packaging-cues.ts';
import { extractAccentColors } from './packaging-color.ts';
import { safeFontFilename } from './packaging-font.ts';
import { buildPackagingVars, loadProjectPackagingData, type PackagingLayouts, type PackagingVars } from './packaging-vars.ts';
import type { PackagingStickerDefaults, PackagingStickerInstance } from '../media-core/packaging-stickers.ts';
import { resolvePackagingStickerAssets } from '../media-core/packaging-sticker-assets.ts';
import type { FinalEditRenderSnapshot } from './renderer.ts';
import { composeCoverJpg } from './cover-compose.ts';
import { assertNoStorageSymlink, resolveStoragePath } from './storage-path.ts';

// 单实现已迁至 packaging-vars.ts（导出占位校验共用）；此处 re-export 保持既有调用方不破
export { loadProjectPackagingData };

export interface FinalEditPackagingSnapshot {
  renderJobId: string;
  variantId: string;
  /** 模板标识（overlay-poster / overlay-journal / overlay-minimal / overlay-variety）。 */
  template?: string;
  /** 预留：后期包装界面的文字/颜色/位置编辑只写这个覆盖层。 */
  varsOverrides?: Partial<PackagingVars>;
  /**
   * 导出联动模式：渲染任务把视频预留目标交给包装任务，
   * 包装版直接以正常成片名发布（目录里只有包装版一个文件）。
   * 缺省 = 独立包装模式（产物带「-包装」后缀与原片共存）。
   */
  exportTarget?: ReservedProjectExportTarget;
  /** v3 动态时序：正片卖点对时列表（enqueueRender 冻结）。 */
  pointCues?: PointCue[];
  /** v3 动态时序：封面静帧时长（秒）。 */
  coverSec?: number;
  /** v3 动态时序：正片卖点模式 timed/even/none。 */
  pointCuesMode?: 'timed' | 'even' | 'none';
  /** §7：按模板记忆的手动布局（enqueueRender 冻结，写入 vars.json 供模板 applyLayouts）。 */
  layouts?: PackagingLayouts;
  /** §7：pointCues 手动编辑保护标志（随快照冻结，审计用）。 */
  pointCuesEdited?: boolean;
  /** 独立贴纸与新增默认动效，随渲染快照冻结。 */
  stickers?: PackagingStickerInstance[];
  stickerDefaults?: PackagingStickerDefaults;
  /** §10 ②：三槽用户字体（enqueueRender 时冻结；文件已物化到 packaging/fonts/user/）。 */
  pointFont?: { family: string; file: string };
  titleFont?: { family: string; file: string };
  subtitleFont?: { family: string; file: string };
}

export interface PackagingInternalOutput {
  videoRelativePath: string;
  vars: PackagingVars;
  renderSeconds: number;
}

export interface PackagedPublishTarget {
  videoRelativePath: string;
  videoFilename: string;
  displayDirectory: string;
}

export interface PackagingJobResult {
  internal: PackagingInternalOutput;
  published: PackagedPublishTarget;
}

const PACKAGED_TMP_SUFFIX = '.packaging-tmp';

function makeAbortError(): Error {
  const error = new Error('包装任务因服务停机而中止');
  error.name = 'AbortError';
  return error;
}

interface RenderJobRecord {
  groupId: string;
  snapshot: FinalEditRenderSnapshot;
  output: {
    videoRelativePath: string;
    coverRelativePath?: string;
    publishedVideoRelativePath?: string;
    videoFilename?: string;
    displayDirectory?: string;
    durationSec?: number;
  };
}

export function loadSucceededRenderJob(db: Database.Database, renderJobId: string): RenderJobRecord {
  const row = db.prepare(`SELECT status, groupId, inputSnapshotJson, outputJson FROM final_edit_jobs WHERE id=? AND kind='render'`).get(renderJobId) as { status: string; groupId: string | null; inputSnapshotJson: string; outputJson: string | null } | undefined;
  if (!row || row.status !== 'succeeded' || !row.outputJson) throw new FinalEditError('render_required', '请先完成一次导出渲染，再使用包装', 409);
  let snapshot: FinalEditRenderSnapshot;
  let output: RenderJobRecord['output'];
  try {
    snapshot = JSON.parse(row.inputSnapshotJson) as FinalEditRenderSnapshot;
    output = JSON.parse(row.outputJson) as RenderJobRecord['output'];
  } catch {
    throw new FinalEditError('render_snapshot_invalid', '渲染任务快照已损坏，请重新导出', 409);
  }
  if (!output?.videoRelativePath) throw new FinalEditError('render_artifact_invalid', '渲染产物记录缺失，请重新导出', 409);
  return { groupId: row.groupId || '', snapshot, output };
}

/** 组装模板时间线变量：v2 文案契约 + v3 时序（coverSec/totalSec/pointCues/pointCuesMode）+ §7 布局 + §10 ② 三槽字体文件。 */
/** 供 API 做包装文案预览：不重渲、只跑确定性组装。 */
export function previewPackagingVars(db: Database.Database, renderJobId: string, overrides?: Partial<PackagingVars>): PackagingVars {
  const { snapshot } = loadSucceededRenderJob(db, renderJobId);
  const project = snapshot.exportIdentity?.projectId ? loadProjectPackagingData(db, snapshot.exportIdentity.projectId) : {};
  return buildPackagingVars({ coverTitle: snapshot.group.coverTitle ? { primary: snapshot.group.coverTitle.primary.text, secondary: snapshot.group.coverTitle.secondary.text } : undefined, subtitleCues: snapshot.group.subtitleCues, exportIdentity: snapshot.exportIdentity, project, overrides });
}

/** 清理历史中断遗留的临时产物（包装工作目录与导出目录的 .packaging-tmp）。 */
function sweepStaleTempFiles(packagingDir: string, exportDirAbs: string): void {
  try {
    const rendersDir = path.join(packagingDir, 'renders');
    for (const entry of fs.readdirSync(rendersDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('_work_')) continue;
      const full = path.join(rendersDir, entry.name);
      try {
        if (Date.now() - fs.statSync(full).mtimeMs > 60 * 60_000) fs.rmSync(full, { recursive: true, force: true });
      } catch { /* 单个目录清理失败不阻塞 */ }
    }
  } catch { /* renders 目录不存在等情况忽略 */ }
  try {
    for (const entry of fs.readdirSync(exportDirAbs)) {
      if (entry.endsWith(PACKAGED_TMP_SUFFIX)) {
        try { fs.unlinkSync(path.join(exportDirAbs, entry)); } catch { /* 忽略 */ }
      }
    }
  } catch { /* 忽略 */ }
}

/** 发布包装产物：联动模式进渲染预留目标（目录唯一成片）；独立模式带「-包装」后缀与原片共存。 */
export async function publishPackagedResult(input: {
  storageRoot: string;
  internalVideoRelativePath: string;
  exportTarget?: ReservedProjectExportTarget;
  renderVideoRelativePath: string;
  displayDirectory?: string;
  exportIdentity?: ExportIdentity;
}): Promise<PackagedPublishTarget> {
  const target = input.exportTarget || (input.exportIdentity
    ? reserveProjectExportTarget(input.storageRoot, input.exportIdentity) : undefined);
  if (target) {
    try {
      await publishReservedSingleFile({
        storageRoot: input.storageRoot,
        sourceRelativePath: input.internalVideoRelativePath,
        targetRelativePath: target.videoRelativePath,
        reservationRelativePath: target.reservationRelativePath,
        invalidCode: 'packaging_output_invalid',
      });
      completeExportReservation(input.storageRoot, target.reservationRelativePath);
    } catch (error) {
      if (!input.exportTarget) releaseReservedExportTarget(input.storageRoot, target);
      throw error;
    }
    return {
      videoRelativePath: target.videoRelativePath,
      videoFilename: target.videoFilename,
      displayDirectory: target.displayDirectory,
    };
  }
  return publishPackagedVideo(input);
}

/** 独立包装模式：与原片同目录、独立文件名（<原片名>-包装.mp4），占位检测 + 临时文件 + 原子改名。 */
export function publishPackagedVideo(input: {
  storageRoot: string;
  internalVideoRelativePath: string;
  renderVideoRelativePath: string;
  displayDirectory?: string;
}): PackagedPublishTarget {
  const internalAbs = assertNoStorageSymlink(input.storageRoot, input.internalVideoRelativePath);
  const internalSize = fs.statSync(internalAbs).size;
  if (internalSize <= 0) throw new FinalEditError('packaging_output_invalid', '包装产物为空');
  const renderDirRelative = path.dirname(input.renderVideoRelativePath);
  const exportDirAbs = assertNoStorageSymlink(input.storageRoot, renderDirRelative);
  sweepStaleTempFiles(resolvePackagingDir(), exportDirAbs);
  const renderBase = path.basename(input.renderVideoRelativePath).replace(/\.mp4$/i, '');
  for (let sequence = 1; sequence < 10_000; sequence += 1) {
    const suffix = sequence === 1 ? '' : `-${String(sequence).padStart(2, '0')}`;
    const videoFilename = `${renderBase}-包装${suffix}.mp4`;
    const targetAbs = path.join(exportDirAbs, videoFilename);
    if (fs.existsSync(targetAbs)) continue;
    const temporary = `${targetAbs}${PACKAGED_TMP_SUFFIX}`;
    fs.copyFileSync(internalAbs, temporary, fs.constants.COPYFILE_EXCL);
    if (fs.statSync(temporary).size !== internalSize) {
      fs.unlinkSync(temporary);
      throw new FinalEditError('packaging_output_invalid', '包装发布产物大小校验失败');
    }
    fs.renameSync(temporary, targetAbs);
    return {
      videoRelativePath: path.join(renderDirRelative, videoFilename),
      videoFilename,
      displayDirectory: input.displayDirectory || '',
    };
  }
  throw new FinalEditError('export_name_exhausted', '同名包装成片数量过多，无法发布');
}

/** 中止发生在发布之后时，撤掉已发布的包装版（原片不受影响）。 */
export async function deletePackagedPublish(storageRoot: string, target: PackagedPublishTarget): Promise<void> {
  try { await fs.promises.unlink(assertNoStorageSymlink(storageRoot, target.videoRelativePath)); } catch { /* 已不存在 */ }
}

export function registerPackagedArtifact(db: Database.Database, input: {
  projectId: string;
  sourceJobId: string;
  target: PackagedPublishTarget;
  createdAt: string;
  /** 联动模式 = 'final_video'（目录唯一成片）；独立模式 = 'packaged_video'。 */
  kind?: 'final_video' | 'packaged_video';
}): void {
  const kind = input.kind || 'packaged_video';
  db.prepare(`DELETE FROM project_artifacts WHERE projectId=? AND relativePath=? AND COALESCE(sourceJobId, '')<>?`).run(input.projectId, input.target.videoRelativePath, input.sourceJobId);
  db.prepare(`
    INSERT INTO project_artifacts
      (id, projectId, kind, displayName, relativePath, mimeType, sourceJobId, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sourceJobId, kind) DO UPDATE SET
      projectId=excluded.projectId,
      displayName=excluded.displayName,
      relativePath=excluded.relativePath,
      mimeType=excluded.mimeType
  `).run(`final-edit:${input.sourceJobId}:${kind === 'final_video' ? 'video' : 'packaged-video'}`, input.projectId, kind, input.target.videoFilename, input.target.videoRelativePath, 'video/mp4', input.sourceJobId, input.createdAt);
}

/**
 * §C 包装封面帧合成（联动模式）：overlay.webm 抽封面落定帧（透明 PNG），与原始底图经
 * composeCoverJpg（与 renderer 单实现）合成包装封面 JPG 临时文件。
 * 在视频发布前调用——ffmpeg/sharp 失败 = 包装任务失败且发布未开始、预留完整，重试走既有已验证路径。
 * 返回临时 JPG 路径，由调用方在视频发布成功后原子覆盖已发布素封面。
 */
async function composePackagedCoverTemp(input: {
  storageRoot: string;
  jobDir: string;
  renderSnapshot: FinalEditRenderSnapshot;
  coverSec: number;
  signal?: AbortSignal;
}): Promise<string> {
  const overlayAbs = path.join(input.jobDir, 'overlay.webm');
  if (!fs.existsSync(overlayAbs)) throw new FinalEditError('packaging_cover_failed', '包装层产物缺失，无法合成包装封面', 409);
  const framePng = path.join(input.jobDir, 'overlay-cover-frame.png');
  // 抽帧时刻=封面段中点（与「跳到封面」预览锚点一致）：入场动画已落定、.stage 退场（coverSec-0.18 起淡出）未开始——
  // 曾取 coverSec-1帧 正落在退场淡出中段，封面整体半透明（2026-10-10 用户实机实锤）
  const settleSec = Math.max(0.04, input.coverSec / 2);
  await runFfmpeg(['-y', '-c:v', 'libvpx-vp9', '-i', overlayAbs, '-ss', settleSec.toFixed(3), '-frames:v', '1', '-pix_fmt', 'rgba', framePng], { timeoutMs: 60_000, signal: input.signal });
  const preset = OUTPUT_PRESETS[input.renderSnapshot.variant.outputPreset];
  const coverTitleEnabled = input.renderSnapshot.group.coverTitleEnabled !== false;
  const titlePng = path.join(resolveStoragePath(input.storageRoot, input.renderSnapshot.overlayBundle.relativeDir), 'title.png');
  const tempJpg = path.join(input.jobDir, 'cover-packaged.tmp.jpg');
  await composeCoverJpg({
    coverSourcePath: assertNoStorageSymlink(input.storageRoot, input.renderSnapshot.coverRelativePath),
    framing: input.renderSnapshot.variant.cover.framing,
    output: { width: preset.width, height: preset.height },
    overlays: [...(coverTitleEnabled && fs.existsSync(titlePng) ? [titlePng] : []), framePng],
    jpgPath: tempJpg,
  });
  fs.rmSync(framePng, { force: true });
  fs.rmSync(overlayAbs, { force: true }); // 取件用完即清，产物目录不囤大文件
  return tempJpg;
}

/**
 * 包装任务主流程（worker 在重任务锁内调用）：组装文案 → 渲染管线 → 校验 → 发布。
 * 返回内部产物与发布目标；数据库状态更新由 worker 在事务内完成。
 */
export async function executePackagingJob(input: {
  db: Database.Database;
  storageRoot: string;
  jobId: string;
  projectId: string;
  snapshot: FinalEditPackagingSnapshot;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}): Promise<PackagingJobResult> {
  const { snapshot: renderSnapshot, output: renderOutput, groupId } = loadSucceededRenderJob(input.db, input.snapshot.renderJobId);
  const packagingDir = resolvePackagingDir();
  const templateDir = resolvePackagingTemplateDir(packagingDir, input.snapshot.template);
  const templateName = path.basename(templateDir);
  const sourceVideoAbs = assertNoStorageSymlink(input.storageRoot, renderOutput.videoRelativePath);
  if (!fs.existsSync(sourceVideoAbs)) throw new FinalEditError('render_artifact_invalid', '渲染内部产物已丢失，请重新导出后再包装', 409);

  const project = loadProjectPackagingData(input.db, input.projectId);
  // 画面吸色：仅 overlay-poster 使用；失败返回空数组，模板回退默认配色
  const accents = templateName === 'overlay-poster'
    ? await extractAccentColors(sourceVideoAbs, (renderOutput.durationSec || 4) / 2, { jobId: input.jobId, projectId: input.projectId })
    : [];
  const vars = buildPackagingVars({ coverTitle: renderSnapshot.group.coverTitle ? { primary: renderSnapshot.group.coverTitle.primary.text, secondary: renderSnapshot.group.coverTitle.secondary.text } : undefined, subtitleCues: renderSnapshot.group.subtitleCues, exportIdentity: renderSnapshot.exportIdentity, project, accents, overrides: input.snapshot.varsOverrides });

  // v3 动态时序：totalSec=实际渲染时长；coverSec=封面静帧；pointCues 冻结优先，缺省按当前组数据幂等提取
  const coverSec = FINAL_EDIT_INTRO_DURATION_US / 1e6;
  const totalSec = renderOutput.durationSec && renderOutput.durationSec > 0
    ? renderOutput.durationSec
    : coverSec + renderSnapshot.group.narrationDurationUs / 1e6;
  let pointCues = input.snapshot.pointCues ?? [];
  let pointCuesMode: 'timed' | 'even' | 'none' = input.snapshot.pointCuesMode ?? 'none';
  if (input.snapshot.pointCues === undefined && groupId) {
    const ensured = await ensurePackagingPointCues(input.db, groupId);
    pointCues = ensured.pointCues;
    pointCuesMode = ensured.mode;
  }
  const stickerAssets = resolvePackagingStickerAssets({ packagingDir, template: templateName, stickers: input.snapshot.stickers });
  const timelineVars = buildTimelineVars({
    vars,
    totalSec,
    coverSec,
    pointCues,
    pointCuesMode,
    // §7：快照冻结的手动布局（模板端 applyLayouts 按 data-point-id 覆盖默认版式）
    layouts: input.snapshot.layouts,
    stickers: input.snapshot.stickers,
    stickerDefaults: input.snapshot.stickerDefaults,
    stickerAssets,
    template: input.snapshot.template,
    // §10 ②：快照冻结的三槽字体（非法/缺失文件名由 safeFontFilename 过滤，package-video 端二次校验存在性）
    fonts: {
      titleFile: safeFontFilename(input.snapshot.titleFont?.file) ?? undefined,
      subtitleFile: safeFontFilename(input.snapshot.subtitleFont?.file) ?? undefined,
      pointFile: safeFontFilename(input.snapshot.pointFont?.file) ?? undefined,
    },
  });

  const jobRelativeDir = path.join('final-edits', 'jobs', input.jobId);
  const jobDir = assertNoStorageSymlink(input.storageRoot, jobRelativeDir);
  fs.mkdirSync(jobDir, { recursive: true });
  const varsPath = path.join(jobDir, 'packaging-vars.json');
  fs.writeFileSync(varsPath, JSON.stringify(timelineVars, null, 2), 'utf-8');
  const temporaryOutput = path.join(jobDir, 'final-packaged.tmp.mp4');
  const finalOutput = path.join(jobDir, 'final-packaged.mp4');
  fs.rmSync(temporaryOutput, { force: true });

  writeLog({ jobId: input.jobId, projectId: input.projectId, level: 'info', message: `包装任务开始：渲染任务 ${input.snapshot.renderJobId}，模板 ${templateName}` });
  const startedAt = Date.now();
  await runPackagingPipeline({
    nodeExe: resolvePackagingNode(),
    packagingDir,
    args: [path.join(packagingDir, 'package-video.mjs'), sourceVideoAbs, varsPath, temporaryOutput, templateDir],
    signal: input.signal,
    onStage: (stage) => input.onProgress?.(stage),
  });
  if (input.signal?.aborted) throw makeAbortError();
  const stat = fs.statSync(temporaryOutput, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size <= 0) throw new FinalEditError('packaging_output_invalid', '包装管线未产出有效视频');
  if (renderOutput.durationSec) {
    const actualDuration = await probeDurationSec(temporaryOutput);
    if (Math.abs(actualDuration - renderOutput.durationSec) > 1) {
      fs.rmSync(temporaryOutput, { force: true });
      throw new FinalEditError('packaging_output_invalid', `包装产物时长异常：${actualDuration.toFixed(3)}s，预期 ${renderOutput.durationSec.toFixed(3)}s`);
    }
  }
  fs.renameSync(temporaryOutput, finalOutput);
  const renderSeconds = (Date.now() - startedAt) / 1000;
  input.onProgress?.(0.95);

  // §C 包装封面（仅联动模式）：发布前合成临时 JPG——失败=任务失败且预留完整（重试幂等），
  // 发布成功后原子覆盖渲染任务先发的素封面（artifact 路径不变，DB 零更新）
  const packagedCoverTmp = input.snapshot.exportTarget
    ? await composePackagedCoverTemp({ storageRoot: input.storageRoot, jobDir, renderSnapshot, coverSec, signal: input.signal })
    : null;

  const published = await publishPackagedResult({
    storageRoot: input.storageRoot,
    internalVideoRelativePath: path.join(jobRelativeDir, 'final-packaged.mp4'),
    exportTarget: input.snapshot.exportTarget,
    renderVideoRelativePath: renderOutput.publishedVideoRelativePath || renderOutput.videoRelativePath,
    displayDirectory: renderOutput.displayDirectory,
    exportIdentity: renderSnapshot.exportIdentity ? {
      ...renderSnapshot.exportIdentity,
      productionCodes: { ...renderSnapshot.exportIdentity.productionCodes, packagingCode: packagingCode({ enabled: true, template: templateName }) },
    } : undefined,
  });
  if (packagedCoverTmp && input.snapshot.exportTarget) {
    try {
      fs.renameSync(packagedCoverTmp, assertNoStorageSymlink(input.storageRoot, input.snapshot.exportTarget.coverRelativePath));
    } catch (error) {
      // rename 同卷原子操作几乎不可失败；兜底降级为素封面（修复前现状），不拖垮已发布的包装视频
      writeLog({ jobId: input.jobId, projectId: input.projectId, level: 'warn', message: `包装封面覆盖失败（视频已发布，封面保留无包装版）：${error instanceof Error ? error.message : String(error)}` });
    }
  }
  writeLog({ jobId: input.jobId, projectId: input.projectId, level: 'info', message: `包装任务完成：${published.videoFilename}（${renderSeconds.toFixed(1)}s）` });
  input.onProgress?.(1);
  return {
    internal: { videoRelativePath: path.join(jobRelativeDir, 'final-packaged.mp4'), vars, renderSeconds },
    published,
  };
}

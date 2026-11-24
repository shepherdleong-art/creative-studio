import { preparePackaging } from './packaging.ts';
import type Database from 'better-sqlite3';
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';
import { getDb } from '../db.ts';
import { countFilmFrames } from './frames.ts';
import { detectVideoScenes } from '../media-core/scene-detect.ts';
import { FINAL_EDIT_FPS } from '../media-core/render-contract.ts';
import { createVideoJobsForShot } from '../video-job-create.ts';
import { runVideoQueue, getVideoQueueStatus, DEFAULT_VIDEO_TIMEOUT_MS } from '../video-queue.ts';
import { requireAccessContext } from '../media-core/access-context.ts';
import { readRuntimeConfig } from '../team-service/config.ts';
import { productionParamsFor } from '../team-service/production-defaults.ts';
import { OneClickFilmError } from './errors.ts';
import { listEntries, type OneClickFilmEntry, type OneClickFilmRun } from './store.ts';
import { upsertReviewFromDetection } from './review.ts';
import { narrationGate, narrationSignature } from './tts.ts';
import { videoReferenceCapability } from '../video-reference-contract.ts';

/**
 * 确认稿直出原片（05）。
 *
 * 每条成片提交一个整片生成任务：供应商收到该条最后确认的全文、参考与参数。
 * 冻结脚本快照、模型、通道与账号身份；之后改稿仍可查到原任务的真实输入。
 * 正文从第 0 秒开始，封面、字幕、花字与 BGM 到包装阶段才加入。
 */

export interface OneClickFilmVideoJob {
  id: string;
  entryId: string;
  entryCode: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'needs_check' | 'canceled';
  videoJobId: string | null;
  errorMessage: string | null;
  model: string;
  providerId: string;
  aspectRatio: string;
  durationSec: number;
  localVideoPath: string | null;
  displayName: string | null;
  createdAt: string;
  cuts: { status: string; durationUs: number; fps: number; cuts: number[]; errorMessage: string | null } | null;
}

function videoPathOf(db: Database.Database, videoJobId: string | null): string | null {
  if (!videoJobId) return null;
  const row = db.prepare(`SELECT localVideoPath FROM video_jobs WHERE id = ?`)
    .get(videoJobId) as { localVideoPath: string | null } | undefined;
  return row?.localVideoPath ?? null;
}

export function listVideoJobs(db: Database.Database, run: OneClickFilmRun): OneClickFilmVideoJob[] {
  const rows = db.prepare(`
    SELECT v.*, vj.status AS queueStatus, vj.localVideoPath, vj.displayName
    FROM one_click_film_video_jobs v
    LEFT JOIN video_jobs vj ON vj.id = v.videoJobId
    WHERE v.runId = ?
    ORDER BY v.entryCode ASC, v.createdAt DESC
  `).all(run.id) as Array<Record<string, unknown> & {
    id: string; entryId: string; entryCode: string; status: OneClickFilmVideoJob['status'];
    videoJobId: string | null; errorMessage: string | null; model: string; providerId: string;
    aspectRatio: string; durationSec: number; localVideoPath: string | null;
    displayName: string | null; createdAt: string;
  }>;
  return rows.map((row) => {
    const cuts = db.prepare(`SELECT status, durationUs, fps, cutsJson, errorMessage FROM one_click_film_scene_cuts WHERE videoJobId = ?`)
      .get(row.id) as { status: string; durationUs: number; fps: number; cutsJson: string; errorMessage: string | null } | undefined;
    let cutsValue: number[] = [];
    try {
      const parsed: unknown = JSON.parse(cuts?.cutsJson ?? '[]');
      if (Array.isArray(parsed)) cutsValue = parsed.filter((value): value is number => typeof value === 'number');
    } catch { cutsValue = []; }
    return {
      id: row.id,
      entryId: row.entryId,
      entryCode: row.entryCode,
      status: row.queueStatus === 'needs_check' || row.queueStatus === 'canceled' ? row.queueStatus : row.status,
      videoJobId: row.videoJobId,
      errorMessage: row.errorMessage,
      model: row.model,
      providerId: row.providerId,
      aspectRatio: row.aspectRatio,
      durationSec: row.durationSec,
      localVideoPath: row.localVideoPath,
      displayName: row.displayName,
      createdAt: row.createdAt,
      cuts: cuts ? {
        status: cuts.status,
        durationUs: cuts.durationUs,
        fps: cuts.fps,
        cuts: cutsValue,
        errorMessage: cuts.errorMessage,
      } : null,
    };
  });
}

/** 每条成片的确认稿都必须与当前脚本一致，缺一条就拒绝整批提交并指出条目。 */
export function assertEntriesReadyForGeneration(entries: OneClickFilmEntry[]): void {
  if (entries.length === 0) throw new OneClickFilmError('invalid_input', '还没有可生成的成片条目');
  const pending = entries.filter((entry) => entry.status !== 'confirmed' || !entry.scriptConfirmedAt);
  if (pending.length > 0) {
    throw new OneClickFilmError(
      'invalid_input',
      `这些条目还没有确认稿：${pending.map((entry) => entry.code).join('、')}`,
    );
  }
}

/** 整批提交前的完整闸门：确认稿 + TTS 配音。 */
export function assertEntriesReadyWithNarration(
  db: Database.Database,
  entries: OneClickFilmEntry[],
  durationSec?: number,
): void {
  assertEntriesReadyForGeneration(entries);
  const problems = narrationGate(db, entries, durationSec);
  if (problems.length > 0) {
    throw new OneClickFilmError('invalid_input', problems.join('；'));
  }
}

function ensureShotContainer(db: Database.Database, input: {
  run: OneClickFilmRun;
  entry: OneClickFilmEntry;
  sourceImageId: string;
}): { shotSetId: string; shotId: string } {
  const scope = JSON.stringify([input.run.id, input.entry.id, input.sourceImageId]);
  const shotSetId = uuidv5('film/set/' + scope, uuidv5.URL);
  const shotId = uuidv5('film/shot/' + scope, uuidv5.URL);
  const access = requireAccessContext();
  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT s.shotSetId, s.id AS shotId FROM shots s JOIN shot_sets ss ON ss.id=s.shotSetId
      WHERE ss.projectId=? AND (s.id=? OR (s.sourceImageId=?
        AND s.id IN (SELECT shotId FROM one_click_film_video_jobs WHERE runId=? AND entryId=?)))
      LIMIT 1
    `).get(input.run.projectId, shotId, input.sourceImageId, input.run.id, input.entry.id) as
      { shotSetId: string; shotId: string } | undefined;
    if (existing) return existing;
    db.prepare(`INSERT INTO shot_sets (id, projectId, name, productCode, category, status) VALUES (?, ?, ?, ?, '', 'draft')`)
      .run(shotSetId, input.run.projectId, `一键成片 · ${input.entry.code}`, input.entry.productNameSnapshot);
    db.prepare(`INSERT INTO shots (id, shotSetId, indexNum, sourceImageId) VALUES (?, ?, 1, ?)`)
      .run(shotId, shotSetId, input.sourceImageId);
    access.registerInheritedScope({
      resourceType: 'shot_set', resourceId: shotSetId,
      parent: { resourceType: 'project', resourceId: input.run.projectId },
    });
    access.registerInheritedScope({
      resourceType: 'shot', resourceId: shotId,
      parent: { resourceType: 'shot_set', resourceId: shotSetId },
    });
    return { shotSetId, shotId };
  }).immediate();
}

export interface SubmitGenerationInput {
  run: OneClickFilmRun;
  providerId: string;
  durationSec: number;
  aspectRatio: string;
  resolution?: string;
  /** 样片生成只给支持样片的通道；其余通道只能直出。 */
  mode?: 'draft' | 'direct';
  codes?: string[];
  db?: Database.Database;
}

/**
 * 提交整批直出。requestKey 由「条目 + 确认稿哈希 + 参数」派生：
 * 双击或断线重发只会命中同一个任务，不会重复提交。
 */
export async function submitOneClickFilmGeneration(input: SubmitGenerationInput): Promise<{
  jobs: OneClickFilmVideoJob[];
  submitted: string[];
  reused: string[];
}> {
  const db = input.db ?? getDb();
  const allEntries = listEntries(db, input.run.id);
  const entries = input.codes?.length
    ? allEntries.filter((entry) => input.codes!.includes(entry.code))
    : allEntries;
  assertEntriesReadyWithNarration(db, entries, input.durationSec);
  const analysisId = db.prepare('SELECT currentAnalysisId FROM one_click_film_runs WHERE id=?').pluck().get(input.run.id);
  const requiresReview = entries.filter((entry) => entry.promptDurationSec !== input.durationSec || entry.promptAspectRatio !== input.aspectRatio
    || entry.analysisId !== analysisId);
  if (requiresReview.length) throw new OneClickFilmError('invalid_input',
    `这些条目的参数或素材分析已变更，请重新复核确认：${requiresReview.map((entry) => entry.code).join('、')}`);

  const provider = db.prepare(`SELECT id, name, type, enabled, defaultModel FROM video_providers WHERE id = ?`)
    .get(input.providerId) as { id: string; name: string; type: string; enabled: number; defaultModel: string } | undefined;
  if (!provider || !provider.enabled) {
    throw new OneClickFilmError('invalid_input', '视频供应商未找到或已禁用');
  }

  const submitted: string[] = [];
  const reused: string[] = [];
  const now = new Date().toISOString();

  for (const entry of entries) {
    const sourceImageId = db.prepare(`
      SELECT id FROM image_assets WHERE projectId = ? AND role = 'input'
      AND usage IN ('scene_seed', 'detail_page')
      AND id IN (SELECT value FROM json_each((SELECT sourceImageIdsJson FROM one_click_film_analyses WHERE id=?)))
      ORDER BY CASE WHEN usage = 'scene_seed' THEN 0 ELSE 1 END, createdAt ASC LIMIT 1
    `).get(input.run.projectId, entry.analysisId) as { id: string } | undefined;
    if (!sourceImageId) throw new OneClickFilmError('invalid_input', '项目还没有可用作首帧的素材图');

    const snapshot = {
      entryCode: entry.code,
      promptText: entry.promptText,
      narration: entry.narration,
      outline: entry.outline,
      soundMode: entry.soundMode,
      structure: entry.structure,
      productName: entry.productNameSnapshot,
      sellingPoints: entry.sellingPointsSnapshot,
      scriptRevision: entry.scriptRevision,
      confirmedAt: entry.scriptConfirmedAt,
      durationSec: input.durationSec,
      aspectRatio: input.aspectRatio,
      mode: input.mode ?? 'direct',
      analysisId: entry.analysisId,
      sourceImageId: sourceImageId.id,
      narrationPath: entry.soundMode === 'tts' ? db.prepare(`
        SELECT relativePath FROM one_click_film_narrations WHERE entryId=? AND signature=? AND confirmedAt IS NOT NULL
      `).pluck().get(entry.id, narrationSignature({
        text: entry.narration, providerId: entry.ttsProviderId, voice: entry.ttsVoice, speed: entry.ttsSpeed,
      })) as string | undefined : undefined,
    };
    const requestKey = JSON.stringify([entry.id, entry.scriptConfirmedAt, entry.scriptRevision, input.providerId,
      provider.defaultModel, input.durationSec, input.aspectRatio, input.mode ?? 'direct', input.resolution ?? '', sourceImageId.id]);
    const findExisting = () => db.prepare('SELECT videoJobId FROM one_click_film_video_jobs WHERE runId=? AND requestKey=?')
      .pluck().get(input.run.id, requestKey) as string | undefined;
    if (findExisting()) {
      reused.push(entry.code);
      continue;
    }

    const container = ensureShotContainer(db, { run: input.run, entry, sourceImageId: sourceImageId.id });
    const reference = videoReferenceCapability(provider.type, provider.defaultModel);
    const generationMode = reference.supported && provider.type !== 'jimeng' ? 'reference-to-video' : 'image-to-video';
    let wasCreated = false;
    const created = await createVideoJobsForShot({
      shotSetId: container.shotSetId,
      shotId: container.shotId,
      frozenSourceImageId: sourceImageId.id,
      db,
      replayJobIds() {
        const id = findExisting();
        return id ? [id] : undefined;
      },
      onJobsCreated([videoJobId]) {
        db.prepare(`
          INSERT INTO one_click_film_video_jobs
            (id, runId, projectId, entryId, entryCode, requestKey, shotSetId, shotId, videoJobId, status,
             scriptSnapshotJson, model, providerId, providerType, generationMode, aspectRatio, durationSec,
             resolution, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          uuidv4(), input.run.id, input.run.projectId, entry.id, entry.code, requestKey,
          container.shotSetId, container.shotId, videoJobId,
          JSON.stringify(snapshot), provider.defaultModel, provider.id, provider.type,
          input.mode === 'draft' ? 'draft' : generationMode,
          input.aspectRatio, input.durationSec, input.mode === 'draft' ? '480p' : input.resolution ?? '', now, now,
        );
        wasCreated = true;
      },
      items: [{
        prompt: entry.promptText,
        templateId: null,
        providerId: input.providerId,
        durationSec: input.durationSec,
        tailImageId: null,
        multiShot: null,
        generationMode,
        filmGenerationStage: input.mode ?? 'direct',
        referenceAssetIds: [],
        aspectRatio: input.aspectRatio,
        resolution: input.resolution ?? null,
      }],
    });
    if (!created.ok) throw new OneClickFilmError('invalid_input', `${entry.code}：${created.error}`);
    (wasCreated ? submitted : reused).push(entry.code);
  }

  startOneClickFilmVideoQueue(db, input.run.projectId);
  return { jobs: listVideoJobs(db, input.run), submitted, reused };
}

export function startOneClickFilmVideoQueue(db: Database.Database, projectId: string): void {
  if (getVideoQueueStatus(projectId) === 'idle') {
    const projectRow = db.prepare(`SELECT videoConcurrency FROM projects WHERE id = ?`)
      .get(projectId) as { videoConcurrency?: number } | undefined;
    const concurrency = productionParamsFor(readRuntimeConfig(), {
      videoConcurrency: projectRow?.videoConcurrency,
    }).videoConcurrency;
    runVideoQueue({
      projectId,
      concurrency,
      timeoutMs: DEFAULT_VIDEO_TIMEOUT_MS,
    }).catch((error) => {
      console.error('[OneClickFilm] video queue failed:', error);
    });
  }

}

/** 把队列里的视频任务状态同步到一键成片侧，并对成功媒体做实际切点识别。 */
export async function syncGenerationStatus(db: Database.Database, run: OneClickFilmRun): Promise<void> {
  const rows = db.prepare(`
    SELECT v.id, v.videoJobId, v.entryId, vj.status, vj.localVideoPath, vj.errorMessage
    FROM one_click_film_video_jobs v
    LEFT JOIN video_jobs vj ON vj.id = v.videoJobId
    WHERE v.runId = ?
  `).all(run.id) as Array<{
    id: string; videoJobId: string | null; entryId: string; status: string | null;
    localVideoPath: string | null; errorMessage: string | null;
  }>;

  for (const row of rows) {
    const status = row.status === 'succeeded' ? 'succeeded'
      : row.status === 'failed' ? 'failed'
        : row.status === 'running' ? 'running' : 'queued';
    db.prepare(`UPDATE one_click_film_video_jobs SET status = ?, errorMessage = ?, updatedAt = ? WHERE id = ?`)
      .run(status, row.errorMessage, new Date().toISOString(), row.id);

    if (status !== 'succeeded' || !row.localVideoPath) continue;
    const existing = db.prepare(`SELECT status FROM one_click_film_scene_cuts WHERE videoJobId = ?`)
      .get(row.id) as { status: string } | undefined;
    if (existing?.status === 'succeeded' || existing?.status === 'failed') continue;

    db.prepare(`
      INSERT INTO one_click_film_scene_cuts (id, videoJobId, entryId, status, createdAt, updatedAt)
      VALUES (?, ?, ?, 'running', ?, ?)
      ON CONFLICT(videoJobId) DO UPDATE SET status = 'running', updatedAt = excluded.updatedAt
    `).run(uuidv4(), row.id, row.entryId, new Date().toISOString(), new Date().toISOString());

    try {
      const frames = await countFilmFrames(row.localVideoPath);
      if (!frames) throw new Error('无法读取原片视频帧');
      const durationUs = Math.round(frames * 1e6 / FINAL_EDIT_FPS);
      db.prepare('UPDATE one_click_film_scene_cuts SET durationUs=? WHERE videoJobId=?').run(durationUs, row.id);
      const ranges = await detectVideoScenes({ filePath: row.localVideoPath, durationUs });
      const cuts = ranges.slice(1).map((range) => range.startUs);
      db.prepare(`
        UPDATE one_click_film_scene_cuts
        SET status = 'succeeded', durationUs = ?, fps = ?, cutsJson = ?, errorMessage = NULL, updatedAt = ?
        WHERE videoJobId = ?
      `).run(
        durationUs,
        FINAL_EDIT_FPS,
        JSON.stringify(cuts),
        new Date().toISOString(),
        row.id,
      );
      // 切点直接生成 A 布局审片记录：一镜到底保留一个完整区间。
      upsertReviewFromDetection(db, {
        run,
        jobId: row.id,
        entryId: row.entryId,
        entryCode: db.prepare(`SELECT entryCode FROM one_click_film_video_jobs WHERE id = ?`)
          .pluck().get(row.id) as string,
        durationUs,
        fps: FINAL_EDIT_FPS,
        cutsUs: cuts,
        detection: cuts.length > 0 ? 'cuts' : 'single',
      });
    } catch (error) {
      // 识别失败仍保留可播的整条原片，由剪辑师手动加切点。
      db.prepare(`
        UPDATE one_click_film_scene_cuts
        SET status = 'failed', errorMessage = ?, updatedAt = ?
        WHERE videoJobId = ?
      `).run(
        (error instanceof Error ? error.message : String(error)).slice(0, 500),
        new Date().toISOString(),
        row.id,
      );
        const failedJob = db.prepare(`SELECT v.entryId, v.entryCode, COALESCE(NULLIF(c.durationUs, 0), v.durationSec * 1000000) as durationUs FROM one_click_film_scene_cuts c
        JOIN one_click_film_video_jobs v ON v.id = c.videoJobId WHERE c.videoJobId = ?`)
        .get(row.id) as { entryId: string; entryCode: string; durationUs: number } | undefined;
      if (failedJob) {
        // 识别失败：仍保留可播的整条原片，允许手动加切点。
        upsertReviewFromDetection(db, {
          run,
          jobId: row.id,
          entryId: failedJob.entryId,
          entryCode: failedJob.entryCode,
          durationUs: failedJob.durationUs,
          fps: FINAL_EDIT_FPS,
          cutsUs: [],
          detection: 'failed',
          detectionError: (error instanceof Error ? error.message : String(error)).slice(0, 300),
        });
      }
    }
    // 原片就绪即准备包装。轮询和重试保留已有草稿。
    const entryCode = db.prepare('SELECT entryCode FROM one_click_film_video_jobs WHERE id=?').pluck().get(row.id) as string;
    if (!db.prepare('SELECT 1 FROM one_click_film_packaging WHERE runId=? AND entryCode=?').get(run.id, entryCode)) {
      preparePackaging(db, { run, codes: [entryCode], options: {}, allowPreview: true });
    }
  }
}

export function videoJobFileUrl(localVideoPath: string | null): string | null {
  if (!localVideoPath) return null;
  const normalized = localVideoPath.replace(/\\/g, '/');
  const marker = '/storage/';
  const index = normalized.lastIndexOf(marker);
  const relative = index >= 0 ? normalized.slice(index + marker.length) : normalized;
  const query = relative.startsWith('videos/') ? '?preview=1' : '';
  return `/api/videos/${relative.split('/').map(encodeURIComponent).join('/')}${query}`;
}

export { videoPathOf };

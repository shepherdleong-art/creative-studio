import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { probeVideoMedia } from '../ffmpeg.ts';
import { detectVideoScenes } from '../media-core/scene-detect.ts';
import { requireAccessContext } from '../media-core/access-context.ts';
import { videoDurationOptions } from '../video-duration.ts';
import { createVideoJobsForShot } from '../video-job-create.ts';
import { readVideoSourceReference } from '../video-source-reference.ts';
import { OneClickFilmError } from './errors.ts';
import { REWORK_VIDEO_PROMPT_LIMIT } from './contract.ts';
import { startOneClickFilmVideoQueue } from './generation.ts';
import {
  createCandidate, listCandidates, REWORK_PURPOSE_LABELS, setCandidateResult, type ReworkReference,
} from './rework.ts';
import { listReviews, shotsAtCuts } from './review.ts';
import type { OneClickFilmRun } from './store.ts';
import { estimateFrozenVideoCost } from './video-models.ts';

function boundReworkSource(db: Database.Database, run: OneClickFilmRun, reviewJobId: string) {
  return db.prepare(`
    SELECT v.*, j.model AS boundModel, j.filmGenerationStage, j.generationMode AS providerMode,
      j.usageSnapshotJson, p.name AS providerName, p.type, p.defaultModel FROM one_click_film_video_jobs v
    JOIN video_jobs j ON j.id=v.videoJobId JOIN video_providers p ON p.id=v.providerId
    WHERE v.id=? AND v.runId=? AND p.enabled=1
  `).get(reviewJobId, run.id) as {
    entryId: string; entryCode: string; providerId: string; providerName: string; type: string; boundModel: string; defaultModel: string;
    shotSetId: string; shotId: string; providerMode: 'image-to-video' | 'reference-to-video';
    filmGenerationStage: 'draft' | 'direct' | null; aspectRatio: string; resolution: string;
    scriptSnapshotJson: string; usageSnapshotJson: string | null;
  } | undefined;
}

export function getRedrawQuote(db: Database.Database, run: OneClickFilmRun, reviewJobId: string) {
  const review = listReviews(db, run).find((item) => item.jobId === reviewJobId);
  const source = review && boundReworkSource(db, run, reviewJobId);
  if (!review || !source || source.boundModel !== source.defaultModel) return null;
  const duration = review.durationUs / 1e6;
  const generatedDuration = videoDurationOptions(source.type, source.boundModel).find((value) => value >= Math.ceil(duration - 0.001));
  if (!generatedDuration) return null;
  const script = JSON.parse(source.scriptSnapshotJson) as { soundMode?: string; promptText?: string };
  return {
    model: source.boundModel, provider: source.providerName, account: source.providerId,
    duration, generatedDuration, costMicros: estimateFrozenVideoCost(source.usageSnapshotJson, generatedDuration),
    promptText: script.promptText ?? '',
    sound: script.soundMode === 'tts' ? '保留已确认的 TTS 旁白，使用重抽的现场声'
      : script.soundMode === 'none' ? '使用重抽成片的现场声' : '使用重抽成片的原生画外音和现场声',
  };
}

async function freezeReference(db: Database.Database, run: OneClickFilmRun, reference: ReworkReference): Promise<string> {
  const access = requireAccessContext();
  const asset = db.prepare('SELECT kind FROM video_reference_assets WHERE id=? AND projectId=?')
    .get(reference.id, run.projectId) as { kind: string } | undefined;
  if (asset?.kind === reference.kind) {
    access.assertAccess('video_reference_asset', reference.id, 'read');
    return reference.id;
  }
  if (reference.kind !== 'image') throw new OneClickFilmError('invalid_input', '参考素材不存在或不属于当前项目');
  access.assertAccess('image', reference.id, 'read');
  const image = await readVideoSourceReference(db, reference.id, run.projectId).catch((error: Error) => {
    throw new OneClickFilmError('invalid_input', error.message);
  });
  const filename = db.prepare('SELECT filename FROM image_assets WHERE id=?').pluck().get(image.id) as string;
  const id = `ocf-${createHash('sha256').update(reference.id).digest('hex')}`;
  db.transaction(() => {
    db.prepare(`
      INSERT INTO video_reference_assets (id,projectId,kind,filename,path,mimeType,byteSize,createdAt)
      VALUES (?,?,'image',?,?,?,?,datetime('now'))
      ON CONFLICT(id) DO UPDATE SET mimeType=excluded.mimeType
      WHERE video_reference_assets.mimeType<>excluded.mimeType
    `).run(id, run.projectId, filename, image.path, image.mimeType, image.byteSize);
    access.registerInheritedScope({
      resourceType: 'video_reference_asset', resourceId: id,
      parent: { resourceType: 'project', resourceId: run.projectId },
    });
  }).immediate();
  return id;
}

export async function submitRework(db: Database.Database, input: {
  run: OneClickFilmRun; reviewJobId: string; shotId: string; prompt: string;
  references: ReworkReference[]; requestKey?: string; redrawPrompt?: string;
}) {
  const review = listReviews(db, input.run).find((item) => item.jobId === input.reviewJobId);
  if (!review) throw new OneClickFilmError('not_found', '审片记录不存在', 404);
  const whole = input.shotId === 'whole';
  const redrawPrompt = input.redrawPrompt?.trim();
  if (redrawPrompt !== undefined && (!whole || !redrawPrompt)) {
    throw new OneClickFilmError('invalid_input', '整条重抽的提示词不能为空');
  }
  const target = whole ? { startUs: 0, endUs: review.durationUs } : review.shots.find((shot) => shot.id === input.shotId);
  if (!target || (!whole && !input.prompt.trim())) throw new OneClickFilmError('invalid_input', '请选择镜头并填写返工要求');
  if (input.references.length > 10 || input.references.some((ref) =>
    !ref || !['image', 'video'].includes(ref.kind) || !Object.hasOwn(REWORK_PURPOSE_LABELS, ref.purpose) || typeof ref.id !== 'string')) {
    throw new OneClickFilmError('invalid_input', '返工参考素材或用途无效');
  }
  const source = boundReworkSource(db, input.run, review.jobId);
  if (!source || source.boundModel !== source.defaultModel) throw new OneClickFilmError('invalid_input', '原片绑定的模型或通道已变更');
  const duration = (target.endUs - target.startUs) / 1e6;
  const generationDuration = videoDurationOptions(source.type, source.boundModel).find((value) => value >= Math.ceil(duration - 0.001));
  if (!generationDuration) throw new OneClickFilmError('invalid_input', '通道无法生成覆盖选区长度的候选');
  const script = JSON.parse(source.scriptSnapshotJson) as { promptText?: string };
  const videoPrompt = [
    redrawPrompt ?? script.promptText,
    whole ? '整条重抽' : `重新生成正文第 ${target.startUs / 1e6}–${target.endUs / 1e6} 秒的镜头，只生成可独立剪入的画面。`,
    redrawPrompt === undefined ? input.prompt : '',
    ...input.references.map((reference, index) => `参考 ${index + 1}：${REWORK_PURPOSE_LABELS[reference.purpose]}`),
  ].filter(Boolean).join('\n');
  if (redrawPrompt !== undefined && videoPrompt.length > REWORK_VIDEO_PROMPT_LIMIT) {
    throw new OneClickFilmError('invalid_input', `整条重抽的提示词和参考说明合计最多 ${REWORK_VIDEO_PROMPT_LIMIT} 字符，请缩短后重试`);
  }
  const referenceAssetIds = await Promise.all(input.references.map((reference) => freezeReference(db, input.run, reference)));
  const requestIdentity = [review.jobId, review.reviewSourceId, input.shotId, target, input.prompt, input.references, input.requestKey || ''];
  if (redrawPrompt !== undefined) requestIdentity.push(redrawPrompt);
  const requestKey = createHash('sha256').update(JSON.stringify(requestIdentity)).digest('hex');
  const existing = db.prepare('SELECT id FROM one_click_film_candidates WHERE runId=? AND requestKey=?')
    .pluck().get(input.run.id, requestKey);
  if (existing) return listCandidates(db, input.run).find((candidate) => candidate.id === existing)!;
  const candidate = createCandidate(db, {
    run: input.run, entryId: source.entryId, entryCode: source.entryCode, reviewJobId: review.jobId,
    reviewSourceId: whole ? null : review.reviewSourceId,
    shotId: input.shotId, replaceStartUs: target.startUs, replaceEndUs: target.endUs,
    minimumGenerationUs: generationDuration * 1e6, prompt: redrawPrompt ?? input.prompt, references: input.references,
    providerId: source.providerId, model: source.boundModel, requestKey,
  });
  try {
    const result = await createVideoJobsForShot({
      db, shotId: source.shotId, shotSetId: source.shotSetId,
      items: [{
        providerId: source.providerId,
        prompt: videoPrompt.slice(0, REWORK_VIDEO_PROMPT_LIMIT),
        durationSec: generationDuration, aspectRatio: source.aspectRatio, resolution: source.resolution || null,
        templateId: null, tailImageId: null, multiShot: null, referenceAssetIds,
        generationMode: referenceAssetIds.length ? 'reference-to-video' : source.providerMode,
        filmGenerationStage: source.filmGenerationStage === 'draft' ? 'draft' : 'direct',
      }],
    });
    if (!result.ok) throw new OneClickFilmError('invalid_input', result.error);
    db.prepare('UPDATE one_click_film_candidates SET videoJobId=? WHERE id=?').run(result.videoJobIds[0], candidate.id);
    startOneClickFilmVideoQueue(db, input.run.projectId);
    return candidate;
  } catch (error) {
    setCandidateResult(db, {
      run: input.run, candidateId: candidate.id, status: 'failed',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function syncRework(db: Database.Database, run: OneClickFilmRun): Promise<void> {
  const jobs = db.prepare(`
    SELECT c.id,c.shotId,c.replaceEndUs,j.status,j.localVideoPath,j.errorMessage FROM one_click_film_candidates c
    JOIN video_jobs j ON j.id=c.videoJobId WHERE c.runId=? AND c.status IN ('queued','running')
  `).all(run.id) as Array<{ id: string; shotId: string; replaceEndUs: number; status: string; localVideoPath: string | null; errorMessage: string | null }>;
  for (const job of jobs) {
    if (job.status === 'succeeded' && job.localVideoPath) {
      const probe = await probeVideoMedia(job.localVideoPath);
      if (job.shotId === 'whole' && probe.durationUs > 0) {
        let detection = 'single';
        let detectionError: string | null = null;
        let cuts: number[] = [];
        try {
          const ranges = await detectVideoScenes({ filePath: job.localVideoPath, durationUs: probe.durationUs });
          cuts = ranges.slice(1).map((range) => range.startUs).filter((cut) => cut < job.replaceEndUs);
          if (cuts.length) detection = 'cuts';
        } catch {
          detection = 'failed';
          detectionError = '重抽成片切点识别失败，可手动加切点。';
        }
        db.prepare('UPDATE one_click_film_candidates SET sceneJson=? WHERE id=? AND sceneJson IS NULL')
          .run(JSON.stringify({ detection, detectionError, shots: shotsAtCuts(cuts, job.replaceEndUs) }), job.id);
      }
      setCandidateResult(db, {
        run, candidateId: job.id, status: probe.durationUs > 0 ? 'ready' : 'failed',
        localVideoPath: job.localVideoPath, durationUs: probe.durationUs, errorMessage: probe.errorMessage ?? undefined,
      });
    } else if (job.status === 'failed' || job.status === 'canceled') {
      setCandidateResult(db, { run, candidateId: job.id, status: 'failed', errorMessage: job.errorMessage || '候选生成失败' });
    } else if (job.status === 'running') setCandidateResult(db, { run, candidateId: job.id, status: 'running' });
  }
}

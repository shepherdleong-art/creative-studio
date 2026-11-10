import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { FinalEditError } from '../errors.ts';
import { filmBinding } from './store.ts';
import type { FilmBinding, FilmImportManifest, RegisteredCandidate } from './types.ts';
import { resolveImageJobProvider } from '../../image-provider-selection.ts';
import { getVideoProviderConfigState } from '../../video-auth.ts';
import { videoDurationError, parseVideoDuration } from '../../video-duration.ts';
import { normalizeVideoMultiShotForStorage } from '../../video-multi-shot.ts';
import { sha256 } from '../../film-render/files.ts';
import { probeMedia } from '../../film-render/media.ts';
import { toStorageImageUrl } from '../../storage-url.ts';
import { projectFilmTimeline } from './timeline.ts';
import type { VideoTimeline } from '../types.ts';
import { resolveImportedExternalAssetVideoPath } from '../material-import.ts';
import { requireAccessContext } from '../../media-core/access-context.ts';
import {
  UNIFIED_IMAGE_MODEL_KEY,
  UNIFIED_KLING3_MODEL_KEY,
  UNIFIED_MEDIA_RULE_VERSION,
  isUnifiedImageAnchorProvider,
  isUnifiedKlingAnchorProvider,
} from '../../media-core/unified-media/catalog.ts';
import {
  UnifiedImageRequestError,
  freezeUnifiedImageRequest,
  inferUnifiedImageOutputFromPreset,
} from '../../media-core/unified-media/requests.ts';
import {
  UnifiedKlingRequestError,
  freezeUnifiedKlingVideoRequest,
  unifiedKlingCompatibleChannels,
} from '../../media-core/unified-media/video-requests.ts';
import {
  unifiedImageProviderAvailability,
} from '../../media-core/unified-media/execution.ts';
import {
  unifiedKlingProviderAvailability,
} from '../../media-core/unified-media/video-execution.ts';

type Db = Database.Database;
export type ReworkActor = 'human' | 'agent';
export interface FilmReworkRuntime {
  /** Team mode uses the authenticated server access context; local keeps the desktop gate/old rules. */
  mode: 'local' | 'server';
}
export interface ReworkCommand {
  requestId: string; expectedRevision: number;
  type: 'generate_image' | 'select_image' | 'generate_video' | 'register_video' | 'register_external';
  providerId?: string; model?: string; prompt?: string; inputImageId?: string;
  referenceImageIds?: string[]; size?: string; quality?: string;
  imageId?: string; durationSec?: number; videoJobId?: string; approvedRangeSec?: [number, number];
  externalAssetId?: string;
}
type Shot = { id: string; sourceImageId: string; latestGeneratedImageId: string | null };
function fail(message: string, code = 'film_rework_invalid', status = 400): never { throw new FinalEditError(code, message, status); }
function requestHash(command: ReworkCommand): string {
  return createHash('sha256').update(JSON.stringify(command)).digest('hex');
}
function registerNewTask(
  access: ReturnType<typeof requireAccessContext>,
  module: 'image' | 'video',
  taskId: string,
  projectId: string,
  creationSnapshot: unknown,
): void {
  access.registerInheritedScope({
    resourceType: module === 'image' ? 'job' : 'video_job',
    resourceId: taskId,
    parent: { resourceType: 'project', resourceId: projectId },
  });
  access.registerTaskPrincipal({
    module,
    taskId,
    scope: { resourceType: 'project', resourceId: projectId },
    creationSnapshot,
  });
}
function context(db: Db, groupId: string, clipId: string) {
  const binding = filmBinding(db, groupId);
  if (!binding) return fail('实拍成片不存在', 'film_not_found', 404);
  const candidates = JSON.parse(binding.candidatesJson) as RegisteredCandidate[];
  const candidate = candidates.find(c => c.clipId === clipId);
  if (!candidate) return fail('镜头不属于该成片', 'film_shot_not_found', 404);
  const shot = db.prepare('SELECT id,sourceImageId,latestGeneratedImageId FROM shots WHERE id=? AND shotSetId=?').get(candidate.shotId, binding.shotSetId) as Shot | undefined;
  if (!shot) return fail('原分镜已失效', 'film_shot_not_found', 404);
  const state = db.prepare('SELECT revision FROM final_edit_film_shots WHERE bindingId=? AND clipId=?').get(binding.id, clipId) as { revision: number } | undefined;
  return { binding, candidates, shot, revision: state?.revision ?? 0 };
}
function expected(actual: number, value: unknown) {
  if (!Number.isSafeInteger(value) || value !== actual) fail('镜头已变化，请刷新并核对当前选择后重试；输入内容已保留。', 'revision_conflict', 409);
}
function image(db: Db, binding: FilmBinding, id: unknown) {
  if (typeof id !== 'string' || !db.prepare('SELECT 1 FROM image_assets WHERE id=? AND projectId=?').get(id, binding.projectId)) fail('图片不存在或不属于当前项目');
  return id as string;
}
function text(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 20000) return fail(`${name}不能为空或过长`);
  return value.trim();
}
function previous(db: Db, bindingId: string, clipId: string, command: ReworkCommand, actor: ReworkActor) {
  const row = db.prepare('SELECT * FROM final_edit_film_reworks WHERE id=?').get(command.requestId) as { bindingId: string; clipId: string; actor: string; requestJson: string; resultJson: string } | undefined;
  if (!row) return;
  if (row.bindingId !== bindingId || row.clipId !== clipId || row.actor !== actor || row.requestJson !== JSON.stringify(command)) fail('请求标识已用于不同操作', 'request_conflict', 409);
  return JSON.parse(row.resultJson) as { revision: number; jobId?: string };
}
function record(db: Db, binding: FilmBinding, clipId: string, shotId: string, revision: number, command: ReworkCommand, actor: ReworkActor, jobId?: string) {
  const result = { revision: revision + 1, ...(jobId ? { jobId } : {}) };
  db.prepare(`INSERT INTO final_edit_film_shots(bindingId,clipId,shotId,revision) VALUES (?,?,?,?)
    ON CONFLICT(bindingId,clipId) DO UPDATE SET revision=excluded.revision`).run(binding.id, clipId, shotId, result.revision);
  db.prepare(`INSERT INTO final_edit_film_reworks(id,bindingId,clipId,baseRevision,actor,kind,jobId,requestJson,resultJson,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(command.requestId, binding.id, clipId, revision, actor, command.type, jobId || null, JSON.stringify(command), JSON.stringify(result), new Date().toISOString());
  return result;
}

export function readFilmRework(db: Db, groupId: string, clipId: string) {
  const { binding, shot, revision, candidates } = context(db, groupId, clipId);
  const manifest = JSON.parse(binding.manifestJson) as FilmImportManifest;
  const original = manifest.shots.find(s => s.id === clipId)!;
  const source = original.candidates.find(c => c.id === original.selectedCandidateId)!;
  const originalVideo = candidates.find(c => c.clipId === clipId && c.file === source.file);
  const originalImage = originalVideo && db.prepare('SELECT sourceImageId FROM video_jobs WHERE id=?').get(originalVideo.videoJobId) as { sourceImageId: string } | undefined;
  const imageRows = db.prepare('SELECT id,filename,path FROM image_assets WHERE projectId=?').all(binding.projectId) as Array<{ id: string; filename: string; path: string }>;
  const history = db.prepare(`SELECT id,actor,kind,jobId,baseRevision,requestJson,createdAt FROM final_edit_film_reworks WHERE bindingId=? AND clipId=? ORDER BY rowid`).all(binding.id, clipId) as Array<{ id: string; actor: string; kind: string; jobId: string | null; baseRevision: number; requestJson: string; createdAt: string }>;
    const imageJobs = db.prepare(`SELECT j.id,j.status,j.providerStatus,j.outputImageId,j.errorMessage,j.prompt,j.providerId,j.model,
      j.inputImageId,j.referenceImageIds,j.unifiedModel,j.unifiedRuleVersion,j.cancelRequestedAt
    FROM jobs j JOIN final_edit_film_reworks r ON r.jobId=j.id
    WHERE r.bindingId=? AND r.clipId=? AND r.kind='generate_image'
    ORDER BY r.rowid DESC`).all(binding.id, clipId) as Array<{
      id: string; status: string; providerStatus: string | null; outputImageId: string | null; errorMessage: string | null;
      prompt: string; providerId: string; model: string; inputImageId: string;
      referenceImageIds: string; unifiedModel: string | null; unifiedRuleVersion: string | null;
      cancelRequestedAt: string | null;
    }>;
    const videoJobs = (db.prepare(`SELECT id,status,providerStatus,sourceImageId,prompt,providerId,model,durationSec,
      errorMessage,localVideoPath,unifiedModel,unifiedRuleVersion,cancelRequestedAt
    FROM video_jobs WHERE projectId=? AND shotSetId=? AND shotId=?
    ORDER BY createdAt DESC,rowid DESC`).all(binding.projectId, binding.shotSetId, shot.id) as Array<{
      id: string; status: string; providerStatus: string | null; sourceImageId: string; prompt: string; providerId: string;
      model: string; durationSec: number; errorMessage: string | null; localVideoPath: string | null;
      unifiedModel: string | null; unifiedRuleVersion: string | null; cancelRequestedAt: string | null;
    }>).map(({ localVideoPath, ...job }) => ({ ...job, previewUrl: localVideoPath ? toStorageImageUrl(localVideoPath)?.replace('/api/images/', '/api/videos/') + '?preview=1' : null }));
  return { groupId, projectId: binding.projectId, shotSetId: binding.shotSetId, clipId, shotId: shot.id, revision,
    sourceImageId: shot.sourceImageId, importedImageId: originalImage?.sourceImageId || shot.sourceImageId, currentImageId: shot.latestGeneratedImageId || shot.sourceImageId,
    provenance: source, images: imageRows.map(row => ({ id: row.id, name: row.filename, url: toStorageImageUrl(row.path) })),
    imageJobs, videoJobs, history: history.map(row => ({ ...row, request: JSON.parse(row.requestJson), requestJson: undefined })),
    registeredVideoIds: candidates.filter(c => c.clipId === clipId).map(c => c.videoJobId) };
}

export async function applyFilmRework(
  db: Db,
  storageRoot: string,
  groupId: string,
  clipId: string,
  command: ReworkCommand,
  actor: ReworkActor,
  runtime: FilmReworkRuntime = { mode: 'local' },
) {
  if (!command || typeof command.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(command.requestId)) fail('缺少有效请求标识');
  if (!['generate_image', 'select_image', 'generate_video', 'register_video', 'register_external'].includes(command.type)) fail('未知返工操作');
  if (actor === 'agent' && command.type === 'select_image') fail('Agent 续跑只能增加候选，请在工作台明确采用图片', 'film_manual_selection_required', 409);
  const initial = context(db, groupId, clipId);
  const access = requireAccessContext();
  if (runtime.mode === 'server' && access.kind !== 'team') {
    fail('团队返工缺少已验证的成员身份', 'film_actor_required', 403);
  }
  const replay = previous(db, initial.binding.id, clipId, command, actor);
  if (replay) return replay;
  expected(initial.revision, command.expectedRevision);

  // Media inspection is deliberately outside the DB write transaction. CAS is repeated after await.
  let prepared: RegisteredCandidate | undefined;
  let preparedPath: string | undefined;
  type ExternalSource = { id: string; relativePath: string; fileFingerprint: string; durationUs: number };
  const externalSource = () => db.prepare(`SELECT id,relativePath,fileFingerprint,durationUs FROM final_edit_external_assets WHERE id=? AND projectId=? AND shotSetId=? AND status='ready'`).get(command.externalAssetId || '', initial.binding.projectId, initial.binding.shotSetId) as ExternalSource | undefined;
  let external: ExternalSource | undefined;
  if (command.type === 'register_video' || command.type === 'register_external') {
    let job: { id: string; localVideoPath: string; sourceImageId?: string } | undefined;
    if (command.type === 'register_external') {
      if (typeof command.externalAssetId !== 'string') fail('缺少外部素材标识');
      external = externalSource();
      if (!external) fail('外部素材不存在、未就绪或不属于当前分镜组');
      job = { id: `external-asset-${external.id}`, localVideoPath: resolveImportedExternalAssetVideoPath(storageRoot, initial.binding, external.relativePath) };
    } else {
      job = db.prepare(`SELECT * FROM video_jobs WHERE id=? AND projectId=? AND shotSetId=? AND shotId=?
        AND (status='succeeded' OR (status='canceled' AND providerStatus='succeeded'))`)
        .get(command.videoJobId || '', initial.binding.projectId, initial.binding.shotSetId, initial.shot.id) as
        { id: string; localVideoPath: string; sourceImageId: string } | undefined;
    }
    if (!job?.localVideoPath) fail('只能登记该镜头已成功的视频任务');
    if (!external) image(db, initial.binding, job.sourceImageId);
    const range = command.approvedRangeSec;
    if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || range[0] < 0 || range[1] <= range[0]) fail('请填写有效的已审核区间');
    if (initial.candidates.some(c => c.videoJobId === job.id)) fail('视频已登记，请直接在第五步选择', 'film_candidate_exists', 409);
    const managed = path.resolve(storageRoot, initial.binding.managedRootRelative);
    const relative = path.relative(fs.realpathSync(storageRoot), fs.realpathSync(managed));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fs.realpathSync(managed) !== managed) fail('托管工程路径无效');
    const dir = path.join(managed, 'rework', randomUUID());
    fs.mkdirSync(dir, { recursive: true });
    preparedPath = path.join(dir, 'candidate.mp4');
    try {
      const hash = sha256(job.localVideoPath);
      if (external && hash !== external.fileFingerprint) fail('外部素材文件已变化，请重新上传');
      fs.copyFileSync(job.localVideoPath, preparedPath, fs.constants.COPYFILE_EXCL);
      if (sha256(preparedPath) !== hash) fail('复制期间视频发生变化');
      const media = await probeMedia(preparedPath, dir);
      const durationSec = Number(media.format.duration);
      if (!media.streams.some(s => s.codec_type === 'video') || !Number.isFinite(durationSec) || durationSec < range[1]) fail('审核区间超出实际视频时长');
      const spec = JSON.parse(initial.binding.specJson);
      prepared = { videoJobId: job.id, ...(external ? { externalAssetId: external.id } : {}), shotId: initial.shot.id, clipId, file: path.relative(managed, preparedPath).split(path.sep).join('/'), fingerprint: hash, durationSec, approvedRangeSec: range };
      const timeline = JSON.parse((db.prepare('SELECT timelineJson FROM final_edit_variants WHERE id=?').get(initial.binding.variantId) as { timelineJson: string }).timelineJson) as VideoTimeline;
      const clip = timeline.clips.find(c => c.id === clipId)!;
      const span = clip.sourceOutFrame - clip.sourceInFrame;
      Object.assign(clip, { videoJobId: job.id, sourceFingerprint: hash, sourceInFrame: Math.ceil(range[0] * 24), sourceOutFrame: Math.ceil(range[0] * 24) + span });
      projectFilmTimeline(spec, timeline, [...initial.candidates, prepared]);
    } catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
  }
  let committed = false;
  try {
    return db.transaction(() => {
      const { binding, shot, revision, candidates } = context(db, groupId, clipId);
      const replay = previous(db, binding.id, clipId, command, actor);
      if (replay) return replay;
      expected(revision, command.expectedRevision);
      let jobId: string | undefined;
      if (command.type === 'generate_image') {
        const providerId = text(command.providerId, '图片供应商');
        const providerRow = db.prepare(`SELECT id,name,type,model,enabled,baseUrl,apiKey
          FROM providers WHERE id=?`).get(providerId) as {
            id: string; name: string; type: string; model: string;
            enabled: number; baseUrl: string; apiKey: string;
          } | undefined;
        if (!providerRow) fail('供应商不存在');
        if (!providerRow.enabled) fail('供应商已禁用');
        const input = image(db, binding, command.inputImageId);
        if (!Array.isArray(command.referenceImageIds) || command.referenceImageIds.length > 20) fail('请明确选择参考图列表');
        const refs = [...new Set(command.referenceImageIds)].filter(id => id !== input).map(id => image(db, binding, id));
        jobId = randomUUID();
        if (runtime.mode === 'server' && !isUnifiedImageAnchorProvider(providerRow)) {
          fail('团队版新返工请选择统一模型“Image 2”，不能直接指定其他图片通道。', 'team_unified_model_required', 409);
        }
        if (isUnifiedImageAnchorProvider(providerRow)) {
          if (runtime.mode !== 'server') fail('统一 Image 2 仅在团队版可用', 'team_unified_model_required', 409);
          if (command.model && command.model !== UNIFIED_IMAGE_MODEL_KEY) {
            fail('统一模型身份已变化，请刷新后核对', 'revision_conflict', 409);
          }
          const available = unifiedImageProviderAvailability(db)
            .some((channel) => channel.identityValid && channel.configured);
          if (!available) fail('当前没有已启用且凭据可用的 Image 2 通道。');
          const output = inferUnifiedImageOutputFromPreset(command.size);
          if (!output) fail('请选择 Image 2 支持的清晰度与比例对应尺寸。');
          let frozen;
          try {
            frozen = freezeUnifiedImageRequest({
              inputImageId: input,
              referenceImageIds: refs,
              prompt: text(command.prompt, '分镜提示词'),
              tier: output.tier,
              ratio: output.ratio,
              referenceGuidanceMode: 'preserve_subject',
            });
          } catch (error) {
            fail(error instanceof UnifiedImageRequestError ? error.message : String(error));
          }
          db.prepare(`INSERT INTO jobs(
              id,projectId,inputImageId,referenceImageIds,providerId,model,prompt,size,quality,
              status,attempt,maxAttempts,createdAt,referenceGuidanceMode,
              unifiedModel,unifiedRuleVersion,unifiedRequestJson,creationSource,creationRequestKey,creationRequestHash
            ) VALUES (?,?,?,?,?,?,?,?,?,'pending',0,1,?,'preserve_subject',?,?,?,?,?,?)`)
            .run(
              jobId, binding.projectId, input, JSON.stringify(refs),
              providerRow.id, UNIFIED_IMAGE_MODEL_KEY, frozen.prompt, frozen.size, 'auto',
              new Date().toISOString(), UNIFIED_IMAGE_MODEL_KEY, UNIFIED_MEDIA_RULE_VERSION,
              JSON.stringify(frozen), 'team_film_rework', command.requestId, requestHash(command),
            );
          registerNewTask(access, 'image', jobId, binding.projectId, {
            entry: 'team_film_rework', requestId: command.requestId,
            bindingId: binding.id, clipId, shotId: shot.id,
            unifiedModel: UNIFIED_IMAGE_MODEL_KEY,
            unifiedRuleVersion: UNIFIED_MEDIA_RULE_VERSION,
            unifiedRequest: frozen,
          });
        } else {
          const provider = resolveImageJobProvider(db, providerId, { providerId, model: '' });
          if (command.model !== provider.model) fail('供应商模型已变化，请刷新后核对', 'revision_conflict', 409);
          db.prepare(`INSERT INTO jobs(id,projectId,inputImageId,referenceImageIds,providerId,model,prompt,size,quality,maxAttempts,createdAt) VALUES (?,?,?,?,?,?,?,?,?,1,?)`)
            .run(jobId, binding.projectId, input, JSON.stringify(refs), provider.providerId, provider.model, text(command.prompt, '分镜提示词'), text(command.size, '图片尺寸'), text(command.quality, '图片质量'), new Date().toISOString());
          registerNewTask(access, 'image', jobId, binding.projectId, {
            entry: 'film_rework', requestId: command.requestId,
            bindingId: binding.id, clipId, shotId: shot.id,
            inputImageId: input, referenceImageIds: refs,
          });
        }
      } else if (command.type === 'select_image') {
        const imageId = image(db, binding, command.imageId);
        const candidate = db.prepare(`SELECT j.id FROM jobs j
          JOIN final_edit_film_reworks r ON r.jobId=j.id
          WHERE r.bindingId=? AND r.clipId=? AND r.kind='generate_image'
            AND (j.status='succeeded' OR (j.status='canceled' AND j.providerStatus='succeeded'))
            AND j.outputImageId=?`).get(binding.id, clipId, imageId) as { id: string } | undefined;
        const originalImages = db.prepare(`SELECT sourceImageId FROM video_jobs WHERE shotId=? AND shotSetId=?`).all(shot.id, binding.shotSetId) as Array<{ sourceImageId: string }>;
        if (!candidate && !originalImages.some(row => row.sourceImageId === imageId)) fail('图片不是该镜头的候选');
        // Never bind latestJobId: a late queue completion must not undo this explicit selection.
        db.prepare('UPDATE shots SET latestGeneratedImageId=?,latestJobId=NULL WHERE id=?').run(imageId, shot.id);
        if (candidate) db.prepare('INSERT OR IGNORE INTO shot_result_candidates(id,shotId,jobId,imageAssetId) VALUES (?,?,?,?)').run(`${shot.id}:${imageId}`, shot.id, candidate.id, imageId);
      } else if (command.type === 'generate_video') {
        const sourceImageId = image(db, binding, command.imageId);
        if (sourceImageId !== (shot.latestGeneratedImageId || shot.sourceImageId)) fail('当前分镜图已变化', 'revision_conflict', 409);
        const providerId = text(command.providerId, '视频供应商');
        const providerRow = db.prepare('SELECT * FROM video_providers WHERE id=? AND enabled=1').get(providerId) as
          (Parameters<typeof getVideoProviderConfigState>[0] & {
            id: string; type: string; defaultModel: string;
          }) | undefined;
        if (!providerRow) fail('视频供应商未找到或已禁用');
        jobId = randomUUID();
        if (runtime.mode === 'server' && !isUnifiedKlingAnchorProvider(providerRow)) {
          fail('团队版新返工请选择统一模型“可灵 3.0”，不能直接指定其他视频通道。', 'team_unified_model_required', 409);
        }
        if (isUnifiedKlingAnchorProvider(providerRow)) {
          if (runtime.mode !== 'server') fail('统一可灵 3.0 仅在团队版可用', 'team_unified_model_required', 409);
          if (command.model && command.model !== UNIFIED_KLING3_MODEL_KEY) {
            fail('统一模型身份已变化，请刷新后核对', 'revision_conflict', 409);
          }
          const duration = parseVideoDuration(command.durationSec);
          let frozen;
          try {
            frozen = freezeUnifiedKlingVideoRequest({
              sourceImageId,
              tailImageId: null,
              referenceAssetIds: [],
              prompt: text(command.prompt, '视频提示词'),
              durationSec: duration,
              generationMode: 'image-to-video',
              multiShot: false,
              aspectRatio: null,
              resolution: null,
            });
          } catch (error) {
            fail(error instanceof UnifiedKlingRequestError ? error.message : String(error));
          }
          const available = new Set(unifiedKlingProviderAvailability(db)
            .filter((channel) => channel.identityValid && channel.configured)
            .map((channel) => channel.channelKey));
          if (!unifiedKlingCompatibleChannels(frozen).some((channel) => available.has(channel.channelKey))) {
            fail('当前没有已配置的可灵 3.0 通道支持这组要求。');
          }
          db.prepare(`INSERT INTO video_jobs(
              id,projectId,shotSetId,shotId,sourceImageId,providerId,model,prompt,durationSec,
              generationMode,aspectRatio,resolution,multiShot,status,attempt,maxAttempts,displayName,createdAt,
              unifiedModel,unifiedRuleVersion,unifiedRequestJson
            ) VALUES (?,?,?,?,?,?,?,?,?,'image-to-video',NULL,NULL,0,'pending',0,1,?,?,?,?,?)`)
            .run(
              jobId, binding.projectId, binding.shotSetId, shot.id, sourceImageId,
              providerRow.id, UNIFIED_KLING3_MODEL_KEY, frozen.prompt, frozen.durationSec,
              `${clipId} 局部返工`, new Date().toISOString(),
              UNIFIED_KLING3_MODEL_KEY, UNIFIED_MEDIA_RULE_VERSION, JSON.stringify(frozen),
            );
          registerNewTask(access, 'video', jobId, binding.projectId, {
            entry: 'team_film_rework', requestId: command.requestId,
            bindingId: binding.id, clipId, shotId: shot.id,
            unifiedModel: UNIFIED_KLING3_MODEL_KEY,
            unifiedRuleVersion: UNIFIED_MEDIA_RULE_VERSION,
            unifiedRequest: frozen,
          });
        } else {
          if (!getVideoProviderConfigState(providerRow).configured) fail('视频供应商未配置或已禁用');
          const model = providerRow.defaultModel.trim();
          if (command.model !== model) fail('供应商模型已变化，请刷新后核对', 'revision_conflict', 409);
          const duration = parseVideoDuration(command.durationSec);
          const error = videoDurationError(providerRow.type, model, duration);
          if (error) fail(error);
          db.prepare(`INSERT INTO video_jobs(id,projectId,shotSetId,shotId,sourceImageId,providerId,model,prompt,durationSec,multiShot,displayName,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(jobId, binding.projectId, binding.shotSetId, shot.id, sourceImageId, providerRow.id, model, text(command.prompt, '视频提示词'), duration, normalizeVideoMultiShotForStorage(providerRow.type, model, false), `${clipId} 局部返工`, new Date().toISOString());
          registerNewTask(access, 'video', jobId, binding.projectId, {
            entry: 'film_rework', requestId: command.requestId,
            bindingId: binding.id, clipId, shotId: shot.id,
            sourceImageId, durationSec: duration,
          });
        }
      } else if (prepared) {
        if (candidates.some(c => c.videoJobId === prepared.videoJobId)) fail('视频已被登记', 'revision_conflict', 409);
        if (external) {
          if (JSON.stringify(externalSource()) !== JSON.stringify(external)) fail('外部素材归属或状态已变化', 'revision_conflict', 409);
        } else if (!db.prepare(`SELECT 1 FROM video_jobs WHERE id=? AND shotId=? AND shotSetId=? AND projectId=?
          AND (status='succeeded' OR (status='canceled' AND providerStatus='succeeded'))`)
          .get(prepared.videoJobId, shot.id, binding.shotSetId, binding.projectId)) fail('视频归属或状态已变化', 'revision_conflict', 409);
        const analysis = db.prepare('SELECT fileFingerprint FROM final_edit_asset_analysis WHERE videoJobId=?').get(prepared.videoJobId) as { fileFingerprint: string } | undefined;
        if (analysis && analysis.fileFingerprint !== prepared.fingerprint) fail('素材分析指纹与当前文件不一致', 'revision_conflict', 409);
        db.prepare('UPDATE final_edit_film_bindings SET candidatesJson=?,inputHashesJson=? WHERE id=?').run(JSON.stringify([...candidates, prepared]), JSON.stringify({ ...JSON.parse(binding.inputHashesJson), [prepared.file]: prepared.fingerprint }), binding.id);
        db.prepare(`INSERT INTO final_edit_asset_analysis(videoJobId,shotSetId,fileFingerprint,providerId,model,analyzerVersion,status,mediaJson,generatedJson,updatedAt) VALUES (?,?,?,'','','rework-metadata/1','succeeded',?,'{}',?)
          ON CONFLICT(videoJobId) DO NOTHING`).run(prepared.videoJobId, binding.shotSetId, prepared.fingerprint, JSON.stringify({ durationUs: Math.round(prepared.durationSec * 1e6) }), new Date().toISOString());
        jobId = prepared.videoJobId;
      }
      const result = record(db, binding, clipId, shot.id, revision, command, actor, jobId);
      committed = true;
      return result;
    }).immediate();
  } finally {
    if (preparedPath && !committed) fs.rmSync(path.dirname(preparedPath), { recursive: true, force: true });
  }
}

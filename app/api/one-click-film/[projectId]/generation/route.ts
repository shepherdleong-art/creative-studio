import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { getRunForProject, listEntries } from '@/lib/one-click-film/store';
import {
  listVideoJobs,
  submitOneClickFilmGeneration,
  syncGenerationStatus,
  videoJobFileUrl,
} from '@/lib/one-click-film/generation';
import { assertOneClickFilmApiReady, jsonError, readJsonBody } from '@/lib/one-click-film/http';
import { OneClickFilmError } from '@/lib/one-click-film/errors';
import { getFilmPreview, readFilmBody } from '@/lib/one-click-film/composition';
import {
  assertGenerationSettings,
  listVideoModelOptions,
  validateGenerationSettings,
} from '@/lib/one-click-film/video-models';

/**
 * 生成视频：列出可用的视频通道与当前队列，并提交整批直出。
 * 队列按条目显示进度；成功媒体带可播放地址与实际切点。
 */
async function __teamRouteGET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    await assertOneClickFilmApiReady();
    const { projectId } = await params;
    const db = getDb();
    const access = requireAccessContext();
    if (access.kind === 'team') access.assertAccess('project', projectId, 'read');
    const run = getRunForProject(db, projectId);
    if (!run) return NextResponse.json({ providers: [], jobs: [], entries: [] });

    await syncGenerationStatus(db, run);
    const providers = listVideoModelOptions(db).map((option) => ({
      id: option.providerId, name: option.providerName, type: option.providerType,
      model: option.model, hasApiKey: option.hasApiKey,
    }));

    const jobs = await Promise.all(listVideoJobs(db, run).map(async (job) => {
      const body = job.status === 'succeeded' ? readFilmBody(db, run, job.entryCode) : null;
      const videoUrl = body?.jobId === job.id && body.snapshot.narrationPath
        ? await getFilmPreview(db, run, { ...body, edits: [], signature: `${body.jobId}:original-narration` })
        : videoJobFileUrl(job.localVideoPath);
      return { ...job, localVideoPath: undefined, videoUrl };
    }));
    return NextResponse.json({
      providers,
      entries: listEntries(db, run.id),
      jobs,
    });
  } catch (error) {
    return jsonError(error);
  }
}

async function __teamRoutePOST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    await assertOneClickFilmApiReady();
    const { projectId } = await params;
    const db = getDb();
    const access = requireAccessContext();
    if (access.kind === 'team') access.assertAccess('project', projectId, 'write');
    const run = getRunForProject(db, projectId);
    if (!run) throw new OneClickFilmError('not_found', '项目还没有一键成片记录', 404);
    const body = await readJsonBody(request);
    const providerId = typeof body.providerId === 'string' ? body.providerId : '';
    if (!providerId) throw new OneClickFilmError('invalid_input', '请选择视频通道');
    const durationSec = Number(body.durationSec ?? 15);
    if (!Number.isInteger(durationSec) || durationSec < 2 || durationSec > 60) {
      throw new OneClickFilmError('invalid_input', '正文时长必须是 2–60 的整数秒');
    }
    const aspectRatio = typeof body.aspectRatio === 'string' && body.aspectRatio.trim()
      ? body.aspectRatio.trim() : '3:4';
    const codes = Array.isArray(body.codes)
      ? body.codes.filter((code): code is string => typeof code === 'string')
      : undefined;
    // 服务端给出与界面一致的判定：时长、画幅、生成模式必须落在通道声明的范围内。
    const mode = body.mode === 'draft' ? 'draft' as const : 'direct' as const;
    assertGenerationSettings(validateGenerationSettings({
      option: listVideoModelOptions(db).find((item) => item.providerId === providerId),
      durationSec,
      aspectRatio,
      mode,
    }));

    const result = await submitOneClickFilmGeneration({
      run,
      providerId,
      durationSec,
      aspectRatio,
      mode,
      resolution: typeof body.resolution === 'string' ? body.resolution : undefined,
      codes,
      db,
    });
    return NextResponse.json({
      ...result,
      jobs: result.jobs.map((job) => ({ ...job, localVideoPath: undefined, videoUrl: videoJobFileUrl(job.localVideoPath) })),
    });
  } catch (error) {
    return jsonError(error);
  }
}

export const GET = withTeamRoute('/api/one-click-film/[projectId]/generation', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/one-click-film/[projectId]/generation', 'POST', __teamRoutePOST);

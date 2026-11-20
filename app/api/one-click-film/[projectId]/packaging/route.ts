import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { getRunForProject } from '@/lib/one-click-film/store';
import { listPackaging, listPackagingPreviewSources, parsePackagingOptions, preparePackaging, updatePackagingDraft, type TextCue } from '@/lib/one-click-film/packaging';
import { listFilmBgm, recognizeFilmPackagingSubtitles } from '@/lib/one-click-film/packaging-render';
import { getFilmPreview, readFilmBody } from '@/lib/one-click-film/composition';
import { listReviews } from '@/lib/one-click-film/review';
import { packagingOverlayConfig } from '@/lib/one-click-film/packaging-edit';
import { packagingPreviewHtml } from '@/lib/media-core/packaging-preview';
import { buildPackagingVars, sanitizePointCues } from '@/lib/media-core/packaging-vars';
import { FINAL_EDIT_FPS, FINAL_EDIT_INTRO_FRAMES } from '@/lib/media-core/render-contract';
import { assertOneClickFilmApiReady, jsonError, readJsonBody } from '@/lib/one-click-film/http';
import { OneClickFilmError } from '@/lib/one-click-film/errors';

/** 一键批量包装与包装后继续编辑。 */
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
    return NextResponse.json({
      packaging: run ? listPackaging(db, run) : [],
      previews: run ? listPackagingPreviewSources(db, run) : [],
      bgm: (await listFilmBgm(db)).map(({ id, name }) => ({ id, name })),
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
    const action = String(body.action ?? 'prepare');
    const entryCode = String(body.entryCode ?? '');

    if (action === 'edit') {
      updatePackagingDraft(db, {
          run,
          entryCode,
          title: typeof body.title === 'string' ? body.title : undefined,
          template: typeof body.template === 'string' ? body.template : undefined,
          subtitleCues: Array.isArray(body.subtitleCues) ? body.subtitleCues as TextCue[] : undefined,
          pointCues: Array.isArray(body.pointCues) ? body.pointCues as TextCue[] : undefined,
          bgmVolume: typeof body.bgmVolume === 'number' ? body.bgmVolume : undefined,
          bgmId: typeof body.bgmId === 'string' ? body.bgmId : undefined,
          options: body.options,
          expectedRevision: typeof body.revision === 'number' ? body.revision : undefined,
      });
      return NextResponse.json({ packaging: listPackaging(db, run) });
    }
    if (action === 'recognize-subtitles') {
      await recognizeFilmPackagingSubtitles(db, run, entryCode, Number(body.revision));
      return NextResponse.json({ packaging: listPackaging(db, run) });
    }
    if (action === 'open' || action === 'preview') {
      const film = readFilmBody(db, run, entryCode);
      if (!film) throw new OneClickFilmError('not_found', '还没有生成原片', 404);
      const durationSec = film.frames / FINAL_EDIT_FPS;
      if (action === 'preview') {
        const options = parsePackagingOptions(body.options);
        const title = typeof body.title === 'string' ? body.title.slice(0, 60) : '';
        const config = packagingOverlayConfig({ options, template: options.template, title, pointCues: sanitizePointCues(body.pointCues) ?? [] });
        if (!config.enabled) return NextResponse.json({ html: '' });
        const coverSec = options.cover ? FINAL_EDIT_INTRO_FRAMES / FINAL_EDIT_FPS : 0;
        return NextResponse.json({ html: packagingPreviewHtml({
          config, vars: buildPackagingVars({ subtitleCues: [], overrides: config.varsOverrides }),
          totalSec: durationSec + coverSec, coverSec, edit: true, staticCover: true, coverEnabled: options.cover,
        }) });
      }
      let record = listPackaging(db, run).find((item) => item.entryCode === entryCode);
      if (!record) {
        preparePackaging(db, { run, options: body.options, codes: [entryCode], allowPreview: true });
        record = listPackaging(db, run).find((item) => item.entryCode === entryCode);
      }
      const review = listReviews(db, run).find((item) => item.jobId === film.jobId);
      return NextResponse.json({
        record,
        media: { url: await getFilmPreview(db, run, film, film.draft && film.hdApproved), durationSec, shots: review?.shots ?? [] },
      });
    }

    if (action !== 'prepare') throw new OneClickFilmError('invalid_input', '不支持的包装操作');
    const codes = Array.isArray(body.codes) ? body.codes.map(String) : undefined;
    const results = preparePackaging(db, { run, options: body.options, codes, allowPreview: true });
    return NextResponse.json({ results, packaging: listPackaging(db, run) });
  } catch (error) {
    return jsonError(error);
  }
}

export const GET = withTeamRoute('/api/one-click-film/[projectId]/packaging', 'GET', __teamRouteGET);
export const POST = withTeamRoute('/api/one-click-film/[projectId]/packaging', 'POST', __teamRoutePOST);

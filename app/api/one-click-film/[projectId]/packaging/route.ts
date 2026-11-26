import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';
import { requireAccessContext } from '@/lib/media-core/access-context';
import { syncGenerationStatus } from '@/lib/one-click-film/generation';
import { getEntry, getRunForProject } from '@/lib/one-click-film/store';
import { extractFilmPackagingPoints, listPackaging, listPackagingPreviewSources, parsePackagingOptions, preparePackaging, updatePackagingDraft, type TextCue } from '@/lib/one-click-film/packaging';
import { filmPreviewFontCss, listFilmBgm, recognizeFilmPackagingSubtitles } from '@/lib/one-click-film/packaging-render';
import { getFilmPreview, playableFilmBody, readFilmBody, readyHdPaths, sourceIdsForBody } from '@/lib/one-click-film/composition';
import { listReviews, reviewForPlayback, undoableMergeId } from '@/lib/one-click-film/review';
import { packagingOverlayConfig } from '@/lib/one-click-film/packaging-edit';
import { packagingPreviewHtml } from '@/lib/media-core/packaging-preview';
import { buildPackagingVars, sanitizePointCues } from '@/lib/media-core/packaging-vars';
import { FINAL_EDIT_FPS, FINAL_EDIT_INTRO_FRAMES } from '@/lib/media-core/render-contract';
import { validatePackagingStickers } from '@/lib/media-core/packaging-stickers';
import { isExecutionDeferredError, isExecutionUnknownError } from '@/lib/media-core/execution/waiting';
import { assertOneClickFilmApiReady, jsonError, readJsonBody } from '@/lib/one-click-film/http';
import { OneClickFilmError } from '@/lib/one-click-film/errors';
import { retryFilmAutoCover, scheduleFilmAutoCover } from '@/lib/one-click-film/cover-auto';
import { previewFilmCover, previewFilmCoverFramingSource, previewProjectCoverThumbnail } from '@/lib/one-click-film/cover-render';
import { validateFilmCoverSelection } from '@/lib/one-click-film/cover-source';
import { listFilmCoverCandidates } from '@/lib/one-click-film/cover-assets';
import { filmCoverGenerationConfig, queueFilmCoverGeneration } from '@/lib/one-click-film/cover-generation';
import { startFilmCoverGenerationAfterReadiness } from '@/lib/one-click-film/cover-generation-worker';
import { isOneClickFilmTemplate } from '@/lib/one-click-film/packaging-constants';
import { extractPackagingPalette, resolveTemplateHueMode } from '@/lib/media-core/packaging-palette';
import { resolvePackagingDir, resolvePackagingTemplateDir } from '@/lib/media-core/packaging-runtime';

/** 一键批量包装与包装后继续编辑。 */
async function __teamRouteGET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    await assertOneClickFilmApiReady();
    const { projectId } = await params;
    const db = getDb();
    const access = requireAccessContext();
    if (access.kind === 'team') access.assertAccess('project', projectId, 'read');
    const thumbnailId = request.nextUrl.searchParams.get('coverThumbnail');
    if (thumbnailId !== null) {
      const thumbnail = await previewProjectCoverThumbnail(db, projectId, thumbnailId);
      return new NextResponse(new Uint8Array(thumbnail.jpeg), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store' } });
    }
    const run = getRunForProject(db, projectId);
    const candidateCode = request.nextUrl.searchParams.get('coverCandidates');
    if (candidateCode !== null) {
      if (!run) throw new OneClickFilmError('not_found', '项目还没有一键成片记录', 404);
      const entry = getEntry(db, run.id, candidateCode);
      return NextResponse.json({ coverGeneration: await filmCoverGenerationConfig(db), coverCandidates: listFilmCoverCandidates(db, run, entry.id) },
        { headers: { 'Cache-Control': 'private, no-store' } });
    }
    const coverCode = request.nextUrl.searchParams.get('cover');
    if (coverCode !== null) {
      const saved = run && readFilmBody(db, run, coverCode);
      if (!run || !saved) throw new OneClickFilmError('not_found', '还没有生成原片', 404);
      const record = listPackaging(db, run).find(item => item.entryCode === coverCode);
      const cover = await previewFilmCover(db, run, await playableFilmBody(saved), record?.options.coverMedia);
      return new NextResponse(new Uint8Array(cover), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store' } });
    }
    const autoCode = request.nextUrl.searchParams.get('autoCover');
    if (autoCode !== null) {
      const body = run && readFilmBody(db, run, autoCode);
      if (!run || !body) throw new OneClickFilmError('not_found', '还没有生成原片', 404);
      scheduleFilmAutoCover(db, run, body);
      return NextResponse.json({ record: listPackaging(db, run).find(item => item.entryCode === autoCode) });
    }
    if (run) await syncGenerationStatus(db, run);
    return NextResponse.json({
      packaging: run ? listPackaging(db, run) : [],
      previews: run ? listPackagingPreviewSources(db, run) : [],
      coverGeneration: await filmCoverGenerationConfig(db),
      coverCandidates: run ? listFilmCoverCandidates(db, run) : [],
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

    if (action === 'generate-cover') {
      const film = readFilmBody(db, run, entryCode);
      if (!film) throw new OneClickFilmError('not_found', '还没有生成原片', 404);
      if (body.template !== undefined && !isOneClickFilmTemplate(body.template)) {
        throw new OneClickFilmError('invalid_input', '所选包装模板无效。');
      }
      const template = isOneClickFilmTemplate(body.template) ? body.template
        : listPackaging(db, run).find(item => item.entryCode === entryCode)?.template ?? 'overlay-poster';
      const aspectRatio = db.prepare(`SELECT aspectRatio FROM one_click_film_video_jobs WHERE runId=? AND entryId=? AND videoJobId=?`)
        .pluck().get(run.id, film.entryId, film.originalVideoJobId) as string | undefined;
      const coverCandidate = await queueFilmCoverGeneration(db, run, {
        entryCode, requestKey: body.requestKey, providerId: body.providerId, referenceImageIds: body.referenceImageIds,
        preference: body.preference, template, aspectRatio: aspectRatio ?? getEntry(db, run.id, entryCode).promptAspectRatio,
      });
      void startFilmCoverGenerationAfterReadiness();
      return NextResponse.json({ coverCandidate }, { status: coverCandidate.status === 'queued' || coverCandidate.status === 'running' ? 202 : 200 });
    }

    if (action === 'retry-auto-cover') {
      const saved = retryFilmAutoCover(db, run, entryCode, body.sourceSignature, body.attempt);
      scheduleFilmAutoCover(db, run, saved);
      return NextResponse.json({ record: listPackaging(db, run).find(item => item.entryCode === entryCode) });
    }

    if (action === 'cover-framing-source') {
      const saved = readFilmBody(db, run, entryCode);
      if (!saved) throw new OneClickFilmError('not_found', '还没有生成原片', 404);
      const film = await playableFilmBody(saved);
      const options = body.options && typeof body.options === 'object' ? body.options as Record<string, unknown> : {};
      const coverMedia = validateFilmCoverSelection(db, run, film, options.coverMedia);
      const source = await previewFilmCoverFramingSource(db, run, film, coverMedia);
      return NextResponse.json({ image: `data:image/jpeg;base64,${source.jpeg.toString('base64')}`, width: source.width, height: source.height });
    }

    if (action === 'edit') {
      if (typeof body.revision !== 'number' || !Number.isSafeInteger(body.revision) || body.revision < 1) {
        throw new OneClickFilmError('invalid_input', '缺少有效的包装草稿修订号');
      }
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
          expectedRevision: body.revision,
      });
      return NextResponse.json({ packaging: listPackaging(db, run) });
    }
    if (action === 'recognize-subtitles') {
      try {
        await recognizeFilmPackagingSubtitles(db, run, entryCode, Number(body.revision), body.prepareIfMissing === true ? 'open' : 'explicit');
      } catch (error) {
        if (isExecutionDeferredError(error)) return NextResponse.json({ subtitleWaiting: true }, { status: 202 });
        if (isExecutionUnknownError(error)) throw new OneClickFilmError('conflict', '口播识别已提交，正在等待结果核对。', 409);
        throw error;
      }
      return NextResponse.json({ packaging: listPackaging(db, run) });
    }
    if (action === 'extract-points') {
      const record = listPackaging(db, run).find(item => item.entryCode === entryCode);
      return NextResponse.json({ pointCues: extractFilmPackagingPoints(db, run, entryCode, record?.subtitlesPrepared ? record.subtitleCues : []) });
    }
    if (action === 'open' || action === 'preview') {
      const saved = readFilmBody(db, run, entryCode);
      if (!saved) throw new OneClickFilmError('not_found', '还没有生成原片', 404);
      const film = await playableFilmBody(saved);
      const durationSec = film.frames / FINAL_EDIT_FPS;
      if (action === 'preview') {
        const options = parsePackagingOptions(body.options);
        if (body.options && typeof body.options === 'object' && 'coverMedia' in body.options) {
          options.coverMedia = validateFilmCoverSelection(db, run, film, body.options.coverMedia);
        }
        if (body.options && typeof body.options === 'object' && 'assetStickers' in body.options) {
          try { options.assetStickers = validatePackagingStickers(body.options.assetStickers, film.frames); }
          catch (error) { throw new OneClickFilmError('invalid_input', error instanceof Error ? error.message : '贴纸数据无效'); }
        }
        const title = typeof body.title === 'string' ? body.title.slice(0, 60) : '';
        const config = packagingOverlayConfig({ options, template: options.template, title, pointCues: sanitizePointCues(body.pointCues) ?? [] });
        const jpeg = await previewFilmCover(db, run, film, options.coverMedia);
        const coverImage = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
        if (!config.enabled) return NextResponse.json({ html: '', coverImage });
        const coverSec = options.cover ? FINAL_EDIT_INTRO_FRAMES / FINAL_EDIT_FPS : 0;
        const hueMode = resolveTemplateHueMode(resolvePackagingTemplateDir(resolvePackagingDir(), config.template));
        const paletteSource = !options.cover && options.coverMedia ? await previewFilmCover(db, run, film) : jpeg;
        const palette = await extractPackagingPalette(paletteSource, hueMode);
        const html = packagingPreviewHtml({
          config, vars: buildPackagingVars({ subtitleCues: [], overrides: config.varsOverrides }),
          totalSec: durationSec + coverSec, coverSec, palette, edit: true, staticCover: true, coverEnabled: options.cover,
        });
        return NextResponse.json({ coverImage, html: html.replace('</head>', `<style>${filmPreviewFontCss(config)}</style></head>`) });
      }
      let record = listPackaging(db, run).find((item) => item.entryCode === entryCode);
      if (!record) {
        preparePackaging(db, { run, options: body.options, codes: [entryCode], allowPreview: true });
        record = listPackaging(db, run).find((item) => item.entryCode === entryCode);
      }
      scheduleFilmAutoCover(db, run, film);
      let subtitleWarning: string | undefined;
      let subtitleWaiting = false;
      if (body.prepareSubtitles === true && record?.options.subtitles && !record.subtitlesPrepared && film.snapshot.soundMode !== 'none') {
        try {
          await recognizeFilmPackagingSubtitles(db, run, entryCode, record.revision, 'open');
        } catch (error) {
          if (error instanceof OneClickFilmError && error.code === 'conflict') throw error;
          subtitleWaiting = isExecutionDeferredError(error);
          subtitleWarning = subtitleWaiting ? '口播识别正在等待名额，空出后自动对时。'
            : isExecutionUnknownError(error) ? '口播识别已提交，正在等待结果核对。'
              : '口播对时未完成。可在字幕面板校对草稿或重新识别。';
        }
      }
      const review = listReviews(db, run).find((item) => item.jobId === film.jobId);
      if (!review) throw new OneClickFilmError('not_found', '审片记录尚未准备好', 404);
      const hdReady = film.draft && readyHdPaths(db, run, film).size === sourceIdsForBody(film).length;
      const url = await getFilmPreview(db, run, film, hdReady);
      const playback = reviewForPlayback(review, Math.round(durationSec * 1e6));
      record = listPackaging(db, run).find(item => item.entryCode === entryCode);
      if (record?.subtitlesPrepared) {
        subtitleWaiting = false;
        subtitleWarning = undefined;
      }
      return NextResponse.json({
        record, subtitleWarning, subtitleWaiting,
        coverGeneration: await filmCoverGenerationConfig(db), coverCandidates: listFilmCoverCandidates(db, run, film.entryId),
        media: { url, durationSec, shots: playback.shots, signature: film.signature, sharedFonts: access.kind === 'team', review: { ...playback, entryId: film.entryId, draft: film.draft,
          hdApproved: film.hdApproved, hdVideoUrl: hdReady ? url : null, undoMergeId: undoableMergeId(db, review) } },
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

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import {
  applyBatchOutputClipEdit,
  type BatchOutputClipEdit,
} from '@/lib/batch-production/output-arrangement';
import type { CoverFraming, TextStyle } from '@/lib/media-core/cover-types';
import { scheduleRenderAfterClipEdit } from '@/lib/batch-production/phase-e';
import { ensureBatchSchedulerStarted } from '@/lib/batch-production/bootstrap';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 片段级编辑（等长 trim/replace、变长修剪、删除、插入、分割）：就地改写当前
 * 候选版本 arrangement，只在画面变化时递增 editRevision 并重渲染同一版本。
 * 分割是纯结构操作，不递增 revision、不触发重渲染。
 *
 * `deferRender: true` 只写 arrangement 不排渲染：编辑器里的预览是客户端实时合成，
 * 不看渲染产物；编辑器在退出这一轮调整时用 `type: 'commit_render'` 一次性提交，
 * 避免每次微调都被整片渲染锁住——requestKey 含 editRevision 且 createBatchTask 按 key 幂等，
 * 所以重复提交、以及「已经渲染过的 revision」都不会多排任务。
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string; planId: string }> }) {
  const { id, planId } = await context.params;
  const projectId = batchProjectIdFromRequest(request);
  if (!projectId) {
    return NextResponse.json({
      error: 'missing_project_id',
      message: '缺少 projectId 参数',
    }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
  }
  try {
    await assertBatchApiReady();
    const body = await request.json().catch(() => ({})) as {
      type?: unknown;
      clipId?: unknown;
      sourceStartUs?: unknown;
      sourceEndUs?: unknown;
      assetId?: unknown;
      afterClipId?: unknown;
      durationUs?: unknown;
      offsetUs?: unknown;
      timeUs?: unknown;
      trackId?: unknown;
      gainDb?: unknown;
      fadeInSec?: unknown;
      fadeOutSec?: unknown;
      cueId?: unknown;
      text?: unknown;
      startUs?: unknown;
      endUs?: unknown;
      splitUs?: unknown;
      leftText?: unknown;
      rightText?: unknown;
      framing?: unknown;
      title?: unknown;
      style?: unknown;
      deferRender?: unknown;
    };
    const clipId = typeof body.clipId === 'string' ? body.clipId.trim() : '';

    // 提交这一轮片段调整:只排渲染,不改 arrangement。当前 editRevision 已经排过
    // (或正在渲染)时命中同一 requestKey,原样返回既有任务,不会重复排队。
    if (body.type === 'commit_render') {
      const db = getDb();
      const renderTaskId = scheduleRenderAfterClipEdit(db, projectId, id, planId);
      if (renderTaskId) ensureBatchSchedulerStarted();
      return NextResponse.json({ committed: true, renderTaskId }, { headers: BATCH_NO_STORE_HEADERS });
    }

    let edit: BatchOutputClipEdit;

    if (body.type === 'trim' || body.type === 'trim_variable') {
      if (!clipId) {
        return NextResponse.json({
          error: 'invalid_clip_edit',
          message: '片段编辑需要 clipId',
        }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      if (
        typeof body.sourceStartUs !== 'number' || !Number.isSafeInteger(body.sourceStartUs)
        || typeof body.sourceEndUs !== 'number' || !Number.isSafeInteger(body.sourceEndUs)
      ) {
        return NextResponse.json({
          error: 'invalid_clip_edit',
          message: '截取区间必须是安全整数(微秒)',
        }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      edit = { type: body.type, clipId, sourceStartUs: body.sourceStartUs, sourceEndUs: body.sourceEndUs };
    } else if (body.type === 'replace') {
      const assetId = typeof body.assetId === 'string' ? body.assetId.trim() : '';
      if (!clipId || !assetId) {
        return NextResponse.json({
          error: 'invalid_clip_edit',
          message: '替换编辑需要 clipId 与 assetId',
        }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      edit = { type: 'replace', clipId, assetId };
    } else if (body.type === 'delete') {
      if (!clipId) {
        return NextResponse.json({
          error: 'invalid_clip_edit',
          message: '删除编辑需要 clipId',
        }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      edit = { type: 'delete', clipId };
    } else if (body.type === 'insert') {
      const assetId = typeof body.assetId === 'string' ? body.assetId.trim() : '';
      const afterClipId = typeof body.afterClipId === 'string'
        ? body.afterClipId.trim()
        : body.afterClipId === null
          ? null
          : undefined;
      if (!assetId || afterClipId === undefined || (afterClipId !== null && !afterClipId)) {
        return NextResponse.json({
          error: 'invalid_clip_edit',
          message: '插入编辑需要 assetId 与 afterClipId(null 表示插到最前)',
        }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      if (
        body.durationUs !== undefined
        && (typeof body.durationUs !== 'number' || !Number.isSafeInteger(body.durationUs) || body.durationUs <= 0)
      ) {
        return NextResponse.json({
          error: 'invalid_clip_edit',
          message: '插入时长必须是正整数(微秒)',
        }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      edit = { type: 'insert', assetId, afterClipId, ...(body.durationUs === undefined ? {} : { durationUs: body.durationUs }) };
    } else if (body.type === 'split') {
      if (!clipId || typeof body.offsetUs !== 'number' || !Number.isSafeInteger(body.offsetUs) || body.offsetUs < 0) {
        return NextResponse.json({
          error: 'invalid_clip_edit',
          message: '分割编辑需要 clipId 与非负安全整数 offsetUs(微秒)',
        }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      edit = { type: 'split', clipId, offsetUs: body.offsetUs };
    } else if (body.type === 'set_cover') {
      const assetId = typeof body.assetId === 'string' ? body.assetId.trim() : '';
      if (!assetId || typeof body.timeUs !== 'number' || !Number.isSafeInteger(body.timeUs) || body.timeUs < 0) {
        return NextResponse.json({
          error: 'invalid_clip_edit',
          message: '封面编辑需要 assetId 与非负安全整数 timeUs(微秒)',
        }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      if (body.framing !== undefined && body.framing !== null && (typeof body.framing !== 'object' || Array.isArray(body.framing))) {
        return NextResponse.json({ error: 'invalid_clip_edit', message: '封面构图参数无效' }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      if (body.title !== undefined && (body.title === null || typeof body.title !== 'object' || Array.isArray(body.title))) {
        return NextResponse.json({ error: 'invalid_clip_edit', message: '封面标题参数无效' }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      edit = {
        type: 'set_cover',
        assetId,
        timeUs: body.timeUs,
        ...(body.framing === undefined ? {} : { framing: body.framing as CoverFraming | null }),
        ...(body.title === undefined ? {} : { title: body.title }),
      };
    } else if (body.type === 'set_music_track') {
      const trackId = body.trackId === null
        ? null
        : typeof body.trackId === 'string' && body.trackId.trim()
          ? body.trackId.trim()
          : undefined;
      if (trackId === undefined) {
        return NextResponse.json({
          error: 'invalid_clip_edit',
          message: 'BGM 编辑需要有效 trackId，null 表示关闭音乐',
        }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      edit = { type: 'set_music_track', trackId };
    } else if (body.type === 'set_music_params') {
      if (![body.gainDb, body.fadeInSec, body.fadeOutSec].every((value) => typeof value === 'number' && Number.isFinite(value))) {
        return NextResponse.json({
          error: 'invalid_clip_edit',
          message: 'BGM 参数必须是有限数字',
        }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      const gainDb = body.gainDb as number;
      const fadeInSec = body.fadeInSec as number;
      const fadeOutSec = body.fadeOutSec as number;
      edit = {
        type: 'set_music_params',
        gainDb,
        fadeInSec,
        fadeOutSec,
      };
    } else if (body.type === 'set_narration_gain') {
      if (typeof body.gainDb !== 'number' || !Number.isFinite(body.gainDb)) {
        return NextResponse.json({
          error: 'invalid_clip_edit',
          message: '口播音量必须是有限数字',
        }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      edit = { type: 'set_narration_gain', gainDb: body.gainDb };
    } else if (body.type === 'set_subtitle_style') {
      if (body.style !== null && (typeof body.style !== 'object' || Array.isArray(body.style))) {
        return NextResponse.json({ error: 'invalid_clip_edit', message: '字幕样式参数无效' }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      edit = { type: 'set_subtitle_style', style: body.style === null ? null : body.style as TextStyle };
    } else if (body.type === 'set_subtitle_cue_text') {
      const cueId = typeof body.cueId === 'string' ? body.cueId.trim() : '';
      if (!cueId || typeof body.text !== 'string') {
        return NextResponse.json({
          error: 'invalid_clip_edit',
          message: '字幕文字编辑需要 cueId 与 text',
        }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      edit = { type: 'set_subtitle_cue_text', cueId, text: body.text };
    } else if (body.type === 'move_subtitle_cue' || body.type === 'trim_subtitle_cue') {
      const cueId = typeof body.cueId === 'string' ? body.cueId.trim() : '';
      if (!cueId || typeof body.startUs !== 'number' || !Number.isSafeInteger(body.startUs)
        || typeof body.endUs !== 'number' || !Number.isSafeInteger(body.endUs)
        || body.startUs < 0 || body.endUs <= body.startUs) {
        return NextResponse.json({
          error: 'invalid_clip_edit',
          message: '字幕编辑需要有效 cueId、startUs 与 endUs',
        }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      edit = { type: body.type, cueId, startUs: body.startUs, endUs: body.endUs };
    } else if (body.type === 'split_subtitle_cue') {
      const cueId = typeof body.cueId === 'string' ? body.cueId.trim() : '';
      if (!cueId || typeof body.splitUs !== 'number' || !Number.isSafeInteger(body.splitUs) || body.splitUs < 0) {
        return NextResponse.json({
          error: 'invalid_clip_edit',
          message: '字幕分割需要有效 cueId 与 splitUs',
        }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      if (body.leftText !== undefined && typeof body.leftText !== 'string') {
        return NextResponse.json({ error: 'invalid_clip_edit', message: '字幕左侧文字无效' }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      if (body.rightText !== undefined && typeof body.rightText !== 'string') {
        return NextResponse.json({ error: 'invalid_clip_edit', message: '字幕右侧文字无效' }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      edit = {
        type: 'split_subtitle_cue',
        cueId,
        splitUs: body.splitUs,
        ...(body.leftText === undefined ? {} : { leftText: body.leftText }),
        ...(body.rightText === undefined ? {} : { rightText: body.rightText }),
      };
    } else if (body.type === 'delete_subtitle_cue') {
      const cueId = typeof body.cueId === 'string' ? body.cueId.trim() : '';
      if (!cueId) {
        return NextResponse.json({ error: 'invalid_clip_edit', message: '字幕删除需要 cueId' }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      edit = { type: 'delete_subtitle_cue', cueId };
    } else if (body.type === 'restore_automatic_subtitles') {
      edit = { type: 'restore_automatic_subtitles' };
    } else {
      return NextResponse.json({
        error: 'invalid_clip_edit',
        message: '编辑需要 type(trim/replace/trim_variable/delete/insert/split/set_cover/set_music_track/set_music_params/set_narration_gain/set_subtitle_style/set_subtitle_cue_text/move_subtitle_cue/trim_subtitle_cue/split_subtitle_cue/delete_subtitle_cue/restore_automatic_subtitles/commit_render)',
      }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
    }

    const db = getDb();
    const result = applyBatchOutputClipEdit(db, projectId, id, planId, edit);
    // 视觉变化才重渲染这一条；requestKey 含 editRevision，同一次编辑重复提交
    // 不会重复排队，无变化(unchanged)与纯结构分割(split)都不排队。
    // deferRender 时把这次渲染欠着，等调用方 commit_render 一次性结清。
    const deferRender = body.deferRender === true;
    const renderDeferred = result.visualChanged && deferRender;
    const renderTaskId = result.visualChanged && !deferRender
      ? scheduleRenderAfterClipEdit(db, projectId, id, planId)
      : null;
    if (renderTaskId) ensureBatchSchedulerStarted();
    return NextResponse.json({ ...result, renderTaskId, renderDeferred }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_clip_edit_failed', '编辑成片片段失败');
  }
}

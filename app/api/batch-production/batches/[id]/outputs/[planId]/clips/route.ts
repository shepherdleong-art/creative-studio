import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { assertBatchApiReady } from '@/lib/batch-production/runtime-readiness';
import {
  applyBatchOutputClipEdit,
  type BatchOutputClipEdit,
} from '@/lib/batch-production/output-arrangement';
import type { CoverFraming, TextStyle } from '@/lib/media-core/cover-types';
import { scheduleRenderAfterCoverChange } from '@/lib/batch-production/phase-e';
import { resolveCoverContractHash } from '@/lib/batch-production/cover-contract';
import { ensureBatchSchedulerStarted } from '@/lib/batch-production/bootstrap';
import {
  BATCH_NO_STORE_HEADERS,
  batchProjectIdFromRequest,
  batchRouteErrorResponse,
} from '../../../../response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 片段级编辑（等长 trim/replace、变长修剪、删除、插入、分割、封面、BGM、字幕）：
 * 就地改写当前候选版本 arrangement，画面/音频/字幕变化时递增 editRevision 并
 * 清除审核结论。编辑器优先模型下编辑只保存，不排整片渲染；完整 mp4 在导出阶段
 * 按完整渲染契约生成。
 *
 * 只有影响封面契约的编辑（换封面素材/时间/构图/标题，或替换掉封面引用的第一条
 * 片段）会让封面渲染任务重跑：封面任务 requestKey 是统一的 coverContractHash，
 * 同一契约重复触发幂等命中既有任务；与封面无关的编辑不会产生任何新任务。
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
    };
    const clipId = typeof body.clipId === 'string' ? body.clipId.trim() : '';

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
    } else if (body.type === 'set_music') {
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
      if (![body.gainDb, body.fadeInSec, body.fadeOutSec].every((value) => typeof value === 'number' && Number.isFinite(value))) {
        return NextResponse.json({
          error: 'invalid_clip_edit',
          message: 'BGM 参数必须是有限数字',
        }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
      }
      edit = {
        type: 'set_music',
        trackId,
        gainDb: body.gainDb as number,
        fadeInSec: body.fadeInSec as number,
        fadeOutSec: body.fadeOutSec as number,
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
        message: '编辑需要 type(trim/replace/trim_variable/delete/insert/split/set_cover/set_music_track/set_music_params/set_music/set_narration_gain/set_subtitle_style/set_subtitle_cue_text/move_subtitle_cue/trim_subtitle_cue/split_subtitle_cue/delete_subtitle_cue/restore_automatic_subtitles)',
      }, { status: 400, headers: BATCH_NO_STORE_HEADERS });
    }

    const db = getDb();
    // 封面契约前后比对:只有封面契约真的变化才排封面任务。BGM、字幕、口播
    // 音量等编辑同样会置 visualChanged,但不能触发封面重渲染;老批次没有
    // 封面任务时更不能因为改 BGM 平白生出一条封面任务。
    const planRow = db.prepare(`SELECT currentVersionId FROM batch_output_plans WHERE id = ?`).get(planId) as {
      currentVersionId: string | null;
    } | undefined;
    const outputVersionId = planRow?.currentVersionId ?? null;
    let coverContractBefore: string | null = null;
    if (outputVersionId) {
      try {
        coverContractBefore = resolveCoverContractHash(db, outputVersionId);
      } catch {
        coverContractBefore = null;
      }
    }
    const result = applyBatchOutputClipEdit(db, projectId, id, planId, edit);
    let coverContractAfter: string | null = null;
    if (outputVersionId && result.visualChanged) {
      try {
        coverContractAfter = resolveCoverContractHash(db, outputVersionId);
      } catch {
        coverContractAfter = null;
      }
    }
    // 前后契约任一无法解析时保持老行为(visualChanged 即排),可解析且相等则
    // 说明本次编辑与封面无关,不产生封面任务。
    const coverContractChanged = result.changed
      && result.visualChanged
      && (coverContractBefore === null || coverContractAfter === null || coverContractBefore !== coverContractAfter);
    const coverTaskId = coverContractChanged
      ? scheduleRenderAfterCoverChange(db, projectId, id, planId)
      : null;
    if (coverTaskId) ensureBatchSchedulerStarted();
    return NextResponse.json({ ...result, coverTaskId }, { headers: BATCH_NO_STORE_HEADERS });
  } catch (error) {
    return batchRouteErrorResponse(error, 'batch_clip_edit_failed', '编辑成片片段失败');
  }
}

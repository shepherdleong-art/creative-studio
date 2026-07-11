// lib/final-video/submit-job.ts
// Submits an immutable preview/final render job snapshot from a reviewed draft.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '../db.ts';
import { dataRoot } from '../data-root.ts';
import { getFinalVideoDraft, snapshotDraftForJob } from './draft-store.ts';
import { startFinalVideoQueue } from './render-queue.ts';
import { errorCode, jsonError, stale } from './route-helpers.ts';
import { isPathWithinRoot } from './fs-safety.ts';
import type { FinalVideoJobSnapshot, NarrationBeat } from './types.ts';

function submissionError(message: string, code: 'invalid_input' | 'not_found' = 'invalid_input'): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function jobDirectory(jobId: string): string {
  const storageRoot = path.resolve(dataRoot(), 'storage');
  const directory = path.resolve(storageRoot, 'final-videos', jobId);
  if (!isPathWithinRoot(storageRoot, directory)) throw submissionError('job 工作目录不安全');
  return directory;
}

function copyNarrationIntoJob(snapshot: FinalVideoJobSnapshot, jobId: string): FinalVideoJobSnapshot {
  if (snapshot.narrationBeats.length === 0) return snapshot;

  const draftsRoot = path.resolve(dataRoot(), 'storage', 'final-video-drafts');
  const narrationRoot = path.resolve(draftsRoot, snapshot.draftId, 'narration');
  let realDraftsRoot: string;
  let realNarrationRoot: string;
  try {
    realDraftsRoot = fs.realpathSync(draftsRoot);
    realNarrationRoot = fs.realpathSync(narrationRoot);
  } catch {
    throw submissionError('草稿口播目录不存在');
  }
  if (!isPathWithinRoot(realDraftsRoot, realNarrationRoot)) throw submissionError('草稿口播目录路径不安全');
  const workDir = path.join(jobDirectory(jobId), 'work');
  const narrationDir = path.join(workDir, 'narration');
  fs.mkdirSync(narrationDir, { recursive: true });

  const copied = new Map<string, string>();
  const beats: NarrationBeat[] = snapshot.narrationBeats.map((beat) => {
    let realSource: string;
    try {
      realSource = fs.realpathSync(beat.audioPath);
    } catch {
      throw submissionError(`口播音频不存在：${beat.audioPath}`);
    }
    if (!isPathWithinRoot(realNarrationRoot, realSource)) throw submissionError('草稿口播音频路径不安全');
    if (!fs.statSync(realSource).isFile()) throw submissionError(`口播音频不是文件：${beat.audioPath}`);

    let copiedPath = copied.get(realSource);
    if (!copiedPath) {
      const extension = path.extname(realSource);
      const safeExtension = /^\.[A-Za-z0-9]{1,10}$/.test(extension) ? extension : '.m4a';
      copiedPath = path.join(narrationDir, `group-${copied.size + 1}${safeExtension}`);
      fs.copyFileSync(realSource, copiedPath);
      copied.set(realSource, copiedPath);
    }
    return { ...beat, audioPath: copiedPath };
  });
  return { ...snapshot, narrationBeats: beats };
}

export function submitFinalVideoDraftJob(input: {
  draftId: string;
  expectedRevision: number;
  kind: 'preview' | 'final';
}): string {
  const db = getDb();
  const jobId = randomUUID();
  let createdDirectory = false;
  try {
    db.transaction(() => {
      const draft = getFinalVideoDraft(input.draftId);
      if (!draft) throw submissionError('成片草稿不存在', 'not_found');
      if (draft.revision !== input.expectedRevision) {
        throw Object.assign(new Error('stale_revision'), { code: 'stale_revision' });
      }
      if (draft.stage !== 'review') throw submissionError('只有审核中的成片草稿可以提交渲染');

      const snapshot = snapshotDraftForJob(input.draftId, input.expectedRevision, input.kind);
      if (snapshot.packageConfig.mode === 'bgm-only') {
        if (snapshot.selectedClipIds.length === 0) throw submissionError('纯 BGM 模式请至少选择一条视频素材');
        if (new Set(snapshot.selectedClipIds).size !== snapshot.selectedClipIds.length) throw submissionError('同一视频素材不能重复选择');
        const clipIds = new Set(snapshot.clipPool.map((clip) => clip.clipId));
        if (snapshot.selectedClipIds.some((clipId) => !clipIds.has(clipId))) {
          throw submissionError('已选择的视频素材不存在，请刷新后重新选择');
        }
      }
      createdDirectory = true;
      const copiedSnapshot = copyNarrationIntoJob(snapshot, jobId);
      db.prepare(`INSERT INTO final_video_jobs (
        id, projectId, shotSetId, scriptDraftId, status, packageJson, kind, draftId, draftRevision,
        narrationBeatsJson, clipPoolJson, arrangementJson, issuesJson, selectedClipIdsJson, solverVersion
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          jobId, draft.projectId, draft.shotSetId, draft.scriptDraftId,
          JSON.stringify(copiedSnapshot.packageConfig), copiedSnapshot.kind, copiedSnapshot.draftId, copiedSnapshot.draftRevision,
          JSON.stringify(copiedSnapshot.narrationBeats), JSON.stringify(copiedSnapshot.clipPool),
          JSON.stringify(copiedSnapshot.arrangement), JSON.stringify(copiedSnapshot.issues),
          JSON.stringify(copiedSnapshot.selectedClipIds), copiedSnapshot.solverVersion,
        );
    })();
  } catch (error) {
    if (createdDirectory) fs.rmSync(jobDirectory(jobId), { recursive: true, force: true });
    throw error;
  }

  // Queue startup must follow the durable INSERT; a recovered process can now pick up this job safely.
  startFinalVideoQueue();
  return jobId;
}

/** Shared POST handler for the preview and final submit routes; they differ only in `kind`. */
export function createSubmitHandler(kind: 'preview' | 'final') {
  const failureLabel = kind === 'preview' ? '创建预览任务失败' : '创建正式渲染任务失败';
  return async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError('请求内容必须是 JSON 对象', 400);
    const unknownKeys = Object.keys(body).filter((key) => key !== 'revision');
    if (unknownKeys.length) return jsonError(`不支持的字段：${unknownKeys.join(', ')}`, 400);
    if (!Number.isInteger(body.revision) || (body.revision as number) < 0) return jsonError('revision 必须是非负整数', 400);

    try {
      return NextResponse.json({ jobId: submitFinalVideoDraftJob({ draftId: id, expectedRevision: body.revision as number, kind }) });
    } catch (error) {
      const code = errorCode(error);
      if (code === 'not_found') return jsonError('成片草稿不存在', 404);
      if (code === 'stale_revision') return stale();
      if (code === 'invalid_input') return jsonError(error instanceof Error ? error.message : String(error), 400);
      return jsonError(`${failureLabel}：${error instanceof Error ? error.message : String(error)}`, 500);
    }
  };
}

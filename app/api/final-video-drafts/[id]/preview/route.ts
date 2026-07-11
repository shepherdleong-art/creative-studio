import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { dataRoot } from '@/lib/data-root';
import { getFinalVideoDraft, snapshotDraftForJob } from '@/lib/final-video/draft-store';
import { startFinalVideoQueue } from '@/lib/final-video/render-queue';
import type { FinalVideoJobSnapshot, NarrationBeat } from '@/lib/final-video/types';

type Context = { params: Promise<{ id: string }> };

const jsonError = (error: string, status: number) => NextResponse.json({ error }, { status });
const stale = () => NextResponse.json(
  { error: 'stale_revision', message: '草稿已在别处更新，请刷新后重试' }, { status: 409 },
);

function submissionError(message: string, code: 'invalid_input' | 'not_found' = 'invalid_input'): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function jobDirectory(jobId: string): string {
  const storageRoot = path.resolve(dataRoot(), 'storage');
  const directory = path.resolve(storageRoot, 'final-videos', jobId);
  if (!isWithin(storageRoot, directory)) throw submissionError('job 工作目录不安全');
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
  if (!isWithin(realDraftsRoot, realNarrationRoot)) throw submissionError('草稿口播目录路径不安全');
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
    if (!isWithin(realNarrationRoot, realSource)) throw submissionError('草稿口播音频路径不安全');
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
      createdDirectory = true;
      const copiedSnapshot = copyNarrationIntoJob(snapshot, jobId);
      db.prepare(`INSERT INTO final_video_jobs (
        id, projectId, shotSetId, scriptDraftId, status, packageJson, kind, draftId, draftRevision,
        narrationBeatsJson, clipPoolJson, arrangementJson, issuesJson, solverVersion
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          jobId, draft.projectId, draft.shotSetId, draft.scriptDraftId,
          JSON.stringify(copiedSnapshot.packageConfig), copiedSnapshot.kind, copiedSnapshot.draftId, copiedSnapshot.draftRevision,
          JSON.stringify(copiedSnapshot.narrationBeats), JSON.stringify(copiedSnapshot.clipPool),
          JSON.stringify(copiedSnapshot.arrangement), JSON.stringify(copiedSnapshot.issues), copiedSnapshot.solverVersion,
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

export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError('请求内容必须是 JSON 对象', 400);
  const unknownKeys = Object.keys(body).filter((key) => key !== 'revision');
  if (unknownKeys.length) return jsonError(`不支持的字段：${unknownKeys.join(', ')}`, 400);
  if (!Number.isInteger(body.revision) || (body.revision as number) < 0) return jsonError('revision 必须是非负整数', 400);

  try {
    return NextResponse.json({ jobId: submitFinalVideoDraftJob({ draftId: id, expectedRevision: body.revision as number, kind: 'preview' }) });
  } catch (error) {
    const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
    if (code === 'not_found') return jsonError('成片草稿不存在', 404);
    if (code === 'stale_revision') return stale();
    if (code === 'invalid_input') return jsonError(error instanceof Error ? error.message : String(error), 400);
    return jsonError(`创建预览任务失败：${error instanceof Error ? error.message : String(error)}`, 500);
  }
}

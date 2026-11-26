import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { authorizeManagedFileRead, requireAccessContext, runWithTaskAccessContext } from '../media-core/access-context.ts';
import { FINAL_EDIT_FPS } from '../media-core/render-contract.ts';
import type { CompleteJsonInput } from '../script-providers/index.ts';
import { isExecutionDeferredError } from '../media-core/execution/waiting.ts';
import { PROVIDER_CONTENT_FILTER_HINT } from '../script-providers/error-diagnostics.ts';
import { bodyFrame, filmBodyPictureSegments, filmStoragePath, playableFilmBody, readFilmBody, type FilmBody } from './composition.ts';
import { readFilmAutoCoverRow, reconcileFilmCoverChoice, type FilmAutoCoverFallback } from './cover-auto-state.ts';
import { extractFilmCoverFrame } from './cover-render.ts';
import { OneClickFilmError } from './errors.ts';
import { tryFilmRequestLock } from './request-lock.ts';
import { listReviews, reviewForPlayback, type ReviewShot } from './review.ts';
import { getAnalysis, getEntry, type OneClickFilmRun } from './store.ts';

const MAX_CANDIDATES = 8;
const AUTO_COVER_MODULE = 'one-click-film-cover-auto';

type CoverCandidate = { frame: number; shotId: string };
type CoverVisionRequest = { request: CompleteJsonInput; candidates: CoverCandidate[] };
type CoverOutcome = CoverCandidate | { reason: FilmAutoCoverFallback };

function planFilmCoverCandidates(shots: readonly ReviewShot[], frames: number): CoverCandidate[] {
  const candidates = shots.flatMap(shot => {
    const start = Math.max(0, bodyFrame(shot.startUs));
    const end = Math.min(frames, bodyFrame(shot.endUs));
    return end > start ? [{ frame: Math.min(end - 1, Math.floor((start + end) / 2)), shotId: shot.id }] : [];
  });
  if (candidates.length <= MAX_CANDIDATES) return candidates;
  return Array.from({ length: MAX_CANDIDATES }, (_, index) =>
    candidates[Math.round(index * (candidates.length - 1) / (MAX_CANDIDATES - 1))]!);
}

function readCoverChoice(value: unknown, candidates: readonly CoverCandidate[]): CoverOutcome {
  const choice = value && typeof value === 'object' && !Array.isArray(value) && 'candidate' in value
    ? value.candidate : undefined;
  if (choice === null) return { reason: 'no_panorama' };
  if (typeof choice !== 'number' || !Number.isSafeInteger(choice) || choice < 1 || choice > candidates.length) {
    return { reason: 'invalid_result' };
  }
  return candidates[choice - 1]!;
}

function coverVisionFailure(error: unknown): CoverOutcome {
  const message = error instanceof Error ? error.message : '';
  if ((error instanceof Error && error.cause === 'http_451') || /HTTP 451\b/.test(message) || message.includes(PROVIDER_CONTENT_FILTER_HINT)) {
    return { reason: 'content_filtered' };
  }
  if (/无效 JSON|invalid_json/.test(message)) return { reason: 'invalid_result' };
  if (/超时|timed out|timeout/i.test(message)) return { reason: 'timeout' };
  return { reason: 'request_failed' };
}

async function prepareVisionRequest(
  db: Database.Database, run: OneClickFilmRun, body: FilmBody, attempt: number,
): Promise<CoverVisionRequest | CoverOutcome> {
  const { pickVisionProvider } = await import('./analysis.ts');
  let provider: ReturnType<typeof pickVisionProvider>;
  try { provider = pickVisionProvider(); }
  catch { return { reason: 'no_provider' }; }
  const review = listReviews(db, run).find(item => item.jobId === body.jobId);
  if (!review) return { reason: 'media_unavailable' };
  const playback = reviewForPlayback(review, Math.round(body.frames * 1e6 / FINAL_EDIT_FPS));
  const candidates = planFilmCoverCandidates(playback.shots, body.frames);
  if (!candidates.length) return { reason: 'media_unavailable' };
  const entry = getEntry(db, run.id, body.entryCode);
  const related = getAnalysis(db, body.snapshot.analysisId ?? entry.analysisId);
  const analysis = related?.projectId === run.projectId ? related : null;
  const prompt = {
    task: 'select_product_panorama_cover_frame',
    entryCode: entry.code,
    productName: body.snapshot.productName ?? entry.productNameSnapshot,
    appearance: analysis?.appearance.slice(0, 600) ?? '',
    sceneClues: analysis?.sceneClues.slice(0, 600) ?? '',
    candidates: candidates.map((item, index) => ({ number: index + 1, shotId: item.shotId, frame: item.frame })),
    requirements: ['按图片顺序匹配候选编号，选择产品主体最完整、清晰、遮挡最少的一张',
      '排除转场、明显运动模糊以及只展示局部或裁掉主体的画面；没有适合的全景时返回 null'],
    output: { candidate: '候选编号（从 1 开始的整数）或 null' },
  };
  try {
    const { segments } = filmBodyPictureSegments(body);
    const inputs = new Set(segments.map(segment => segment.file));
    for (const file of inputs) authorizeManagedFileRead(file);
    const directory = filmStoragePath(path.join('one-click-film', 'previews', run.id));
    await fs.mkdir(directory, { recursive: true });
    const work = await fs.mkdtemp(path.join(directory, 'cover-vision-'));
    try {
      const images: NonNullable<CompleteJsonInput['images']> = [];
      for (const candidate of candidates) {
        let offset = candidate.frame;
        const segment = segments.find(item => {
          if (offset < item.count) return true;
          offset -= item.count;
          return false;
        });
        if (!segment) return { reason: 'media_unavailable' };
        const file = path.join(work, `${images.length}.jpg`);
        await extractFilmCoverFrame(segment.file, segment.start + offset, file, true);
        images.push({ mimeType: 'image/jpeg', imageBase64: (await fs.readFile(file)).toString('base64') });
      }
      const taskId = `one-click-film-cover-${body.entryId}`;
      return { candidates, request: {
        providerId: provider.id, model: provider.model,
        systemPrompt: '你是电商短视频封面选帧编辑。只返回一个 JSON 对象，包含 candidate 字段。',
        userPrompt: JSON.stringify(prompt), images, maxTokens: 256, timeoutMs: 12_000,
        usageContext: { enabled: true, projectId: run.projectId, refType: 'one-click-film-auto-cover',
          refId: body.entryId },
        executionContext: { taskId, step: 'select-cover-frame', inputRevision: `${body.signature}:a${attempt}`,
          businessAttempt: { id: `${body.signature}:${attempt}`, number: attempt },
          scope: { resourceType: 'project', resourceId: run.projectId } },
      } };
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  } catch {
    return { reason: 'media_unavailable' };
  }
}

async function publishCover(db: Database.Database, run: OneClickFilmRun, body: FilmBody) {
  const lease = await tryFilmRequestLock('cover-draft', [body.entryId]);
  if (!lease) return;
  try {
    db.transaction(() => {
      if (readFilmBody(db, run, body.entryCode)?.signature === body.signature) reconcileFilmCoverChoice(db, body);
    }).immediate();
  } finally { lease.release(); }
}

/** A cross-process lease protects extraction and submission. Terminal rows are retried only by an explicit command. */
export async function syncFilmAutoCover(db: Database.Database, run: OneClickFilmRun, saved: FilmBody): Promise<void> {
  const lease = await tryFilmRequestLock('cover-auto', [saved.entryId, saved.signature]);
  if (!lease) return;
  const identity = [saved.entryId, saved.signature] as const;
  try {
    if (readFilmBody(db, run, saved.entryCode)?.signature !== saved.signature) return;
    db.prepare(`INSERT OR IGNORE INTO one_click_film_auto_covers(entryId, sourceSignature, state, principalTaskId)
      VALUES (?, ?, 'queued', ?)`).run(...identity, saved.originalVideoJobId);
    const row = readFilmAutoCoverRow(db, saved)!;
    const body = await playableFilmBody(saved).catch(() => saved);
    await publishCover(db, run, body);
    if (row.state === 'ready' || row.state === 'fallback') return;
    const settle = (outcome: CoverOutcome) => {
      const selected = 'frame' in outcome;
      db.prepare(`UPDATE one_click_film_auto_covers SET state=?, frame=?, shotId=?, reason=?, requestJson=NULL
        WHERE entryId=? AND sourceSignature=? AND attempt=?`).run(
        selected ? 'ready' : 'fallback', selected ? outcome.frame : null, selected ? outcome.shotId : null,
        selected ? null : outcome.reason, ...identity, row.attempt);
    };
    try {
      // Local adapters lack a durable execution checkpoint after a process exit.
      if (row.state === 'started' && requireAccessContext().kind === 'local') {
        settle({ reason: 'request_failed' });
      } else {
        await runWithTaskAccessContext(db, row.principalModule, row.principalTaskId, async () => {
          requireAccessContext().assertAccess('project', run.projectId, 'read');
          const prepared: CoverVisionRequest | CoverOutcome = row.requestJson
            ? JSON.parse(row.requestJson) as CoverVisionRequest : await prepareVisionRequest(db, run, body, row.attempt);
          if (!('request' in prepared)) { settle(prepared); return; }
          if (readFilmBody(db, run, body.entryCode)?.signature !== body.signature) return;
          db.prepare(`UPDATE one_click_film_auto_covers SET state='started', requestJson=?
            WHERE entryId=? AND sourceSignature=? AND attempt=?`).run(JSON.stringify(prepared), ...identity, row.attempt);
          const { completeJson } = await import('../script-providers/index.ts');
          const response = await completeJson<unknown>(prepared.request);
          settle(readCoverChoice(response, prepared.candidates));
        });
      }
    } catch (error) {
      if (isExecutionDeferredError(error)) {
        db.prepare(`UPDATE one_click_film_auto_covers SET state='waiting'
          WHERE entryId=? AND sourceSignature=? AND attempt=?`).run(...identity, row.attempt);
      } else {
        settle(coverVisionFailure(error));
      }
    }
    await publishCover(db, run, body);
  } finally { lease.release(); }
}

export function retryFilmAutoCover(db: Database.Database, run: OneClickFilmRun, code: string, signature: unknown, attempt: unknown) {
  const body = readFilmBody(db, run, code);
  if (!body) throw new OneClickFilmError('not_found', '还没有生成原片', 404);
  if (body.signature !== signature) throw new OneClickFilmError('conflict', '成片已更新，请重新打开后挑选封面', 409);
  if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new OneClickFilmError('invalid_input', '缺少有效的自动挑帧版本');
  }
  const access = requireAccessContext();
  db.transaction(() => {
    access.assertAccess('project', run.projectId, 'write');
    const taskId = randomUUID();
    const updated = db.prepare(`UPDATE one_click_film_auto_covers
      SET state='queued', attempt=attempt+1, frame=NULL, shotId=NULL, reason=NULL, requestJson=NULL, principalModule=?, principalTaskId=?
      WHERE entryId=? AND sourceSignature=? AND attempt=? AND state IN ('ready','fallback')`)
      .run(AUTO_COVER_MODULE, taskId, body.entryId, body.signature, attempt);
    if (!updated.changes) return;
    access.registerTaskPrincipal({
      module: AUTO_COVER_MODULE, taskId, scope: { resourceType: 'project', resourceId: run.projectId },
      creationSnapshot: { entryId: body.entryId, sourceSignature: body.signature, attempt: attempt + 1 },
    });
  }).immediate();
  return body;
}

const queued = new Map<string, () => Promise<void>>();
const active = new Set<string>();

function pumpCoverQueue() {
  while (active.size < 2 && queued.size) {
    const [key, work] = queued.entries().next().value!;
    queued.delete(key);
    active.add(key);
    void work().catch(() => console.warn('[OneClickFilm] 自动挑帧未能同步')).finally(() => {
      active.delete(key);
      pumpCoverQueue();
    });
  }
}

export function scheduleFilmAutoCover(db: Database.Database, run: OneClickFilmRun, body: FilmBody) {
  const key = `${body.entryId}/${body.signature}`;
  if (active.has(key) || queued.has(key)) return;
  queued.set(key, () => syncFilmAutoCover(db, run, body));
  pumpCoverQueue();
}

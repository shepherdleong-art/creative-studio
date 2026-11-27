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

function evenlySpaced<T>(choices: T[], limit: number): T[] {
  if (limit <= 0) return [];
  if (choices.length <= limit) return choices;
  if (limit === 1) return [choices[Math.floor((choices.length - 1) / 2)]!];
  return Array.from({ length: limit }, (_, index) =>
    choices[Math.round(index * (choices.length - 1) / (limit - 1))]!);
}

function planFilmCoverCandidates(shots: readonly ReviewShot[], frames: number): CoverCandidate[] {
  const middle: CoverCandidate[] = [];
  const later: CoverCandidate[] = [];
  for (const shot of shots) {
    const start = Math.max(0, bodyFrame(shot.startUs));
    const end = Math.min(frames, bodyFrame(shot.endUs));
    if (end <= start) continue;
    const frame = Math.floor((start + end) / 2);
    middle.push({ frame, shotId: shot.id });
    const laterFrame = Math.min(end - 2, start + Math.floor((end - start) * 2 / 3));
    if (laterFrame > frame) later.push({ frame: laterFrame, shotId: shot.id });
  }
  const primary = evenlySpaced(middle, MAX_CANDIDATES);
  return [...primary, ...evenlySpaced(later, MAX_CANDIDATES - primary.length)];
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
  db: Database.Database, run: OneClickFilmRun, body: FilmBody, attempt: number, signal: AbortSignal,
): Promise<CoverVisionRequest | CoverOutcome> {
  const { pickVisionProvider } = await import('./analysis.ts');
  signal.throwIfAborted();
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
        signal.throwIfAborted();
        let offset = candidate.frame;
        const segment = segments.find(item => {
          if (offset < item.count) return true;
          offset -= item.count;
          return false;
        });
        if (!segment) return { reason: 'media_unavailable' };
        const file = path.join(work, `${images.length}.jpg`);
        await extractFilmCoverFrame(segment.file, segment.start + offset, file, true, signal);
        images.push({ mimeType: 'image/jpeg', imageBase64: (await fs.readFile(file, { signal })).toString('base64') });
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
    signal.throwIfAborted();
    return { reason: 'media_unavailable' };
  }
}

async function publishCover(db: Database.Database, run: OneClickFilmRun, body: FilmBody, signal: AbortSignal) {
  const lease = await tryFilmRequestLock('cover-draft', [body.entryId]);
  if (!lease) return;
  try {
    if (signal.aborted || !db.open) return;
    db.transaction(() => {
      const current = readFilmBody(db, run, body.entryCode);
      if (current?.signature === body.signature && current.coverCutsSignature === body.coverCutsSignature) reconcileFilmCoverChoice(db, body);
    }).immediate();
  } finally { lease.release(); }
}

/** A cross-process lease protects extraction and submission. Terminal rows are retried only by an explicit command. */
export async function syncFilmAutoCover(db: Database.Database, run: OneClickFilmRun, saved: FilmBody): Promise<void> {
  const signal = queue.controller.signal;
  if (signal.aborted) return;
  const lease = await tryFilmRequestLock('cover-auto', [saved.entryId, saved.signature]);
  if (!lease) return;
  const identity = [saved.entryId, saved.signature] as const;
  try {
    if (signal.aborted || !db.open) return;
    const current = readFilmBody(db, run, saved.entryCode);
    if (current?.signature !== saved.signature || current.coverCutsSignature !== saved.coverCutsSignature) return;
    const cuts = current.coverCutsSignature ?? '';
    db.transaction(() => {
      // Adopt pre-upgrade results without charging again. Subsequent cut changes get a fresh attempt.
      db.prepare(`UPDATE one_click_film_auto_covers SET cutsSignature=?
        WHERE entryId=? AND sourceSignature=? AND cutsSignature IS NULL`).run(cuts, ...identity);
      const superseded = db.prepare(`SELECT attempt FROM one_click_film_auto_covers
        WHERE entryId=? AND sourceSignature=? AND cutsSignature<>? AND state IN ('waiting','started')`)
        .pluck().get(...identity, cuts);
      if (superseded && requireAccessContext().kind !== 'local') {
        db.prepare(`UPDATE execution_operations SET status='failed', updatedAt=?
          WHERE module='llm' AND taskId=? AND step='select-cover-frame' AND inputRevision=?
            AND status IN ('pending','deferred') AND currentPermitId IS NULL`)
          .run(new Date().toISOString(), `one-click-film-cover-${saved.entryId}`, `${saved.signature}:a${superseded}`);
      }
      db.prepare(`INSERT INTO one_click_film_auto_covers(entryId, sourceSignature, state, principalTaskId, cutsSignature)
        VALUES (?, ?, 'queued', ?, ?) ON CONFLICT(entryId,sourceSignature) DO UPDATE SET
        state='queued', attempt=attempt+1, requestJson=NULL, frame=NULL, shotId=NULL, reason=NULL,
        principalModule='video', principalTaskId=excluded.principalTaskId, cutsSignature=excluded.cutsSignature
        WHERE cutsSignature<>excluded.cutsSignature`).run(...identity, saved.originalVideoJobId, cuts);
    }).immediate();
    const row = readFilmAutoCoverRow(db, saved)!;
    const body = await playableFilmBody(saved, signal).catch(() => saved);
    await publishCover(db, run, body, signal);
    if (signal.aborted || !db.open || row.state === 'ready' || row.state === 'fallback') return;
    const settle = (outcome: CoverOutcome) => {
      if (signal.aborted || !db.open) return;
      const selected = 'frame' in outcome;
      const updated = db.prepare(`UPDATE one_click_film_auto_covers SET state=?, frame=?, shotId=?, reason=?, requestJson=NULL
        WHERE entryId=? AND sourceSignature=? AND attempt=?`).run(
        selected ? 'ready' : 'fallback', selected ? outcome.frame : null, selected ? outcome.shotId : null,
        selected ? null : outcome.reason, ...identity, row.attempt);
      if (updated.changes && !selected && outcome.reason !== 'no_panorama') {
        console.warn('[OneClickFilm] 自动封面回退', outcome.reason);
      }
    };
    try {
      // Local adapters lack a durable execution checkpoint after a process exit.
      if (row.state === 'started' && requireAccessContext().kind === 'local') {
        settle({ reason: 'request_failed' });
      } else {
        await runWithTaskAccessContext(db, row.principalModule, row.principalTaskId, async () => {
          requireAccessContext().assertAccess('project', run.projectId, 'read');
          const prepared: CoverVisionRequest | CoverOutcome = row.requestJson
            ? JSON.parse(row.requestJson) as CoverVisionRequest : await prepareVisionRequest(db, run, body, row.attempt, signal);
          if (signal.aborted || !db.open) return;
          if (!('request' in prepared)) { settle(prepared); return; }
          const latestBody = readFilmBody(db, run, body.entryCode);
          if (latestBody?.signature !== body.signature || latestBody.coverCutsSignature !== cuts) return;
          db.prepare(`UPDATE one_click_film_auto_covers SET state='started', requestJson=?
            WHERE entryId=? AND sourceSignature=? AND attempt=?`).run(JSON.stringify(prepared), ...identity, row.attempt);
          const { completeJson } = await import('../script-providers/index.ts');
          const response = await completeJson<unknown>({ ...prepared.request, signal });
          settle(readCoverChoice(response, prepared.candidates));
        });
      }
    } catch (error) {
      if (signal.aborted || !db.open) return;
      if (isExecutionDeferredError(error)) {
        db.transaction(() => {
          // Admission may just have updated the reason. Close only this unsent
          // request, using the current ledger state under the same write lock.
          const { operationId } = error as { operationId: string };
          const denied = db.prepare(`UPDATE execution_operations SET status='failed', updatedAt=?
            WHERE id=? AND module='llm' AND status='deferred' AND currentPermitId IS NULL
              AND waitReason IN ('model_forbidden','monthly_budget','actor_disabled','scope_forbidden',
                'actor_paused','cost_unknown','pricing_required','pool_missing','pool_disabled','currency_mismatch')
            RETURNING waitReason`).pluck().get(new Date().toISOString(), operationId);
          if (denied) {
            settle({ reason: denied === 'model_forbidden' || denied === 'monthly_budget' ? denied : 'policy_denied' });
          } else {
            db.prepare(`UPDATE one_click_film_auto_covers SET state='waiting'
              WHERE entryId=? AND sourceSignature=? AND attempt=?`).run(...identity, row.attempt);
          }
        }).immediate();
      } else {
        settle(coverVisionFailure(error));
      }
    }
    await publishCover(db, run, body, signal);
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

type AutoCoverQueue = {
  controller: AbortController;
  queued: Map<string, () => Promise<void>>;
  active: Map<string, Promise<void>>;
};
const globals = globalThis as Record<PropertyKey, unknown>;
const QUEUE_KEY = Symbol.for('creative-studio.one-click-film-auto-cover-queue');
const queue = (globals[QUEUE_KEY] ??= { controller: new AbortController(), queued: new Map(), active: new Map() }) as AutoCoverQueue;

function pumpCoverQueue() {
  while (!queue.controller.signal.aborted && queue.active.size < 2 && queue.queued.size) {
    const [key, work] = queue.queued.entries().next().value!;
    queue.queued.delete(key);
    const pending = work().catch(() => {
      if (!queue.controller.signal.aborted) console.warn('[OneClickFilm] 自动封面回退', 'request_failed');
    }).finally(() => {
      queue.active.delete(key);
      pumpCoverQueue();
    });
    queue.active.set(key, pending);
  }
}

export function scheduleFilmAutoCover(db: Database.Database, run: OneClickFilmRun, body: FilmBody) {
  const key = `${body.entryId}/${body.signature}`;
  if (queue.controller.signal.aborted || queue.active.has(key) || queue.queued.has(key)) return;
  queue.queued.set(key, () => syncFilmAutoCover(db, run, body));
  pumpCoverQueue();
}

export async function stopFilmAutoCover() {
  queue.controller.abort();
  queue.queued.clear();
  await Promise.allSettled(queue.active.values());
}

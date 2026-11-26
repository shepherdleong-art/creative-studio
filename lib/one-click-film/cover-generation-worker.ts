import fs from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import sharp from 'sharp';
import { sha256Canonical } from '../canonical-json.ts';
import { preferReadableCosOrigin, tryUploadBufferToCosAndSign } from '../cos-media.ts';
import { getDb } from '../db.ts';
import { normalizeGeneratedImageToNativeRatio } from '../image-output-normalize.ts';
import { registerManagedFile, requireAccessContext, runWithTaskAccessContext } from '../media-core/access-context.ts';
import { ExecutionError, type AdmissionWaitReason, type AttemptRecord, type ExecutionReceipt, type Money } from '../media-core/execution/context.ts';
import type { ExecutionModuleLifecycle } from '../media-core/execution/contracts.ts';
import { ensureMediaProviderPool } from '../media-core/execution/media-provider-pool.ts';
import { getExecutionModuleRuntime } from '../media-core/execution/module-runtime.ts';
import { readAttempt, readOperation } from '../media-core/execution/records.ts';
import { ProviderRequestError } from '../media-core/submission-evidence.ts';
import { downloadGatewayTaskImage, readGatewayTaskImage, submitCosGatewayImage } from '../providers/gateway-task-image.ts';
import { recordUsage } from '../usage-ledger.ts';
import { calculateUsageCostMicros, type CoreUsageSnapshotV1 } from '../usage-pricing.ts';
import { filmStoragePath } from './composition.ts';
import type { CoverReference, FilmCoverAsset } from './cover-assets.ts';
import { FILM_COVER_GENERATION_MODULE, filmCoverGenerationConfig, filmCoverProviderFingerprint, filmCoverReferenceHash, findFilmCoverProvider } from './cover-generation.ts';
import { resolveProjectCoverImagePath } from './cover-source.ts';
import { tryFilmRequestLock } from './request-lock.ts';
import { getOneClickFilmReadiness } from './runtime-readiness.ts';

type CoverProvider = NonNullable<ReturnType<typeof findFilmCoverProvider>>;
const POLL_INTERVAL = 3_000;
const REVIEW_INTERVAL = 30_000;

const messages: Record<string, string> = {
  waiting: '等待云端并发名额，空出后自动生成。',
  generating: '全景封面生成中，可继续编辑这条成片。',
  monthly_budget: '全景封面生成费用超出本月额度。',
  model_forbidden: '当前账号没有所选模型的使用权限。',
  actor_disabled: '当前账号已停用。',
  scope_forbidden: '当前账号没有此项目的生成权限。',
  actor_paused: '当前账号的付费生成已暂停。',
  cost_unknown: '还有费用待核对，请联系管理员处理。',
  pool_missing: '公司图像通道的共享资源池尚未配置，请联系管理员。',
  pool_mapping_mismatch: '公司图像通道的共享资源池尚未配置，请联系管理员。',
  pool_disabled: '公司图像通道的共享资源池已停用，请联系管理员。',
  policy: '全景封面生成被供应商内容策略拦截，请调整构图偏好或参考图。',
  rejected: '供应商拒绝了全景封面生成请求。',
  remote_failed: '供应商未能生成全景封面，请检查参考图或稍后再试。',
  submission_unknown: '提交结果待核对，请勿重复提交。',
  polling: '全景封面已提交，正在确认供应商结果。',
  delivery: '全景封面已生成，但暂时无法保存图片。',
  reference: '参考图已变更或无法通过 COS 交付，未提交生成。',
  unavailable: '所选 GPT Image 2.6 通道当前不可用。',
  provider_changed: '通道配置已变更。恢复提交时的配置后将继续查询。',
  internal: '全景封面暂时无法生成。',
};

function updateAsset(db: Database.Database, id: string, status: FilmCoverAsset['status'], reason: string, delay?: number) {
  db.prepare(`UPDATE one_click_film_cover_assets SET status=?, errorCode=?, message=?, nextAttemptAt=?, updatedAt=? WHERE id=?`)
    .run(status, status === 'failed' || reason === 'submission_unknown' ? reason : null, messages[reason] ?? messages.internal,
      delay === undefined ? null : new Date(Date.now() + delay).toISOString(), new Date().toISOString(), id);
}

function failOperation(db: Database.Database, operationId: string, code: string) {
  db.prepare(`UPDATE execution_operations SET status='failed', waitReason=?, waitDetail=NULL, updatedAt=?
    WHERE id=? AND status IN ('pending','deferred')`).run(code, new Date().toISOString(), operationId);
}

function lastCoverRejection(db: Database.Database, operationId: string): string | undefined {
  // A confirmed non-creation releases the permit and clears currentAttemptId. Keep
  // an explicit rejection terminal for this candidate even if the worker crashed before writeback.
  return db.prepare(`SELECT errorCode FROM execution_attempts WHERE operationId=? AND terminalState='not_created'
    ORDER BY transportSeq DESC LIMIT 1`).pluck().get(operationId) as string | undefined;
}

async function deliverReferences(db: Database.Database, asset: FilmCoverAsset, signal: AbortSignal): Promise<string[]> {
  const references = JSON.parse(asset.referenceImagesJson) as CoverReference[];
  const urls: string[] = [];
  for (const reference of references) {
    signal.throwIfAborted();
    const file = resolveProjectCoverImagePath(db, asset.projectId, reference.id);
    const bytes = await fs.readFile(file, { signal });
    if (filmCoverReferenceHash(bytes) !== reference.sha256) throw new Error('reference_changed');
    const { format } = await sharp(bytes).metadata();
    const mimeType = format === 'jpeg' || format === 'png' || format === 'webp' ? `image/${format}` : undefined;
    if (!mimeType) throw new Error('reference_format');
    const signedUrl = await tryUploadBufferToCosAndSign(bytes, mimeType);
    if (!signedUrl?.startsWith('https://')) throw new Error('cos_unavailable');
    urls.push(asset.model.endsWith('-sunburst') ? await preferReadableCosOrigin(signedUrl, signal) : signedUrl);
  }
  return urls;
}

function resultPath(asset: FilmCoverAsset) {
  return path.posix.join('one-click-film', 'covers', asset.runId, `${asset.id}.png`);
}

async function saveImage(asset: FilmCoverAsset, url: string, provider: CoverProvider, signal: AbortSignal) {
  signal.throwIfAborted();
  const download = await downloadGatewayTaskImage(url, provider.baseUrl, provider.apiKey, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
  if (!download.ok) throw new Error('cover_download');
  signal.throwIfAborted();
  const jpegOrPng = sharp(download.buffer, { limitInputPixels: 64_000_000 });
  const { format } = await jpegOrPng.metadata();
  if (format !== 'png' && format !== 'jpeg' && format !== 'webp') throw new Error('cover_image_format');
  const png = await jpegOrPng.autoOrient().png().toBuffer();
  const normalized = await normalizeGeneratedImageToNativeRatio(png, asset.requestedSize);
  const file = filmStoragePath(resultPath(asset));
  await fs.mkdir(path.dirname(file), { recursive: true });
  const pending = `${file}.part`;
  try {
    await fs.writeFile(pending, normalized.imageBuffer);
    await fs.rename(pending, file);
  } finally {
    await fs.rm(pending, { force: true });
  }
}

async function publishImage(db: Database.Database, asset: FilmCoverAsset) {
  const relative = resultPath(asset);
  const file = filmStoragePath(relative);
  const { width, height } = await sharp(file).metadata();
  if (!width || !height) throw new Error('cover_dimensions');
  db.transaction(() => {
    registerManagedFile({ absolutePath: file, mimeType: 'image/png',
      references: [{ resourceType: 'project', resourceId: asset.projectId, role: 'derivative' }] });
    db.prepare(`UPDATE one_click_film_cover_assets SET status='ready', relativePath=?, width=?, height=?,
      errorCode=NULL, message=NULL, nextAttemptAt=NULL, updatedAt=? WHERE id=?`).run(relative, width, height, new Date().toISOString(), asset.id);
  }).immediate();
}

function recordImageUsage(db: Database.Database, asset: FilmCoverAsset, snapshot: CoreUsageSnapshotV1, attempt?: AttemptRecord) {
  const result = recordUsage(db, {
    eventKey: attempt ? `execution-attempt:${attempt.id}:submitted` : `${FILM_COVER_GENERATION_MODULE}:${asset.id}`,
    snapshot, usage: { quantity: 1, callCount: 1, detail: { source: 'live', taskType: FILM_COVER_GENERATION_MODULE } },
    projectId: asset.projectId, refType: FILM_COVER_GENERATION_MODULE, refId: asset.id, executionAttemptId: attempt?.id,
  });
  if (!result.ok) throw new Error('cover_usage_write');
}

function isConcurrencyWait(reasons: AdmissionWaitReason[]) {
  return reasons.length === 0 || reasons.every(reason =>
    ['pool_capacity', 'personal_concurrency', 'fair_share', 'maintenance'].includes(reason));
}

async function generateCover(db: Database.Database, initial: FilmCoverAsset, signal: AbortSignal) {
  const access = requireAccessContext();
  const runtime = access.kind === 'team' ? getExecutionModuleRuntime() : null;
  if (access.kind === 'team' && !runtime) return;
  const asset = initial;
  const snapshot = JSON.parse(asset.usageSnapshotJson ?? 'null') as CoreUsageSnapshotV1 | null;
  if (!snapshot) return updateAsset(db, asset.id, 'failed', 'internal');
  const cost: Money = { currency: 'CNY', minor: Math.ceil(calculateUsageCostMicros(snapshot.priceComponents, 1) / 10_000) };
  const operationKey = `${FILM_COVER_GENERATION_MODULE}/${asset.id}/generate`;
  const operationId = runtime && (asset.operationId ?? db.prepare(`SELECT id FROM execution_operations WHERE actorId=? AND operationKey=?`)
    .pluck().get(access.actor.userId, operationKey) as string | undefined);
  const operation = operationId ? readOperation(db, operationId) : undefined;
  const attempt = operation?.currentAttemptId ? readAttempt(db, operation.currentAttemptId) : undefined;
  if (attempt?.terminalState === 'failed' || attempt?.terminalState === 'not_created') {
    const reason = attempt.errorCode ?? 'remote_failed';
    if (attempt.terminalState === 'not_created' && attempt.costState !== 'released') {
      await runtime?.facade.settle({ attemptId: attempt.id, outcome: 'not_created', remoteTerminal: true, errorCode: reason });
    }
    if (operation) failOperation(db, operation.id, reason);
    return updateAsset(db, asset.id, 'failed', reason);
  }
  const previousRejection = operation && !attempt ? lastCoverRejection(db, operation.id) : undefined;
  if (operation && previousRejection) {
    failOperation(db, operation.id, previousRejection);
    return updateAsset(db, asset.id, 'failed', previousRejection);
  }
  const remoteId = attempt?.remoteId ?? asset.remoteId;
  const sent = Boolean(remoteId || asset.submittedAt || attempt?.submissionState === 'maybe_sent' || attempt?.terminalState === 'succeeded');
  const provider = findFilmCoverProvider(db, asset.providerId, sent);
  if (!provider || filmCoverProviderFingerprint(provider) !== asset.providerFingerprint) {
    if (sent) return updateAsset(db, asset.id, 'running', 'provider_changed', REVIEW_INTERVAL);
    if (operation) failOperation(db, operation.id, 'unavailable');
    return updateAsset(db, asset.id, 'failed', 'unavailable');
  }
  if (remoteId || attempt?.terminalState === 'succeeded') {
    return pollCover(db, asset, provider, remoteId, attempt, snapshot, cost, signal);
  }
  if (sent) {
    if (!runtime && await fs.stat(filmStoragePath(resultPath(asset))).then(stat => stat.isFile(), () => false)) {
      return pollCover(db, asset, provider, null, undefined, snapshot, cost, signal);
    }
    // A durable execution receipt can arrive later via journal recovery or administrator reconciliation.
    return updateAsset(db, asset.id, runtime ? 'running' : 'failed', 'submission_unknown', runtime ? REVIEW_INTERVAL : undefined);
  }
  const config = await filmCoverGenerationConfig(db);
  if (!config.channels.some(channel => channel.id === provider.id)) {
    if (operation) failOperation(db, operation.id, 'unavailable');
    return updateAsset(db, asset.id, 'failed', 'unavailable');
  }
  const requestSnapshot = { providerId: asset.providerId, model: asset.model, prompt: asset.prompt, size: asset.requestedSize,
    references: JSON.parse(asset.referenceImagesJson) as CoverReference[] };
  let grant;
  if (runtime) {
    const providerSnapshot = { providerId: provider.id, type: provider.type, model: provider.model, requestModel: provider.model, baseUrl: provider.baseUrl };
    const current = operation ?? runtime.facade.enqueue({
      operationKey, actor: { userId: access.actor.userId }, scope: { resourceType: 'project', resourceId: asset.projectId },
      module: FILM_COVER_GENERATION_MODULE, taskId: asset.id, step: 'generate', inputRevision: '1',
      businessAttempt: { id: asset.id, number: 1 }, inputSnapshot: requestSnapshot, inputHash: sha256Canonical(requestSnapshot),
      continuationKey: `${FILM_COVER_GENERATION_MODULE}.generate`, providerSnapshot, configVersion: sha256Canonical(providerSnapshot),
      credentialVersionRef: asset.providerFingerprint, requiredPools: [ensureMediaProviderPool(db, provider.baseUrl, provider.apiKey)],
      quote: { kind: 'priced', reserve: cost, pricingSnapshot: snapshot },
    }).operation;
    db.prepare(`UPDATE one_click_film_cover_assets SET operationId=? WHERE id=?`).run(current.id, asset.id);
    if (current.status === 'failed') return updateAsset(db, asset.id, 'failed', current.waitReason ?? 'internal');
    const admission = runtime.facade.admit({ instanceId: runtime.instanceId, fence: runtime.fence, operationId: current.id });
    if (admission.kind !== 'admitted') {
      if (admission.kind === 'idle' || isConcurrencyWait(admission.reasons)) {
        return updateAsset(db, asset.id, 'queued', 'waiting', POLL_INTERVAL);
      }
      const reason = admission.reasons.find(reason => reason in messages) ?? 'internal';
      failOperation(db, current.id, reason);
      return updateAsset(db, asset.id, 'failed', reason);
    }
    grant = admission.grant;
  }
  let imageUrls: string[];
  try {
    imageUrls = await deliverReferences(db, asset, signal);
    signal.throwIfAborted();
  } catch {
    if (signal.aborted) return;
    if (runtime && grant) {
      await runtime.facade.settle({ attemptId: grant.attempt.id, outcome: 'not_created', remoteTerminal: true, errorCode: 'reference' });
      failOperation(db, grant.operation.id, 'reference');
    }
    return updateAsset(db, asset.id, 'failed', 'reference');
  }
  updateAsset(db, asset.id, 'running', 'generating', POLL_INTERVAL);
  const send = async (): Promise<ExecutionReceipt> => {
    try {
      const result = await submitCosGatewayImage({ model: asset.model, size: asset.requestedSize, prompt: asset.prompt, imageUrls }, provider.apiKey, provider.baseUrl, signal);
      const remoteId = result.taskId && /^[\w.:-]{1,512}$/.test(result.taskId) ? result.taskId : undefined;
      if (result.immediateImageUrl) {
        try { await saveImage(asset, result.immediateImageUrl, provider, signal); }
        catch { /* The provider generated a billable image even when local delivery failed. */ }
        return { remoteId, terminalState: 'succeeded', actualCost: cost };
      }
      if (remoteId) return { remoteId };
      throw new Error('missing_cover_receipt');
    } catch (error) {
      if (error instanceof ProviderRequestError && !error.ambiguous) {
        return { terminalState: 'not_created', errorCode: error.httpStatus === 451 ? 'policy' : 'rejected' };
      }
      // Keep the original provider message and signed URLs out of the journal and logs.
      throw new Error('cover_transport_unknown');
    }
  };
  let receipt: ExecutionReceipt;
  let executionAttempt;
  if (runtime && grant) {
    let intent;
    try { intent = await runtime.facade.markSubmitting({ grant, requestSnapshot }); }
    catch (error) {
      if (readAttempt(db, grant.attempt.id).submissionState === 'not_sent') {
        const code = error instanceof ExecutionError ? error.code : 'internal';
        await runtime.facade.settle({ attemptId: grant.attempt.id, outcome: 'not_created', remoteTerminal: true, errorCode: code });
      }
      throw error;
    }
    executionAttempt = await runtime.facade.transmit(intent, send);
    receipt = { remoteId: executionAttempt.remoteId ?? undefined, terminalState: executionAttempt.terminalState ?? undefined,
      errorCode: executionAttempt.errorCode ?? undefined };
  } else {
    db.prepare(`UPDATE one_click_film_cover_assets SET submittedAt=? WHERE id=?`).run(new Date().toISOString(), asset.id);
    receipt = await send();
  }
  if (receipt.terminalState === 'not_created') {
    if (runtime && executionAttempt) {
      await runtime.facade.settle({ attemptId: executionAttempt.id, outcome: 'not_created', remoteTerminal: true, errorCode: receipt.errorCode });
      failOperation(db, executionAttempt.operationId, receipt.errorCode ?? 'rejected');
    }
    return updateAsset(db, asset.id, 'failed', receipt.errorCode ?? 'rejected');
  }
  if (receipt.remoteId) {
    db.prepare(`UPDATE one_click_film_cover_assets SET remoteId=?, submittedAt=? WHERE id=?`).run(receipt.remoteId, new Date().toISOString(), asset.id);
    if (receipt.terminalState !== 'succeeded') return;
  }
  await pollCover(db, asset, provider, receipt.remoteId ?? null, executionAttempt, snapshot, cost, signal);
}

async function pollCover(db: Database.Database, asset: FilmCoverAsset, provider: CoverProvider, remoteId: string | null,
  attempt: AttemptRecord | undefined, snapshot: CoreUsageSnapshotV1, cost: Money, signal: AbortSignal) {
  const facade = getExecutionModuleRuntime()?.facade;
  let imageUrl: string | undefined;
  const hasImage = await fs.stat(filmStoragePath(resultPath(asset))).then(stat => stat.isFile(), () => false);
  if (attempt?.terminalState === 'succeeded' && attempt.costState !== 'settled') {
    await facade?.settle({ attemptId: attempt.id, outcome: 'succeeded', actualCost: cost, remoteTerminal: true, result: { coverAssetId: asset.id } });
  }
  if (remoteId && !hasImage) {
    if (!/^[\w.:-]{1,512}$/.test(remoteId)) return updateAsset(db, asset.id, 'running', 'polling', REVIEW_INTERVAL);
    const result = await readGatewayTaskImage(remoteId, provider.apiKey, provider.baseUrl, signal);
    if (result.status === 'failed' || result.httpStatus === 451) {
      const reason = result.httpStatus === 451 || /\b451\b|content[ _-]?(?:policy|filter)|safety/i.test(result.errorMessage ?? '') ? 'policy' : 'remote_failed';
      if (attempt && attempt.terminalState !== 'succeeded') await facade?.settle({ attemptId: attempt.id,
        outcome: 'failed', remoteTerminal: true, errorCode: reason, errorStage: 'remote_poll' });
      return updateAsset(db, asset.id, 'failed', reason);
    }
    if (result.status !== 'succeeded' || !result.imageUrl) return updateAsset(db, asset.id, 'running',
      result.status === 'unknown' ? 'polling' : 'generating', result.status === 'unknown' ? REVIEW_INTERVAL : POLL_INTERVAL);
    imageUrl = result.imageUrl;
  }
  if (attempt && attempt.terminalState !== 'succeeded') await facade?.settle({ attemptId: attempt.id, outcome: 'succeeded',
    actualCost: cost, remoteTerminal: true, result: { coverAssetId: asset.id } });
  try {
    recordImageUsage(db, asset, snapshot, attempt);
    if (imageUrl) await saveImage(asset, imageUrl, provider, signal);
    await publishImage(db, asset);
  } catch {
    if (signal.aborted) return;
    if (attempt) await facade?.captureError({ attemptId: attempt.id, outcome: 'failed', stage: 'download', errorCode: 'cover_delivery' });
    updateAsset(db, asset.id, remoteId ? 'running' : 'failed', 'delivery', remoteId ? REVIEW_INTERVAL : undefined);
  }
}

const WORKER_KEY = Symbol.for('creative-studio.one-click-film-cover-worker');
type Worker = { stop: () => Promise<void> };
const globals = globalThis as Record<PropertyKey, unknown>;

function startFilmCoverWorker(db: Database.Database): void {
  if (globals[WORKER_KEY]) return;
  const controller = new AbortController();
  const pending = new Map<string, Promise<void>>();
  const tick = () => {
    const capacity = 10 - pending.size;
    if (controller.signal.aborted || capacity <= 0 || !db.open) return;
    const assets = db.prepare(`SELECT * FROM one_click_film_cover_assets WHERE status IN ('queued','running')
      AND nextAttemptAt <= ? ORDER BY nextAttemptAt,rowid LIMIT 30`).all(new Date().toISOString()) as FilmCoverAsset[];
    for (const asset of assets.filter(asset => !pending.has(asset.id)).slice(0, capacity)) {
      const work = (async () => {
        const lock = await tryFilmRequestLock('cover-generation', [asset.id]);
        if (!lock) return;
        try {
          const current = db.prepare(`SELECT * FROM one_click_film_cover_assets WHERE id=? AND status IN ('queued','running')
            AND nextAttemptAt <= ?`).get(asset.id, new Date().toISOString()) as FilmCoverAsset | undefined;
          if (!current) return;
          await runWithTaskAccessContext(db, FILM_COVER_GENERATION_MODULE, current.id, () => generateCover(db, current, controller.signal));
        } catch (error) {
          if (controller.signal.aborted || !db.open) return;
          const code = error instanceof ExecutionError ? error.code : 'internal';
          const assetState = db.prepare(`SELECT submittedAt, remoteId, operationId FROM one_click_film_cover_assets WHERE id=?`)
            .get(asset.id) as Pick<FilmCoverAsset, 'submittedAt' | 'remoteId' | 'operationId'> | undefined;
          const operation = assetState?.operationId ? readOperation(db, assetState.operationId) : undefined;
          const attempt = operation?.currentAttemptId ? readAttempt(db, operation.currentAttemptId) : undefined;
          if (assetState?.remoteId || attempt?.remoteId) updateAsset(db, asset.id, 'running', 'polling', REVIEW_INTERVAL);
          else if (attempt?.submissionState === 'maybe_sent' || attempt?.submissionState === 'accepted') {
            updateAsset(db, asset.id, 'running', 'submission_unknown', REVIEW_INTERVAL);
          } else if (assetState?.submittedAt) updateAsset(db, asset.id, 'failed', 'submission_unknown');
          else if (code === 'maintenance' || code === 'execution_not_ready') updateAsset(db, asset.id, 'queued', 'waiting', POLL_INTERVAL);
          else {
            if (operation) failOperation(db, operation.id, code);
            updateAsset(db, asset.id, 'failed', code);
          }
        } finally {
          lock.release();
        }
      })().catch(() => undefined).finally(() => pending.delete(asset.id));
      pending.set(asset.id, work);
    }
  };
  const timer = setInterval(tick, 1_000);
  timer.unref();
  globals[WORKER_KEY] = { async stop() {
    controller.abort();
    clearInterval(timer);
    await Promise.allSettled(pending.values());
    delete globals[WORKER_KEY];
  } } satisfies Worker;
}

export async function startFilmCoverGenerationAfterReadiness() {
  try {
    if ((await getOneClickFilmReadiness()).available) startFilmCoverWorker(getDb());
  } catch {
    // This feature has its own readiness gate and can recover on a later visit.
  }
}

export async function stopFilmCoverGeneration() {
  await (globals[WORKER_KEY] as Worker | undefined)?.stop();
}

export function createFilmCoverGenerationLifecycle(): ExecutionModuleLifecycle {
  return {
    name: FILM_COVER_GENERATION_MODULE,
    ensureSchemaReady() {},
    registerRecovery() {},
    recover() {},
    async start(context) {
      if (context.signal.aborted) return;
      await startFilmCoverGenerationAfterReadiness();
      context.signal.addEventListener('abort', () => { void stopFilmCoverGeneration(); }, { once: true });
    },
    async drain() { await stopFilmCoverGeneration(); return 0; },
  };
}

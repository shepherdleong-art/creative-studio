import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { sha256Canonical } from '../canonical-json.ts';
import { companyImageCapsForModel, companyImageDeliverySize } from '../company-gateway-size.ts';
import { inspectCompanyProviderRuntime } from '../company-provider-runtime.ts';
import { QINIU_IMAGE_26_MODELS } from '../company-qiniu-image-models.ts';
import { isCosMediaConfigured } from '../cos-media.ts';
import { dataRoot } from '../data-root.ts';
import { GPT_IMAGE_2_SIZE_MAP } from '../gpt-image-2-size-presets.ts';
import { requireAccessContext } from '../media-core/access-context.ts';
import { legacyMediaProviderCredentialFingerprint } from '../media-core/execution/media-provider-pool.ts';
import { evaluateProviderExecutionGate } from '../provider-execution-gate.ts';
import { createCoreUsageSnapshot, resolveCoreUsagePlan, type CoreUsageProviderSnapshot } from '../usage-pricing.ts';
import { filmCoverCandidate, type CoverReference, type FilmCoverAsset, type FilmCoverAssetInput } from './cover-assets.ts';
import { FILM_COVER_TITLE_CLEARANCE, MAX_FILM_COVER_PREFERENCE_LENGTH, MAX_FILM_COVER_REFERENCES, type FilmCoverGenerationConfig } from './cover-generation-types.ts';
import { resolveProjectCoverImagePath } from './cover-source.ts';
import { OneClickFilmError } from './errors.ts';
import { isOneClickFilmTemplate, ONE_CLICK_FILM_TEMPLATE_LABELS, type OneClickFilmTemplateId } from './packaging-constants.ts';
import { getAnalysis, getEntry, type OneClickFilmRun } from './store.ts';

export const FILM_COVER_GENERATION_MODULE = 'one-click-film-cover';

interface CoverProvider {
  id: string;
  name: string;
  type: 'gateway-task-image';
  model: string;
  baseUrl: string;
  apiKey: string;
  enabled: number;
}

export function findFilmCoverProvider(db: Database.Database, providerId: string, includeDisabled = false): CoverProvider | undefined {
  const spec = QINIU_IMAGE_26_MODELS.find(model => model.id === providerId);
  if (!spec) return undefined;
  const provider = db.prepare(`SELECT id, name, type, model, baseUrl, apiKey, enabled FROM providers
    WHERE id=? AND model=? AND type='gateway-task-image' AND length(trim(apiKey)) > 0 AND length(trim(baseUrl)) > 0
      AND (enabled=1 OR ?=1)`).get(spec.id, spec.model, Number(includeDisabled)) as CoverProvider | undefined;
  if (!provider) return undefined;
  return { ...provider, name: spec.name, baseUrl: provider.baseUrl.trim(), apiKey: provider.apiKey.trim() };
}

export function filmCoverProviderFingerprint(provider: CoverProvider): string {
  return legacyMediaProviderCredentialFingerprint(provider.baseUrl, provider.apiKey);
}

export async function filmCoverGenerationConfig(db: Database.Database): Promise<FilmCoverGenerationConfig> {
  const disabled = (reason: string): FilmCoverGenerationConfig => ({ enabled: false, reason, channels: [], maxReferences: MAX_FILM_COVER_REFERENCES });
  const configured = QINIU_IMAGE_26_MODELS.flatMap(({ id }) => findFilmCoverProvider(db, id) ?? []);
  if (!configured.length) return disabled('未启用已配置的 GPT Image 2.6 Flare 或 Sunburst 通道。');
  const companyRuntime = await inspectCompanyProviderRuntime({ root: dataRoot() });
  const checks = configured.map(provider => ({ provider, gate: evaluateProviderExecutionGate({
    provider: { id: provider.id, executionScope: 'company', baseUrl: provider.baseUrl, enabled: true, configured: true },
    capability: 'media', companyRuntime, mediaTransportAvailable: isCosMediaConfigured(),
  }) }));
  const channels = checks.filter(({ gate }) => gate.allowed).map(({ provider: { id, name, model } }) => ({ id, name, model }));
  if (!channels.length) return disabled(checks[0]!.gate.message);
  return { enabled: true, channels, maxReferences: MAX_FILM_COVER_REFERENCES };
}

export function filmCoverReferenceHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function hashProjectCoverReference(db: Database.Database, projectId: string, id: string): Promise<CoverReference> {
  const file = resolveProjectCoverImagePath(db, projectId, id);
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return { id, sha256: hash.digest('hex') };
}

export async function queueFilmCoverGeneration(db: Database.Database, run: OneClickFilmRun, input: {
  entryCode: string;
  requestKey: unknown;
  providerId: unknown;
  referenceImageIds: unknown;
  preference: unknown;
  template: OneClickFilmTemplateId;
  aspectRatio: string;
}) {
  const access = requireAccessContext();
  access.assertAccess('project', run.projectId, 'write');
  const entry = getEntry(db, run.id, input.entryCode);
  const { requestKey, providerId, referenceImageIds } = input;
  if (typeof requestKey !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(requestKey)) {
    throw new OneClickFilmError('invalid_input', '全景封面请求缺少有效的去重键。');
  }
  if (!Array.isArray(referenceImageIds) || referenceImageIds.length > MAX_FILM_COVER_REFERENCES
    || referenceImageIds.some(id => typeof id !== 'string') || new Set(referenceImageIds).size !== referenceImageIds.length) {
    throw new OneClickFilmError('invalid_input', `全景封面最多可勾选 ${MAX_FILM_COVER_REFERENCES} 张不同的项目参考图。`);
  }
  if (input.preference !== undefined && (typeof input.preference !== 'string' || Array.from(input.preference).length > MAX_FILM_COVER_PREFERENCE_LENGTH)) {
    throw new OneClickFilmError('invalid_input', `构图偏好最多 ${MAX_FILM_COVER_PREFERENCE_LENGTH} 字。`);
  }
  if (typeof providerId !== 'string' || !QINIU_IMAGE_26_MODELS.some(spec => spec.id === providerId) || !isOneClickFilmTemplate(input.template)) {
    throw new OneClickFilmError('invalid_input', '请选择 GPT Image 2.6 Flare 或 Sunburst 和有效的包装模板。');
  }
  const preference = typeof input.preference === 'string' ? input.preference.trim() : '';
  const requestHash = sha256Canonical([providerId, referenceImageIds, preference, input.template]);
  const existing = () => {
    const asset = db.prepare(`SELECT * FROM one_click_film_cover_assets
      WHERE projectId=? AND runId=? AND entryId=? AND requestKey=?`).get(run.projectId, run.id, entry.id, requestKey) as FilmCoverAsset | undefined;
    if (asset && asset.requestHash !== requestHash) throw new OneClickFilmError('conflict', '该全景封面请求已用于不同的生成设置。', 409);
    return asset;
  };
  const replay = existing();
  if (replay) return filmCoverCandidate(replay);
  const provider = findFilmCoverProvider(db, providerId);
  const config = await filmCoverGenerationConfig(db);
  if (!provider || !config.channels.some(channel => channel.id === provider.id)) {
    throw new OneClickFilmError('invalid_input', config.reason ?? '所选 GPT Image 2.6 通道当前不可用。');
  }
  const ratios = input.aspectRatio.split(':').map(Number);
  const size = GPT_IMAGE_2_SIZE_MAP[input.aspectRatio]?.['2k']
    ?? (ratios.length === 2 && ratios.every(value => value > 0 && value <= 10_000) ? `${ratios[0]}x${ratios[1]}` : undefined);
  if (!size) throw new OneClickFilmError('invalid_input', '无法确定当前成片的画幅。');
  const requestedSize = companyImageDeliverySize(size, companyImageCapsForModel(provider.model)!);
  const references = await Promise.all((referenceImageIds as string[]).map(async id => {
    try { return await hashProjectCoverReference(db, run.projectId, id); }
    catch { throw new OneClickFilmError('invalid_input', '所选参考图不可用，请重新勾选当前项目的图片。'); }
  }));
  const analysis = getAnalysis(db, entry.analysisId);
  const prompt = [
    `为「${entry.productNameSnapshot}」生成一张 ${input.aspectRatio} 画幅的电商产品全景封面照片。`,
    analysis?.appearance && `产品外观线索：${analysis.appearance}`,
    analysis?.sceneClues && `场景线索：${analysis.sceneClues}`,
    '用中远景把产品完整拍入画面，保留所有边缘和清楚的主体轮廓，主体放在画面中下部。',
    '严格保持参考图中的产品外观、结构、比例、材质和配色，避免遮挡与拉伸变形。',
    `包装模板「${ONE_CLICK_FILM_TEMPLATE_LABELS[input.template]}」需要${FILM_COVER_TITLE_CLEARANCE[input.template]}`,
    '图片中不要生成装饰文字、标题、水印、贴纸或边框，标题由视频包装层添加。',
    preference && `构图偏好（须符合上述产品一致性及留白要求）：${preference}`,
  ].filter(Boolean).join('\n');
  const pricingIdentity: CoreUsageProviderSnapshot = {
    providerTable: 'providers', providerId: provider.id, providerName: provider.name, providerType: provider.type,
    executionScope: 'company', configuredModel: provider.model, requestModel: provider.model, baseUrl: provider.baseUrl,
  };
  const plan = resolveCoreUsagePlan(pricingIdentity);
  if (!plan) throw new OneClickFilmError('invalid_input', '所选全景封面通道缺少已核验的计费价格。');
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const asset: FilmCoverAssetInput = {
    id, runId: run.id, projectId: run.projectId, entryId: entry.id, entryCode: entry.code,
    requestKey, requestHash, providerId, model: provider.model, references, prompt, requestedSize,
    providerFingerprint: filmCoverProviderFingerprint(provider), createdAt,
    usageSnapshot: createCoreUsageSnapshot(pricingIdentity, plan, { startedAt: createdAt, refType: FILM_COVER_GENERATION_MODULE, refId: id }),
  };
  const saved = db.transaction(() => {
    const replay = existing();
    if (replay) return replay;
    db.prepare(`INSERT INTO one_click_film_cover_assets
      (id, runId, projectId, entryId, entryCode, status, requestKey, requestHash, providerId, model, referenceImagesJson,
        prompt, requestedSize, providerFingerprint, usageSnapshotJson, message, nextAttemptAt, createdAt, updatedAt)
      VALUES (@id,@runId,@projectId,@entryId,@entryCode,'queued',@requestKey,@requestHash,@providerId,@model,@referenceImagesJson,
        @prompt,@requestedSize,@providerFingerprint,@usageSnapshotJson,'等待云端并发名额',@createdAt,@createdAt,@createdAt)`).run({
      ...asset, referenceImagesJson: JSON.stringify(references), usageSnapshotJson: JSON.stringify(asset.usageSnapshot),
    });
    access.registerTaskPrincipal({ module: FILM_COVER_GENERATION_MODULE, taskId: id,
      scope: { resourceType: 'project', resourceId: run.projectId }, creationSnapshot: { entryId: entry.id, model: provider.model } });
    return db.prepare(`SELECT * FROM one_click_film_cover_assets WHERE id=?`).get(id) as FilmCoverAsset;
  }).immediate();
  return filmCoverCandidate(saved);
}

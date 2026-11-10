import type Database from 'better-sqlite3';
import {
  listExecutionPoolBindings,
  listExecutionPools,
  mediaUpstreamBindingKey,
  readExecutionPool,
  readExecutionPoolBinding,
  upsertExecutionPool,
  upsertExecutionPoolBinding,
  type ExecutionPoolBinding,
  type ExecutionPoolSummary,
} from '../media-core/execution/pools.ts';
import {
  readUnifiedImageCongestionSettings,
  updateUnifiedImageCongestionSettings,
  type UnifiedImageCongestionSettings,
} from '../media-core/unified-media/settings.ts';
import { ExecutionError } from '../media-core/execution/context.ts';
import {
  legacyMediaProviderCredentialFingerprint,
  legacyMediaProviderPoolKey,
} from '../media-core/execution/media-provider-pool.ts';
import type { TeamViewer } from './diagnostics.ts';
import { ensureCanvasCapabilitiesRegistered } from '../creative-canvas/capabilities-bootstrap.ts';

/**
 * 管理员资源池配置服务（R01）。
 *
 * 约束：
 * - 池写入只经 upsertExecutionPool（版本冲突 + 映射快照校验）；
 * - 供应商凭据只在服务端读取并折算成指纹，绝不进入响应、日志或 CLI 输出；
 * - 同一真实上游的多个 Key 只有在管理员显式绑定时才共享池容量。
 */

export class TeamPoolError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'TeamPoolError';
    this.code = code;
    this.status = status;
  }
}

export type PoolRequirementStatus =
  | 'ready' | 'missing' | 'disabled' | 'mapping_mismatch' | 'credential_missing' | 'provider_disabled';

export interface PoolRequirement {
  key: string;
  entityType: 'image' | 'video' | 'script' | 'tts' | 'canvas';
  entityId: string;
  label: string;
  poolKey: string;
  kind: 'remote';
  mappingSnapshot: Record<string, unknown>;
  status: PoolRequirementStatus;
  message: string | null;
  poolVersion: number | null;
}

export interface PoolAdminState {
  pools: ExecutionPoolSummary[];
  bindings: ExecutionPoolBinding[];
  requirements: PoolRequirement[];
  ready: boolean;
  blockers: string[];
  unifiedImageCongestion: UnifiedImageCongestionSettings;
  occupancy: Array<{
    poolKey: string;
    capacity: number;
    held: number;
    accepted: number;
    maybeSent: number;
    notSent: number;
    activeMembers: Array<{ actorId: string; held: number; pending: number; running: number }>;
  }>;
}

export type PoolChange =
  | {
    action: 'upsert';
    poolKey: string;
    kind: 'upload' | 'remote' | 'download' | 'media';
    capacity: number;
    enabled: boolean;
    mappingSnapshot: Record<string, unknown>;
    expectedVersion: number;
  }
  | {
    action: 'bind-media-upstream';
    entityType: 'image' | 'video';
    entityId: string;
    poolKey: string;
    capacity: number;
    enabled?: boolean;
    expectedVersion: number;
    label?: string;
  };

export interface PoolChangePreview {
  poolKey: string;
  action: 'create' | 'update' | 'noop';
  currentVersion: number;
  nextVersion: number;
  kind: string;
  capacity: number;
  enabled: boolean;
  bindingKey: string | null;
}

const POOL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const POOL_KINDS = new Set(['upload', 'remote', 'download', 'media']);
const FORBIDDEN_MAPPING_KEY = /^(api_?key|secret|secret_?key|access_?key|token|password|authorization|private_?key|credential)$/i;

function assertAdmin(viewer: TeamViewer): void {
  if (viewer.role !== 'admin') {
    throw new TeamPoolError(403, 'pool_admin_forbidden', '只有管理员可以配置受控资源池。');
  }
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TeamPoolError(400, 'pool_mapping_invalid', `${label} 必须是受控映射对象。`);
  }
  return value as Record<string, unknown>;
}

function assertNoSecrets(value: unknown, path = 'mappingSnapshot'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_MAPPING_KEY.test(key)) {
      throw new TeamPoolError(400, 'pool_mapping_secret', `资源池映射不得包含明文凭据字段：${path}.${key}。`);
    }
    assertNoSecrets(item, `${path}.${key}`);
  }
}

function validateMapping(mapping: unknown): Record<string, unknown> {
  const snapshot = assertRecord(mapping, 'mappingSnapshot');
  if (typeof snapshot.protocol !== 'string' || !snapshot.protocol.trim()) {
    throw new TeamPoolError(400, 'pool_mapping_invalid', '资源池映射必须声明 protocol。');
  }
  assertNoSecrets(snapshot);
  return snapshot;
}

function normalizePoolInput(change: Extract<PoolChange, { action: 'upsert' }>): {
  poolKey: string;
  kind: 'upload' | 'remote' | 'download' | 'media';
  capacity: number;
  enabled: boolean;
  mappingSnapshot: Record<string, unknown>;
  expectedVersion: number;
} {
  const poolKey = change.poolKey?.trim();
  if (!poolKey || !POOL_KEY_PATTERN.test(poolKey)) {
    throw new TeamPoolError(400, 'pool_key_invalid', '池键只能包含字母、数字、点、下划线、冒号和连字符。');
  }
  if (!POOL_KINDS.has(change.kind)) {
    throw new TeamPoolError(400, 'pool_kind_invalid', '池类型只支持 upload/remote/download/media。');
  }
  if (!Number.isSafeInteger(change.capacity) || change.capacity < 0) {
    throw new TeamPoolError(400, 'pool_capacity_invalid', '池容量必须是非负安全整数。');
  }
  if (typeof change.enabled !== 'boolean') {
    throw new TeamPoolError(400, 'pool_enabled_invalid', '池启用状态必须是布尔值。');
  }
  if (!Number.isSafeInteger(change.expectedVersion) || change.expectedVersion < 0) {
    throw new TeamPoolError(400, 'pool_version_invalid', '池版本必须是非负安全整数（新池为 0）。');
  }
  return {
    poolKey,
    kind: change.kind,
    capacity: change.capacity,
    enabled: change.enabled,
    mappingSnapshot: validateMapping(change.mappingSnapshot),
    expectedVersion: change.expectedVersion,
  };
}

interface ProviderCredential {
  label: string;
  enabled: boolean;
  baseUrl: string;
  credentialIdentity: string;
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function imageProviderCredential(db: Database.Database, providerId: string): ProviderCredential {
  if (!tableExists(db, 'providers')) throw new TeamPoolError(404, 'provider_not_found', '图片供应商不存在。');
  const row = db.prepare('SELECT id, name, baseUrl, apiKey, enabled FROM providers WHERE id = ?').get(providerId) as
    | { id: string; name: string; baseUrl: string; apiKey: string; enabled: number } | undefined;
  if (!row) throw new TeamPoolError(404, 'provider_not_found', '图片供应商不存在。');
  return {
    label: row.name || row.id,
    enabled: Boolean(row.enabled),
    baseUrl: row.baseUrl ?? '',
    credentialIdentity: (row.apiKey ?? '').trim(),
  };
}

function videoProviderCredential(db: Database.Database, providerId: string): ProviderCredential {
  if (!tableExists(db, 'video_providers')) throw new TeamPoolError(404, 'provider_not_found', '视频供应商不存在。');
  const row = db.prepare(
    'SELECT id, name, type, baseUrl, apiKey, accessKey, secretKey, enabled FROM video_providers WHERE id = ?',
  ).get(providerId) as {
    id: string; name: string; type: string; baseUrl: string; apiKey: string;
    accessKey: string; secretKey: string; enabled: number;
  } | undefined;
  if (!row) throw new TeamPoolError(404, 'provider_not_found', '视频供应商不存在。');
  const credentialIdentity = row.type === 'kling'
    ? `${(row.accessKey ?? '').trim()}\0${(row.secretKey ?? '').trim()}`
    : (row.apiKey ?? '').trim();
  return {
    label: row.name || row.id,
    enabled: Boolean(row.enabled),
    baseUrl: row.baseUrl ?? '',
    credentialIdentity,
  };
}

function mediaProviderCredential(db: Database.Database, entityType: 'image' | 'video', entityId: string): ProviderCredential {
  return entityType === 'image' ? imageProviderCredential(db, entityId) : videoProviderCredential(db, entityId);
}

function sharedUpstreamMapping(baseUrl: string, fingerprints: string[]): Record<string, unknown> {
  return {
    protocol: 'media-upstream-pool/1',
    baseUrl: baseUrl.trim().replace(/\/$/, ''),
    credentialFingerprints: [...new Set(fingerprints)].sort(),
  };
}

function mappingFingerprints(mapping: unknown): string[] {
  const snapshot = mapping && typeof mapping === 'object' ? mapping as Record<string, unknown> : {};
  return Array.isArray(snapshot.credentialFingerprints)
    ? snapshot.credentialFingerprints.filter((item): item is string => typeof item === 'string')
    : [];
}

function poolStatusFor(input: {
  poolKey: string;
  mappingSnapshot: Record<string, unknown>;
  providerEnabled: boolean;
  credentialPresent: boolean;
  db: Database.Database;
}): { status: PoolRequirementStatus; message: string | null; version: number | null } {
  if (!input.providerEnabled) {
    return { status: 'provider_disabled', message: '供应商已停用；启用后才会提交付费任务。', version: null };
  }
  if (!input.credentialPresent) {
    return { status: 'credential_missing', message: '供应商凭据未配置，无法生成资源池映射。', version: null };
  }
  let pool;
  try {
    pool = readExecutionPool(input.db, input.poolKey);
  } catch {
    return {
      status: 'missing',
      message: `资源池 ${input.poolKey} 尚未配置；请由管理员在资源池配置中确认容量与映射。`,
      version: null,
    };
  }
  const protocol = (input.mappingSnapshot as { protocol?: unknown }).protocol;
  const poolMapping = pool.mappingSnapshot as Record<string, unknown>;
  const matches = protocol === 'media-upstream-pool/1'
    ? poolMapping.protocol === 'media-upstream-pool/1'
      && poolMapping.baseUrl === input.mappingSnapshot.baseUrl
      && mappingFingerprints(poolMapping).includes(String(mappingFingerprints(input.mappingSnapshot)[0] ?? ''))
    : protocol === 'legacy-media-upstream/1'
      ? poolMapping.protocol === 'legacy-media-upstream/1'
        && poolMapping.baseUrl === input.mappingSnapshot.baseUrl
        && poolMapping.credentialFingerprint === input.mappingSnapshot.credentialFingerprint
      : poolMapping.protocol === protocol;
  if (!matches) {
    return { status: 'mapping_mismatch', message: `资源池 ${input.poolKey} 的映射与当前供应商身份不一致，请重新确认。`, version: pool.version };
  }
  if (!pool.enabled) {
    return { status: 'disabled', message: `资源池 ${input.poolKey} 已停用；新付费步骤会被拒绝。`, version: pool.version };
  }
  return { status: 'ready', message: null, version: pool.version };
}

function requirementFromProvider(
  db: Database.Database,
  entityType: 'image' | 'video',
  credential: ProviderCredential,
  entityId: string,
  poolKey?: string,
): PoolRequirement {
  const fingerprint = credential.credentialIdentity
    ? legacyMediaProviderCredentialFingerprint(credential.baseUrl, credential.credentialIdentity)
    : '';
  const binding = fingerprint
    ? readExecutionPoolBinding(db, mediaUpstreamBindingKey(fingerprint))
    : undefined;
  const resolvedPoolKey = poolKey ?? binding?.poolKey
    ?? (fingerprint ? legacyMediaProviderPoolKey(credential.baseUrl, credential.credentialIdentity) : '');
  const mapping = binding
    ? sharedUpstreamMapping(credential.baseUrl, [fingerprint])
    : {
      protocol: 'legacy-media-upstream/1',
      baseUrl: credential.baseUrl.trim().replace(/\/$/, ''),
      credentialFingerprint: fingerprint,
    };
  const status = fingerprint && resolvedPoolKey
    ? poolStatusFor({
      db,
      poolKey: resolvedPoolKey,
      mappingSnapshot: mapping,
      providerEnabled: credential.enabled,
      credentialPresent: true,
    })
    : { status: 'credential_missing' as const, message: '供应商凭据未配置，无法生成资源池映射。', version: null };
  return {
    key: `${entityType}:${entityId}`,
    entityType,
    entityId,
    label: credential.label,
    poolKey: resolvedPoolKey,
    kind: 'remote',
    mappingSnapshot: mapping,
    status: status.status,
    message: status.message,
    poolVersion: status.version,
  };
}

function moduleRequirement(
  db: Database.Database,
  entityType: 'script' | 'tts',
  entityId: string,
  label: string,
  poolKey: string,
  mapping: Record<string, unknown>,
  providerCount: number,
  moduleEnabled: boolean,
): PoolRequirement {
  if (providerCount === 0) {
    return {
      key: `${entityType}:${entityId}`, entityType, entityId, label, poolKey, kind: 'remote', mappingSnapshot: mapping,
      status: 'provider_disabled', message: '尚无已启用的同类供应商，配置后才会产生付费调用。', poolVersion: null,
    };
  }
  const status = poolStatusFor({
    db, poolKey, mappingSnapshot: mapping, providerEnabled: moduleEnabled, credentialPresent: true,
  });
  return {
    key: `${entityType}:${entityId}`, entityType, entityId, label, poolKey, kind: 'remote', mappingSnapshot: mapping,
    status: status.status, message: status.message, poolVersion: status.version,
  };
}

/** 枚举所有调用面需要的池：图片、视频、LLM、TTS、画布（已配置能力）。 */
export function listPoolRequirements(db: Database.Database): PoolRequirement[] {
  const requirements: PoolRequirement[] = [];
  if (tableExists(db, 'providers')) {
    const rows = db.prepare('SELECT id, name, baseUrl, apiKey, enabled FROM providers ORDER BY name, id')
      .all() as Array<{ id: string; name: string; baseUrl: string; apiKey: string; enabled: number }>;
    for (const row of rows) {
      requirements.push(requirementFromProvider(db, 'image', {
        label: row.name || row.id, enabled: Boolean(row.enabled), baseUrl: row.baseUrl ?? '',
        credentialIdentity: (row.apiKey ?? '').trim(),
      }, row.id));
    }
  }
  if (tableExists(db, 'video_providers')) {
    const rows = db.prepare(
      'SELECT id, name, type, baseUrl, apiKey, accessKey, secretKey, enabled FROM video_providers ORDER BY name, id',
    ).all() as Array<{
      id: string; name: string; type: string; baseUrl: string; apiKey: string;
      accessKey: string; secretKey: string; enabled: number;
    }>;
    for (const row of rows) {
      requirements.push(requirementFromProvider(db, 'video', {
        label: row.name || row.id, enabled: Boolean(row.enabled), baseUrl: row.baseUrl ?? '',
        credentialIdentity: row.type === 'kling'
          ? `${(row.accessKey ?? '').trim()}\0${(row.secretKey ?? '').trim()}`
          : (row.apiKey ?? '').trim(),
      }, row.id));
    }
  }
  const scriptCount = tableExists(db, 'script_providers')
    ? Number(db.prepare('SELECT COUNT(*) FROM script_providers WHERE enabled = 1').pluck().get() ?? 0)
    : 0;
  requirements.push(moduleRequirement(db, 'script', 'llm', '脚本 / LLM', 'llm:remote', {
    protocol: 'llm-remote/1', modules: ['script', 'script-studio', 'batch', 'canvas-semantic'],
  }, scriptCount, scriptCount > 0));
  const ttsCount = tableExists(db, 'final_edit_tts_providers')
    ? Number(db.prepare('SELECT COUNT(*) FROM final_edit_tts_providers WHERE enabled = 1').pluck().get() ?? 0)
    : 0;
  requirements.push(moduleRequirement(db, 'tts', 'tts', 'TTS / 字幕对齐', 'tts:remote', {
    protocol: 'tts-remote/1', modules: ['tts', 'alignment'],
  }, ttsCount, ttsCount > 0));
  if (tableExists(db, 'creative_canvas_tasks')) {
    const historical = db.prepare(`
      SELECT DISTINCT json_extract(providerSnapshot, '$.providerIdentity') AS providerIdentity
      FROM creative_canvas_tasks WHERE json_valid(providerSnapshot)
    `).all() as Array<{ providerIdentity: string | null }>;
    const identities = new Set([
      ...ensureCanvasCapabilitiesRegistered(db).map((capability) => capability.providerIdentity),
      ...historical.map((row) => row.providerIdentity).filter((id): id is string => typeof id === 'string' && id.length > 0),
    ]);
    for (const providerIdentity of identities) {
      const media = requirements.find((item) => ['image', 'video'].includes(item.entityType) && item.entityId === providerIdentity);
      if (media) {
        requirements.push({ ...media, key: `canvas:${providerIdentity}`, entityType: 'canvas', label: `创作画布 · ${media.label}` });
        continue;
      }
      requirements.push({
        key: `canvas:${providerIdentity}`,
        entityType: 'canvas',
        entityId: providerIdentity,
        label: `创作画布 · ${providerIdentity}`,
        poolKey: `${providerIdentity}:remote`,
        kind: 'remote',
        mappingSnapshot: { protocol: 'canvas-remote/1', providerIdentity },
        status: 'missing',
        message: null,
        poolVersion: null,
      });
      const index = requirements.length - 1;
      const status = poolStatusFor({
        db,
        poolKey: requirements[index].poolKey,
        mappingSnapshot: requirements[index].mappingSnapshot,
        providerEnabled: true,
        credentialPresent: true,
      });
      requirements[index] = {
        ...requirements[index],
        status: status.status,
        message: status.message,
        poolVersion: status.version,
      };
    }
  }
  return requirements;
}

function readPoolOccupancy(db: Database.Database): PoolAdminState['occupancy'] {
  return db.prepare(`
    SELECT p.poolKey, p.capacity,
      (SELECT COUNT(*) FROM execution_reservations r
        WHERE r.kind = 'concurrency' AND r.poolKey = p.poolKey AND r.state = 'held') AS held,
      (SELECT COUNT(*) FROM execution_attempts a
        WHERE a.submissionState = 'accepted' AND EXISTS (
          SELECT 1 FROM execution_reservations r
          WHERE r.attemptId = a.id AND r.kind = 'concurrency' AND r.poolKey = p.poolKey AND r.state = 'held')) AS accepted,
      (SELECT COUNT(*) FROM execution_attempts a
        WHERE a.submissionState = 'maybe_sent' AND EXISTS (
          SELECT 1 FROM execution_reservations r
          WHERE r.attemptId = a.id AND r.kind = 'concurrency' AND r.poolKey = p.poolKey AND r.state = 'held')) AS maybeSent,
      (SELECT COUNT(*) FROM execution_attempts a
        WHERE a.submissionState = 'not_sent' AND EXISTS (
          SELECT 1 FROM execution_reservations r
          WHERE r.attemptId = a.id AND r.kind = 'concurrency' AND r.poolKey = p.poolKey AND r.state = 'held')) AS notSent
    FROM execution_pools p ORDER BY p.poolKey
  `).all().map((row) => {
    const pool = row as { poolKey: string; capacity: number; held: number; accepted: number; maybeSent: number; notSent: number };
    const activeMembers = db.prepare(`
      SELECT r.actorId,
        SUM(CASE WHEN r.state = 'held' THEN 1 ELSE 0 END) AS held,
        SUM(CASE WHEN o.status IN ('pending', 'deferred') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN a.submissionState IN ('not_sent', 'maybe_sent', 'accepted') THEN 1 ELSE 0 END) AS running
      FROM execution_reservations r
      JOIN execution_operations o ON o.id = r.operationId
      LEFT JOIN execution_attempts a ON a.id = r.attemptId
      WHERE r.kind = 'concurrency' AND r.poolKey = ?
      GROUP BY r.actorId
      HAVING held > 0 OR pending > 0 OR running > 0
      ORDER BY r.actorId
    `).all(pool.poolKey) as PoolAdminState['occupancy'][number]['activeMembers'];
    return { ...pool, activeMembers };
  });
}

export function readPoolAdminState(db: Database.Database, viewer: TeamViewer): PoolAdminState {
  assertAdmin(viewer);
  const requirements = listPoolRequirements(db);
  const blockers = requirements
    .filter((requirement) => requirement.status !== 'ready' && requirement.status !== 'provider_disabled')
    .map((requirement) => `${requirement.label}：${requirement.message ?? requirement.status}`);
  return {
    pools: listExecutionPools(db),
    bindings: listExecutionPoolBindings(db),
    requirements,
    ready: blockers.length === 0,
    blockers,
    unifiedImageCongestion: readUnifiedImageCongestionSettings(db),
    occupancy: readPoolOccupancy(db),
  };
}

export function updateUnifiedImageCongestion(
  db: Database.Database,
  viewer: TeamViewer,
  input: {
    imageCongestionThresholdSec: unknown;
    expectedVersion: unknown;
  },
): UnifiedImageCongestionSettings {
  assertAdmin(viewer);
  try {
    return updateUnifiedImageCongestionSettings(db, input);
  } catch (error) {
    if (error instanceof ExecutionError) {
      if (error.code === 'settings_version_conflict') {
        throw new TeamPoolError(409, error.code, error.message);
      }
      if (error.code === 'invalid_congestion_threshold'
        || error.code === 'invalid_settings_version') {
        throw new TeamPoolError(400, error.code, error.message);
      }
    }
    throw error;
  }
}

function derivedChange(db: Database.Database, change: Extract<PoolChange, { action: 'bind-media-upstream' }>): {
  poolKey: string;
  kind: 'remote';
  capacity: number;
  enabled: boolean;
  mappingSnapshot: Record<string, unknown>;
  expectedVersion: number;
  bindingKey: string;
  label: string;
} {
  if (!['image', 'video'].includes(change.entityType)) {
    throw new TeamPoolError(400, 'pool_binding_invalid', '只有图片/视频供应商可以绑定媒体上游池。');
  }
  if (!POOL_KEY_PATTERN.test(change.poolKey ?? '')) {
    throw new TeamPoolError(400, 'pool_key_invalid', '池键只能包含字母、数字、点、下划线、冒号和连字符。');
  }
  if (!Number.isSafeInteger(change.capacity) || change.capacity < 0) {
    throw new TeamPoolError(400, 'pool_capacity_invalid', '池容量必须是非负安全整数。');
  }
  if (!Number.isSafeInteger(change.expectedVersion) || change.expectedVersion < 0) {
    throw new TeamPoolError(400, 'pool_version_invalid', '池版本必须是非负安全整数（新池为 0）。');
  }
  const credential = mediaProviderCredential(db, change.entityType, change.entityId);
  const identity = credential.credentialIdentity;
  if (!identity.trim()) {
    throw new TeamPoolError(409, 'provider_credential_missing', '供应商尚未配置凭据；先在供应商设置中填写后再绑定资源池。');
  }
  if (!credential.baseUrl.trim()) {
    throw new TeamPoolError(409, 'provider_base_url_missing', '供应商尚未配置网关地址，无法确认上游共享关系。');
  }
  const fingerprint = legacyMediaProviderCredentialFingerprint(credential.baseUrl, identity);
  const bindingKey = mediaUpstreamBindingKey(fingerprint);
  const existing = db.prepare('SELECT mappingSnapshotJson FROM execution_pools WHERE poolKey = ?').get(change.poolKey) as
    | { mappingSnapshotJson: string } | undefined;
  let existingFingerprints: string[] = [];
  if (existing) {
    let parsed: unknown = null;
    try { parsed = JSON.parse(existing.mappingSnapshotJson); } catch { parsed = null; }
    const protocol = parsed && typeof parsed === 'object' ? (parsed as { protocol?: unknown }).protocol : undefined;
    if (protocol !== 'media-upstream-pool/1') {
      throw new TeamPoolError(
        409, 'pool_mapping_conflict',
        `资源池 ${change.poolKey} 已按其他协议配置；共享上游池只能绑定同一映射协议。`,
      );
    }
    const mapping = parsed as Record<string, unknown>;
    if (typeof mapping.baseUrl === 'string' && mapping.baseUrl !== credential.baseUrl.trim().replace(/\/$/, '')) {
      throw new TeamPoolError(409, 'pool_mapping_conflict', `资源池 ${change.poolKey} 已绑定其他上游地址，不能把不同账户合并计容。`);
    }
    existingFingerprints = mappingFingerprints(mapping);
  }
  const bound = readExecutionPoolBinding(db, bindingKey);
  if (bound && bound.poolKey !== change.poolKey) {
    throw new TeamPoolError(409, 'pool_binding_conflict', `该供应商凭据已绑定资源池 ${bound.poolKey}，请先解绑或沿用原池。`);
  }
  return {
    poolKey: change.poolKey,
    kind: 'remote',
    capacity: change.capacity,
    enabled: change.enabled ?? true,
    mappingSnapshot: sharedUpstreamMapping(credential.baseUrl, [...existingFingerprints, fingerprint]),
    expectedVersion: change.expectedVersion,
    bindingKey,
    label: change.label?.trim() || credential.label,
  };
}

export function previewPoolChanges(db: Database.Database, viewer: TeamViewer, changes: PoolChange[]): PoolChangePreview[] {
  assertAdmin(viewer);
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new TeamPoolError(400, 'pool_changes_required', '至少提供一项资源池变更。');
  }
  return changes.map((change) => {
    const derived = change.action === 'bind-media-upstream'
      ? derivedChange(db, change)
      : { ...normalizePoolInput(change), bindingKey: null as string | null };
    const existing = db.prepare('SELECT version, capacity, enabled, kind FROM execution_pools WHERE poolKey = ?')
      .get(derived.poolKey) as { version: number; capacity: number; enabled: number; kind: string } | undefined;
    if (existing && existing.version !== derived.expectedVersion) {
      throw new TeamPoolError(
        409, 'pool_version_conflict',
        `资源池 ${derived.poolKey} 版本已变化：期望 ${derived.expectedVersion}，实际 ${existing.version}。请刷新后重试。`,
      );
    }
    const same = existing && existing.capacity === derived.capacity
      && Boolean(existing.enabled) === derived.enabled && existing.kind === derived.kind;
    return {
      poolKey: derived.poolKey,
      action: !existing ? 'create' : same ? 'noop' : 'update',
      currentVersion: existing?.version ?? 0,
      nextVersion: existing ? existing.version + 1 : 1,
      kind: derived.kind,
      capacity: derived.capacity,
      enabled: derived.enabled,
      bindingKey: derived.bindingKey,
    };
  });
}

export function applyPoolChanges(
  db: Database.Database,
  viewer: TeamViewer,
  changes: PoolChange[],
): { applied: PoolChangePreview[]; requirements: PoolRequirement[] } {
  assertAdmin(viewer);
  const previews = previewPoolChanges(db, viewer, changes);
  const applied = db.transaction(() => changes.map((change, index) => {
    const derived = change.action === 'bind-media-upstream'
      ? derivedChange(db, change)
      : { ...normalizePoolInput(change), bindingKey: null as string | null };
    upsertExecutionPool(db, {
      poolKey: derived.poolKey,
      kind: derived.kind,
      capacity: derived.capacity,
      enabled: derived.enabled,
      mappingSnapshot: derived.mappingSnapshot,
      expectedVersion: derived.expectedVersion,
    });
    if (derived.bindingKey) {
      upsertExecutionPoolBinding(db, {
        bindingKey: derived.bindingKey,
        poolKey: derived.poolKey,
        label: 'label' in derived ? derived.label : '',
      });
    }
    return previews[index];
  })).immediate();
  return { applied, requirements: listPoolRequirements(db) };
}

/** 供应商保存/启用后返回的池状态；只用于展示可修复原因，不阻塞保存。 */
export function providerPoolStatus(
  db: Database.Database,
  entityType: 'image' | 'video',
  entityId: string,
): { poolKey: string; status: PoolRequirementStatus; message: string | null } | null {
  try {
    const credential = mediaProviderCredential(db, entityType, entityId);
    if (!credential.credentialIdentity.trim() || !credential.baseUrl.trim()) {
      return {
        poolKey: '',
        status: 'credential_missing',
        message: '保存供应商后填写凭据与网关地址，才能确认资源池映射。',
      };
    }
    const requirement = requirementFromProvider(db, entityType, credential, entityId);
    return { poolKey: requirement.poolKey, status: requirement.status, message: requirement.message };
  } catch {
    return null;
  }
}

import type { ExecutionPoolSummary } from '../media-core/execution/pools.ts';
import type { PoolAdminState, PoolChange, PoolRequirement, PoolRequirementStatus } from './pools.ts';

/**
 * 名额池管理视图（13 号票）。
 *
 * 管理页面要「一个上游账号一行」，但真实的四个数据源粒度不同：
 *   - `pools` 是池级（容量、启用、版本、映射快照）；
 *   - `bindings` 是「凭据指纹 → 池」的显式共享绑定；
 *   - `requirements` 是按模型的（同一个池下的 13 个模型有 13 条）；
 *   - `occupancy` 是池级的（已占 / 已受理 / 可能已发 / 未发 + 正在使用的成员）。
 * 这里把它们压成「池 → 行」的视图模型，页面与测试共用同一份聚合，
 * 避免 UI 自己再拼一遍、拼出与接口不一致的行数或状态。
 *
 * 本文件是**纯函数**：不读数据库、不写数据、不依赖 React。同一凭据跨池只产出
 * 提醒（`warnings`），绝不自动合并——合并必须由管理员显式改绑。
 */

/** 四个白话状态：管理员不需要知道六个内部状态值。 */
export type PoolViewState = 'ready' | 'unconfigured' | 'credential_missing' | 'disabled';

export const POOL_STATE_LABELS: Record<PoolViewState, string> = {
  ready: '可以用',
  unconfigured: '还没设名额',
  credential_missing: '缺密钥',
  disabled: '已停用',
};

export interface PoolViewModel {
  key: string;
  label: string;
  entityType: PoolRequirement['entityType'];
  entityId: string;
  status: PoolRequirementStatus;
}

export interface PoolViewMember {
  actorId: string;
  held: number;
  pending: number;
  running: number;
}

export interface PoolViewRow {
  /** 稳定的行标识：有池键时就是池键，没有池键的孤儿账号用模型键。 */
  id: string;
  /** 内部池编号；页面上默认收起，只有展开「排查用的内部编号」才显示。 */
  poolKey: string;
  /** 账号名：优先取显式绑定的供应商名，其次取该池下模型的供应商名。 */
  accountName: string;
  /** 类别白话：图片 / 视频 / 图片和视频 / 脚本 / 配音 / 画布。 */
  kindLabel: string;
  poolKind: ExecutionPoolSummary['kind'];
  /** 池映射协议；`null` 表示这个池还不存在。 */
  poolProtocol: string | null;
  mappingSnapshot: Record<string, unknown> | null;
  capacity: number;
  /** 池是否启用；未成池的账号按启用处理，保存时沿用这个值。 */
  enabled: boolean;
  version: number;
  /** 池记录是否存在（false = 只有模型、还没设名额）。 */
  configured: boolean;
  state: PoolViewState;
  statusLabel: string;
  statusDetail: string | null;
  nextStep: { label: string; href: string } | null;
  modelCount: number;
  models: PoolViewModel[];
  occupancy: { capacity: number; held: number; accepted: number; maybeSent: number; notSent: number };
  activeMembers: PoolViewMember[];
  /** 保存这次改动时用于 `bind-media-upstream` 的媒体实体；没有媒体模型时为 null。 */
  binding: { entityType: 'image' | 'video'; entityId: string } | null;
  /**
   * 这一行保存时用哪种变更：媒体上游共用池走 `bind-media-upstream`（会顺带写绑定），
   * 其余模块池（脚本 / 配音 / 画布）只能直接 `upsert`。
   */
  saveAction: 'bind-media-upstream' | 'upsert';
  /**
   * 这一行卷进了「同一凭据分属多个池」的提醒时，给一句就地说明；
   * 没卷进去就是 `null`。只是提示，不阻止保存。
   */
  mergeWarning: string | null;
  /** 这个账号能否在本页保存名额（缺密钥、没有池键时为 false）。 */
  canSave: boolean;
}

export interface PoolCredentialWarning {
  /** 凭据指纹（sha256）；页面只用于去重，不直接展示。 */
  fingerprint: string;
  /** 同一凭据当前落在哪些配额池（恰好两个及以上）。 */
  poolKeys: string[];
  message: string;
}

export interface PoolAdminView {
  rows: PoolViewRow[];
  warnings: PoolCredentialWarning[];
  summary: {
    total: number;
    configured: number;
    ready: number;
    unconfigured: number;
    credentialMissing: number;
    disabled: number;
    models: number;
  };
}

const ENTITY_KIND_LABELS: Record<PoolRequirement['entityType'], string> = {
  image: '图片',
  video: '视频',
  script: '脚本',
  tts: '配音',
  canvas: '画布',
};

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => (value ?? '').trim()).filter(Boolean))];
}

function mappingFingerprints(mapping: unknown): string[] {
  if (!mapping || typeof mapping !== 'object') return [];
  const snapshot = mapping as Record<string, unknown>;
  const list = Array.isArray(snapshot.credentialFingerprints)
    ? snapshot.credentialFingerprints.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
  const single = typeof snapshot.credentialFingerprint === 'string' && snapshot.credentialFingerprint
    ? [snapshot.credentialFingerprint]
    : [];
  return uniqueStrings([...list, ...single]);
}

function mappingProtocol(mapping: unknown): string | null {
  if (!mapping || typeof mapping !== 'object') return null;
  const protocol = (mapping as { protocol?: unknown }).protocol;
  return typeof protocol === 'string' && protocol ? protocol : null;
}

function kindLabelFor(models: PoolViewModel[]): string {
  const types = new Set(models.map((model) => model.entityType));
  if (types.size === 0) return '上游账号';
  // 图片和视频是同一类「生成模型」，合起来读更自然；其余类别照原名连起来。
  if (types.size === 2 && types.has('image') && types.has('video')) return '图片和视频';
  return [...types].map((type) => ENTITY_KIND_LABELS[type]).join('、');
}

/**
 * 脚本 / 配音 / 画布这类模块池没有供应商实体可绑，只能在 `/api/team/pools` 里
 * 直接 upsert 池本身；媒体上游池则必须经 `bind-media-upstream` 才会写绑定、
 * 校验映射快照。这里按映射协议判一次，页面和测试用同一份判定。
 */
function isNonMediaModulePool(mapping: unknown): boolean {
  const protocol = mappingProtocol(mapping);
  return protocol !== null && protocol !== 'media-upstream-pool/1' && protocol !== 'legacy-media-upstream/1';
}

/** 没有绑定、也没有模型名的池：用映射快照里的上游地址当账号名（绝不用内部池键）。 */
function upstreamLabel(mapping: unknown): string | null {
  if (!mapping || typeof mapping !== 'object') return null;
  const baseUrl = (mapping as { baseUrl?: unknown }).baseUrl;
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return null;
  let host = baseUrl.trim();
  try { host = new URL(baseUrl).hostname || host; } catch { /* 非标准地址就原样用 */ }
  return `${host} 上游账号`;
}

/** 同一模型可能在 requirements 里出现两次（image/video 与从它派生的 canvas 视图）。 */
function dedupeModels(requirements: PoolRequirement[]): PoolViewModel[] {
  const mediaIds = new Set(requirements
    .filter((item) => item.entityType === 'image' || item.entityType === 'video')
    .map((item) => item.entityId));
  const seen = new Set<string>();
  const models: PoolViewModel[] = [];
  for (const item of requirements) {
    if (item.entityType === 'canvas' && mediaIds.has(item.entityId)) continue;
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    models.push({
      key: item.key,
      label: item.label,
      entityType: item.entityType,
      entityId: item.entityId,
      status: item.status,
    });
  }
  return models;
}

interface DerivedState {
  state: PoolViewState;
  statusDetail: string | null;
  nextStep: PoolViewRow['nextStep'];
}

function deriveState(input: {
  pool: ExecutionPoolSummary | undefined;
  requirements: PoolRequirement[];
}): DerivedState {
  const { pool, requirements } = input;
  if (pool && !pool.enabled) {
    return {
      state: 'disabled',
      statusDetail: '已停用；新任务不会用到这个账号，正在跑的任务不受影响。',
      nextStep: null,
    };
  }
  const statuses = new Set(requirements.map((item) => item.status));
  if (statuses.has('credential_missing')) {
    return {
      state: 'credential_missing',
      statusDetail: '这个账号还没填密钥，员工暂时用不了。',
      nextStep: { label: '去填写密钥', href: '/settings' },
    };
  }
  if (!pool) {
    return {
      state: 'unconfigured',
      statusDetail: '还没给这个账号设名额。',
      nextStep: null,
    };
  }
  if (statuses.has('mapping_mismatch')) {
    return {
      state: 'unconfigured',
      statusDetail: '映射对不上了：密钥或网关地址改过，需要重新确认这个账号的模型。',
      nextStep: { label: '去供应商配置', href: '/settings' },
    };
  }
  if (statuses.has('provider_disabled')) {
    return {
      state: 'unconfigured',
      statusDetail: '还没有启用同类供应商，名额暂时用不上。',
      nextStep: { label: '去供应商配置', href: '/settings' },
    };
  }
  if (pool.capacity <= 0) {
    return {
      state: 'unconfigured',
      statusDetail: '还没给这个账号设名额。',
      nextStep: null,
    };
  }
  if (statuses.has('missing')) {
    return {
      state: 'unconfigured',
      statusDetail: '名额还没保存到服务器，重新保存一次即可。',
      nextStep: null,
    };
  }
  return { state: 'ready', statusDetail: null, nextStep: null };
}

/**
 * 把池管理状态聚合成「一个名额池一行」。
 *
 * 行数等于名额池数：每个 `execution_pools` 记录一行；只在 requirements 里出现、
 * 还没成池的账号（例如同一指纹下的两个供应商）也各占一行，否则管理员没地方给它设名额。
 * 完全没有凭据、没有池键的账号按模型各自成行。
 */
export function buildPoolAdminView(
  state: Pick<PoolAdminState, 'pools' | 'bindings' | 'requirements' | 'occupancy'>,
): PoolAdminView {
  const pools = [...state.pools];
  const bindings = [...state.bindings];
  const occupancyByPool = new Map(state.occupancy.map((item) => [item.poolKey, item]));

  // 按显示分组：池键相同的模型合成一行；没有池键的孤儿账号各占一行。
  const groups = new Map<string, { poolKey: string; requirements: PoolRequirement[] }>();
  const groupKeyOf = (requirement: PoolRequirement) => requirement.poolKey || `model:${requirement.key}`;
  for (const requirement of state.requirements) {
    const groupKey = groupKeyOf(requirement);
    const existing = groups.get(groupKey);
    if (existing) existing.requirements.push(requirement);
    else groups.set(groupKey, { poolKey: requirement.poolKey ?? '', requirements: [requirement] });
  }
  // 没有任何模型的池也必须出现（账号行数 = 名额池数），否则管理员看不到这个池。
  for (const pool of pools) {
    if (!groups.has(pool.poolKey)) groups.set(pool.poolKey, { poolKey: pool.poolKey, requirements: [] });
  }

  const bindingLabelsByPool = new Map<string, string[]>();
  for (const binding of bindings) {
    const labels = bindingLabelsByPool.get(binding.poolKey) ?? [];
    if (binding.label) labels.push(binding.label);
    bindingLabelsByPool.set(binding.poolKey, labels);
  }

  const rows: PoolViewRow[] = [];
  for (const [groupKey, group] of groups) {
    const poolKey = group.poolKey;
    const requirements = group.requirements;
    const pool = pools.find((item) => item.poolKey === poolKey);
    const models = dedupeModels(requirements);
    const occupancy = poolKey ? occupancyByPool.get(poolKey) : undefined;
    const bindingLabels = uniqueStrings(bindingLabelsByPool.get(poolKey) ?? []);
    const modelLabels = uniqueStrings(models.map((model) => model.label));
    // 账号名一律不暴露内部池编号：显式绑定的供应商名优先；没有绑定时用这个池里的模型名，
    // 但要写成「… 等 N 个模型」而不是「N 个账号」——一个池就是一个账号。
    const labels = bindingLabels.length > 0 ? bindingLabels : modelLabels;
    const accountName = labels.length === 1
      ? labels[0]
      : labels.length > 1
        ? `${labels[0]} 等 ${labels.length} ${bindingLabels.length > 0 ? '个账号' : '个模型'}`
        : upstreamLabel(pool?.mappingSnapshot ?? requirements[0]?.mappingSnapshot) ?? '还没登记模型的上游账号';
    const derived = deriveState({ pool, requirements });
    const media = requirements.find((item) => item.entityType === 'image' || item.entityType === 'video');
    rows.push({
      id: groupKey,
      poolKey,
      accountName,
      kindLabel: kindLabelFor(models),
      poolKind: pool?.kind ?? 'remote',
      poolProtocol: mappingProtocol(pool?.mappingSnapshot),
      mappingSnapshot: (pool?.mappingSnapshot as Record<string, unknown> | undefined)
        ?? requirements.find((item) => item.mappingSnapshot && typeof item.mappingSnapshot === 'object')?.mappingSnapshot
        ?? null,
      capacity: pool?.capacity ?? 0,
      enabled: pool?.enabled ?? true,
      version: pool?.version ?? 0,
      configured: Boolean(pool),
      state: derived.state,
      statusLabel: POOL_STATE_LABELS[derived.state],
      statusDetail: derived.statusDetail,
      nextStep: derived.nextStep,
      modelCount: models.length,
      models,
      occupancy: {
        capacity: pool?.capacity ?? occupancy?.capacity ?? 0,
        held: occupancy?.held ?? 0,
        accepted: occupancy?.accepted ?? 0,
        maybeSent: occupancy?.maybeSent ?? 0,
        notSent: occupancy?.notSent ?? 0,
      },
      activeMembers: occupancy?.activeMembers ?? [],
      binding: media && (media.entityType === 'image' || media.entityType === 'video')
        ? { entityType: media.entityType, entityId: media.entityId }
        : null,
      saveAction: media && (media.entityType === 'image' || media.entityType === 'video')
        && !isNonMediaModulePool(pool?.mappingSnapshot ?? media.mappingSnapshot)
        ? 'bind-media-upstream'
        : 'upsert',
      mergeWarning: null,
      canSave: Boolean(poolKey) && !requirements.some((item) => item.status === 'credential_missing'),
    });
  }

  // 行序：可用的排前面，其余按状态严重程度；同状态按池键，保证刷新前后稳定。
  const stateRank: Record<PoolViewState, number> = {
    ready: 0, unconfigured: 1, credential_missing: 2, disabled: 3,
  };
  rows.sort((left, right) => stateRank[left.state] - stateRank[right.state]
    || left.id.localeCompare(right.id));

  // 同一凭据被分到两个及以上配额池：只提醒，建议合并。凭据本身不出现在视图里。
  const poolsByFingerprint = new Map<string, Set<string>>();
  const recordFingerprint = (fingerprint: string, targetPoolKey: string) => {
    if (!fingerprint || !targetPoolKey) return;
    const bucket = poolsByFingerprint.get(fingerprint) ?? new Set<string>();
    bucket.add(targetPoolKey);
    poolsByFingerprint.set(fingerprint, bucket);
  };
  for (const pool of pools) {
    for (const fingerprint of mappingFingerprints(pool.mappingSnapshot)) recordFingerprint(fingerprint, pool.poolKey);
  }
  for (const binding of bindings) {
    const fingerprint = binding.bindingKey.startsWith('media-upstream:')
      ? binding.bindingKey.slice('media-upstream:'.length)
      : '';
    recordFingerprint(fingerprint, binding.poolKey);
  }
  const warnings: PoolCredentialWarning[] = [];
  for (const [fingerprint, poolKeys] of poolsByFingerprint) {
    if (poolKeys.size < 2) continue;
    const sorted = [...poolKeys].sort();
    const nameOf = (key: string) => rows.find((row) => row.poolKey === key)?.accountName ?? key;
    warnings.push({
      fingerprint,
      poolKeys: sorted,
      message: `同一个上游账号的凭据被分到了 ${sorted.length} 个名额池（${sorted.map(nameOf).join('、')}），`
        + '上游实际并发会超过账号额度。建议合并成一个名额池：只保留一个池，并在供应商配置里重新保存该账号。',
    });
  }
  warnings.sort((left, right) => left.poolKeys.join('|').localeCompare(right.poolKeys.join('|')));
  // 每个卷进提醒的池就地给一句说明，管理员不用回头对照顶部提示。
  for (const warning of warnings) {
    for (const poolKey of warning.poolKeys) {
      const row = rows.find((item) => item.poolKey === poolKey);
      if (row) row.mergeWarning = `这个账号的凭据还被绑在另外 ${warning.poolKeys.length - 1} 个名额池里，上游并发会超额；建议合并。`;
    }
  }

  const summary = {
    total: rows.length,
    configured: rows.filter((row) => row.configured).length,
    ready: rows.filter((row) => row.state === 'ready').length,
    unconfigured: rows.filter((row) => row.state === 'unconfigured').length,
    credentialMissing: rows.filter((row) => row.state === 'credential_missing').length,
    disabled: rows.filter((row) => row.state === 'disabled').length,
    models: rows.reduce((total, row) => total + row.modelCount, 0),
  };
  return { rows, warnings, summary };
}

/**
 * 把「改这一行的名额」翻译成 `/api/team/pools` 的一次变更。
 *
 * 名额是池级的：一次保存只产生**一条**变更，作用于整个池，池下全部模型一起生效。
 * 媒体上游池走 `bind-media-upstream`（接口会同时写绑定并校验映射快照）；
 * 脚本 / 配音这类模块池没有供应商实体，只能 `upsert` 池本身。
 *
 * `expectedVersion` 取目标池当前读到的版本号（新池为 0）——这是防并发的唯一依据。
 * 行上的版本号只在这个行的池就是目标池时可用；合并到别的池时由调用方传目标池的版本。
 */
export function buildPoolChange(
  row: Pick<
    PoolViewRow,
    'poolKey' | 'capacity' | 'enabled' | 'version' | 'poolKind' | 'binding' | 'mappingSnapshot' | 'saveAction'
  >,
  next: { capacity: number; enabled?: boolean; targetPoolKey?: string; targetVersion?: number },
): { preview: PoolChange; apply: PoolChange; targetPoolKey: string } {
  const capacity = next.capacity;
  const enabled = next.enabled ?? row.enabled;
  const targetPoolKey = (next.targetPoolKey ?? row.poolKey).trim();
  const expectedVersion = targetPoolKey === row.poolKey ? row.version : (next.targetVersion ?? 0);
  if (targetPoolKey !== row.poolKey && !row.binding) {
    throw new Error('只有媒体上游账号才能合并到别的名额池');
  }
  // 已有旧版池调整容量/开关时保留映射；显式合并仍走共享绑定校验。
  const editingLegacyPool = targetPoolKey === row.poolKey && row.version > 0
    && mappingProtocol(row.mappingSnapshot) === 'legacy-media-upstream/1';
  if (row.saveAction === 'bind-media-upstream' && row.binding && !editingLegacyPool) {
    const change: PoolChange = {
      action: 'bind-media-upstream',
      entityType: row.binding.entityType,
      entityId: row.binding.entityId,
      poolKey: targetPoolKey,
      capacity,
      enabled,
      expectedVersion,
    };
    return { preview: change, apply: change, targetPoolKey };
  }
  const change: PoolChange = {
    action: 'upsert',
    poolKey: targetPoolKey,
    kind: row.poolKind,
    capacity,
    enabled,
    mappingSnapshot: row.mappingSnapshot ?? { protocol: 'remote-pool/1' },
    expectedVersion,
  };
  return { preview: change, apply: change, targetPoolKey };
}

/** 界面里可输入的池键格式；与 `lib/team-service/pools.ts` 的校验保持一致。 */
export const POOL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

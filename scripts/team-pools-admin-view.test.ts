import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * 13 号票：名额池管理视图（一个上游账号一行）。
 *
 * 四条验收里有三条落在这一层：
 *   1. 名额池管理状态按池汇总模型（纯函数）；
 *   3. 同一凭据分属不同池时给出提醒（纯函数）；
 *   2. 改一次名额对整个池生效（接口，走真实 upsertExecutionPool）；
 *   4. 版本号冲突时拒绝保存（接口）。
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-pools-view-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = root;

const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { listExecutionPools } = await import('../lib/media-core/execution/pools.ts');
const {
  applyPoolChanges, previewPoolChanges, readPoolAdminState, TeamPoolError,
  updateUnifiedImageCongestion,
} = await import('../lib/team-service/pools.ts');
const { buildPoolAdminView, buildPoolChange } = await import('../lib/team-service/pool-admin-view.ts');

const admin = { userId: 'admin-1', role: 'admin' as const };

type Requirement = {
  key: string;
  entityType: 'image' | 'video' | 'script' | 'tts' | 'canvas';
  entityId: string;
  label: string;
  poolKey: string;
  kind: 'remote';
  mappingSnapshot: Record<string, unknown>;
  status: 'ready' | 'missing' | 'disabled' | 'mapping_mismatch' | 'credential_missing' | 'provider_disabled';
  message: string | null;
  poolVersion: number | null;
};

function pool(
  poolKey: string,
  capacity: number,
  enabled: boolean,
  mappingSnapshot: Record<string, unknown> = { protocol: 'media-upstream-pool/1', baseUrl: 'https://gw.test', credentialFingerprints: ['fp-1'] },
  version = 1,
) {
  return {
    poolKey, kind: 'remote' as const, capacity, enabled, mappingSnapshot, version,
    updatedAt: '2026-11-07T00:00:00.000Z',
  };
}

function requirement(overrides: Partial<Requirement> & Pick<Requirement, 'key' | 'label' | 'poolKey'>): Requirement {
  const entityType = overrides.entityType ?? 'image';
  return {
    entityType,
    entityId: overrides.key.split(':').at(-1) ?? overrides.key,
    kind: 'remote',
    mappingSnapshot: { protocol: 'media-upstream-pool/1', baseUrl: 'https://gw.test', credentialFingerprints: ['fp-1'] },
    status: 'ready',
    message: null,
    poolVersion: null,
    ...overrides,
  };
}

function stateOf(input: {
  pools?: ReturnType<typeof pool>[];
  bindings?: Array<{ bindingKey: string; poolKey: string; label: string; createdAt?: string; updatedAt?: string }>;
  requirements?: Requirement[];
  occupancy?: Array<{
    poolKey: string; capacity: number; held: number; accepted: number; maybeSent: number; notSent: number;
    activeMembers: Array<{ actorId: string; held: number; pending: number; running: number }>;
  }>;
}) {
  return {
    pools: input.pools ?? [],
    bindings: (input.bindings ?? []).map((binding) => ({
      createdAt: '2026-11-07T00:00:00.000Z', updatedAt: '2026-11-07T00:00:00.000Z', ...binding,
    })),
    requirements: input.requirements ?? [],
    ready: (input.requirements ?? []).every((item) => item.status === 'ready' || item.status === 'provider_disabled'),
    blockers: [],
    occupancy: input.occupancy ?? [],
  };
}

// ---------- 1. 按池汇总模型：一个池一行，模型数 / 占用 / 成员从三个来源合成 ----------

const aggregated = buildPoolAdminView(stateOf({
  pools: [
    pool('media:company', 3, true, { protocol: 'media-upstream-pool/1', baseUrl: 'https://gw.test', credentialFingerprints: ['fp-a', 'fp-b'] }, 4),
    pool('llm:remote', 4, true, { protocol: 'llm-remote/1', modules: ['script'] }, 2),
  ],
  bindings: [
    { bindingKey: 'media-upstream:fp-a', poolKey: 'media:company', label: '公司网关 A' },
    { bindingKey: 'media-upstream:fp-b', poolKey: 'media:company', label: '公司网关 B' },
  ],
  requirements: [
    requirement({ key: 'image:model-a', label: '公司网关 Nano Banana 2', poolKey: 'media:company', poolVersion: 4 }),
    requirement({ key: 'image:model-b', label: '公司网关 Seedream 5.0 Pro', poolKey: 'media:company', poolVersion: 4 }),
    requirement({ key: 'video:model-c', entityType: 'video', label: '公司即梦 Seedance 2.5', poolKey: 'media:company', poolVersion: 4 }),
    requirement({
      key: 'script:llm', entityType: 'script', label: '脚本 / LLM', poolKey: 'llm:remote', poolVersion: 2,
      mappingSnapshot: { protocol: 'llm-remote/1', modules: ['script'] },
    }),
  ],
  occupancy: [
    {
      poolKey: 'media:company', capacity: 3, held: 2, accepted: 1, maybeSent: 1, notSent: 0,
      activeMembers: [{ actorId: 'PUIKIN', held: 2, pending: 1, running: 1 }],
    },
  ],
}));

assert.equal(aggregated.rows.length, 2, '两个名额池就是两行，不按 4 个模型拆行');
const company = aggregated.rows.find((row) => row.poolKey === 'media:company');
assert.ok(company, '必须能按池键找到公司网关那一行');
assert.equal(company!.configured, true);
assert.equal(company!.modelCount, 3, '同一池的 3 个模型必须汇总到一行');
assert.deepEqual(company!.models.map((model) => model.key).sort(), ['image:model-a', 'image:model-b', 'video:model-c']);
assert.equal(company!.capacity, 3, '名额取池级容量');
assert.equal(company!.version, 4);
assert.equal(company!.accountName, '公司网关 A 等 2 个账号', '同一池绑定的多个供应商名要合成账号名');
assert.equal(company!.kindLabel, '图片和视频');
assert.deepEqual(company!.occupancy, { capacity: 3, held: 2, accepted: 1, maybeSent: 1, notSent: 0 });
assert.deepEqual(company!.activeMembers, [{ actorId: 'PUIKIN', held: 2, pending: 1, running: 1 }]);
assert.equal(company!.state, 'ready');
assert.equal(company!.statusLabel, '可以用');

const scriptRow = aggregated.rows.find((row) => row.poolKey === 'llm:remote');
assert.ok(scriptRow);
assert.equal(scriptRow!.modelCount, 1);
assert.equal(scriptRow!.kindLabel, '脚本');
assert.equal(scriptRow!.accountName, '脚本 / LLM');

assert.equal(aggregated.summary.total, 2);
assert.equal(aggregated.summary.configured, 2);
assert.equal(aggregated.summary.ready, 2);
assert.equal(aggregated.summary.models, 4);
assert.deepEqual(aggregated.warnings, [], '两个池各自独立的凭据不算拆分');

// 尚未成池的账号也要有一行（否则管理员没法给它设名额），并带可保存的绑定信息。
const pending = buildPoolAdminView(stateOf({
  requirements: [
    requirement({ key: 'image:new-a', label: '图片供应商 A', poolKey: 'media-upstream:aaaa', status: 'missing' }),
    requirement({ key: 'image:new-b', label: '图片供应商 B', poolKey: 'media-upstream:aaaa', status: 'missing' }),
  ],
  occupancy: [{ poolKey: 'media-upstream:aaaa', capacity: 0, held: 0, accepted: 0, maybeSent: 0, notSent: 0, activeMembers: [] }],
}));
assert.equal(pending.rows.length, 1, '同一池键下还没成池的模型也算一个账号一行');
assert.equal(pending.rows[0].configured, false);
assert.equal(pending.rows[0].state, 'unconfigured');
assert.equal(pending.rows[0].statusLabel, '还没设名额');
assert.equal(pending.rows[0].canSave, true);
assert.deepEqual(pending.rows[0].binding, { entityType: 'image', entityId: 'new-a' });
assert.equal(pending.rows[0].poolKey, 'media-upstream:aaaa');
assert.equal(pending.summary.configured, 0);

// ---------- 4 个白话状态：可以用 / 还没设名额 / 缺密钥 / 已停用 ----------

const states = buildPoolAdminView(stateOf({
  pools: [
    pool('media:off', 5, false, { protocol: 'media-upstream-pool/1', baseUrl: 'https://gw.test', credentialFingerprints: ['fp-off'] }),
    pool('llm:remote', 0, true, { protocol: 'llm-remote/1' }),
    pool('tts:remote', 4, true, { protocol: 'tts-remote/1' }),
  ],
  requirements: [
    requirement({ key: 'image:off', label: '停用账号', poolKey: 'media:off', status: 'disabled', poolVersion: 1 }),
    requirement({
      key: 'script:llm', entityType: 'script', label: '脚本 / LLM', poolKey: 'llm:remote',
      status: 'provider_disabled', mappingSnapshot: { protocol: 'llm-remote/1' }, poolVersion: 1,
    }),
    requirement({
      key: 'tts:tts', entityType: 'tts', label: 'TTS / 字幕对齐', poolKey: 'tts:remote',
      status: 'mapping_mismatch', message: '资源池 tts:remote 的映射与当前供应商身份不一致，请重新确认。',
      mappingSnapshot: { protocol: 'tts-remote/1' }, poolVersion: 1,
    }),
    requirement({ key: 'image:nokey', label: '即梦官方账号', poolKey: '', status: 'credential_missing' }),
  ],
}));
const byKey = (key: string) => states.rows.find((row) => row.poolKey === key)!;
assert.equal(byKey('media:off').state, 'disabled');
assert.equal(byKey('media:off').statusLabel, '已停用');
assert.equal(byKey('llm:remote').state, 'unconfigured', '名额 0 等于还没设名额');
assert.equal(byKey('tts:remote').state, 'unconfigured', '映射不一致归入还没设名额，并用一句话说清去处');
assert.match(byKey('tts:remote').statusDetail ?? '', /映射/);
assert.deepEqual(byKey('tts:remote').nextStep, { label: '去供应商配置', href: '/settings' });
const orphan = states.rows.find((row) => row.poolKey === '')!;
assert.equal(orphan.state, 'credential_missing');
assert.equal(orphan.statusLabel, '缺密钥');
assert.equal(orphan.canSave, false, '没有池键的账号只能去填密钥，不能在这里存名额');
assert.ok(orphan.nextStep?.href === '/settings');
assert.equal(states.summary.credentialMissing, 1);
assert.equal(states.summary.unconfigured, 2);
assert.equal(states.summary.disabled, 1);

// ---------- 3. 同一上游凭据被绑到不同名额池：只提醒、不合并 ----------

const splitState = stateOf({
  pools: [
    pool('media:shared', 4, true, { protocol: 'media-upstream-pool/1', baseUrl: 'https://gw.test', credentialFingerprints: ['split-fp'] }),
    pool('media:separate', 2, true, { protocol: 'media-upstream-pool/1', baseUrl: 'https://gw.test', credentialFingerprints: ['split-fp'] }),
    pool('media:other', 2, true, { protocol: 'media-upstream-pool/1', baseUrl: 'https://gw.test', credentialFingerprints: ['other-fp'] }),
  ],
  bindings: [
    { bindingKey: 'media-upstream:split-fp', poolKey: 'media:shared', label: '网关账号' },
    { bindingKey: 'media-upstream:other-fp', poolKey: 'media:other', label: '另一个账号' },
  ],
  requirements: [
    requirement({ key: 'image:split', label: '网关账号 · Nano Banana 2', poolKey: 'media:shared', poolVersion: 1 }),
    requirement({ key: 'image:other', label: '另一个账号 · 可灵 3.0', poolKey: 'media:other', poolVersion: 1 }),
  ],
});
const before = JSON.stringify(splitState);
const split = buildPoolAdminView(splitState);
assert.equal(split.warnings.length, 1, '同一枚指纹落在两个池，必须恰好一条提醒');
assert.deepEqual(split.warnings[0].poolKeys, ['media:separate', 'media:shared']);
assert.match(split.warnings[0].message, /同一个上游账号/);
assert.match(split.warnings[0].message, /合并/);
assert.equal(JSON.stringify(splitState), before, '只提醒，不改数据：视图构建必须是纯函数');
assert.equal(split.rows.length, 3, '提醒不合并行：三个池还是三行');

// 反过来：一个池里放两枚指纹（显式共享）不是问题。
const sharedOk = buildPoolAdminView(stateOf({
  pools: [pool('media:shared', 4, true, { protocol: 'media-upstream-pool/1', baseUrl: 'https://gw.test', credentialFingerprints: ['a', 'b'] })],
  bindings: [
    { bindingKey: 'media-upstream:a', poolKey: 'media:shared', label: 'A' },
    { bindingKey: 'media-upstream:b', poolKey: 'media:shared', label: 'B' },
  ],
  requirements: [requirement({ key: 'image:a', label: 'A', poolKey: 'media:shared', poolVersion: 1 })],
}));
assert.deepEqual(sharedOk.warnings, [], '同一个池里绑多个 Key 是正常共享，不该提醒');

// ---------- 2 / 4. 接口：改一次名额对整个池生效；版本冲突拒绝保存 ----------

fs.mkdirSync(path.join(root, 'data'), { recursive: true });
const db = new Database(path.join(root, 'data', 'workbench.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, baseUrl TEXT NOT NULL DEFAULT '',
    apiKeyEnv TEXT NOT NULL DEFAULT '', apiKey TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1, defaultCostPerImage REAL
  );
  CREATE TABLE IF NOT EXISTS script_providers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
    baseUrl TEXT NOT NULL DEFAULT '', apiKey TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1
  );
`);

try {
  const readiness = await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(root) });
  assert.equal(readiness.available, true, readiness.message);

  const initialSettings = readPoolAdminState(db, admin).unifiedImageCongestion;
  assert.equal(initialSettings.imageCongestionThresholdSec, 30, 'Image 2 default congestion threshold is 30 seconds');
  assert.equal(initialSettings.version, 1);
  assert.throws(
    () => updateUnifiedImageCongestion(db, { userId: 'employee-1', role: 'employee' }, {
      imageCongestionThresholdSec: 10,
      expectedVersion: initialSettings.version,
    }),
    (error: unknown) => error instanceof TeamPoolError && error.status === 403,
  );
  for (const invalid of [-1, 1.5, 3_601, '30']) {
    assert.throws(
      () => updateUnifiedImageCongestion(db, admin, {
        imageCongestionThresholdSec: invalid,
        expectedVersion: initialSettings.version,
      }),
      (error: unknown) => error instanceof TeamPoolError && error.status === 400,
    );
  }
  const updatedSettings = updateUnifiedImageCongestion(db, admin, {
    imageCongestionThresholdSec: 12,
    expectedVersion: initialSettings.version,
  });
  assert.equal(updatedSettings.imageCongestionThresholdSec, 12);
  assert.equal(updatedSettings.version, initialSettings.version + 1);
  assert.equal(readPoolAdminState(db, admin).unifiedImageCongestion.imageCongestionThresholdSec, 12);
  assert.throws(
    () => updateUnifiedImageCongestion(db, admin, {
      imageCongestionThresholdSec: 20,
      expectedVersion: initialSettings.version,
    }),
    (error: unknown) => error instanceof TeamPoolError && error.code === 'settings_version_conflict',
  );

  // 两个 Key 属于同一个真实上游（同 baseUrl、不同 Key），管理员显式绑到同一个池。
  db.prepare(`INSERT INTO providers (id, name, baseUrl, apiKey, model, type, enabled)
    VALUES ('pool-img-a', '公司网关模型 A', 'https://gateway.example.test/v1', 'key-a', 'nano-banana-3.1', 'openai-compatible', 1)`).run();
  db.prepare(`INSERT INTO providers (id, name, baseUrl, apiKey, model, type, enabled)
    VALUES ('pool-img-b', '公司网关模型 B', 'https://gateway.example.test/v1', 'key-b', 'doubao-seedream-5-0-pro-image', 'openai-compatible', 1)`).run();
  applyPoolChanges(db, admin, [{
    action: 'bind-media-upstream', entityType: 'image', entityId: 'pool-img-a',
    poolKey: 'media:company', capacity: 3, expectedVersion: 0,
  }]);
  applyPoolChanges(db, admin, [{
    action: 'bind-media-upstream', entityType: 'image', entityId: 'pool-img-b',
    poolKey: 'media:company', capacity: 3, expectedVersion: 1,
  }]);

  const beforeSave = readPoolAdminState(db, admin);
  const beforeView = buildPoolAdminView(beforeSave);
  const row = beforeView.rows.find((item) => item.poolKey === 'media:company');
  assert.ok(row);
  assert.equal(row!.modelCount, 2, '两个模型共用一个池 → 一行');
  assert.equal(row!.state, 'ready');
  assert.deepEqual(row!.binding, { entityType: 'image', entityId: 'pool-img-a' });

  // 界面上的一条「保存」= 预览 + 应用，两次都只针对这个池。
  const built = buildPoolChange(row!, { capacity: 7 });
  assert.equal(built.preview.action, 'bind-media-upstream', '媒体上游池必须走绑定接口，才会写绑定并校验映射');
  assert.equal((built.preview as { entityId: string }).entityId, 'pool-img-a');
  assert.equal(built.preview.expectedVersion, 2, 'expectedVersion 必须取读到的池版本');
  for (const change of [built.preview, built.apply]) {
    assert.equal((change as { poolKey: string }).poolKey, 'media:company', '一次保存只产生一条池级变更');
  }
  const preview = previewPoolChanges(db, admin, [built.preview]);
  assert.equal(preview[0].action, 'update');
  assert.equal(preview[0].currentVersion, 2);
  assert.equal(preview[0].nextVersion, 3);
  assert.equal(listExecutionPools(db).find((item) => item.poolKey === 'media:company')!.capacity, 3, '预览不落库');

  applyPoolChanges(db, admin, [built.apply]);
  const afterSave = readPoolAdminState(db, admin);
  const savedPool = afterSave.pools.find((item) => item.poolKey === 'media:company')!;
  assert.equal(savedPool.capacity, 7, '改一次名额，池容量就是 7');
  assert.equal(savedPool.version, 3);
  for (const key of ['image:pool-img-a', 'image:pool-img-b']) {
    const saved = afterSave.requirements.find((item) => item.key === key)!;
    assert.equal(saved.poolKey, 'media:company', `${key} 仍在这个池`);
    assert.equal(saved.status, 'ready', `${key} 的名额随池一起生效`);
    assert.equal(saved.poolVersion, 3, `${key} 看到的是同一个新版本号`);
  }
  // 保存后重新聚合：行数不变、该行状态仍「可以用」、顶部计数跟着变。
  const afterView = buildPoolAdminView(afterSave);
  assert.equal(afterView.rows.length, beforeView.rows.length, '改名额不会多出账号行');
  const savedRow = afterView.rows.find((item) => item.poolKey === 'media:company')!;
  assert.equal(savedRow.capacity, 7);
  assert.equal(savedRow.state, 'ready');
  assert.equal(savedRow.statusLabel, '可以用');
  assert.equal(afterView.summary.ready, 1);
  assert.equal(savedRow.modelCount, 2, '这一行仍然是两个模型共用同一个账号');
  assert.equal(afterView.summary.models, afterView.rows.reduce((total, item) => total + item.modelCount, 0));

  // 版本号冲突：别人刚改过，本次保存必须整体拒绝，容量不变。
  const staleChange = { ...built.preview, capacity: 9, expectedVersion: 2 };
  assert.throws(
    () => previewPoolChanges(db, admin, [staleChange]),
    (error: unknown) => error instanceof TeamPoolError && error.code === 'pool_version_conflict' && error.status === 409,
    '预览阶段就要用版本号拒绝过期保存',
  );
  assert.throws(
    () => applyPoolChanges(db, admin, [staleChange]),
    (error: unknown) => error instanceof TeamPoolError && error.code === 'pool_version_conflict',
  );
  assert.equal(listExecutionPools(db).find((item) => item.poolKey === 'media:company')!.capacity, 7, '冲突保存不得写入');
  assert.equal(
    readPoolAdminState(db, admin).pools.find((item) => item.poolKey === 'media:company')!.version,
    3,
    '冲突保存不得推进版本号',
  );

  // 员工不得读取池管理视图（沿用现有权限规则）。
  assert.throws(
    () => readPoolAdminState(db, { userId: 'employee-1', role: 'employee' }),
    (error: unknown) => error instanceof TeamPoolError && error.status === 403,
  );

  console.log('team pools admin view tests passed');
} finally {
  try { db.close(); } catch { /* 已关闭 */ }
  fs.rmSync(root, { recursive: true, force: true });
}

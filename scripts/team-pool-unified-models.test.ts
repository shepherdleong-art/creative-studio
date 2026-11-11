import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-unified-pools-'));
Object.assign(process.env, {
  CREATIVE_STUDIO_DATA_ROOT: root,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'unified-pools-test',
  CREATIVE_STUDIO_PORT: '13999',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
  CREATIVE_STUDIO_CANVAS_ENABLE: '1',
  CREATIVE_STUDIO_CANVAS_EXECUTOR: 'company',
});
const { ensureServerDeploymentMarker, readRuntimeConfig } = await import('../lib/team-service/config.ts');
const runtime = readRuntimeConfig();
assert.equal(runtime.mode, 'server');
if (runtime.mode === 'server') ensureServerDeploymentMarker(runtime);
const { getDb, closeDb } = await import('../lib/db.ts');
const { seedProviders } = await import('../lib/seed.ts');
const { schemaUpgradeRuntimePaths } = await import('../lib/schema-upgrade/runtime.ts');
const { checkExecutionReadiness } = await import('../lib/media-core/execution/readiness.ts');
const { readPoolAdminState, applyPoolChanges } = await import('../lib/team-service/pools.ts');
const { buildPoolAdminView } = await import('../lib/team-service/pool-admin-view.ts');
const { UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_KLING3_ANCHOR_ID, UNIFIED_IMAGE_CHANNELS, UNIFIED_KLING3_CHANNELS } = await import('../lib/media-core/unified-media/catalog.ts');
const db = getDb();
const admin = { userId: 'admin-pools-test', role: 'admin' as const };

try {
  seedProviders();
  const readiness = await checkExecutionReadiness({ db, ...schemaUpgradeRuntimePaths(root) });
  assert.equal(readiness.available, true, readiness.message);
  db.exec(`
    UPDATE providers SET enabled = 0;
    UPDATE video_providers SET enabled = 0;
    UPDATE script_providers SET enabled = 0;
    UPDATE final_edit_tts_providers SET enabled = 0;
    CREATE TABLE creative_canvas_tasks (id TEXT PRIMARY KEY, providerSnapshot TEXT NOT NULL);
  `);
  for (const channel of UNIFIED_IMAGE_CHANNELS) {
    db.prepare('UPDATE providers SET enabled=1,baseUrl=?,apiKey=? WHERE id=?')
      .run('http://127.0.0.1:9', 'fixture-' + channel.channelKey, channel.providerId);
  }
  for (const channel of UNIFIED_KLING3_CHANNELS) {
    db.prepare('UPDATE video_providers SET enabled=1,baseUrl=?,apiKey=? WHERE id=?')
      .run('http://127.0.0.1:9', 'fixture-' + channel.channelKey, channel.providerId);
  }
  db.prepare('UPDATE providers SET enabled=1 WHERE id=?').run(UNIFIED_IMAGE_ANCHOR_ID);
  db.prepare('UPDATE video_providers SET enabled=1 WHERE id=?').run(UNIFIED_KLING3_ANCHOR_ID);
  const versions = new Map<string, number>();
  for (const [entityType, channels] of [['image', UNIFIED_IMAGE_CHANNELS], ['video', UNIFIED_KLING3_CHANNELS]] as const) {
    for (const channel of channels) {
      const poolKey = 'test:' + channel.channelKey;
      applyPoolChanges(db, admin, [{ action: 'bind-media-upstream', entityType, entityId: channel.providerId, poolKey, capacity: 3, expectedVersion: versions.get(poolKey) ?? 0 }]);
      versions.set(poolKey, (versions.get(poolKey) ?? 0) + 1);
    }
  }
  const state = readPoolAdminState(db, admin);
  const anchors = new Set<string>([UNIFIED_IMAGE_ANCHOR_ID, UNIFIED_KLING3_ANCHOR_ID]);
  const phantom = state.requirements.filter(item => anchors.has(item.entityId));
  assert.deepEqual(phantom.map(item => ({ label: item.label, status: item.status })), [],
    '统一模型是路由入口，不应作为独立图片/视频/画布账号显示“缺密钥”');
  const view = buildPoolAdminView(state);
  assert.ok(!view.rows.some(row => row.models.some(model => anchors.has(model.entityId))),
    '管理员“模型与名额”页面不得显示统一模型的虚假缺密钥账号行');
  for (const channel of [...UNIFIED_IMAGE_CHANNELS, ...UNIFIED_KLING3_CHANNELS]) {
    assert.ok(state.requirements.some(item => item.entityId === channel.providerId && item.status === 'ready'),
      '真实通道的凭据与名额检查必须保留');
  }
  const historicalChannel = UNIFIED_IMAGE_CHANNELS[0];
  db.prepare('INSERT INTO creative_canvas_tasks (id,providerSnapshot) VALUES (?,?)')
    .run('legacy-real-channel', JSON.stringify({ providerIdentity: historicalChannel.providerId }));
  db.prepare('INSERT INTO creative_canvas_tasks (id,providerSnapshot) VALUES (?,?)')
    .run('unified-routing-entry', JSON.stringify({ providerIdentity: UNIFIED_IMAGE_ANCHOR_ID }));
  const historical = readPoolAdminState(db, admin);
  assert.ok(historical.requirements.some(item => item.entityType === 'canvas'
    && item.entityId === historicalChannel.providerId && item.status === 'ready'),
  '旧画布任务的真实通道仍应复用真实名额池');
  assert.ok(!historical.requirements.some(item => anchors.has(item.entityId)),
    '历史画布快照中的统一入口也不得产生虚假账号');
  db.prepare('UPDATE providers SET apiKey=? WHERE id=?').run('', historicalChannel.providerId);
  const missing = readPoolAdminState(db, admin);
  assert.ok(missing.requirements.some(item => item.entityId === historicalChannel.providerId
    && item.entityType === 'image' && item.status === 'credential_missing'),
  '真实通道的密钥确实缺失时必须继续提示');
  assert.ok(!missing.requirements.some(item => anchors.has(item.entityId)));
  console.log('unified model pool configuration tests passed');
} finally {
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}

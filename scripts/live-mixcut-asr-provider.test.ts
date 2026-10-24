/**
 * ASR 供应商配置解析：数据库优先、环境变量兜底。
 *
 * 这些断言覆盖的是「用户在设置页填了 Key 到底会不会生效」这条最容易被
 * 悄悄弄坏的链路：优先级、停用语义、以及表不存在时不能把老配置一起废掉。
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  ASR_KEY_ENV,
  ASR_URL_ENV,
  asrEnvFromDatabase,
  readAsrProviderRow,
  resolveAsrConfig,
  type AsrProviderRow,
} from '../lib/live-mixcut/asr-provider.ts';
import { LIVE_MIXCUT_SCHEMA_V2_SQL } from '../lib/live-mixcut/schema-v2-sql.ts';
import { createVolcFlashAsrAdapter, VOLC_FLASH_ASR_RESOURCE_ID, VOLC_FLASH_ASR_URL } from '../lib/media-core/adapters/volc-asr.ts';

const row = (patch: Partial<AsrProviderRow> = {}): AsrProviderRow => ({
  id: 'volc-flash-asr',
  name: '火山 大模型录音文件极速版识别',
  type: 'volc-flash-asr',
  baseUrl: VOLC_FLASH_ASR_URL,
  apiKey: '',
  keyEnv: ASR_KEY_ENV,
  resourceId: VOLC_FLASH_ASR_RESOURCE_ID,
  model: 'bigmodel',
  enabled: 1,
  isBuiltin: 1,
  ...patch,
});

// 1. 数据库有 Key → 用数据库，且标记来源
{
  const resolved = resolveAsrConfig(row({ apiKey: 'db-key' }), { [ASR_KEY_ENV]: 'env-key' });
  assert.equal(resolved.apiKey, 'db-key', '设置页填的 Key 必须优先于环境变量');
  assert.equal(resolved.keySource, 'database');
  assert.equal(resolved.configured, true);
}

// 2. 数据库没 Key → 回退环境变量，老配置不能失效
{
  const resolved = resolveAsrConfig(row(), { [ASR_KEY_ENV]: 'env-key' });
  assert.equal(resolved.apiKey, 'env-key');
  assert.equal(resolved.keySource, 'env');
  assert.equal(resolved.configured, true);
}

// 3. 两处都没有 → 未配置，且给出默认端点便于界面回显
{
  const resolved = resolveAsrConfig(row(), {});
  assert.equal(resolved.configured, false);
  assert.equal(resolved.keySource, null);
  assert.equal(resolved.baseUrl, VOLC_FLASH_ASR_URL);
  assert.equal(resolved.resourceId, VOLC_FLASH_ASR_RESOURCE_ID);
}

// 4. 明确停用 → 即使数据库有 Key、环境变量也有，都视为未配置
{
  const resolved = resolveAsrConfig(row({ enabled: 0, apiKey: 'db-key' }), { [ASR_KEY_ENV]: 'env-key' });
  assert.equal(resolved.configured, false, '停用后不得偷偷回退环境变量');
  assert.equal(resolved.keySource, null);
}

// 5. 自定义 baseUrl 要生效（用户可能走自建代理）
{
  const resolved = resolveAsrConfig(row({ apiKey: 'k', baseUrl: 'https://proxy.example.com/asr' }), {});
  assert.equal(resolved.baseUrl, 'https://proxy.example.com/asr');
}

// 6. 表不存在时读取返回 null，不得抛错
{
  const db = new Database(':memory:');
  assert.equal(readAsrProviderRow(db), null, '迁移没跑时读取必须安全返回 null');
  // 回退到环境变量仍应可用
  const env = asrEnvFromDatabase(db, { [ASR_KEY_ENV]: 'env-key' });
  assert.equal(env[ASR_KEY_ENV], 'env-key');
  db.close();
}

// 7. 真正执行 v2 迁移：内置行存在、默认未配置、经数据库写入后立即生效
{
  const db = new Database(':memory:');
  db.exec(LIVE_MIXCUT_SCHEMA_V2_SQL);
  const stored = readAsrProviderRow(db);
  assert.ok(stored, 'v2 迁移必须插入内置火山行');
  assert.equal(stored.id, 'volc-flash-asr');
  assert.equal(stored.baseUrl, VOLC_FLASH_ASR_URL);
  assert.equal(stored.resourceId, VOLC_FLASH_ASR_RESOURCE_ID);
  assert.equal(stored.apiKey, '', '内置行 Key 默认为空，等用户填');
  assert.equal(stored.keyEnv, ASR_KEY_ENV);
  assert.equal(resolveAsrConfig(stored, {}).configured, false);

  // 用户在设置页填了 Key —— 模拟 PUT 的写入
  db.prepare('UPDATE live_mixcut_asr_providers SET apiKey = ? WHERE id = ?').run('user-filled-key', 'volc-flash-asr');
  const filled = resolveAsrConfig(readAsrProviderRow(db), {});
  assert.equal(filled.configured, true, '设置页填完 Key 后必须立即变为已配置');
  assert.equal(filled.keySource, 'database');

  // 合并出的 env 必须让适配器认到
  const adapter = createVolcFlashAsrAdapter(asrEnvFromDatabase(db, {}));
  assert.equal(adapter.configured, true, '适配器必须能通过数据库配置变为已配置');

  // 清空 Key 后回退环境变量
  db.prepare('UPDATE live_mixcut_asr_providers SET apiKey = ? WHERE id = ?').run('', 'volc-flash-asr');
  const backToEnv = createVolcFlashAsrAdapter(asrEnvFromDatabase(db, { [ASR_KEY_ENV]: 'env-key' }));
  assert.equal(backToEnv.configured, true, '清空设置页 Key 后应回退环境变量');
  db.close();
}

// 8. 自定义 URL 要能传给适配器（endpointHash 随之变化）
{
  const db = new Database(':memory:');
  db.exec(LIVE_MIXCUT_SCHEMA_V2_SQL);
  db.prepare('UPDATE live_mixcut_asr_providers SET apiKey = ?, baseUrl = ? WHERE id = ?')
    .run('k', 'https://custom.example.com/asr', 'volc-flash-asr');
  const env = asrEnvFromDatabase(db, {});
  assert.equal(env[ASR_URL_ENV], 'https://custom.example.com/asr');
  const custom = createVolcFlashAsrAdapter(env);
  assert.notEqual(custom.identity.endpointHash, createVolcFlashAsrAdapter({ [ASR_KEY_ENV]: 'k' }).identity.endpointHash,
    '换了端点，身份哈希必须不同，避免旧任务误用新服务');
  db.close();
}

console.log('live-mixcut asr provider tests passed');

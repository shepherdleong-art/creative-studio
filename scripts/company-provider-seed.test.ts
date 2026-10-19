import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-company-seed-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = dataRoot;

try {
  const { getDb, closeDb } = await import('../lib/db.ts');
  const { seedProviders, seedAllVideo, COMPANY_LITELLM_BASE_URL } = await import('../lib/seed.ts');
  const { getVideoProviderConfigState } = await import('../lib/video-auth.ts');

  seedProviders();
  seedAllVideo();
  // 再跑一遍：种子必须幂等，不产生重复行、不改写已播种配置
  seedProviders();
  seedAllVideo();

  const db = getDb();

  // 图片：公司网关 image2-medium 开箱即用
  const image = db.prepare(`SELECT * FROM providers WHERE id = 'company-gateway-image2-medium'`).get() as Record<string, unknown>;
  assert.equal(image.type, 'gateway-task-image');
  assert.equal(image.baseUrl, COMPANY_LITELLM_BASE_URL);
  assert.equal(image.model, 'image2-medium');
  assert.equal(image.enabled, 1);
  assert.ok(image.apiKey, '公司图片供应商种子必须带非空 apiKey（LiteLLM 不校验，仅占位）');
  const imageCount = db.prepare(`SELECT COUNT(*) AS c FROM providers WHERE id = 'company-gateway-image2-medium'`).get() as { c: number };
  assert.equal(imageCount.c, 1);

  // 视频：公司可灵 3.0 / 公司即梦 Fast，均为 openai-video 且配置完整
  for (const [id, model] of [
    ['company-kling-3-0', 'kling-3.0'],
    ['company-seedance-2-0-fast', 'doubao-seedance-2-0-fast-260128'],
  ] as const) {
    const row = db.prepare(`SELECT * FROM video_providers WHERE id = ?`).get(id) as Record<string, unknown>;
    assert.equal(row.type, 'openai-video');
    assert.equal(row.baseUrl, COMPANY_LITELLM_BASE_URL);
    assert.equal(row.defaultModel, model);
    assert.equal(row.enabled, 1);
    assert.deepEqual(getVideoProviderConfigState(row as never), { configured: true, missing: [] });
  }

  // 脚本：GPT 内置供应商指向公司模型（company scope + 视觉）
  const gpt = db.prepare(`SELECT * FROM script_providers WHERE id = 'gpt'`).get() as Record<string, unknown>;
  assert.equal(gpt.baseUrl, COMPANY_LITELLM_BASE_URL);
  assert.equal(gpt.model, 'GPT-5-6-Luna-Standard');
  assert.equal(gpt.executionScope, 'company');
  assert.equal(gpt.supportsVision, 1);
  assert.ok(gpt.apiKey);

  // 其他内置脚本供应商保持 external 且不预填公司地址
  const kimi = db.prepare(`SELECT * FROM script_providers WHERE id = 'kimi'`).get() as Record<string, unknown>;
  assert.equal(kimi.executionScope, 'external');
  assert.equal(kimi.baseUrl, '');

  // 场景 B：库里已有手工配置的同模型公司供应商时，补种不得重复添加
  db.prepare(`DELETE FROM providers WHERE id = 'company-gateway-image2-medium'`).run();
  db.prepare(`DELETE FROM video_providers WHERE id IN ('company-kling-3-0', 'company-seedance-2-0-fast')`).run();
  db.prepare(`
    INSERT INTO providers (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled, defaultCostPerImage)
    VALUES ('manual-company-image', '手工公司图', 'http://127.0.0.1:4000', 'COMPANY_API_KEY', 'manual-key', 'image2-medium', 'gateway-task-image', 1, 1.05)
  `).run();
  db.prepare(`
    INSERT INTO video_providers (id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel, enabled, defaultDurationSec, baseUrl, apiKey, accessKey, secretKey)
    VALUES ('manual-company-kling', '手工公司可灵', 'openai-video', '', '', '', 'kling-3.0', 1, 5, 'http://127.0.0.1:4000', 'manual-key', '', '')
  `).run();
  seedProviders();
  seedAllVideo();
  const imageAfterManual = db.prepare(`SELECT COUNT(*) AS c FROM providers WHERE type = 'gateway-task-image' AND model = 'image2-medium'`).get() as { c: number };
  assert.equal(imageAfterManual.c, 1, '已有手工公司图片供应商时不得再补种');
  const klingAfterManual = db.prepare(`SELECT COUNT(*) AS c FROM video_providers WHERE type = 'openai-video' AND defaultModel = 'kling-3.0'`).get() as { c: number };
  assert.equal(klingAfterManual.c, 1, '已有手工公司可灵时不得再补种');
  const seedanceReadded = db.prepare(`SELECT COUNT(*) AS c FROM video_providers WHERE id = 'company-seedance-2-0-fast'`).get() as { c: number };
  assert.equal(seedanceReadded.c, 1, '未手工配置的模型仍应补种');

  closeDb();
  console.log('company provider seed tests passed');
} finally {
  // Windows 上 WAL 文件句柄释放有延迟，清理失败不影响测试结果
  try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch { /* 临时目录留待系统清理 */ }
}

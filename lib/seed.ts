import { getDb } from './db.ts';
import { GPTGE_GPT_IMAGE_2_PROVIDER } from './image-provider-presets.ts';
import { isPlaceholderValue } from './video-auth.ts';
import { defaultScriptProviderConfigs } from './script-providers/config.ts';
import { v4 as uuidv4 } from 'uuid';

// 公司供应商统一经本机 LiteLLM 代理（127.0.0.1:4000）转发；代理不校验调用方
// Bearer（上游真实 Key 由包内 config.yaml 持有），所以种子里的 apiKey 只需非空
// 且不被占位清理识别——不能含 'example.com' / 'your-'（见 video-auth.ts）。
// 这两项只在新库首次播种时写入；已有库的用户配置不会被覆盖。
export const COMPANY_LITELLM_BASE_URL = 'http://127.0.0.1:4000';
const COMPANY_LITELLM_PLACEHOLDER_KEY = 'litellm-local-passthrough';

export function seedProviders() {
  const db = getDb();

  const existing = db.prepare(`SELECT COUNT(*) as count FROM providers`).get() as { count: number };
  if (existing.count === 0) {
    const providers = [
      {
        id: uuidv4(),
        name: 'GeekAI',
        baseUrl: 'https://geekai.co/api',
        apiKeyEnv: 'GEEKAI_API_KEY',
        apiKey: '',
        model: 'gpt-image-2',
        type: 'geekai-json',
        enabled: 1,
        defaultCostPerImage: 0.5,
      },
      {
        id: 'packy-gpt-image-2',
        name: 'Packy GPT-Image-2',
        baseUrl: 'https://www.packyapi.com',
        apiKeyEnv: 'PACKY_API_KEY',
        apiKey: '',
        model: 'gpt-image-2',
        type: 'packy-images',
        enabled: 0,
        defaultCostPerImage: 0.5,
      },
      GPTGE_GPT_IMAGE_2_PROVIDER,
      {
        id: 'packy-nano-banana-2',
        name: 'Packy Nano Banana 2',
        baseUrl: 'https://www.packyapi.com',
        apiKeyEnv: 'PACKY_IMAGE_API_KEY',
        apiKey: '',
        model: 'gemini-3.1-flash-image-preview',
        type: 'packy-gemini-image',
        enabled: 0,
        defaultCostPerImage: 0.4,
      },
      {
        id: 'gptge-nano-banana-2-2k',
        name: 'GPT.ge Nano Banana 2 2K',
        baseUrl: 'https://api.gpt.ge',
        apiKeyEnv: 'GPTGE_API_KEY',
        apiKey: '',
        model: 'gemini-3.1-flash-image-2k',
        type: 'packy-gemini-image',
        enabled: 0,
        defaultCostPerImage: 0.25,
      },
      {
        id: 'gptge-nano-banana-pro-2k',
        name: 'GPT.ge Nano Banana Pro 2K',
        baseUrl: 'https://api.gpt.ge',
        apiKeyEnv: 'GPTGE_API_KEY',
        apiKey: '',
        model: 'gemini-3-pro-image-2k',
        type: 'packy-gemini-image',
        enabled: 0,
        defaultCostPerImage: 0.34,
      },
      {
        id: 'packy-nano-banana-pro',
        name: 'Packy Nano Banana Pro',
        baseUrl: 'https://www.packyapi.com',
        apiKeyEnv: 'PACKY_IMAGE_API_KEY',
        apiKey: '',
        model: 'gemini-3-pro-image-preview',
        type: 'packy-gemini-image',
        enabled: 0,
        defaultCostPerImage: 0.7,
      },
    ];

    const insert = db.prepare(
      `INSERT INTO providers (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled, defaultCostPerImage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const p of providers) {
      insert.run(p.id, p.name, p.baseUrl, p.apiKeyEnv, p.apiKey, p.model, p.type, p.enabled, p.defaultCostPerImage);
    }
  }

  // Clean up any placeholder apiKey values that may have been persisted before
  // isPlaceholderValue filtering was added to the seed (self-healing migration).
  cleanPlaceholderKeys(db);
  ensurePackyImageProviders(db);
  ensureGptGeImageProvider(db);
  ensureCompanyImageProvider(db);
}

/**
 * 公司图片供应商（image2-medium，经本机 LiteLLM）开箱即用补种。
 * 只在 canonical ID 缺失时插入；同模型的手工/公网配置仍可并存，且已有
 * canonical 行的用户配置不会被覆盖。
 */
function ensureCompanyImageProvider(db: ReturnType<typeof getDb>) {
  db.prepare(`
    INSERT INTO providers
      (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled, defaultCostPerImage)
    SELECT
      'company-gateway-image2-medium', '公司网关 image2-medium', ?, 'COMPANY_API_KEY', ?, 'image2-medium', 'gateway-task-image', 1, 1.05
    WHERE NOT EXISTS (
      SELECT 1 FROM providers
      WHERE id = 'company-gateway-image2-medium'
    )
  `).run(
    COMPANY_LITELLM_BASE_URL,
    COMPANY_LITELLM_PLACEHOLDER_KEY
  );
}

function cleanPlaceholderKeys(db: ReturnType<typeof getDb>) {
  const rows = db.prepare(
    `SELECT id, apiKey FROM providers WHERE apiKey IS NOT NULL AND apiKey != ''`
  ).all() as Array<{ id: string; apiKey: string }>;

  for (const row of rows) {
    if (isPlaceholderValue(row.apiKey)) {
      db.prepare(`UPDATE providers SET apiKey = '' WHERE id = ?`).run(row.id);
    }
  }
}

function ensurePackyImageProviders(db: ReturnType<typeof getDb>) {
  db.prepare(`
    UPDATE providers
    SET type = 'packy-gemini-image'
    WHERE baseUrl LIKE '%packyapi.com%'
      AND model IN ('gemini-3.1-flash-image-preview', 'gemini-3-pro-image-preview')
  `).run();

  db.prepare(`
    INSERT INTO providers
      (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled, defaultCostPerImage)
    SELECT
      'packy-nano-banana-2', 'Packy Nano Banana 2', ?, 'PACKY_IMAGE_API_KEY', ?, 'gemini-3.1-flash-image-preview', 'packy-gemini-image', 0, 0.4
    WHERE NOT EXISTS (
      SELECT 1 FROM providers
      WHERE baseUrl LIKE '%packyapi.com%'
        AND model = 'gemini-3.1-flash-image-preview'
    )
  `).run(
    'https://www.packyapi.com',
    ''
  );

  db.prepare(`
    INSERT INTO providers
      (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled, defaultCostPerImage)
    SELECT
      'packy-nano-banana-pro', 'Packy Nano Banana Pro', ?, 'PACKY_IMAGE_API_KEY', ?, 'gemini-3-pro-image-preview', 'packy-gemini-image', 0, 0.7
    WHERE NOT EXISTS (
      SELECT 1 FROM providers
      WHERE baseUrl LIKE '%packyapi.com%'
        AND model = 'gemini-3-pro-image-preview'
    )
  `).run(
    'https://www.packyapi.com',
    ''
  );
}

function ensureGptGeImageProvider(db: ReturnType<typeof getDb>) {
  db.prepare(`
    INSERT INTO providers
      (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled, defaultCostPerImage)
    SELECT
      'gptge-gpt-image-2', 'GPT.ge GPT-Image-2', ?, 'GPTGE_API_KEY', ?, 'gpt-image-2', 'openai-compatible', 0, 0.12
    WHERE NOT EXISTS (
      SELECT 1 FROM providers
      WHERE id = 'gptge-gpt-image-2'
        OR (baseUrl LIKE '%api.gpt.ge%' AND model = 'gpt-image-2')
    )
  `).run(
    'https://api.gpt.ge',
    ''
  );

  db.prepare(`
    INSERT INTO providers
      (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled, defaultCostPerImage)
    SELECT
      'gptge-nano-banana-2-2k', 'GPT.ge Nano Banana 2 2K', ?, 'GPTGE_API_KEY', ?, 'gemini-3.1-flash-image-2k', 'packy-gemini-image', 0, 0.25
    WHERE NOT EXISTS (
      SELECT 1 FROM providers
      WHERE id = 'gptge-nano-banana-2-2k'
        OR (baseUrl LIKE '%api.gpt.ge%' AND model = 'gemini-3.1-flash-image-2k')
    )
  `).run(
    'https://api.gpt.ge',
    ''
  );

  db.prepare(`
    INSERT INTO providers
      (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled, defaultCostPerImage)
    SELECT
      'gptge-nano-banana-pro-2k', 'GPT.ge Nano Banana Pro 2K', ?, 'GPTGE_API_KEY', ?, 'gemini-3-pro-image-2k', 'packy-gemini-image', 0, 0.34
    WHERE NOT EXISTS (
      SELECT 1 FROM providers
      WHERE id = 'gptge-nano-banana-pro-2k'
        OR (baseUrl LIKE '%api.gpt.ge%' AND model = 'gemini-3-pro-image-2k')
    )
  `).run(
    'https://api.gpt.ge',
    ''
  );
}

export function seedVideoProviders() {
  const db = getDb();

  const existing = db.prepare(`SELECT COUNT(*) as count FROM video_providers`).get() as { count: number };
  if (existing.count === 0) {
  const providers = [
    {
      id: 'kling-3',
      name: '可灵 3.0',
      type: 'kling',
      baseUrlEnv: 'KLING_VIDEO_BASE_URL',
      apiKeyEnv: 'KLING_VIDEO_API_KEY',
      modelEnv: 'KLING_VIDEO_MODEL',
      defaultModel: 'kling-v3',
      enabled: 1,
      defaultDurationSec: 5,
      baseUrl: '',
      apiKey: '',
      accessKey: '',
      secretKey: '',
    },
    {
      id: 'kling-2-5',
      name: '可灵 2.5',
      type: 'kling',
      baseUrlEnv: 'KLING_VIDEO_BASE_URL',
      apiKeyEnv: 'KLING_VIDEO_API_KEY',
      modelEnv: 'KLING_2_5_VIDEO_MODEL',
      defaultModel: 'kling-v2-5-turbo',
      enabled: 1,
      defaultDurationSec: 5,
      baseUrl: '',
      apiKey: '',
      accessKey: '',
      secretKey: '',
    },
    {
      id: 'jimeng-2',
      name: '即梦 1.5 Pro (Seedance)',
      type: 'jimeng',
      baseUrlEnv: 'JIMENG_VIDEO_BASE_URL',
      apiKeyEnv: 'JIMENG_VIDEO_API_KEY',
      modelEnv: 'JIMENG_VIDEO_MODEL',
      defaultModel: 'doubao-seedance-1-5-pro-251215',
      enabled: 1,
      defaultDurationSec: 5,
      baseUrl: '',
      apiKey: '',
      accessKey: '',
      secretKey: '',
    },
    {
      id: 'jimeng-2-0',
      name: '即梦 2.0 (Seedance 2.0)',
      type: 'jimeng',
      baseUrlEnv: 'JIMENG_VIDEO_BASE_URL',
      apiKeyEnv: 'JIMENG_VIDEO_API_KEY',
      modelEnv: 'JIMENG_VIDEO_MODEL',
      defaultModel: 'doubao-seedance-2-0-260128',
      enabled: 1,
      defaultDurationSec: 5,
      baseUrl: '',
      apiKey: '',
      accessKey: '',
      secretKey: '',
    },
  ];

  const insert = db.prepare(
    `INSERT INTO video_providers (id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel, enabled, defaultDurationSec, baseUrl, apiKey, accessKey, secretKey)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const p of providers) {
    insert.run(p.id, p.name, p.type, p.baseUrlEnv, p.apiKeyEnv, p.modelEnv, p.defaultModel, p.enabled, p.defaultDurationSec, p.baseUrl, p.apiKey, p.accessKey, p.secretKey);
  }
  }

  ensureCompanyVideoProviders(db);
}

/**
 * 公司视频供应商（可灵 3.0 / 即梦 Seedance 2.0 Fast，经本机 LiteLLM）开箱即用补种。
 * 别名必须与 config.yaml 的 model_name 一致；尾帧 allowlist 见
 * lib/company-gateway-tail-frame.ts。只在 canonical ID 缺失时插入；同模型的手工/公网
 * 配置仍可并存，且已有 canonical 行的用户配置不会被覆盖。
 */
function ensureCompanyVideoProviders(db: ReturnType<typeof getDb>) {
  const companyProviders = [
    {
      id: 'company-kling-3-0',
      name: '公司可灵 3.0',
      modelEnv: 'COMPANY_KLING_VIDEO_MODEL',
      defaultModel: 'kling-3.0',
    },
    {
      id: 'company-seedance-2-0-fast',
      name: '公司即梦 Seedance 2.0 Fast',
      modelEnv: 'COMPANY_SEEDANCE_VIDEO_MODEL',
      defaultModel: 'doubao-seedance-2-0-fast-260128',
    },
  ];

  const insert = db.prepare(`
    INSERT INTO video_providers
      (id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel, enabled, defaultDurationSec, baseUrl, apiKey, accessKey, secretKey)
    SELECT ?, ?, 'openai-video', 'COMPANY_VIDEO_BASE_URL', 'COMPANY_VIDEO_API_KEY', ?, ?, 1, 5, ?, ?, '', ''
    WHERE NOT EXISTS (
      SELECT 1 FROM video_providers
      WHERE id = ?
    )
  `);

  for (const p of companyProviders) {
    insert.run(p.id, p.name, p.modelEnv, p.defaultModel, COMPANY_LITELLM_BASE_URL, COMPANY_LITELLM_PLACEHOLDER_KEY, p.id);
  }
}

export function seedScriptProviders() {
  const db = getDb();

  // 新库首次播种时，GPT 直接指向公司供应商（本机 LiteLLM + 公司模型），
  // 开箱即用；ON CONFLICT 不更新 baseUrl/apiKey/model/executionScope/
  // supportsVision，已有库的用户配置保持不变。
  const insert = db.prepare(`
    INSERT INTO script_providers
      (id, name, type, apiStyle, baseUrl, apiKey, model, keyEnv, baseUrlEnv, modelEnv, defaultBaseUrl, defaultModel, maxTokens, enabled, isBuiltin, executionScope, supportsVision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      keyEnv = excluded.keyEnv,
      baseUrlEnv = excluded.baseUrlEnv,
      modelEnv = excluded.modelEnv,
      defaultBaseUrl = excluded.defaultBaseUrl,
      defaultModel = excluded.defaultModel,
      isBuiltin = 1
  `);

  for (const config of defaultScriptProviderConfigs) {
    const isCompanyGpt = config.id === 'gpt';
    insert.run(
      config.id,
      config.name,
      config.id === 'gemini' ? 'gemini' : 'openai-compatible',
      config.apiStyle,
      isCompanyGpt ? COMPANY_LITELLM_BASE_URL : '',
      isCompanyGpt ? COMPANY_LITELLM_PLACEHOLDER_KEY : '',
      isCompanyGpt ? 'GPT-5-6-Luna-Standard' : '',
      config.keyEnv,
      config.baseUrlEnv,
      config.modelEnv,
      config.defaultBaseUrl,
      config.defaultModel,
      config.maxTokens,
      isCompanyGpt ? 'company' : 'external',
      isCompanyGpt ? 1 : 0
    );
  }
}

export function seedMotionTemplates() {
  const db = getDb();

  const templates = [
    {
      id: 'slow-push-in',
      name: '慢速推进',
      description: '镜头缓慢推近主体，适合突出产品质感。',
      prompt: '以当前图片为首帧，镜头缓慢向主体推进，运动平稳自然。保持产品结构、材质、比例、颜色和画面构图稳定，不要添加文字，不要让主体变形。',
    },
    {
      id: 'gentle-static',
      name: '稳定氛围镜头',
      description: '画面基本静止，只保留轻微光影和布料动感。',
      prompt: '以当前图片为首帧，保持固定机位，画面几乎静止，仅有轻微自然光影变化和柔和环境微动。保持产品结构、材质、比例、颜色和构图稳定，不要添加文字。',
    },
    {
      id: 'left-to-right-slide',
      name: '横向滑动',
      description: '镜头从左向右平滑移动，适合展示空间关系。',
      prompt: '以当前图片为首帧，镜头从左向右缓慢平滑滑动，主体始终完整清晰。保持产品结构、材质、比例、颜色和空间关系稳定，不要添加文字，不要产生畸变。',
    },
    {
      id: 'subtle-orbit',
      name: '轻微环绕',
      description: '轻微侧向环绕，增强立体感。',
      prompt: '以当前图片为首帧，镜头围绕主体做非常轻微的侧向环绕，幅度小、速度慢、运动平稳。保持产品结构、材质、比例、颜色和构图稳定，不要添加文字。',
    },
    {
      id: 'detail-push',
      name: '材质细节推进',
      description: '轻微靠近材质细节，适合表现面料、皮质、金属等。',
      prompt: '以当前图片为首帧，镜头缓慢靠近产品材质细节，突出纹理和质感。保持产品结构、材质、比例和颜色真实稳定，不要添加文字，不要让主体变形。',
    },
    {
      id: 'steady-pull-back',
      name: '镜头平稳后拉',
      description: '镜头匀速远离主体，逐渐展现整体环境，适合收尾或空间感展示。',
      prompt: '以当前图片为首帧，镜头平稳缓慢向后拉远，逐渐展现主体与整体环境的关系，运动匀速自然。保持产品结构、材质、比例、颜色和画面构图稳定，不要添加文字，不要让主体变形。',
    },
  ];

  // 逐行幂等插入（而非空表才种子），让老库也能拿到后续新增的模板。
  const insert = db.prepare(
    `INSERT OR IGNORE INTO video_prompt_templates (id, name, description, prompt, category, isBuiltin)
     VALUES (?, ?, ?, ?, 'camera_motion', 1)`
  );

  for (const t of templates) {
    insert.run(t.id, t.name, t.description, t.prompt);
  }
}

export function seedAllVideo() {
  seedVideoProviders();
  seedMotionTemplates();
  seedScriptProviders();
}

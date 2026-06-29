import { getDb } from '@/lib/db';
import { GPTGE_GPT_IMAGE_2_PROVIDER } from '@/lib/image-provider-presets';
import { isPlaceholderValue } from '@/lib/video-auth';
import { defaultScriptProviderConfigs } from '@/lib/script-providers/config';
import { v4 as uuidv4 } from 'uuid';

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
      {
        id: uuidv4(),
        name: '公司现有 API',
        baseUrl: 'https://company-gateway.example.com',
        apiKeyEnv: 'COMPANY_API_KEY',
        apiKey: '',
        model: 'gpt-image-2',
        type: 'openai-compatible',
        enabled: 0,
        defaultCostPerImage: 1.2,
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
  if (existing.count > 0) return;

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

export function seedScriptProviders() {
  const db = getDb();

  const insert = db.prepare(`
    INSERT INTO script_providers
      (id, name, type, apiStyle, baseUrl, apiKey, model, keyEnv, baseUrlEnv, modelEnv, defaultBaseUrl, defaultModel, maxTokens, enabled, isBuiltin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      type = excluded.type,
      apiStyle = excluded.apiStyle,
      keyEnv = excluded.keyEnv,
      baseUrlEnv = excluded.baseUrlEnv,
      modelEnv = excluded.modelEnv,
      defaultBaseUrl = excluded.defaultBaseUrl,
      defaultModel = excluded.defaultModel,
      maxTokens = excluded.maxTokens,
      isBuiltin = 1
  `);

  for (const config of defaultScriptProviderConfigs) {
    insert.run(
      config.id,
      config.name,
      config.id === 'gemini' ? 'gemini' : 'openai-compatible',
      config.apiStyle,
      '',
      '',
      '',
      config.keyEnv,
      config.baseUrlEnv,
      config.modelEnv,
      config.defaultBaseUrl,
      config.defaultModel,
      config.maxTokens
    );
  }
}

export function seedMotionTemplates() {
  const db = getDb();

  const existing = db.prepare(`SELECT COUNT(*) as count FROM video_prompt_templates`).get() as { count: number };
  if (existing.count > 0) return;

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
  ];

  const insert = db.prepare(
    `INSERT INTO video_prompt_templates (id, name, description, prompt, category, isBuiltin)
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

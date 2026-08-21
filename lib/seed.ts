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

  // 池子里现在清一色是运镜，category 恒为 camera_motion，不再逐条声明。
  const templates: Array<{
    id: string;
    name: string;
    description: string;
    prompt: string;
  }> = [
    // ── 以下 10 条直接对齐视频模型自带的运镜词表 ──────────────────────
    // 用模型训练过的词（推进 / 拉远 / 右摇 / 上摇…），比自造措辞可靠得多。
    {
      id: 'slow-push-in',
      name: '推进',
      description: '镜头向主体缓慢靠近，突出产品质感。',
      prompt: '以当前图片为首帧，镜头推进，向主体缓慢靠近，运动平稳自然。保持产品结构、材质、比例、颜色和画面构图稳定，不要添加文字，不要让主体变形。',
    },
    {
      id: 'steady-pull-back',
      name: '拉远',
      description: '镜头匀速退离主体，交代整体环境，适合收尾。',
      prompt: '以当前图片为首帧，镜头拉远，缓慢退离主体，逐渐展现主体与整体环境的关系，运动匀速自然。保持产品结构、材质、比例、颜色和画面构图稳定，不要添加文字，不要让主体变形。',
    },
    {
      id: 'gentle-static',
      name: '固定镜头',
      description: '机位和光线都不动，只有极轻微的环境微动。',
      prompt: '以当前图片为首帧，固定镜头，机位与镜头全程不动，光线保持恒定，仅有布料、蒸汽、微尘一类极轻微的环境微动。保持产品结构、材质、比例、颜色和构图稳定，不要添加文字。',
    },
    {
      id: 'handheld-drift',
      name: '手持镜头',
      description: '模拟手持呼吸感，给静物加一点活气。',
      prompt: '以当前图片为首帧，手持镜头，画面带有轻微的呼吸感和自然晃动，不产生明显位移。保持产品结构、材质、比例、颜色和构图稳定，不要添加文字，不要让主体变形。',
    },
    {
      id: 'subtle-orbit',
      name: '环绕',
      // 和 orbit-subject 的分别写死在措辞里：这条是「一小段弧线」。
      description: '绕主体走一小段侧向弧线，增强立体感。',
      prompt: '以当前图片为首帧，镜头环绕，绕主体走一小段侧向弧线，幅度小、速度慢、运动平稳。保持产品结构、材质、比例、颜色和构图稳定，不要添加文字。',
    },
    {
      id: 'orbit-subject',
      name: '围绕主体运镜',
      description: '以主体为圆心持续绕行，比「环绕」幅度大。',
      prompt: '以当前图片为首帧，围绕主体运镜，镜头以主体为圆心持续绕行，始终把主体保持在画面中心，运动连贯平稳。保持产品结构、材质、比例、颜色稳定，不要添加文字，不要让主体变形。',
    },
    {
      id: 'follow-subject',
      name: '跟随',
      description: '镜头与主体保持固定距离一路跟着走。',
      prompt: '以当前图片为首帧，跟随镜头，镜头与主体保持相对稳定的距离一路跟随移动，主体始终完整清晰地留在画面内。保持产品结构、材质、比例、颜色稳定，不要添加文字，不要产生畸变。',
    },
    {
      id: 'pan-right',
      name: '右摇',
      description: '机位不动，镜头原地向右转。',
      prompt: '以当前图片为首帧，镜头右摇，机位固定不动，只让镜头原地向右转动，不做任何平移。保持产品结构、材质、比例、颜色稳定，不要添加文字，不要产生畸变。',
    },
    {
      id: 'tilt-up',
      name: '上摇',
      description: '机位不动，镜头由下往上摇起，突出体量感。',
      prompt: '以当前图片为首帧，镜头上摇，机位固定不动，镜头由下向上缓慢摇起，突出主体的体量与气势。保持产品结构、材质、比例、颜色稳定，不要添加文字，不要让主体变形。',
    },
    {
      id: 'tilt-down',
      name: '下摇',
      description: '机位不动，镜头由上往下摇落，交代主体与台面的关系。',
      prompt: '以当前图片为首帧，镜头下摇，机位固定不动，镜头由上向下缓慢摇落，逐渐显露主体与台面的关系。保持产品结构、材质、比例、颜色稳定，不要添加文字，不要让主体变形。',
    },

    // ── 词表之外只补这一条 ──────────────────────────────────────────
    {
      id: 'pan-left',
      name: '左摇',
      // 词表里只给了右摇，左摇是同一个动作的反向，白送的变体。
      description: '右摇的反向，用来错开重复感。',
      prompt: '以当前图片为首帧，镜头左摇，机位固定不动，只让镜头原地向左转动，不做任何平移。保持产品结构、材质、比例、颜色稳定，不要添加文字，不要产生畸变。',
    },
  ];

  // 逐行幂等写入（而非空表才种子），让老库也能拿到后续新增的模板。
  // 这里用 upsert 而不是 INSERT OR IGNORE：detail-push 原先的措辞和 slow-push-in
  // 是同一个镜头动作（六条里有两条是推进），老库必须能拿到修正后的文案，否则
  // 批量填充洗出来的画面还是三分之一在推镜头。DO UPDATE 上的 WHERE 保证只改
  // 内置行，用户自建模板（isBuiltin = 0）永远不会被种子覆盖。
  const upsert = db.prepare(
    `INSERT INTO video_prompt_templates (id, name, description, prompt, category, isBuiltin)
     VALUES (@id, @name, @description, @prompt, 'camera_motion', 1)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       prompt = excluded.prompt,
       category = excluded.category
     WHERE video_prompt_templates.isBuiltin = 1`
  );

  // 退役的内置模板：措辞和别的条目撞脸（detail-push 是推进、横移和左右摇
  // 分不开、升降和上下摇分不开），留着只会让批量填充洗出重复画面。
  const retiredBuiltinIds = [
    'detail-push',
    'left-to-right-slide',
    'right-to-left-slide',
    'slow-pan',
    'pedestal-up',
    'pedestal-down',
    'tilt-up-hero',
    'tilt-down-overview',
    // 这两条不是运镜（一个动焦点一个动光），不在词表里，去掉。
    'rack-focus',
    'light-drift',
  ];

  // video_jobs.templateId 有外键指向这张表，被历史任务引用的行删不掉、也不该
  // 删——那是那条视频的出处。所以只清理没人引用的内置行；仍被引用的留在库里，
  // 代价只是选择器里多一个旧条目。用户自建模板（isBuiltin = 0）一律不碰。
  const retire = db.prepare(
    `DELETE FROM video_prompt_templates
     WHERE id = ?
       AND isBuiltin = 1
       AND NOT EXISTS (SELECT 1 FROM video_jobs WHERE video_jobs.templateId = ?)`
  );

  const writeAll = db.transaction(() => {
    for (const t of templates) {
      upsert.run({
        id: t.id,
        name: t.name,
        description: t.description,
        prompt: t.prompt,
      });
    }
    for (const id of retiredBuiltinIds) retire.run(id, id);
  });
  writeAll();
}

export function seedAllVideo() {
  seedVideoProviders();
  seedMotionTemplates();
  seedScriptProviders();
}

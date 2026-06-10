import { getDb } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';

export function seedProviders() {
  const db = getDb();

  const existing = db.prepare(`SELECT COUNT(*) as count FROM providers`).get() as { count: number };
  if (existing.count > 0) return;

  const providers = [
    {
      id: uuidv4(),
      name: 'GeekAI',
      baseUrl: process.env.GEEKAI_BASE_URL || 'https://geekai.co/api',
      apiKeyEnv: 'GEEKAI_API_KEY',
      apiKey: process.env.GEEKAI_API_KEY || '',
      model: 'gpt-image-2',
      type: 'geekai-json',
      enabled: 1,
      defaultCostPerImage: 0.5,
    },
    {
      id: uuidv4(),
      name: 'Packy GPT-Image-2',
      baseUrl: process.env.PACKY_BASE_URL || 'https://www.packyapi.com',
      apiKeyEnv: 'PACKY_API_KEY',
      apiKey: process.env.PACKY_API_KEY || '',
      model: 'gpt-image-2',
      type: 'packy-images',
      enabled: 0,
      defaultCostPerImage: 0.5,
    },
    {
      id: uuidv4(),
      name: '公司现有 API',
      baseUrl: process.env.COMPANY_BASE_URL || 'https://company-gateway.example.com',
      apiKeyEnv: 'COMPANY_API_KEY',
      apiKey: process.env.COMPANY_API_KEY || '',
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
      defaultModel: 'kling-3.0',
      enabled: 1,
      defaultDurationSec: 5,
    },
    {
      id: 'jimeng-2',
      name: '即梦 2.0',
      type: 'jimeng',
      baseUrlEnv: 'JIMENG_VIDEO_BASE_URL',
      apiKeyEnv: 'JIMENG_VIDEO_API_KEY',
      modelEnv: 'JIMENG_VIDEO_MODEL',
      defaultModel: 'jimeng-2.0',
      enabled: 1,
      defaultDurationSec: 5,
    },
  ];

  const insert = db.prepare(
    `INSERT INTO video_providers (id, name, type, baseUrlEnv, apiKeyEnv, modelEnv, defaultModel, enabled, defaultDurationSec)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const p of providers) {
    insert.run(p.id, p.name, p.type, p.baseUrlEnv, p.apiKeyEnv, p.modelEnv, p.defaultModel, p.enabled, p.defaultDurationSec);
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
}

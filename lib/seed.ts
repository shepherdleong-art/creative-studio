import { getDb } from './db.ts';
import { isPlaceholderValue } from './video-auth.ts';

export function seedProviders() {
  const db = getDb();

  // 不再预置任何第三方图片供应商（GeekAI/Packy/GPT.ge 等）：
  // 内部部署只使用公司供应商，由统一配置导入（provisioning）写入；
  // 既有本地数据库中的历史供应商保留不动。
  cleanPlaceholderKeys(db);
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


export function seedVideoProviders() {
  // 不再预置任何第三方视频供应商（可灵/即梦直连）：内部部署只使用公司供应商，
  // 由统一配置导入（provisioning）写入 openai-video 类型供应商。
  // 既有本地数据库中的历史供应商保留不动。
}

export function seedScriptProviders() {
  // 不再预置任何第三方脚本供应商（Gemini/Qwen/Kimi/GPT 直连）：内部部署只使用公司
  // GPT-5.5，由统一配置导入（provisioning）写入。既有本地数据库中的历史供应商保留不动。
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

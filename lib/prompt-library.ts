/**
 * 「我的常用」提示词库（05 / 06 号票）。
 *
 * 复用现有 `video_prompt_templates` 表的私有归属能力：每一行仍有 `ownerKey`
 * 与团队 scope（私有/公开），`category` 区分三类写法。这样员工保存的全文归本人账号，
 * 公共预设仍是管理员发布的那一行原文，改写另存不会回写公共库。
 *
 * 本文件只放纯函数与常量，路由、组件和测试共用同一份分类与校验。
 */

export const PROMPT_CATEGORIES = ['camera_motion', 'scene', 'shot'] as const;
export type PromptCategory = typeof PROMPT_CATEGORIES[number];

export const PROMPT_CATEGORY_LABELS: Record<PromptCategory, string> = {
  camera_motion: '视频运镜',
  scene: '场景图',
  shot: '分镜',
};

export const MY_PROMPT_NAME_MAX = 24;
export const MY_PROMPT_TEXT_MAX = 1000;

export function parsePromptCategory(value: unknown, fallback: PromptCategory = 'camera_motion'): PromptCategory {
  return typeof value === 'string' && (PROMPT_CATEGORIES as readonly string[]).includes(value)
    ? value as PromptCategory
    : fallback;
}

export type MyPromptInput =
  | { ok: true; value: { name: string; prompt: string; category: PromptCategory } }
  | { ok: false; error: string };

/** 保存/更新一条常用词：名称与全文必填，长度与运镜模板同一套上限。 */
export function normalizeMyPromptInput(raw: unknown): MyPromptInput {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '请求内容不是有效对象' };
  const body = raw as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const category = parsePromptCategory(body.category);
  if (!name) return { ok: false, error: '常用词名称不能为空' };
  if (name.length > MY_PROMPT_NAME_MAX) return { ok: false, error: `常用词名称最多 ${MY_PROMPT_NAME_MAX} 个字` };
  if (!prompt) return { ok: false, error: '提示词不能为空' };
  if (prompt.length > MY_PROMPT_TEXT_MAX) return { ok: false, error: `提示词最多 ${MY_PROMPT_TEXT_MAX} 个字` };
  return { ok: true, value: { name, prompt, category } };
}

/** 从公共预设改写：默认名称加「我的」前缀，便于与公共库原文区分。 */
export function personalCopyName(sourceName: string): string {
  const base = sourceName.trim() || '未命名预设';
  return `我的 ${base}`.slice(0, MY_PROMPT_NAME_MAX);
}

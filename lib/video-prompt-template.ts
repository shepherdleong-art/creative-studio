/**
 * 自定义运镜模板的输入校验。
 *
 * 内置模板由 seed 维护、界面上只读；这里只管用户自建/编辑的那部分。
 */

export const TEMPLATE_NAME_MAX = 24;
export const TEMPLATE_DESCRIPTION_MAX = 60;
export const TEMPLATE_PROMPT_MAX = 1000;

/** 图生视频必须交代首帧来源，否则模型容易抛开原图自由发挥。 */
const HEAD_FRAME_HINT = '以当前图片为首帧';
/** 画面里出现模型自己加的字，在成片里几乎一定要返工。 */
const NO_TEXT_HINT = '不要添加文字';

export interface VideoPromptTemplateInput {
  name: string;
  description: string;
  prompt: string;
  inRandomPool: boolean;
}

export type NormalizeResult =
  | { ok: true; value: VideoPromptTemplateInput; warnings: string[] }
  | { ok: false; error: string };

function readString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 校验并归一化一条模板输入。
 *
 * 硬性错误只有「必填为空」和「超长」两类——提示词怎么写是用户的判断，
 * 我们不替他决定。首帧和禁字这两条以 warnings 返回，由界面提示，不拦提交。
 */
export function normalizeVideoPromptTemplateInput(raw: unknown): NormalizeResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '请求内容不是有效对象' };
  const body = raw as Record<string, unknown>;

  const name = readString(body, 'name');
  const description = readString(body, 'description');
  const prompt = readString(body, 'prompt');

  if (!name) return { ok: false, error: '模板名称不能为空' };
  if (name.length > TEMPLATE_NAME_MAX) {
    return { ok: false, error: `模板名称最多 ${TEMPLATE_NAME_MAX} 个字` };
  }
  if (description.length > TEMPLATE_DESCRIPTION_MAX) {
    return { ok: false, error: `模板描述最多 ${TEMPLATE_DESCRIPTION_MAX} 个字` };
  }
  if (!prompt) return { ok: false, error: '提示词不能为空' };
  if (prompt.length > TEMPLATE_PROMPT_MAX) {
    return { ok: false, error: `提示词最多 ${TEMPLATE_PROMPT_MAX} 个字` };
  }

  const warnings: string[] = [];
  if (!prompt.includes(HEAD_FRAME_HINT)) {
    warnings.push(`提示词里建议写上「${HEAD_FRAME_HINT}」，否则模型可能抛开原图自由发挥。`);
  }
  if (!prompt.includes(NO_TEXT_HINT)) {
    warnings.push(`提示词里建议写上「${NO_TEXT_HINT}」，否则画面里可能被模型加字。`);
  }

  return {
    ok: true,
    warnings,
    value: {
      name,
      description,
      prompt,
      // 缺省入池：新建模板的人绝大多数就是想让它参与随机填充。
      inRandomPool: body.inRandomPool === undefined ? true : Boolean(body.inRandomPool),
    },
  };
}

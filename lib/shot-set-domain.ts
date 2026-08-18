/**
 * 分镜组的共享领域规则。
 *
 * 建组有两条入口:项目创建时的整包创建(app/api/projects/route.ts)、以及
 * 独立的建组接口(app/api/projects/[id]/shot-sets/route.ts)。历史上两条
 * 路径的校验不一致 —— 独立接口有 9 张上限和去重,项目创建路径两样都没有。
 * 所有校验集中在这里,两条路径都必须走同一个函数。
 */

/**
 * 一个【普通】分镜组最多容纳多少张分镜图。
 *
 * 这个上限来自第 3 步脚本生成的视觉预算,不是存储或渲染约束:
 * lib/script-vision-image.ts 给整批分镜图的原始字节总预算是
 * SCRIPT_VISION_TOTAL_RAW_BYTES(4MB),而单图预算是
 * min(SCRIPT_VISION_IMAGE_MAX_BYTES, 4MB / 张数)
 * (见 lib/script-generation-v3-service.ts 的 readShotVisuals 调用)。
 *
 * 张数超过 SHOT_VISION_FULL_QUALITY_MAX 后单图预算开始低于 384KB 满配,
 * 20 张时每张仍有约 200KB,在 1024px 长边下画质可用。
 *
 * 【自由素材工位不受这个上限约束】(D18)。它的图片数量无上限,代价是
 * 图多时第 3 步会降质 —— 由 ScriptStrategyConfig 的软提示兜住,不拦截。
 */
export const MAX_SHOTS_PER_SET = 20;

/**
 * 超过这个张数,脚本生成会开始压缩每张分镜图的画质。
 * 4MB / 384KB ≈ 10.67,所以 10 张以内是满配。
 */
export const SHOT_VISION_FULL_QUALITY_MAX = 10;

/**
 * 分镜组类型。
 * - storyboard: 常规分镜组,参与第 2 步「用场景参考图批量生成分镜图」
 * - free:       自由素材工位,直接上传图片做视频,不参与第 2 步;一个项目一个
 */
export type ShotSetKind = 'storyboard' | 'free';

export const SHOT_SET_KINDS: readonly ShotSetKind[] = ['storyboard', 'free'];

export function isShotSetKind(value: unknown): value is ShotSetKind {
  return typeof value === 'string' && (SHOT_SET_KINDS as readonly string[]).includes(value);
}

/** 自由素材工位的固定名字。一个项目只有一个,不需要用户命名。 */
export const FREE_SHOT_SET_NAME = '自由素材工位';

export type NormalizeShotImageIdsResult =
  | { ok: true; ids: string[] }
  | { ok: false; error: string };

/**
 * 归一化建组用的图片 id 列表:接受缺省 → 过滤脏值 → 去重 → 校验数量。
 *
 * 去重发生在数量校验之前,所以「21 个 id 里有一个重复」会被算成 20 张
 * 并放行,而不是误杀。
 *
 * 【务必保留 nullish 分支】新建项目页(app/projects/new/page.tsx)根本不
 * 发送 shotImageIds,所以 allowEmpty 场景下 undefined / null 必须当成
 * 空数组放行。把这条规则放在函数内部(而不是让调用方写 `?? []`),是为了
 * 让下一个调用方不必重新踩一遍这个坑。
 *
 * @param options.allowEmpty 项目创建路径和自由工位允许空(表示暂时没有图);
 *                           普通的独立建组接口不允许。
 * @param options.max        数量上限。默认 MAX_SHOTS_PER_SET;传 null 表示
 *                           不限(自由素材工位,见 D18)。
 */
export function normalizeShotImageIds(
  raw: unknown,
  options: { allowEmpty?: boolean; max?: number | null } = {},
): NormalizeShotImageIdsResult {
  const max = options.max === undefined ? MAX_SHOTS_PER_SET : options.max;

  if (raw === undefined || raw === null) {
    return options.allowEmpty
      ? { ok: true, ids: [] }
      : { ok: false, error: 'shotImageIds 必须是数组' };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'shotImageIds 必须是数组' };
  }
  const ids = [...new Set(
    raw.filter((value): value is string => typeof value === 'string' && value.length > 0),
  )];
  if (ids.length === 0) {
    return options.allowEmpty
      ? { ok: true, ids }
      : { ok: false, error: '至少需要 1 张分镜图' };
  }
  if (max !== null && ids.length > max) {
    return { ok: false, error: `分镜图最多 ${max} 张` };
  }
  return { ok: true, ids };
}

/**
 * 项目工作台第 1 步（场景图）与第 2 步（分镜）的纯规则（07 号票）。
 *
 * 这里只放「不依赖 React、能直接跑单测」的判断：新建分镜组的点选顺序、
 * 全选/取消全选、设为开场、版本切换、失败分镜不能标可用，以及左右键在
 * 候选/分镜之间移动时的下标收口。页面组件与组件里的按钮都调这些函数，
 * 保证「界面上的行为」和「单测断言的行为」是同一份实现。
 */

/** 第 1 步中间栏的两种视图：对照原图 / 网格。 */
export type SceneViewMode = 'compare' | 'grid';

export const SCENE_VIEW_MODES: readonly SceneViewMode[] = ['compare', 'grid'];

export function isSceneViewMode(value: unknown): value is SceneViewMode {
  return typeof value === 'string' && (SCENE_VIEW_MODES as readonly string[]).includes(value);
}

/**
 * 点一下某张图：已选则取消，未选则按「点选顺序」追加到末尾。
 *
 * **点选顺序就是镜头顺序**（规格第 2 步）：所以这里不能排序、不能去重后重排，
 * 只能追加。超过上限时保持原样（调用方负责提示「最多 N 张」）。
 */
export function togglePickedId(picks: readonly string[], id: string, max: number): string[] {
  if (picks.includes(id)) return picks.filter((item) => item !== id);
  if (picks.length >= Math.max(0, max)) return [...picks];
  return [...picks, id];
}

/** 「全选」的判定：选中数等于 min(素材数, 上限)。 */
export function isAllPicked(picks: readonly string[], libraryIds: readonly string[], max: number): boolean {
  const limit = Math.min(libraryIds.length, Math.max(0, max));
  if (limit === 0) return false;
  if (picks.length !== limit) return false;
  const library = new Set(libraryIds);
  return picks.every((id) => library.has(id));
}

/**
 * 「全选」按钮：已经是全选状态就**再点一次取消全选**（规格明确要求），
 * 否则保留已选顺序、按素材列表顺序补到上限。
 */
export function toggleSelectAll(picks: readonly string[], libraryIds: readonly string[], max: number): string[] {
  if (isAllPicked(picks, libraryIds, max)) return [];
  const limit = Math.max(0, max);
  const next = [...picks];
  for (const id of libraryIds) {
    if (next.length >= limit) break;
    if (!next.includes(id)) next.push(id);
  }
  return next;
}

/**
 * 「设为开场」：把它移到第一位，**其余顺序不变**。
 * 未选中时保持原样（按钮只在已选中的图上出现）。
 */
export function movePickedToFront(picks: readonly string[], id: string): string[] {
  if (!picks.includes(id)) return [...picks];
  return [id, ...picks.filter((item) => item !== id)];
}

/** 开场图 = 第一张（沿用现有「第 1 张为开场产品全景图」规则）。 */
export function getOpeningShotId(picks: readonly string[]): string | null {
  return picks.length > 0 ? picks[0] : null;
}

export function isOpeningShot(picks: readonly string[], id: string): boolean {
  return picks[0] === id;
}

/** 删掉素材时同步把它从已选里移除，顺序保持不变。 */
export function removePickedId(picks: readonly string[], id: string): string[] {
  return picks.filter((item) => item !== id);
}

/** 「第 N 版（共 M 版）」。index 从 0 开始；没有版本时退回「第 1 版」。 */
export function formatShotVersionLabel(index: number, total: number): string {
  const safeTotal = Math.max(0, Math.trunc(total));
  if (safeTotal <= 0) return '第 1 版';
  const safeIndex = clampIndex(index, safeTotal);
  return `第 ${safeIndex + 1} 版（共 ${safeTotal} 版）`;
}

export function clampIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  const value = Number.isFinite(index) ? Math.trunc(index) : 0;
  return Math.max(0, Math.min(total - 1, value));
}

/**
 * 左右键移动下标。首尾**回绕**（分镜/候选是有限的环形列表，走到头再按
 * 应该回到另一端，而不是卡住）；列表为空时返回 0。
 */
export function stepIndex(index: number, delta: number, total: number): number {
  if (total <= 0) return 0;
  const current = clampIndex(index, total);
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  return ((current + step) % total + total) % total;
}

/** 第 2 步结果状态：与 `lib/result-gallery-jobs.ts` 的口径一致，只是输入更窄。 */
export type ShotResultState = 'queued' | 'generating' | 'checking' | 'succeeded' | 'failed' | 'empty';

export function resolveShotResultState(jobStatus: string | null | undefined, hasResult: boolean): ShotResultState {
  if (!jobStatus) return hasResult ? 'succeeded' : 'empty';
  if (jobStatus === 'pending') return 'queued';
  if (jobStatus === 'running' || jobStatus === 'retrying') return 'generating';
  if (jobStatus === 'needs_check') return 'checking';
  if (jobStatus === 'succeeded') return hasResult ? 'succeeded' : 'failed';
  if (jobStatus === 'canceled') return hasResult ? 'succeeded' : 'failed';
  if (jobStatus === 'failed') return 'failed';
  return hasResult ? 'succeeded' : 'empty';
}

/**
 * 失败的分镜**不能标可用**（规格第 2 步第 49 条：没生成出来的分镜能被重试，
 * 但不能被标成可用）。只有真出了图的结果才允许「可用」。
 */
export function canMarkShotAvailable(state: ShotResultState): boolean {
  return state === 'succeeded';
}

/** 失败/取消的任务可重试；排队或运行中重试没有意义。 */
export function canRetryShot(state: ShotResultState): boolean {
  return state === 'failed';
}

/**
 * 「重新生成」的可用条件：已有结果或已失败的分镜都能重做（`/api/jobs/:id/regenerate`
 * 接受 succeeded / failed / canceled / needs_check 作为源任务）。
 *
 * 之前界面拿「能否标可用」当重做门禁，失败的分镜因此点不了重新生成，只能点重试；
 * 重试又不会采用右栏新选的供应商，于是失败后无法换供应商重做。这两件事分开判断。
 */
export function canRegenerateShot(state: ShotResultState): boolean {
  return state === 'succeeded' || state === 'failed';
}

/** 有结果（成功）才能切版本、下载、标状态。 */
export function hasShotResult(state: ShotResultState): boolean {
  return state === 'succeeded';
}

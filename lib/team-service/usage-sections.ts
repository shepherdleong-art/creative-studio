/**
 * 团队用量接口的明细分区（04 号票，功能方案第 7 节）。
 *
 * `GET /api/team/usage` 用 `section` 选择「摘要」或某一个明细列表；默认 `summary`。
 * 本模块零依赖（不 import SQLite / Node / React），05 号票的前端可以直接
 * `import type` 或取值，用于页签与契约类型。
 *
 * 权限（在服务端执行，不能只在 UI 隐藏）：
 * - `summary` / `tasks` / `legacy`：员工本人；管理员可选个人/团队/成员范围。
 * - `channels` / `unmapped`：仅管理员（员工请求返回 403）。
 */
export const TEAM_USAGE_SECTIONS = ['summary', 'tasks', 'channels', 'legacy', 'unmapped'] as const;
export type TeamUsageSection = (typeof TEAM_USAGE_SECTIONS)[number];

/** 明细分区里「每条记录 = 一次真实尝试」的三个互斥分类。 */
export const TEAM_USAGE_ATTEMPT_SECTIONS = ['channels', 'legacy', 'unmapped'] as const;
export type TeamUsageAttemptSection = (typeof TEAM_USAGE_ATTEMPT_SECTIONS)[number];

export const DEFAULT_TEAM_USAGE_SECTION: TeamUsageSection = 'summary';

/** 管理员专有分区：员工请求直接 403。 */
export function isAdminOnlyUsageSection(section: TeamUsageSection): boolean {
  return section === 'channels' || section === 'unmapped';
}

export function isTeamUsageSection(value: unknown): value is TeamUsageSection {
  return typeof value === 'string' && (TEAM_USAGE_SECTIONS as readonly string[]).includes(value);
}

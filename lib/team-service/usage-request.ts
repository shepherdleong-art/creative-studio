import { getShanghaiUsagePeriods, parseUsageBoundary } from '../usage-query.ts';
import { usagePresetRange } from '../usage-date-range.ts';
import type { TeamViewer } from './diagnostics.ts';
import { parseTeamPage, type TeamPageRequest } from './pagination.ts';
import { TeamUsageError, type TeamUsageFilters } from './usage.ts';
import {
  DEFAULT_TEAM_USAGE_SECTION,
  isTeamUsageSection,
  type TeamUsageSection,
} from './usage-sections.ts';

function boundary(value: string | null): string | undefined {
  try {
    return parseUsageBoundary(value);
  } catch {
    throw new TeamUsageError(400, 'invalid_usage_query', '日期或时间边界无效。');
  }
}

/** 账期筛选解析后的形状：from/to 一定存在（缺省取账期默认值）。 */
export type TeamUsageQueryFilters = TeamUsageFilters & { from: string; to: string };

export function readTeamUsageFilters(request: Request): TeamUsageQueryFilters {
  const params = new URL(request.url).searchParams;
  const periods = getShanghaiUsagePeriods();
  const period = params.get('period') || 'today';
  if (!['today', 'last7', 'week', 'month', 'custom'].includes(period)) throw new TeamUsageError(400, 'invalid_usage_query', '用量账期无效。');
  const last7Range = usagePresetRange('last7');
  const last7 = { from: boundary(last7Range.from) as string, to: periods.today.to };
  const defaults = period === 'month' ? periods.month : period === 'last7' ? last7 : period === 'week' ? periods.week : periods.today;
  const from = boundary(params.get('from')) ?? defaults.from;
  const to = boundary(params.get('to')) ?? defaults.to;
  if (from >= to) throw new TeamUsageError(400, 'invalid_usage_query', '开始时间必须早于结束时间。');
  const outcome = params.get('outcome');
  if (outcome && outcome !== 'succeeded' && outcome !== 'failed') throw new TeamUsageError(400, 'invalid_usage_query', '任务结果筛选无效。');
  return {
    from,
    to,
    actorUserId: params.get('actorUserId')?.trim() || undefined,
    module: params.get('module')?.trim() || undefined,
    model: params.get('model')?.trim() || undefined,
    outcome: outcome as 'succeeded' | 'failed' | undefined,
  };
}

/** `section` 缺省/空串 = `summary`；非法值 400（复用与任务页一致的错误形状）。 */
export function readTeamUsageSection(request: Request): TeamUsageSection {
  const value = new URL(request.url).searchParams.get('section')?.trim();
  if (!value) return DEFAULT_TEAM_USAGE_SECTION;
  if (!isTeamUsageSection(value)) {
    throw new TeamUsageError(400, 'invalid_usage_section', '用量明细分区无效。');
  }
  return value;
}

/** `page`/`pageSize` 复用 03 号票的公共分页解析；非法值 400。 */
export function readTeamUsagePage(request: Request): TeamPageRequest {
  const params = new URL(request.url).searchParams;
  return parseTeamPage({ page: params.get('page'), pageSize: params.get('pageSize') });
}

export interface TeamUsageScope {
  filters: TeamUsageQueryFilters;
  teamScope: boolean;
  memberId: string;
}

/**
 * 解析 scope/actorUserId，页面与 CSV 导出共用同一套权限裁决：
 * - `scope=team` 只有管理员有效；员工传 `team` 仍按本人（与页面一致）。
 * - `actorUserId` 是管理员的下钻；员工传他人由 `queryTeamUsage` 层 403。
 * - 页面默认个人范围（`defaultSelf`）；CSV 导出保留「管理员不传 scope = 团队口径」
 *   的既有约定（`defaultSelf: false`），避免成员管理页的「导出本月 CSV」变成空表。
 */
export function readTeamUsageScope(
  request: Request,
  viewer: TeamViewer,
  options: { defaultSelf: boolean },
): TeamUsageScope {
  const params = new URL(request.url).searchParams;
  const filters = readTeamUsageFilters(request);
  const teamScope = params.get('scope') === 'team' && viewer.role === 'admin';
  const explicitSelf = params.get('scope') === 'self';
  if (!teamScope && !filters.actorUserId && (explicitSelf || options.defaultSelf)) {
    filters.actorUserId = viewer.userId;
  }
  return { filters, teamScope, memberId: filters.actorUserId ?? viewer.userId };
}

export interface TeamUsageQuery extends TeamUsageScope {
  section: TeamUsageSection;
  page: TeamPageRequest;
}

/** `GET /api/team/usage` 的完整请求解析：section + 完整筛选 + 分页 + scope。 */
export function readTeamUsageQuery(request: Request, viewer: TeamViewer): TeamUsageQuery {
  return {
    ...readTeamUsageScope(request, viewer, { defaultSelf: true }),
    section: readTeamUsageSection(request),
    page: readTeamUsagePage(request),
  };
}

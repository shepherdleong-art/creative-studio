import { getShanghaiUsagePeriods, parseUsageBoundary } from '../usage-query.ts';
import { usagePresetRange } from '../usage-date-range.ts';
import { TeamUsageError, type TeamUsageFilters } from './usage.ts';

function boundary(value: string | null): string | undefined {
  try {
    return parseUsageBoundary(value);
  } catch {
    throw new TeamUsageError(400, 'invalid_usage_query', '日期或时间边界无效。');
  }
}

export function readTeamUsageFilters(request: Request): TeamUsageFilters {
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

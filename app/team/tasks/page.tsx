import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import TeamTasksPanel from '@/components/team/TeamTasksPanel';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { TEAM_SESSION_COOKIE } from '@/lib/team-service/auth/request';
import { getTeamAuthService } from '@/lib/team-service/auth/runtime';

export const dynamic = 'force-dynamic';

/**
 * 全员任务 / 我的任务（12 号票）。
 *
 * 同一页服务两种身份：管理员看全员（`role="admin"`，工具栏标题由外壳解析成「全员任务」），
 * 员工只看自己（`role="employee"`，标题「我的任务」）。可见范围完全由服务端
 * `listTeamTasks` 决定，页面不参与权限判断——员工即使改 URL 也拿不到别人的任务。
 *
 * 详情直链形态：`/team/tasks?taskId=<operationId>`（运行总览的最近任务行就跳这里）。
 */
export default async function TeamTasksPage() {
  if (readRuntimeConfig().mode !== 'server') redirect('/');
  const token = (await cookies()).get(TEAM_SESSION_COOKIE)?.value;
  const principal = token ? getTeamAuthService().resolveSession(token) : null;
  if (!principal || principal.mustChangePassword) redirect('/team/login');
  return <TeamTasksPanel role={principal.role} />;
}

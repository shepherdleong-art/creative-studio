import { authError, authJson } from '../../../../../lib/team-service/auth/http.ts';
import { assertTrustedWriteRequest, requirePrincipal } from '../../../../../lib/team-service/auth/request.ts';
import { TeamAuthError } from '../../../../../lib/team-service/auth/types.ts';
import { viewAsUserCookie } from '../../../../../lib/team-service/view-as-user.ts';
import { withTeamRoute } from '@/lib/team-service/route-wrapper';

/**
 * 管理员一键查看用户视角（04 号票）。
 *
 * 只切**展示**，不动会话：登录身份、权限与数据归属全程不变。
 * 员工调用一律 403；真实员工即使手工写 Cookie，界面也不会切到管理端。
 */
async function __teamRoutePOST(request: Request): Promise<Response> {
  try {
    assertTrustedWriteRequest(request);
    const principal = requirePrincipal(request);
    if (principal.role !== 'admin') {
      throw new TeamAuthError('admin_required', '只有管理员可以切换用户视角。', 403);
    }
    const body = await request.json().catch(() => ({})) as { active?: unknown };
    const active = body.active !== false;
    return authJson(
      { viewMode: active ? 'user' : 'admin' },
      { setCookie: viewAsUserCookie(active) },
    );
  } catch (error) {
    return authError(error);
  }
}

export const POST = withTeamRoute('/api/team/auth/view-as', 'POST', __teamRoutePOST);

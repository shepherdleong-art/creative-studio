'use client';

import { useEffect, useState } from 'react';
import type { WorkspaceRole } from '@/lib/workspace-navigation';

/**
 * 客户端解析当前身份角色（14 号票）。
 *
 * 团队版有两类页面：服务端页面可以直接把 `principal.role` 传下来（出错的任务、
 * 回收站、成员与账号、公共资源、版本与备份），而用量与供应商配置是整页客户端
 * 组件（`useSearchParams`、大量本地状态），拿不到服务端 principal。后者用这个
 * 钩子向同一份会话接口取角色，只为选对每页工具栏的标题文案——不判断权限，
 * 权限仍由各页服务端闸门与接口把关。
 *
 * 未登录或本地版返回 null：此时各页不渲染团队版工具栏。
 */
export function useTeamRole(): WorkspaceRole | null {
  const [role, setRole] = useState<WorkspaceRole | null>(null);
  useEffect(() => {
    if (document.documentElement.dataset.deploymentMode !== 'server') return undefined;
    let active = true;
    void fetch('/api/team/auth/session', { cache: 'no-store', credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) return;
        const body = await response.json() as { authenticated?: boolean; principal?: { role?: string } };
        if (!active || !body.authenticated) return;
        if (body.principal?.role === 'admin' || body.principal?.role === 'employee') setRole(body.principal.role);
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);
  return role;
}

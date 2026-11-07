'use client';

import { useEffect, useId, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import { PageToolbar as SharedPageToolbar } from '@/components/ui/Appearance';
import { workspacePageTitle, type WorkspaceRole } from '@/lib/workspace-navigation';
import {
  claimPageToolbar,
  readPageToolbarClaimed,
  readPageToolbarClaimedOnServer,
  subscribePageToolbarClaim,
} from './page-toolbar-claim';

/** 整幅编辑器页面（画布编辑器、项目工作台）自己铺满，不要外壳标题条。
 * 注意 `/projects/new` 是普通表单页，必须排除在 `/projects/[id]` 之外。 */
const FULL_BLEED = [/^\/canvas\/[^/]+$/, /^\/projects\/(?!new$)[^/]+$/];

/**
 * 外壳级页面标题（05 号票）。
 *
 * 每个团队版页面一进来就有正确的页面标题（= 导航名，见 `lib/workspace-navigation.ts`），
 * 这样任何票都不需要自己记得写标题。用的是 02 号票的共用工具栏部件
 * （`components/ui/Appearance`），和页面自己的工具栏长得一模一样。
 *
 * 页面接管工具栏（挂 `<PageToolbar>` 并删掉自己的 `<h1>`）之后，这条自动让位——
 * 见 `page-toolbar-claim.ts`，所以过渡期不会出现「两条工具栏」。
 */
export default function WorkspacePageHeader({ role }: { role: WorkspaceRole }) {
  const pathname = usePathname();
  const claimed = useSyncExternalStore(subscribePageToolbarClaim, readPageToolbarClaimed, readPageToolbarClaimedOnServer);
  if (claimed) return null;
  if (FULL_BLEED.some((pattern) => pattern.test(pathname))) return null;
  const title = workspacePageTitle(pathname, role);
  if (!title) return null;
  return (
    <div data-testid="page-toolbar" data-page-title={title} data-toolbar-mode="shell">
      <SharedPageToolbar title={<span data-testid="page-toolbar-title">{title}</span>} />
    </div>
  );
}

/**
 * 页面工具栏的挂载登记：用 `<PageToolbar>` 的页面自动占用，外壳那条隐藏。
 * 单独导出是给「页面自己画了工具栏但没走 PageToolbar」的极端情况留的后门。
 */
export function usePageToolbarClaim(active = true): void {
  const owner = useId();
  useEffect(() => {
    if (!active) return undefined;
    return claimPageToolbar(owner);
  }, [active, owner]);
}

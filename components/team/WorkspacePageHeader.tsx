'use client';

import { useEffect, useId, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import { workspacePageTitle, type WorkspaceRole } from '@/lib/workspace-navigation';
import {
  claimPageToolbar,
  readPageToolbarClaimed,
  readPageToolbarClaimedOnServer,
  subscribePageToolbarClaim,
} from './page-toolbar-claim';
import s from './workspace.module.css';

/** 整幅编辑器页面（画布编辑器）自己铺满，不要外壳标题条。 */
const FULL_BLEED = [/^\/canvas\/[^/]+$/, /^\/projects\/[^/]+$/, /^\/team\/login$/];

/**
 * 外壳级页面标题（05 号票）。
 *
 * 每个团队版页面一进来就有正确的页面标题（= 导航名，见 `lib/workspace-navigation.ts`），
 * 这样任何票都不需要自己记得写标题。这是**紧凑的定位条**而不是大标题：页里原本的
 * `<h1>` 还在（归各自的票），两个大标题叠在一起才是真的退步。
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
    <div className={s.pageCrumb} data-testid="page-toolbar" data-page-title={title} data-toolbar-mode="compact">
      <span data-testid="page-toolbar-title">{title}</span>
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

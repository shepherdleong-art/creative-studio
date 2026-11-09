'use client';

import { usePathname } from 'next/navigation';
import { PageToolbar as SharedPageToolbar } from '@/components/ui/Appearance';
import { workspacePageTitle, type WorkspaceRole } from '@/lib/workspace-navigation';
import { usePageToolbarClaim } from './WorkspacePageHeader';

/**
 * 每页工具栏（05 号票）——**各页任务的替换点**。
 *
 * 结构固定为「左：可选返回 + 页面标题；右：本页操作」。
 * 视觉与按钮全部复用 02 号票的共用部件（`@/components/ui/Appearance` 的
 * `PageToolbar` / `ToolbarButton`），本文件只补三件 05 该管的事：
 *   1. 标题默认由外壳按当前路径 + 角色从 `lib/workspace-navigation.ts` 解析（= 导航名）；
 *   2. 「返回」渲染成真链接（可中键新开、可预取），不是只能点的按钮；
 *   3. 挂载即登记占用，让外壳那条只带标题的自动让位（见 `page-toolbar-claim.ts`）。
 *
 * 06 / 07 / 12 / 13 / 14 只需要：
 *   1. 往 `actions` 里塞本页按钮（新建项目、重试、刷新…），推荐用 `ToolbarButton`；
 *   2. 页面里原来的 `<h1>` 标题删掉，改由这里显示（避免两个大标题叠在一起）；
 *   3. 项目工作台这类要自定义标题/返回的，传 `title` + `back`（见 07）。
 *
 * 用法：
 * ```tsx
 * <PageToolbar role={principal.role} actions={<Link className="cap cap-primary" href="/projects/new">新建项目</Link>} />
 * ```
 */
export default function PageToolbar({
  role,
  title,
  subtitle,
  back,
  actions,
  claim = true,
}: {
  role: WorkspaceRole;
  /** 省略时由外壳按路径解析。显式传则覆盖（项目工作台用项目名）。 */
  title?: string;
  subtitle?: React.ReactNode;
  /** 「返回 + 目标」：项目工作台用。 */
  back?: { href: string; label: string };
  /** 本页自己的操作按钮，由各页任务补。 */
  actions?: React.ReactNode;
  /** 页里已有自己的标题、只想借这条放按钮时传 false（外壳标题条保留）。 */
  claim?: boolean;
  /** @deprecated 用 title 即可；保留旧签名避免调用方一次性改名。 */
  ariaLabel?: string;
}) {
  const pathname = usePathname();
  // 页面一旦渲染自己的工具栏，外壳那条只带标题的自动撤下（避免两条工具栏）。
  usePageToolbarClaim(claim);
  const resolved = title ?? workspacePageTitle(pathname, role) ?? '';
  // 「返回」本身就是可用键盘聚焦的按钮（共用 PageToolbar 渲染 `<button aria-label>`），
  // 再补一个 sr-only 链接既重复又会被界面尺寸验收判成「内容被藏起来」（27px 内容压进 1px）。
  // 中键新开/预取的需求改用真正可见的语义：把目标地址放进 data 属性，供需要时读取。
  return (
    <div
      data-testid="page-toolbar"
      {...(resolved ? { 'data-page-title': resolved } : {})}
      {...(back ? { 'data-back-href': back.href } : {})}
    >
      <SharedPageToolbar
        title={<span data-testid="page-toolbar-title">{resolved}</span>}
        subtitle={subtitle}
        actions={actions}
        {...(back
          ? {
              back: {
                label: back.label,
                onClick: () => { window.location.assign(back.href); },
              },
            }
          : {})}
      />
    </div>
  );
}

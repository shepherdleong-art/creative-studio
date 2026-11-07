'use client';

import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import type { WorkspaceRole } from '@/lib/workspace-navigation';
import { usePageToolbarClaim } from './WorkspacePageHeader';
import s from './workspace.module.css';

/**
 * 每页工具栏（05 号票）——**各页任务的替换点**。
 *
 * 结构固定为「左：可选返回 + 页面标题；右：本页操作」。标题默认由外壳按当前路径
 * 与角色从 `lib/workspace-navigation.ts` 解析（= 导航名），所以页面不传也能对。
 *
 * 06 / 07 / 12 / 13 / 14 只需要：
 *   1. 往 `actions` 里塞本页按钮（新建项目、重试、刷新…）；
 *   2. 页面里原来的 `<h1>` 标题删掉，改由这里显示（避免出现两个标题）；
 *   3. 项目工作台这类要自定义标题的，传 `title` + `back`（见 07）。
 *
 * 用法：
 * ```tsx
 * <PageToolbar role={principal.role} actions={<Link className="btn-primary btn-sm" href="/projects/new">新建项目</Link>} />
 * ```
 */
export default function PageToolbar({
  role,
  title,
  subtitle,
  back,
  actions,
  ariaLabel,
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
  ariaLabel?: string;
  /** 页里已有自己的标题、只想借这条放按钮时传 false（外壳标题条保留）。 */
  claim?: boolean;
}) {
  // 页面一旦渲染自己的工具栏，外壳那条只带标题的自动撤下（避免两条工具栏）。
  usePageToolbarClaim(claim);
  return (
    <div
      className={s.pageToolbar}
      role="group"
      aria-label={ariaLabel ?? (title ? `${title}工具栏` : '页面工具栏')}
      data-testid="page-toolbar"
      {...(title ? { 'data-page-title': title } : {})}
    >
      {back && (
        <Link href={back.href} className={s.pageToolbarBack} data-testid="page-toolbar-back">
          <Icon name="chevron-left" size={15} />
          <span>{back.label}</span>
        </Link>
      )}
      <div className={s.pageToolbarTitle}>
        {title ? <h1 data-testid="page-toolbar-title">{title}</h1> : null}
        {subtitle && <p className="mt-1 text-xs text-ink-secondary">{subtitle}</p>}
      </div>
      {actions && <div className={s.pageToolbarActions} data-testid="page-toolbar-actions">{actions}</div>}
    </div>
  );
}

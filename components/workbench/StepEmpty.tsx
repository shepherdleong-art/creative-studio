'use client';

import type { ReactNode } from 'react';
import { EmptyState } from '@/components/ui/Appearance';
import { Icon, type IconName } from '@/components/ui/Icon';
import s from './workbench.module.css';

/**
 * 新项目每步的空状态（07 号票）。
 *
 * 三步内容归 08/09，所以第 3/4/5 步不能把它们的组件换掉，只能在组件**前面**挂一条
 * 可断言的空状态提示（`data-testid="step-empty"`）。第 1/2 步的空状态是中间栏的
 * 主体，直接用 `EmptyState` 铺满。
 */
export function StepEmpty({
  title,
  description,
  action,
  icon = 'sparkle',
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: IconName;
}) {
  return (
    <div className={s.emptyWrap} data-testid="step-empty">
      <EmptyState title={title} description={description} action={action} icon={icon} />
    </div>
  );
}

/** 第 3/4/5 步的空状态条：内容组件照常挂载，只在它上面说明下一步。 */
export function StepEmptyBanner({ title, description }: { title: string; description: ReactNode }) {
  return (
    <div className={s.emptyBanner} data-testid="step-empty">
      <Icon name="sparkle" size={15} />
      <div>
        <b>{title}</b>
        <small>{description}</small>
      </div>
    </div>
  );
}

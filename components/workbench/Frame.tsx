'use client';

import type { ReactNode } from 'react';
import s from './workbench.module.css';

/**
 * 工作台三栏框架（07 号票）——**08/09 号票的步骤容器**。
 *
 * 规格：「每步的布局：左栏是列表或素材，中间是对照或预览，右栏是设置」。
 * 三栏的几何在这里（`workbench.module.css` 的 `.columns`），步骤内容只填三个槽：
 *
 * ```tsx
 * <StepFrame
 *   left={<><PaneHead>…</PaneHead><PaneList>{…}</PaneList></>}
 *   main={<><MainHead …/><div className={s.compare}>…</div></>}
 *   right={<><SettingsHeading>…</SettingsHeading>…</>}
 * />
 * ```
 *
 * 三条约定（改外观时别破坏）：
 * 1. **高度**：`.columns` 自己吃满剩余高度并在内部滚动，页面整体不跟着长高；
 * 2. **宽度**：三栏各列都 `min-width: 0`，不要把固定宽度的控件塞进来（会横向溢出）；
 * 3. **颜色**：只引用 `app/globals.css` 的令牌，不写死浅色值。
 */
export function StepFrame({ left, main, right }: { left: ReactNode; main: ReactNode; right: ReactNode }) {
  return (
    <div className={s.columns}>
      <section className={s.left} aria-label="素材与列表">
        {left}
      </section>
      <section className={s.main}>{main}</section>
      <aside className={s.right} aria-label="设置">
        {right}
      </aside>
    </div>
  );
}

/** 左栏栏头：标题 + 右侧操作（上传、新建…）。 */
export function PaneHead({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className={s.paneHead}>
      <span>{children}</span>
      {action}
    </div>
  );
}

/** 左栏滚动列表容器。 */
export function PaneList({ children }: { children: ReactNode }) {
  return <div className={s.list}>{children}</div>;
}

/** 中间栏栏头：标题 + 说明 + 右侧视图切换等。 */
export function MainHead({ title, note, children }: { title: ReactNode; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className={s.mainHead}>
      <b>{title}</b>
      {note ? <small>{note}</small> : null}
      {children}
    </div>
  );
}

/** 右栏小标题（原型 `.h4`）。 */
export function SettingsHeading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className={s.settingsTitle}>
      <span>{children}</span>
      {action}
    </div>
  );
}

/** 底部状态条（原型 `.status`）：左侧状态，右侧队列操作。 */
export function StatusBar({ children }: { children: ReactNode }) {
  return <div className={s.status}>{children}</div>;
}

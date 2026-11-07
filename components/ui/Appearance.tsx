'use client';

import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/** 页面工具栏（原型 `.tb` + `.ttl` + `.caps`）：左边标题，右边本页操作。 */
export function PageToolbar({
  title,
  subtitle,
  actions,
  back,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  back?: { label: string; onClick: () => void };
}) {
  return (
    <div className="page-toolbar">
      {back ? (
        <button type="button" className="cap cap-icon" aria-label={back.label} title={back.label} onClick={back.onClick}>
          <Icon name="chevron-left" size={16} />
        </button>
      ) : null}
      <div className="page-title">
        <h1>{title}</h1>
        {subtitle ? <small>{subtitle}</small> : null}
      </div>
      {actions ? <div className="page-toolbar-actions">{actions}</div> : null}
    </div>
  );
}

/** 工具栏上的胶囊按钮（原型 `.cap`：默认白底、`.cap.pri` 主操作蓝底）。 */
export function ToolbarButton({
  children,
  icon,
  onClick,
  variant = 'default',
  disabled,
  type = 'button',
  label,
}: {
  children?: ReactNode;
  icon?: IconName;
  onClick?: () => void;
  variant?: 'default' | 'primary';
  disabled?: boolean;
  type?: 'button' | 'submit';
  /** 只有图标时必须给无障碍名字。 */
  label?: string;
}) {
  const iconOnly = !children;
  return (
    <button
      type={type}
      className={`cap${variant === 'primary' ? ' cap-primary' : ''}${iconOnly ? ' cap-icon' : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={iconOnly ? label : undefined}
    >
      {icon ? <Icon name={icon} size={15} /> : null}
      {children}
    </button>
  );
}

/** 分组列表（原型 `.fg`）：白底圆角容器，行与行之间用细分隔线。 */
export function GroupList({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`group-list${className ? ` ${className}` : ''}`}>{children}</div>;
}

/** 分组列表的一行（原型 `.fr`）：左侧标签，右侧控件。 */
export function GroupRow({
  label,
  hint,
  children,
  stacked,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
  stacked?: boolean;
}) {
  return (
    <div className={`group-row${stacked ? ' group-row-stacked' : ''}`}>
      <div className="group-row-label">
        <span>{label}</span>
        {hint ? <small>{hint}</small> : null}
      </div>
      {children ? <div className="group-row-value">{children}</div> : null}
    </div>
  );
}

/** 分组小标题（原型 `.h4` / `.grp`）。 */
export function GroupHeading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="group-heading">
      <span>{children}</span>
      {action}
    </div>
  );
}

/** 分段按钮（原型 `.seg`）：轨道 `--color-seg`，选中块 `--color-seg-on`。
 *  semantics="tabs" 用于视图切换（aria-selected），"toggle" 用于二选一开关（aria-pressed）。 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'default',
  semantics = 'tabs',
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
  size?: 'default' | 'small';
  semantics?: 'tabs' | 'toggle';
}) {
  const toggling = semantics === 'toggle';
  return (
    <div
      className={`seg${size === 'small' ? ' seg-small' : ''}`}
      role={toggling ? 'group' : 'tablist'}
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role={toggling ? undefined : 'tab'}
          aria-selected={toggling ? undefined : option.value === value}
          aria-pressed={toggling ? option.value === value : undefined}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export type TagTone = 'ok' | 'warn' | 'fail' | 'run' | 'idle';

/** 标签（原型 `.tag`）：12px，圆角 6px，按语气取状态色令牌。 */
export function Tag({ tone = 'idle', children }: { tone?: TagTone; children: ReactNode }) {
  return <span className={`tag tag-${tone}`}>{children}</span>;
}

export type DotTone = 'ok' | 'warn' | 'fail' | 'run' | 'idle';

/** 状态点（原型 `.dot`）：7px 圆点，颜色取 `--color-dot-*` 令牌。 */
export function StatusDot({ tone = 'ok', label }: { tone?: DotTone; label?: string }) {
  return <i className={`status-dot-${tone}`} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

/** 空状态（原型 `.ph` / `.ed-empty`）：说明下一步该做什么。 */
export function EmptyState({
  title,
  description,
  action,
  icon = 'sparkle',
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: IconName;
}) {
  return (
    <div className="empty-state">
      <Icon name={icon} size={20} />
      <b>{title}</b>
      {description ? <small>{description}</small> : null}
      {action ? <div className="empty-state-action">{action}</div> : null}
    </div>
  );
}

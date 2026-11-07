'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * 对话框外壳（样子以原型 `.scrim` + `.sheet` 为准）。
 *
 * 只负责外观与无鼠标可用性：遮罩、圆角卡片、标题区、内容区、按钮区、
 * Esc 关闭与焦点收束。有没有业务逻辑由调用方决定。
 */
export function Dialog({
  open,
  title,
  description,
  children,
  footer,
  onClose,
  width = 'default',
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  width?: 'default' | 'wide';
}) {
  const titleId = useId();
  const descriptionId = useId();
  const surface = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    surface.current?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="dialog-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={surface}
        className={`dialog-sheet${width === 'wide' ? ' dialog-sheet-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <header className="dialog-header">
          <div>
            <b id={titleId}>{title}</b>
            {description ? <small id={descriptionId}>{description}</small> : null}
          </div>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </header>
        {children ? <div className="dialog-body">{children}</div> : null}
        {footer ? <footer className="dialog-footer">{footer}</footer> : null}
      </div>
    </div>
  );
}

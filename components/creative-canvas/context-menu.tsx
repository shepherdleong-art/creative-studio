'use client';

/**
 * 通用上下文菜单：复用 sc-canvas-menu 样式族。
 * Esc／点击菜单外／失去焦点时关闭；菜单项点击后先关再执行。
 */

import { useEffect, useRef } from 'react';

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  testId?: string;
}

export function ContextMenu({ x, y, items, onClose }: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      // 点在菜单内部不关闭（让按钮的 onClick 正常触发）
      if (event.target instanceof Node && containerRef.current?.contains(event.target)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [onClose]);

  if (items.length === 0) return null;
  return (
    <div
      ref={containerRef}
      className="sc-canvas-menu"
      style={{ left: x, top: y }}
      data-testid="context-menu"
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          className={`nodrag sc-canvas-menu-item ${item.danger ? 'sc-canvas-menu-item-danger' : ''}`}
          disabled={item.disabled}
          {...(item.testId ? { 'data-testid': item.testId } : {})}
          onClick={() => {
            onClose();
            item.onClick();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

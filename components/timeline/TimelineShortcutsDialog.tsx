'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

const shortcuts = [
  ['Space', '播放 / 暂停'],
  ['V / B', '选择工具 / 分割工具'],
  ['⌘ / Ctrl + B', '在播放头分割选中片段'],
  ['Delete / Backspace', '删除选中片段'],
  ['⌘ / Ctrl + Z', '撤销'],
  ['⌘ / Ctrl + Shift + Z', '重做'],
  ['← / →', '后退 / 前进 1 帧'],
  ['Shift + ← / →', '后退 / 前进 10 帧'],
  ['N', '开启 / 关闭磁吸'],
  ['Alt（按住）', '临时关闭磁吸'],
  ['+ / −', '时间轴缩放'],
  ['Esc', '取消拖动 / 关闭弹窗'],
] as const;

/** 单条与批量共用说明；原生 modal 隔离背景快捷键并管理焦点。 */
export function TimelineShortcutsDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    return () => {
      dialog.close();
      document.body.style.overflow = overflow;
      previousFocus?.focus();
    };
  }, []);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <dialog ref={ref} role="dialog" aria-label="时间轴快捷键" aria-modal="true"
      className="fixed inset-0 m-auto max-h-[85vh] w-[calc(100%_-_2rem)] max-w-lg overflow-y-auto rounded-2xl border border-hairline bg-surface p-0 text-ink shadow-xl backdrop:bg-black/60"
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={event => {
        event.stopPropagation();
        // 说明内只有关闭按钮可交互，Tab / Shift+Tab 保持焦点，不跳到浏览器工具栏。
        if (event.key === 'Tab') { event.preventDefault(); ref.current?.querySelector('button')?.focus(); }
      }}
    >
      <div className="p-5">
        <div className="mb-4 flex items-center justify-between border-b border-hairline pb-3">
          <h3 className="font-semibold">时间轴快捷键</h3>
          <button type="button" className="btn-secondary h-7 w-7 p-0" aria-label="关闭快捷键说明" onClick={onClose}>×</button>
        </div>
        <dl className="space-y-2.5 text-sm">
          {shortcuts.map(([keys, description]) => (
            <div key={keys} className="grid grid-cols-2 items-center gap-4">
              <dt><kbd className="inline-block rounded-md border border-hairline bg-surface-subtle px-2 py-1 font-sans text-xs text-ink-secondary">{keys}</kbd></dt>
              <dd className="font-medium">{description}</dd>
            </div>
          ))}
        </dl>
      </div>
    </dialog>, document.body,
  );
}

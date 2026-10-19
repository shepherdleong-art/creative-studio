'use client';

import { useEffect, useRef, useState } from 'react';
import styles from '@/components/mixcut/mixcut-content.module.css';

/** §B 画面内文字直改：悬浮输入框（父页渲染，iframe 视口裁不到、样式与 app 一致）。
 *  Enter/失焦提交，Esc 取消；keydown stopPropagation 防触发播放暂停等全局快捷键。 */
function PackagingTextEditor({ initialText, allowEmpty, style, onCommit, onCancel }: {
  initialText: string;
  allowEmpty: boolean;
  style: React.CSSProperties;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialText);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const settledRef = useRef(false);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const commit = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCommit(value);
  };
  const cancel = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCancel();
  };
  return (
    <div className={styles.pkTextEditor} style={style} onPointerDown={(event) => event.stopPropagation()}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        maxLength={40}
        placeholder={allowEmpty ? '留空则该元素不显示' : '卖点文字不能为空'}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') { event.preventDefault(); commit(); }
          else if (event.key === 'Escape') { event.preventDefault(); cancel(); }
        }}
        onBlur={commit}
      />
      <span className={styles.pkTextEditorHint}>{allowEmpty ? 'Enter 保存 · Esc 取消 · 留空隐藏' : 'Enter 保存 · Esc 取消'}</span>
    </div>
  );
}

/** §B 浮框定位包装：元素上方优先，顶部放不下改下方，水平钳视口内。 */
export function PackagingTextEditPopover({ textEdit, initialText, onCommit, onCancel }: {
  textEdit: { pointId: string; rect: { left: number; top: number; width: number; height: number }; frame: { left: number; top: number } };
  initialText: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const width = 260;
  const height = 62;
  const centerX = textEdit.frame.left + textEdit.rect.left + textEdit.rect.width / 2;
  const left = Math.min(Math.max(8, centerX - width / 2), window.innerWidth - width - 8);
  const aboveTop = textEdit.frame.top + textEdit.rect.top - 8;
  const top = aboveTop - height > 8
    ? aboveTop - height
    : textEdit.frame.top + textEdit.rect.top + textEdit.rect.height + 8;
  return (
    <PackagingTextEditor
      initialText={initialText}
      allowEmpty={textEdit.pointId.startsWith('cover:')}
      style={{ position: 'fixed', left: Math.round(left), top: Math.round(top), width, zIndex: 70 }}
      onCommit={onCommit}
      onCancel={onCancel}
    />
  );
}


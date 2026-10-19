'use client';

/**
 * 节点文本字段输入 hook（输入卡顿与 IME 问题的根治）。
 *
 * 核心保护：聚焦期间字段由本地草稿驱动，忽略外部 value 变化（任务轮询／
 * 撤销不会打断正在输入的组合），彻底绕开「受控恢复用旧值回写 DOM 把中文
 * 组合提前固化」的问题。
 *
 * 提交时机（与 IME 语义对齐，草稿不滞留本地）：
 * - 组合期间（compositionstart→end）只更新草稿不提交，避免拼音中间态落库；
 * - compositionend 或非组合输入逐键提交——逐键成本由 editor-store 的
 *   updateNodeData 快速路径（跳过全图 reconcile）与节点 memo 隔离承担；
 * - 失焦兜底提交；未聚焦时接受外部值（撤销／重载生效）。
 * 与上游一致时跳过提交，避免空写。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface NodeTextField {
  value: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  onFocus: () => void;
  onBlur: () => void;
  onCompositionStart: () => void;
  onCompositionEnd: (event: React.CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
}

export interface NodeTextFieldResult {
  /** 可直接 {...spread} 到 input/textarea 的属性集（全部是合法 DOM 属性）。 */
  field: NodeTextField;
  /** 程序化写入（@ 补全插入等）：同步草稿并立即提交，与手动输入走同一条路径。 */
  setValue: (next: string) => void;
}

export function useNodeTextField(
  value: string,
  onCommit: (next: string) => void,
): NodeTextFieldResult {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const [composing, setComposing] = useState(false);
  const draftRef = useRef(value);
  /** 上一次同步到草稿的外部值，兼作「已提交基线」：草稿与它一致就没有可提交的差异。 */
  const syncedRef = useRef(value);
  const onCommitRef = useRef(onCommit);
  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  // 未聚焦时同步外部值（撤销／重载）；聚焦或组合期间忽略，保证输入不被打断。
  // 放在 effect 里而不是渲染期：渲染期写 ref 被 react-hooks/refs 禁止，
  // 且未聚焦字段的值变化晚一帧无感知。
  useEffect(() => {
    if (editing || composing || syncedRef.current === value) return;
    syncedRef.current = value;
    draftRef.current = value;
    setDraft(value);
  }, [editing, composing, value]);

  const commitDraft = useCallback(() => {
    const next = draftRef.current;
    if (next !== syncedRef.current) {
      syncedRef.current = next;
      onCommitRef.current(next);
    }
  }, []);

  const onChange = useCallback((event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const next = event.target.value;
    draftRef.current = next;
    setDraft(next);
    // 组合期间只存草稿（拼音中间态不出门），其余逐键提交
    if (!composing) commitDraft();
  }, [composing, commitDraft]);

  const onCompositionStart = useCallback(() => {
    setComposing(true);
  }, []);

  const onCompositionEnd = useCallback((event: React.CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const next = event.currentTarget.value;
    draftRef.current = next;
    setDraft(next);
    setComposing(false);
    commitDraft();
  }, [commitDraft]);

  const onFocus = useCallback(() => {
    setEditing(true);
  }, []);

  const onBlur = useCallback(() => {
    setEditing(false);
    commitDraft();
  }, [commitDraft]);

  const setValue = useCallback((next: string) => {
    draftRef.current = next;
    setDraft(next);
    commitDraft();
  }, [commitDraft]);

  return {
    field: { value: draft, onChange, onFocus, onBlur, onCompositionStart, onCompositionEnd },
    setValue,
  };
}

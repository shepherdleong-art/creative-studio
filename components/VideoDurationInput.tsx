'use client';

import { useState } from 'react';
import { clampVideoDuration, type VideoDurationRange } from '@/lib/video-duration';

/** 聚焦全选，输入时限制上限；仅允许可补成有效两位数的短暂前缀。 */
export default function VideoDurationInput({ value, range, onChange, className, disabled, id }: {
  value: number; range: VideoDurationRange; onChange: (value: number) => void;
  className?: string; disabled?: boolean; id?: string;
}) {
  const keyFor = (seconds: number) => `${seconds}:${range.min}:${range.max}`;
  const [edit, setEdit] = useState({ key: keyFor(value), raw: String(value) });
  const draft = edit.key === keyFor(value) ? edit.raw : String(value);
  const label = `时长（${range.min}–${range.max} 秒，整数）`;
  return <input id={id} type="number" inputMode="numeric" min={range.min} max={range.max} step={1}
    value={draft} className={className} disabled={disabled} title={label} aria-label={label}
    onFocus={(event) => event.currentTarget.select()}
    onKeyDown={(event) => {
      if (!event.ctrlKey && !event.metaKey && ['e', 'E', '+', '-', '.'].includes(event.key)) event.preventDefault();
    }}
    onPaste={(event) => {
      if (!/^\d+$/.test(event.clipboardData.getData('text').trim())) event.preventDefault();
    }}
    onChange={(event) => {
      const raw = event.target.value;
      if (!raw) {
        setEdit({ key: keyFor(value), raw: '' });
        return;
      }
      if (!/^\d+$/.test(raw)) return;
      const parsed = Number(raw);
      // 输入 15 / 30 时保留首位 1 / 3；不可能补成有效秒数的值直接校正。
      const isPrefix = parsed > 0 && parsed < range.min && parsed * 10 <= range.max;
      const next = isPrefix ? parsed : clampVideoDuration(parsed, range);
      setEdit({ key: keyFor(isPrefix ? value : next), raw: String(next) });
      if (!isPrefix) onChange(next);
    }}
    onBlur={() => {
      const next = clampVideoDuration(draft.trim() ? Number(draft) : value, range);
      setEdit({ key: keyFor(next), raw: String(next) });
      onChange(next);
    }} />;
}

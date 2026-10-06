'use client';

import { useState } from 'react';
import { describeVideoDurationOptions, normalizeVideoDraftDuration } from '@/lib/video-duration';

/** 聚焦全选，输入即校正到最近的合法秒数；仅允许可补成有效两位数的短暂前缀。 */
export default function VideoDurationInput({ value, options, onChange, className, disabled, id }: {
  value: number; options: readonly number[]; onChange: (value: number) => void;
  className?: string; disabled?: boolean; id?: string;
}) {
  const min = options[0];
  const max = options[options.length - 1];
  const keyFor = (seconds: number) => `${seconds}:${options.join(',')}`;
  const [edit, setEdit] = useState({ key: keyFor(value), raw: String(value) });
  const draft = edit.key === keyFor(value) ? edit.raw : String(value);
  const label = `时长（${describeVideoDurationOptions(options)}，整数）`;
  return <input id={id} type="number" inputMode="numeric" min={min} max={max} step={1}
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
      const isPrefix = parsed > 0 && parsed < min && parsed * 10 <= max;
      const next = isPrefix ? parsed : normalizeVideoDraftDuration(parsed, options);
      setEdit({ key: keyFor(isPrefix ? value : next), raw: String(next) });
      if (!isPrefix) onChange(next);
    }}
    onBlur={() => {
      const next = normalizeVideoDraftDuration(draft.trim() ? Number(draft) : value, options);
      setEdit({ key: keyFor(next), raw: String(next) });
      onChange(next);
    }} />;
}

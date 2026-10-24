'use client';

import { useCallback, useState } from 'react';
import type { TextStyle } from '@/lib/media-core/cover-types';
import SystemFontPicker from '@/components/ui/SystemFontPicker';
import styles from '../mixcut/mixcut-content.module.css';

interface BatchTextStyleEditorProps {
  label: string;
  value: TextStyle;
  outputWidth: number;
  disabled?: boolean;
  onChange: (style: TextStyle) => void;
}

const inputClass = 'h-8 w-full min-w-0 rounded-lg border border-hairline bg-surface px-2 text-xs text-ink';
const colorClass = 'h-8 w-11 shrink-0 rounded-lg border border-hairline bg-surface p-0.5';

function finiteOr(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function colorInputValue(value: string): string {
  return /^#[0-9a-f]{6}$/iu.test(value) ? value : '#ffffff';
}

function RangeField({
  label,
  value,
  min,
  max,
  step,
  suffix = '',
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const display = Number.isInteger(step) ? String(Math.round(value)) : value.toFixed(2);
  return (
    <label className="block min-w-0">
      <span className="mb-1 flex items-center justify-between gap-2 text-[11px] text-ink-tertiary">
        <span>{label}</span>
        <output className="tabular-nums">{display}{suffix}</output>
      </span>
      <div className="grid grid-cols-[minmax(0,1fr)_64px] items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.target.value))}
          className={styles.rangeInput}
          aria-label={label}
        />
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(finiteOr(event.target.value, value))}
          className="h-8 w-full rounded-lg border border-hairline bg-surface px-2 text-xs tabular-nums text-ink"
          aria-label={`${label}数值`}
        />
      </div>
    </label>
  );
}

export default function BatchTextStyleEditor({
  label,
  value,
  outputWidth,
  disabled = false,
  onChange,
}: BatchTextStyleEditorProps) {
  const patch = (next: Partial<TextStyle>) => onChange({ ...value, ...next });
  // 字体浮层自托管 host：紧跟字体触发器，浮层控件按 DOM 顺序进入所在 dialog 的焦点陷阱，
  // Tab 从浮层出去落到本编辑器的下一个控件（字号），而不是跳过整个样式编辑器。
  const [fontOverlayHost, setFontOverlayHost] = useState<HTMLDivElement | null>(null);
  const setFontOverlayHostRef = useCallback((node: HTMLDivElement | null) => setFontOverlayHost(node), []);

  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="flex w-full items-center justify-between gap-2 text-xs font-medium text-ink">
        <span>{label}</span>
      </legend>

      <label className="block">
        <span className="mb-1 block text-[11px] text-ink-tertiary">字体</span>
        <SystemFontPicker
          value={value.fontFamily}
          ariaLabel={`${label}字体`}
          disabled={disabled}
          onChange={(fontFamily) => onChange({ ...value, fontFamily, fontPostscriptName: undefined })}
          portalRoot={fontOverlayHost}
        />
      </label>
      {/* 字体浮层挂载点：必须紧跟在触发器所在 label 的**外面**。放进 label 内的话，
          label 会把浮层非交互区域（分组标题 / 「N+ 个字体」页脚 / 内边距）的点击转发给被标注控件（即触发器），
          等于点一下标题就把面板关了。放在外面 DOM 顺序不变（label 不可聚焦），Tab 仍落到「字号」。 */}
      <div ref={setFontOverlayHostRef} />

      <div className="space-y-3">
        <RangeField
          label="字号"
          value={value.fontSizePx}
          min={8}
          max={180}
          step={1}
          disabled={disabled}
          onChange={(fontSizePx) => patch({ fontSizePx })}
        />
        <RangeField
          label="缩放"
          value={value.scale}
          min={0.25}
          max={4}
          step={0.05}
          suffix="×"
          disabled={disabled}
          onChange={(scale) => patch({ scale })}
        />
        <RangeField
          label="横向位置"
          value={value.x}
          min={0}
          max={1}
          step={0.01}
          suffix=""
          disabled={disabled}
          onChange={(x) => patch({ x })}
        />
        <RangeField
          label="纵向位置"
          value={value.y}
          min={0}
          max={1}
          step={0.01}
          suffix=""
          disabled={disabled}
          onChange={(y) => patch({ y })}
        />
        <RangeField
          label="文字框宽度"
          value={value.boxWidthPx}
          min={100}
          max={outputWidth}
          step={10}
          suffix=" px"
          disabled={disabled}
          onChange={(boxWidthPx) => patch({ boxWidthPx })}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="block min-w-0">
          <span className="mb-1 block text-[11px] text-ink-tertiary">颜色</span>
          <span className="flex items-center gap-2">
            <input
              type="color"
              className={colorClass}
              aria-label={`${label}文字颜色`}
              value={colorInputValue(value.color)}
              onChange={(event) => patch({ color: event.target.value })}
            />
            <span className="truncate text-[10px] tabular-nums text-ink-tertiary">{value.color}</span>
          </span>
        </label>
        <label className="block min-w-0">
          <span className="mb-1 block text-[11px] text-ink-tertiary">对齐</span>
          <select
            className={inputClass}
            aria-label={`${label}对齐`}
            value={value.align}
            onChange={(event) => patch({ align: event.target.value as TextStyle['align'] })}
          >
            <option value="left">左对齐</option>
            <option value="center">居中</option>
            <option value="right">右对齐</option>
          </select>
        </label>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-2 border-t border-hairline pt-3 text-[11px] text-ink-secondary">
        <label className="flex items-center gap-2">
          <input type="checkbox" aria-label={`${label}斜体`} checked={value.italic} onChange={(event) => patch({ italic: event.target.checked })} className="accent-[var(--color-accent)]" />
          斜体
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" aria-label={`${label}描边`} checked={value.stroke.enabled} onChange={(event) => patch({ stroke: { ...value.stroke, enabled: event.target.checked } })} className="accent-[var(--color-accent)]" />
          描边
        </label>
      </div>

      {value.stroke.enabled && (
        <div className="space-y-3 rounded-lg bg-surface-subtle p-2.5">
          <label className="block">
            <span className="mb-1 block text-[10px] text-ink-tertiary">描边色</span>
            <input
              type="color"
              className={colorClass}
              aria-label={`${label}描边颜色`}
              value={colorInputValue(value.stroke.color)}
              onChange={(event) => patch({ stroke: { ...value.stroke, color: event.target.value } })}
            />
          </label>
          <RangeField
            label="粗细"
            value={value.stroke.widthPx}
            min={0}
            max={40}
            step={0.5}
            suffix=" px"
            disabled={disabled}
            onChange={(widthPx) => patch({ stroke: { ...value.stroke, widthPx } })}
          />
        </div>
      )}

      <label className="flex items-center justify-between gap-2 border-t border-hairline pt-3 text-[11px] font-medium text-ink-secondary">
        <span className="flex items-center gap-2">
          <input type="checkbox" aria-label={`${label}阴影`} checked={value.shadow.enabled} onChange={(event) => patch({ shadow: { ...value.shadow, enabled: event.target.checked } })} className="accent-[var(--color-accent)]" />
          阴影
        </span>
        <span className="text-[10px] font-normal text-ink-tertiary">可调颜色、透明度、模糊与距离</span>
      </label>

      {value.shadow.enabled && (
        <div className="space-y-3 rounded-lg bg-surface-subtle p-2.5">
          <label className="block shrink-0">
            <span className="mb-1 block text-[10px] text-ink-tertiary">阴影色</span>
            <input
              type="color"
              className={colorClass}
              aria-label={`${label}阴影颜色`}
              value={colorInputValue(value.shadow.color)}
              onChange={(event) => patch({ shadow: { ...value.shadow, color: event.target.value } })}
            />
          </label>
          <RangeField
            label="不透明度"
            value={value.shadow.opacity}
            min={0}
            max={1}
            step={0.05}
            disabled={disabled}
            onChange={(opacity) => patch({ shadow: { ...value.shadow, opacity } })}
          />
          <div className="space-y-3">
            <RangeField
              label="模糊"
              value={value.shadow.blurPx}
              min={0}
              max={40}
              step={1}
              suffix=" px"
              disabled={disabled}
              onChange={(blurPx) => patch({ shadow: { ...value.shadow, blurPx } })}
            />
            <RangeField
              label="距离"
              value={value.shadow.distancePx}
              min={0}
              max={40}
              step={1}
              suffix=" px"
              disabled={disabled}
              onChange={(distancePx) => patch({ shadow: { ...value.shadow, distancePx } })}
            />
            <RangeField
              label="角度"
              value={value.shadow.angleDeg}
              min={0}
              max={360}
              step={1}
              suffix="°"
              disabled={disabled}
              onChange={(angleDeg) => patch({ shadow: { ...value.shadow, angleDeg } })}
            />
          </div>
        </div>
      )}
    </fieldset>
  );
}

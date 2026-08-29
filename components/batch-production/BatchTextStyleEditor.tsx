'use client';

import { useEffect, useState } from 'react';
import type { TextStyle } from '@/lib/media-core/cover-types';
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
  const [fonts, setFonts] = useState<string[]>([value.fontFamily]);

  useEffect(() => {
    void fetch('/api/system-fonts').then((response) => response.json()).then((body) => {
      const values = Array.isArray(body) ? body : body.fonts;
      if (Array.isArray(values)) {
        setFonts([...new Set([
          value.fontFamily,
          ...values.map((item) => typeof item === 'string' ? item : item.family).filter((item): item is string => Boolean(item)),
        ])]);
      }
    }).catch(() => undefined);
  }, [value.fontFamily]);

  const refreshFonts = async () => {
    const localWindow = window as Window & { queryLocalFonts?: () => Promise<Array<{ family: string }>> };
    if (!localWindow.queryLocalFonts) return;
    try {
      const localFonts = await localWindow.queryLocalFonts();
      setFonts([...new Set([value.fontFamily, ...localFonts.map((font) => font.family)])]);
    } catch {
      // 用户拒绝本地字体权限时仍保留系统字体接口的结果。
    }
  };

  const patch = (next: Partial<TextStyle>) => onChange({ ...value, ...next });

  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="flex w-full items-center justify-between gap-2 text-xs font-medium text-ink">
        <span>{label}</span>
        <button type="button" className="text-[11px] font-normal text-accent underline underline-offset-2" onClick={() => void refreshFonts()}>刷新字体</button>
      </legend>

      <label className="block">
        <span className="mb-1 block text-[11px] text-ink-tertiary">字体</span>
        <select
          className={inputClass}
          aria-label={`${label}字体`}
          value={value.fontFamily}
          onChange={(event) => onChange({ ...value, fontFamily: event.target.value, fontPostscriptName: undefined })}
        >
          {!fonts.includes(value.fontFamily) && <option value={value.fontFamily}>{value.fontFamily}</option>}
          {fonts.map((font) => <option key={font} value={font}>{font}</option>)}
        </select>
      </label>

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

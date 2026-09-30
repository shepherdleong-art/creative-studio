'use client';

import { useId } from 'react';
import { FURNITURE_OPTIONS, ROOM_OPTIONS, readFurniturePrompt, updateFurniturePrompt } from '@/lib/furniture-prompt';

export default function FurniturePromptControls({ prompt, onChange }: {
  prompt: string;
  onChange: (prompt: string) => void;
}) {
  const id = useId();
  const values = readFurniturePrompt(prompt);
  const fields = [
    { key: 'furniture' as const, label: '家具类目（保持不变）', options: FURNITURE_OPTIONS },
    { key: 'room' as const, label: '场景', options: ROOM_OPTIONS },
  ];

  return (
    <div className="mb-3 space-y-2">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {fields.map(({ key, label, options }) => (
          <div key={key}>
            <label htmlFor={`${id}-${key}`} className="label">{label}</label>
            <select
              id={`${id}-${key}`}
              className="input-field min-h-[42px] disabled:opacity-50"
              value={values[key]}
              disabled={!values[key]}
              onChange={(event) => onChange(updateFurniturePrompt(prompt, key, event.target.value))}
            >
              {!values[key] && <option value="">未识别，请在提示词中编辑</option>}
              {values[key] && !options.includes(values[key]) && <option value={values[key]}>{values[key]}（自定义）</option>}
              {options.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </div>
        ))}
      </div>
      <p className="text-xs text-ink-tertiary">
        选择后自动替换提示词中的对应内容。组合家具或其他场景可直接在下方编辑。
      </p>
    </div>
  );
}

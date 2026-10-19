'use client';

import { SCRIPT_TEMPLATES } from '@/lib/script-templates';

interface Props {
  selectedId: string;
  onSelect: (id: string, name: string) => void;
}

export default function ScriptTemplatePicker({ selectedId, onSelect }: Props) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
      {SCRIPT_TEMPLATES.map((t) => {
        const isSelected = selectedId === t.id;
        return (
          <button
            key={t.id}
            onClick={() => onSelect(t.id, t.name)}
            className={`cursor-pointer rounded-[14px] border p-3 text-left transition-all ${
              isSelected
                ? 'border-accent bg-accent-tint/10 ring-1 ring-accent/30'
                : 'border-hairline bg-surface hover:border-hairline/80 hover:bg-surface-subtle'
            }`}
          >
            <div className="mb-1 text-sm font-semibold text-ink">{t.name}</div>
            <div className="mb-1.5 text-[0.7rem] italic text-accent">{t.slogan}</div>
            <div className="text-[0.65rem] leading-relaxed text-ink-tertiary line-clamp-2">
              {t.example}
            </div>
            <div className="mt-2 inline-flex rounded-full bg-surface-subtle px-1.5 py-px text-[0.6rem] text-ink-tertiary">
              {t.suitable}
            </div>
          </button>
        );
      })}
    </div>
  );
}

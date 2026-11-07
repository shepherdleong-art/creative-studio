'use client';

import { useEffect, useState } from 'react';
import { EmptyState, GroupHeading, StatusDot } from '@/components/ui/Appearance';

interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  type: string;
  enabled: number;
  defaultCostPerImage?: number;
  hasApiKey: boolean;
}

interface Props {
  selectedId?: string;
  onSelect: (provider: Provider) => void;
}

export default function ProviderSettings({ selectedId, onSelect }: Props) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/team/models?kind=image')
      .then((r) => r.json())
      .then((data: Provider[]) => {
        setProviders(data);
        const selectable = data.filter((p) => p.enabled && p.hasApiKey);
        if (!selectedId && selectable.length > 0) {
          onSelect(selectable[0]);
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="py-4 text-[13px] text-ink-secondary">加载供应商列表...</div>;
  }

  const enabledProviders = providers.filter((p) => p.enabled);
  const selectableProviders = enabledProviders.filter((p) => p.hasApiKey);

  // Empty state: no enabled providers
  if (enabledProviders.length === 0) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <GroupHeading>供应商</GroupHeading>
          <a href="/settings" className="link-accent text-[13px]">
            管理供应商
          </a>
        </div>
        <EmptyState
          icon="alert"
          title="当前没有启用的供应商"
          description="请先到供应商配置里启用 GeekAI、Packy 或其他 API。"
          action={<a className="cap" href="/settings">去供应商配置</a>}
        />
      </div>
    );
  }

  // Empty state: enabled but no keys
  if (selectableProviders.length === 0) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <GroupHeading>供应商</GroupHeading>
          <a href="/settings" className="link-accent text-[13px]">
            管理供应商
          </a>
        </div>
        <EmptyState
          icon="key"
          title="已启用供应商，但还没有可用 API Key"
          description="请先到供应商配置里填写 Key。"
          action={<a className="cap" href="/settings">去填写 Key</a>}
        />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <GroupHeading>供应商</GroupHeading>
        <a href="/settings" className="link-accent text-[13px]">
          管理供应商
        </a>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {enabledProviders.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={!p.hasApiKey}
            onClick={() => onSelect(p)}
            aria-pressed={selectedId === p.id}
            className={`rounded-[11px] border p-4 text-left transition-colors ${
              selectedId === p.id
                ? 'border-accent bg-run-tint'
                : p.hasApiKey
                ? 'border-hairline bg-surface hover:border-accent/40'
                : 'border-hairline-soft bg-group opacity-70'
            }`}
          >
            <div className="text-[13px] font-medium text-ink">{p.name}</div>
            <div className="mt-0.5 text-[12px] text-ink-secondary">{p.model}</div>
            <div className="mt-0.5 text-[12px] text-ink-tertiary">类型: {p.type}</div>
            {p.defaultCostPerImage != null && (
              <div className="mt-0.5 text-[12px] text-ink-tertiary">
                预估成本: ¥{p.defaultCostPerImage}/张
              </div>
            )}
            {!p.hasApiKey && (
              <div className="mt-1 flex items-center gap-1 text-[12px] text-warn"><StatusDot tone="warn" /> 未配置 Key，请到管理供应商设置</div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

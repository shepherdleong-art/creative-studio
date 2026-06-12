'use client';

import { useEffect, useState } from 'react';
import { Icon } from '@/components/ui/Icon';

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
    fetch('/api/providers')
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
    return <div className="py-4 text-sm text-ink-secondary">加载供应商列表...</div>;
  }

  const enabledProviders = providers.filter((p) => p.enabled);
  const selectableProviders = enabledProviders.filter((p) => p.hasApiKey);

  // Empty state: no enabled providers
  if (enabledProviders.length === 0) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="label">供应商</label>
          <a href="/settings" className="link-accent text-sm">
            管理供应商
          </a>
        </div>
        <div className="rounded-[18px] border border-warn/30 bg-warn-tint p-4 text-sm text-warn">
          当前没有启用的供应商。请先到供应商配置里启用 GeekAI、Packy 或其他 API。
        </div>
      </div>
    );
  }

  // Empty state: enabled but no keys
  if (selectableProviders.length === 0) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="label">供应商</label>
          <a href="/settings" className="link-accent text-sm">
            管理供应商
          </a>
        </div>
        <div className="rounded-[18px] border border-warn/30 bg-warn-tint p-4 text-sm text-warn">
          已启用供应商，但还没有可用 API Key。请先到供应商配置里填写 Key。
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="label">供应商</label>
        <a href="/settings" className="link-accent text-sm">
          管理供应商
        </a>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {enabledProviders.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={!p.hasApiKey}
            onClick={() => onSelect(p)}
            className={`text-left p-4 rounded-[18px] border-2 transition-all transition-shadow hover:shadow-[0_4px_16px_rgba(0,0,0,.06)] ${
              selectedId === p.id
                ? 'border-accent bg-run-tint'
                : p.hasApiKey
                ? 'border-hairline hover:border-accent/40'
                : 'border-hairline-soft bg-surface-subtle opacity-60'
            }`}
          >
            <div className="font-medium text-sm">{p.name}</div>
            <div className="mt-0.5 text-xs text-ink-secondary">{p.model}</div>
            <div className="mt-0.5 text-xs text-ink-tertiary">类型: {p.type}</div>
            {p.defaultCostPerImage != null && (
              <div className="mt-0.5 text-xs text-ink-tertiary">
                预估成本: ¥{p.defaultCostPerImage}/张
              </div>
            )}
            {!p.hasApiKey && (
              <div className="mt-1 flex items-center gap-1 text-xs text-warn"><Icon name="alert" size={12} /> 未配置 Key，请到管理供应商设置</div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

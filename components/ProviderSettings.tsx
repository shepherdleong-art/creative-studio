'use client';

import { useEffect, useState } from 'react';

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
    return <div className="text-sm text-gray-500">加载供应商列表...</div>;
  }

  const enabledProviders = providers.filter((p) => p.enabled);
  const selectableProviders = enabledProviders.filter((p) => p.hasApiKey);

  // Empty state: no enabled providers
  if (enabledProviders.length === 0) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="label mb-0">供应商</label>
          <a href="/settings" className="text-xs text-blue-600 hover:text-blue-800">
            管理供应商 →
          </a>
        </div>
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-800">
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
          <label className="label mb-0">供应商</label>
          <a href="/settings" className="text-xs text-blue-600 hover:text-blue-800">
            管理供应商 →
          </a>
        </div>
        <div className="rounded-lg border border-orange-200 bg-orange-50 p-4 text-sm text-orange-800">
          已启用供应商，但还没有可用 API Key。请先到供应商配置里填写 Key。
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="label mb-0">供应商</label>
        <a href="/settings" className="text-xs text-blue-600 hover:text-blue-800">
          管理供应商 →
        </a>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {enabledProviders.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={!p.hasApiKey}
            onClick={() => onSelect(p)}
            className={`text-left p-3 rounded-lg border-2 transition-all ${
              selectedId === p.id
                ? 'border-blue-500 bg-blue-50'
                : p.hasApiKey
                ? 'border-gray-200 hover:border-gray-300'
                : 'border-gray-100 bg-gray-50 opacity-60'
            }`}
          >
            <div className="font-medium text-sm">{p.name}</div>
            <div className="text-xs text-gray-500 mt-0.5">{p.model}</div>
            <div className="text-xs text-gray-400 mt-0.5">类型: {p.type}</div>
            {p.defaultCostPerImage != null && (
              <div className="text-xs text-gray-400 mt-0.5">
                预估成本: ¥{p.defaultCostPerImage}/张
              </div>
            )}
            {!p.hasApiKey && (
              <div className="text-xs text-orange-500 mt-1">⚠️ 未配置 Key — 点击「管理供应商」设置</div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

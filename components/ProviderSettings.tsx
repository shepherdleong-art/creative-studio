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
      .then((data) => {
        setProviders(data);
        if (!selectedId && data.length > 0) {
          onSelect(data[0]);
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="text-sm text-gray-500">加载供应商列表...</div>;
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
        {providers.filter((p) => p.enabled).map((p) => (
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
            {p.defaultCostPerImage != null && (
              <div className="text-xs text-gray-400 mt-0.5">
                预估成本: ¥{p.defaultCostPerImage}/张
              </div>
            )}
            {!p.hasApiKey && (
              <div className="text-xs text-orange-500 mt-1">⚠️ 未配置 Key — 点击"管理供应商"设置</div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

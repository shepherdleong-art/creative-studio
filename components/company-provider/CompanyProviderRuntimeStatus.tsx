'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { CompanyProviderRuntimeStatus as RuntimeStatus } from '@/lib/company-provider-runtime';

const STATUS_LABELS: Record<RuntimeStatus['status'], string> = {
  not_configured: '未配置',
  stopped: '未启动',
  unavailable: '当前不可用',
  ready: '可用',
};

const STATUS_CLASSES: Record<RuntimeStatus['status'], string> = {
  not_configured: 'status-pending',
  stopped: 'status-canceled',
  unavailable: 'status-failed',
  ready: 'status-succeeded',
};

const EMPTY_STATUS: RuntimeStatus = {
  status: 'unavailable',
  reason: '公司供应商状态暂时不可用',
  proxyAvailable: false,
  tunnelAvailable: false,
  startedAt: null,
  tunnelEngine: null,
};

async function fetchRuntimeStatus(signal?: AbortSignal): Promise<RuntimeStatus> {
  try {
    const response = await fetch('/api/company-provider/health', { cache: 'no-store', signal });
    const data = await response.json().catch(() => null);
    return response.ok && data && typeof data.status === 'string'
      ? data as RuntimeStatus
      : EMPTY_STATUS;
  } catch {
    return EMPTY_STATUS;
  }
}

export default function CompanyProviderRuntimeStatus() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setRefreshing(true);
    const nextStatus = await fetchRuntimeStatus();
    if (mountedRef.current && requestId === requestIdRef.current) {
      setStatus(nextStatus);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    const requestId = ++requestIdRef.current;
    void (async () => {
      const nextStatus = await fetchRuntimeStatus(controller.signal);
      if (mountedRef.current && requestId === requestIdRef.current) {
        setStatus(nextStatus);
      }
    })();
    return () => {
      mountedRef.current = false;
      controller.abort();
    };
  }, []);

  const current = status ?? EMPTY_STATUS;
  return (
    <section className="card p-5" aria-labelledby="company-provider-runtime-title">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h2 id="company-provider-runtime-title" className="font-semibold">公司供应商运行环境</h2>
            <span className={`status-badge ${STATUS_CLASSES[current.status]}`}>
              <Icon name={current.status === 'ready' ? 'check-circle' : 'alert'} size={12} />
              {STATUS_LABELS[current.status]}
            </span>
          </div>
          <p className="text-sm text-ink-secondary">{current.reason}</p>
        </div>
        <button
          type="button"
          className="btn-secondary btn-sm shrink-0"
          onClick={() => void refresh()}
          disabled={refreshing}
        >
          <Icon name="retry" size={14} />
          {refreshing ? '检查中…' : '刷新'}
        </button>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-2 text-sm text-ink-secondary sm:grid-cols-2">
        <div>
          <span className="text-ink-tertiary">LiteLLM 代理：</span>
          <span className={current.proxyAvailable ? 'text-ok' : 'text-ink-tertiary'}>
            {current.proxyAvailable ? '可用' : '不可用'}
          </span>
        </div>
        <div>
          <span className="text-ink-tertiary">媒体传输隧道：</span>
          <span className={current.tunnelAvailable ? 'text-ok' : 'text-ink-tertiary'}>
            {current.tunnelAvailable ? '可用' : '不可用'}
          </span>
        </div>
        {current.tunnelEngine && (
          <div><span className="text-ink-tertiary">隧道引擎：</span>{current.tunnelEngine}</div>
        )}
        {current.startedAt && (
          <div><span className="text-ink-tertiary">启动时间：</span>{current.startedAt}</div>
        )}
      </div>

      <p className="mt-4 text-xs text-ink-tertiary">
        此处只读取本机状态，不会从网页启动进程，也不会发起模型或媒体请求。
      </p>
    </section>
  );
}

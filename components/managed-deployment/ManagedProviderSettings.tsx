'use client';

import { useEffect, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import ProvisioningImportCard from '@/components/provisioning/ProvisioningImportCard';
import ManagedDeploymentNotice from '@/components/managed-deployment/ManagedDeploymentNotice';
import { useManagedDeployment } from '@/components/managed-deployment/ManagedDeploymentProvider';

const ALLOWLIST_LABELS = [
  ['image', '图片供应商'],
  ['script', '脚本供应商'],
  ['video', '视频供应商'],
  ['tts', '口播配音'],
] as const;

const ROUTE_LABELS: Record<(typeof ALLOWLIST_LABELS)[number][0], string> = {
  image: '公司 LiteLLM',
  script: '公司 LiteLLM',
  video: '公司 LiteLLM',
  tts: '豆包官方直连',
};

const PROVIDER_ENDPOINTS = [
  ['image', '/api/providers'],
  ['script', '/api/providers/script'],
  ['video', '/api/providers/video?all=1'],
  ['tts', '/api/providers/tts'],
] as const;

type ManagedProviderRecord = {
  id: string;
  name?: string;
  model?: string;
  defaultModel?: string;
  type?: string;
};

export default function ManagedProviderSettings() {
  const { status, refreshNow } = useManagedDeployment();
  const [restartBusy, setRestartBusy] = useState(false);
  const [restartMessage, setRestartMessage] = useState('');
  const [importStarting, setImportStarting] = useState(false);
  const [providers, setProviders] = useState<Record<string, ManagedProviderRecord[]>>({});
  const [providersLoading, setProvidersLoading] = useState(false);

  useEffect(() => {
    if (status?.phase !== 'ready' && status?.phase !== 'failed') return;
    const timer = window.setTimeout(() => setImportStarting(false), 0);
    return () => window.clearTimeout(timer);
  }, [status?.phase]);

  useEffect(() => {
    if (!status?.configured) {
      const timer = window.setTimeout(() => {
        setProviders({});
        setProvidersLoading(false);
      }, 0);
      return () => window.clearTimeout(timer);
    }
    let active = true;
    const loadProviders = async () => {
      setProvidersLoading(true);
      const entries = await Promise.all(PROVIDER_ENDPOINTS.map(async ([key, endpoint]) => {
        try {
          const response = await fetch(endpoint, { cache: 'no-store' });
          const value = await response.json().catch(() => []);
          return [key, Array.isArray(value) ? value as ManagedProviderRecord[] : []] as const;
        } catch {
          return [key, []] as const;
        }
      }));
      if (active) {
        setProviders(Object.fromEntries(entries));
        setProvidersLoading(false);
      }
    };
    const timer = window.setTimeout(() => void loadProviders(), 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [status?.configured, status?.importedAt]);

  const restartLiteLlm = async () => {
    setRestartBusy(true);
    setRestartMessage('');
    try {
      const response = await fetch('/api/company-provider/start', { method: 'POST' });
      if (!response.ok) throw new Error('启动请求未被接受');
      setRestartMessage('已请求重新启动 LiteLLM，正在检查状态…');
      await refreshNow();
    } catch (error) {
      setRestartMessage(error instanceof Error ? error.message : '重新启动失败');
    } finally {
      setRestartBusy(false);
    }
  };

  const handleImported = async () => {
    setImportStarting(true);
    await refreshNow();
  };

  const visibleStatus = importStarting && status && status.phase !== 'ready'
    ? { ...status, phase: 'starting' as const, reason: '统一配置已导入，正在启动公司模型服务…' }
    : status;

  return (
    <div className='mx-auto max-w-5xl space-y-5'>
      <div>
        <h1 className='text-3xl font-semibold tracking-[-0.02em]'>公司配置</h1>
        <p className='mt-1 text-sm text-ink-secondary'>此安装由管理员统一管理供应商。这里仅显示状态，并保留配置导入与轮换入口。</p>
      </div>

      {visibleStatus && visibleStatus.phase !== 'ready' && <ManagedDeploymentNotice status={visibleStatus} compact />}

      <section className='card p-5' aria-labelledby='managed-profile-title'>
        <div className='flex flex-wrap items-start justify-between gap-4'>
          <div>
            <h2 id='managed-profile-title' className='font-semibold'>统一配置档案</h2>
            <p className='mt-1 text-sm text-ink-secondary'>供应商身份、密钥和模型由加密配置文件托管，网页端不会回显密钥。</p>
          </div>
          <span className={`status-badge ${status?.configured ? 'status-succeeded' : 'status-pending'}`}>
            {status?.configured ? '已导入' : '尚未导入'}
          </span>
        </div>
        <div className='mt-5 grid gap-3 text-sm text-ink-secondary sm:grid-cols-3'>
          <div><span className='text-ink-tertiary'>配置档案：</span>{status?.profileName || '—'}</div>
          <div><span className='text-ink-tertiary'>导入时间：</span>{status?.importedAt || '—'}</div>
          <div><span className='text-ink-tertiary'>配置指纹：</span><code>{status?.configHashPrefix || '—'}</code></div>
        </div>
      </section>

      <section className='card p-5' aria-labelledby='managed-runtime-title'>
        <div className='flex items-start justify-between gap-4'>
          <div>
            <h2 id='managed-runtime-title' className='font-semibold'>LiteLLM / 代理状态</h2>
            <p className='mt-1 text-sm text-ink-secondary'>{status?.reason || '正在读取状态…'}</p>
          </div>
          <span className={`status-badge ${status?.proxyAvailable ? 'status-succeeded' : status?.phase === 'failed' ? 'status-failed' : 'status-pending'}`}>
            <Icon name={status?.proxyAvailable ? 'check-circle' : 'alert'} size={12} />
            {status?.proxyAvailable ? '代理可用' : status?.phase === 'starting' ? '启动中' : '等待可用'}
          </span>
        </div>
        {status?.phase === 'failed' && (
          <div className='mt-4 flex flex-wrap items-center gap-2'>
            <button type='button' className='btn-primary btn-sm' onClick={() => void restartLiteLlm()} disabled={restartBusy}>
              {restartBusy ? '请求中…' : '重新启动 LiteLLM'}
            </button>
            <a href='#provisioning' className='btn-secondary btn-sm'>重新导入配置</a>
          </div>
        )}
        {restartMessage && <p className='mt-3 text-sm text-ink-secondary' aria-live='polite'>{restartMessage}</p>}
      </section>

      <section className='card p-5' aria-labelledby='managed-provider-title'>
        <h2 id='managed-provider-title' className='font-semibold'>受管供应商</h2>
        <p className='mt-1 text-sm text-ink-secondary'>以下四类供应商由当前 profile 固定，不能在网页端新增、删除、启停或编辑 Key。</p>
        <div className='mt-4 grid gap-3 sm:grid-cols-2'>
          {ALLOWLIST_LABELS.map(([key, label]) => {
            const rows = status?.configured ? providers[key] || [] : [];
            return (
              <div key={key} className='rounded-[14px] border border-hairline bg-surface-subtle px-4 py-3 text-sm'>
                <div className='flex items-center justify-between gap-3'>
                  <span className='font-medium text-ink'>{label}</span>
                  <span className='text-xs text-ink-tertiary'>{providersLoading ? '读取中…' : `${rows.length} 项`}</span>
                </div>
                {!status?.configured && <p className='mt-2 text-xs text-ink-tertiary'>导入统一配置后显示受管供应商。</p>}
                {status?.configured && !providersLoading && rows.length === 0 && <p className='mt-2 text-xs text-ink-tertiary'>当前 profile 未返回可用供应商。</p>}
                {rows.length > 0 && (
                  <div className='mt-2 space-y-1.5'>
                    {rows.map((provider) => (
                      <div key={provider.id} className='flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs'>
                        <span className='min-w-0 truncate text-ink'>{provider.name || provider.id}</span>
                        <span className='text-right text-ink-tertiary'>
                          <code>{provider.id}</code> · {provider.model || provider.defaultModel || provider.type || '固定模型'} · {ROUTE_LABELS[key]}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <ProvisioningImportCard onImported={handleImported} />
    </div>
  );
}

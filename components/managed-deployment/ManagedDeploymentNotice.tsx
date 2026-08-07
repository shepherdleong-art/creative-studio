'use client';

import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import type { ManagedWorkbenchStatus } from '@/lib/managed-workbench';

function titleFor(status: ManagedWorkbenchStatus): string {
  if (status.phase === 'unconfigured') return '请先导入公司统一配置';
  if (status.phase === 'starting') return '公司模型服务正在启动';
  if (status.phase === 'failed') return '公司模型服务暂不可用';
  return '工作台正在准备中';
}

function detailFor(status: ManagedWorkbenchStatus): string {
  if (status.phase === 'unconfigured') return '首次使用前，请在设置页导入管理员提供的加密配置文件。';
  if (status.phase === 'starting') return 'LiteLLM 代理启动完成后，这里会自动解锁。';
  if (status.phase === 'failed') return status.reason || '请在设置页重启 LiteLLM，或重新导入统一配置。';
  return status.reason;
}

export default function ManagedDeploymentNotice({
  status,
  compact = false,
}: {
  status: ManagedWorkbenchStatus | null;
  compact?: boolean;
}) {
  const current = status ?? {
    managed: true,
    phase: 'starting' as const,
    configured: false,
    profileName: null,
    importedAt: null,
    configHashPrefix: null,
    proxyAvailable: false,
    reason: '正在读取公司配置状态…',
  };

  return (
    <section className={`card border-accent/25 bg-accent/[0.04] ${compact ? 'p-4' : 'p-6'}`} aria-live='polite'>
      <div className='flex items-start gap-3'>
        <div className='mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent'>
          <Icon name={current.phase === 'failed' ? 'alert' : 'lock'} size={18} />
        </div>
        <div className='min-w-0'>
          <h2 className='text-base font-semibold text-ink'>{titleFor(current)}</h2>
          <p className='mt-1 text-sm leading-relaxed text-ink-secondary'>{detailFor(current)}</p>
          <Link href='/settings#provisioning' className='btn-primary btn-sm mt-4 inline-flex'>
            前往设置导入配置
          </Link>
        </div>
      </div>
    </section>
  );
}

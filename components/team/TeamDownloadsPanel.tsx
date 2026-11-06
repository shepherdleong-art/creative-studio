'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ClientStatus } from '@/desktop/bridge-types';

const labels: Record<string, string> = { queued: '等待中', running: '传输中', paused: '已暂停', ready: '已完成', failed: '失败', cancelled: '已取消' };

export default function TeamDownloadsPanel() {
  const [status, setStatus] = useState<ClientStatus | null>(null);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      const result = await window.desktopBridge?.getClientStatus?.();
      setStatus(result ?? null);
      setError('');
    } catch { setError('无法读取本机传输状态，请刷新重试。'); }
  }, []);
  useEffect(() => {
    void Promise.resolve().then(refresh);
    const timer = setInterval(() => { void refresh(); }, 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  async function reveal(id: string) {
    try {
      const result = await window.desktopBridge?.revealDownload(id);
      if (!result?.revealed) setError('暂时无法定位本机文件，请检查下载是否完成。');
    } catch { setError('打开下载位置失败。'); }
  }
  const downloads = status?.transfers.filter(item => item.kind === 'download') ?? [];
  return <div className="space-y-6"><div className="flex items-center justify-between"><div><h1 className="text-3xl font-semibold tracking-tight">下载与交付</h1><p className="mt-3 text-sm text-ink-secondary">查看当前客户端的成片下载状态。</p></div><button className="btn-secondary btn-sm" onClick={() => void refresh()}>刷新</button></div>{error && <p role="alert" className="text-fail">{error}</p>}<section className="card divide-y divide-hairline p-6">{downloads.map(item => <div key={item.id} className="flex items-center justify-between gap-4 py-4"><div><strong className="text-sm">{item.displayName ?? '成片下载'}</strong><p className="mt-1 text-xs text-ink-secondary">{labels[item.state] ?? item.state}</p></div>{item.state === 'ready' && item.downloadId && <button className="btn-secondary btn-sm" onClick={() => void reveal(item.downloadId!)}>打开位置</button>}</div>)}{!downloads.length && <p className="py-12 text-center text-sm text-ink-secondary">{status ? '当前设备暂无下载记录。' : '请在桌面客户端查看自动下载；浏览器内可进入项目下载成果。'}</p>}</section></div>;
}

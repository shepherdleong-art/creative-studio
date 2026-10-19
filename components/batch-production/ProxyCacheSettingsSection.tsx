'use client';

import { useCallback, useEffect, useState } from 'react';

interface CacheUsage {
  count: number;
  totalBytes: number;
}

interface CleanupResult {
  deletedCount: number;
  freedBytes: number;
  skippedCount: number;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body.message === 'string' ? body.message : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * 设置页的"清理全部代理"入口:显示全部项目合计的代理占用,清理前不区分项目,
 * 明确说明不影响原片与正式成片(交接文档 §10)。
 */
export default function ProxyCacheSettingsSection() {
  const [usage, setUsage] = useState<CacheUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [cleaning, setCleaning] = useState(false);
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [error, setError] = useState('');

  const loadUsage = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await readJson<CacheUsage>(await fetch('/api/batch-production/proxies/usage', { cache: 'no-store' }));
      setUsage(data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '代理占用查询失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadUsage(), 0);
    return () => window.clearTimeout(timer);
  }, [loadUsage]);

  async function cleanupAll(): Promise<void> {
    setCleaning(true);
    setError('');
    setResult(null);
    try {
      const cleanup = await readJson<CleanupResult>(await fetch('/api/batch-production/proxies/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }));
      setResult(cleanup);
      await loadUsage();
    } catch (cleanupError) {
      setError(cleanupError instanceof Error ? cleanupError.message : '代理清理失败');
    } finally {
      setCleaning(false);
    }
  }

  return (
    <section className="card space-y-4 p-5" aria-label="代理缓存存储管理">
      <div>
        <h3 className="font-semibold text-ink">代理缓存</h3>
        <p className="mt-1 text-sm text-ink-secondary">
          批量生产为流畅预览生成的代理文件集中存放在这里,与项目素材、脚本、批次快照和正式成片完全无关。
          清理不影响任何原始视频、LUT 或正式产物,需要时可以随时重新生成。
        </p>
      </div>
      {loading ? (
        <p className="text-sm text-ink-tertiary">正在统计占用空间…</p>
      ) : (
        <div className="tile flex flex-wrap items-center justify-between gap-3 p-4">
          <div>
            <p className="text-xs text-ink-tertiary">全部项目合计占用</p>
            <strong className="mt-1 block text-2xl text-ink">{usage ? `${formatMb(usage.totalBytes)}MB` : '—'}</strong>
            <p className="mt-1 text-xs text-ink-tertiary">{usage?.count ?? 0} 个代理文件</p>
          </div>
          <button
            type="button"
            className="btn-secondary"
            disabled={cleaning || !usage || usage.count === 0}
            onClick={() => void cleanupAll()}
          >{cleaning ? '清理中…' : '清理全部代理'}</button>
        </div>
      )}
      {result && (
        <div className="rounded-xl bg-ok/10 px-4 py-3 text-sm text-ok">
          已清理 {result.deletedCount} 个代理,释放 {formatMb(result.freedBytes)}MB
          {result.skippedCount > 0 && `,跳过 ${result.skippedCount} 个使用中的文件(释放后会自动完成清理)`}
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-xl bg-fail/10 px-4 py-3 text-sm text-fail">{error}</div>
      )}
    </section>
  );
}

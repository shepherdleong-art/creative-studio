'use client';

import { useEffect, useLayoutEffect, useState, useRef, useCallback } from 'react';
import { Icon } from '@/components/ui/Icon';

interface LogEntry {
  id: string;
  jobId: string | null;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  attempt: number;
  createdAt: string;
}

interface Props {
  projectId?: string;
  logsUrl?: string; // 画布等独立模块复用查看器，保留原项目默认地址
  jobId?: string; // If provided, show only this job's logs
  autoRefresh?: boolean;
  refreshMs?: number;
  fill?: boolean; // When true, fill parent height instead of capping at max-h-96
}

function logDate(value: string): Date {
  return new Date(/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? value : value + 'Z');
}

const LEVEL_LABELS: Record<string, string> = {
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
  debug: 'DEBUG',
};

export default function LogViewer({ projectId, logsUrl, jobId, autoRefresh = false, refreshMs = 1000, fill = false }: Props) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const loadLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (jobId) params.set('jobId', jobId);
      params.set('limit', '300');
      const res = await fetch(`${logsUrl ?? `/api/projects/${projectId}/logs`}?${params}`, {
        cache: 'no-store',
      });
      const data = await res.json();
      if (!res.ok || !Array.isArray(data)) throw new Error(data.message || data.error || '加载日志失败');
      setLogs(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载日志失败');
    }
  }, [projectId, logsUrl, jobId]);

  // Initial load. `loading` starts true (useState); we clear it here inside a
  // nested async fn (same pattern as the other panels) so loadLogs() never
  // setStates synchronously from the effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    let active = true;
    (async () => {
      await loadLogs();
      if (active) setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [loadLogs]);

  // Auto-refresh
  useEffect(() => {
    if (!autoRefresh) return;
    const timeout = setTimeout(loadLogs, 0);
    const interval = setInterval(loadLogs, refreshMs);
    return () => { clearTimeout(timeout); clearInterval(interval); };
  }, [autoRefresh, loadLogs, refreshMs]);

  // The API returns a sliding window of 300 rows, so length stops changing.
  // Follow each committed snapshot/filter, including the first mounted list.
  useLayoutEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, filter, loading, autoScroll]);

  const filteredLogs = filter === 'all' ? logs : logs.filter((l) => l.level === filter);

  const copyLogs = async (entries: LogEntry[]) => {
    const text = entries
      .map(
        (l) =>
          `[${logDate(l.createdAt).toISOString()}] [${l.level.toUpperCase()}] [${l.jobId ? l.jobId.slice(0, 8) : 'queue'}] ${l.message}`
      )
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      fallbackCopy(text);
    }
  };

  const fallbackCopy = (text: string) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  };

  if (loading) {
    return <div className="py-4 text-center text-sm text-ink-tertiary">加载日志...</div>;
  }

  return (
    <div className={fill ? 'flex h-full flex-col' : undefined}>
      {/* Filter bar */}
      <div className="flex items-center gap-2 mb-3 flex-wrap shrink-0">
        <div className="flex gap-1">
          {(['all', 'info', 'warn', 'error'] as const).map((level) => (
            <button
              key={level}
              onClick={() => setFilter(level)}
              className={`text-xs px-2 py-1 rounded ${
                filter === level
                  ? 'bg-ink text-white'
                  : 'bg-surface-subtle text-ink-secondary hover:bg-hairline'
              }`}
            >
              {level === 'all' ? '全部' : LEVEL_LABELS[level]}
              {level !== 'all' && (
                <span className="ml-1 opacity-60">
                  {logs.filter((l) => l.level === level).length}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {autoRefresh && (
            <span className="text-xs text-ok">实时刷新中</span>
          )}
          <button
            onClick={() => copyLogs(logs)}
            className="link-accent inline-flex items-center gap-1 text-xs"
            title="复制全部日志"
          >
            <Icon name="copy" size={12} /> 全部
          </button>
          <button
            onClick={() => copyLogs(logs.filter(l => l.level === 'error'))}
            className="inline-flex items-center gap-1 text-xs text-fail hover:underline"
            title="复制错误日志"
          >
            <Icon name="alert" size={12} /> 错误
          </button>
          <label className="flex cursor-pointer items-center gap-1 text-xs text-ink-tertiary">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              title="持续跟随最新日志；取消勾选后可停留查看历史日志"
              className="w-3 h-3"
            />
            自动滚动
          </label>
          <button
            onClick={loadLogs}
            className="link-accent text-xs"
          >
            刷新
          </button>
        </div>
      </div>

      {error && <p role="alert" className="mb-2 text-xs text-fail">{error}</p>}
      {/* Log list */}
      {filteredLogs.length === 0 ? (
        <div className={`text-center text-sm text-ink-tertiary ${fill ? 'flex flex-1 items-center justify-center' : 'py-6'}`}>
          {filter === 'all' ? '暂无日志' : `无 ${LEVEL_LABELS[filter]} 级别日志`}
        </div>
      ) : (
        <div
          ref={containerRef}
          className={`${fill ? 'min-h-0 flex-1' : 'max-h-96'} overflow-y-auto rounded-lg border border-hairline bg-gray-900 font-mono text-xs text-gray-100`}
        >
          <table className="w-full">
            <tbody>
              {filteredLogs.map((log) => (
                <tr
                  key={log.id}
                  className={`border-b border-gray-800 hover:bg-gray-800/50 ${
                    log.level === 'error' ? 'bg-red-900/20' : ''
                  }`}
                >
                  <td className="py-1 px-2 text-gray-500 whitespace-nowrap w-1">
                    {logDate(log.createdAt).toLocaleTimeString('zh-CN', {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </td>
                  <td className="py-1 px-1 w-1">
                    <span
                      className={`inline-block w-12 text-center rounded text-[10px] px-1 py-px ${
                        log.level === 'error'
                          ? 'bg-red-800 text-red-200'
                          : log.level === 'warn'
                          ? 'bg-yellow-800 text-yellow-200'
                          : log.level === 'debug'
                          ? 'bg-gray-700 text-gray-300'
                          : 'bg-accent/40 text-run-tint'
                      }`}
                    >
                      {LEVEL_LABELS[log.level]}
                    </span>
                  </td>
                  {!jobId && (
                    <td className="py-1 px-2 text-gray-500 w-1 whitespace-nowrap">
                      {!log.jobId ? <Icon name="logs" size={12} className="text-gray-500" /> : (
                        <span title={`任务 ID: ${log.jobId} (点击复制)`} className="cursor-pointer hover:text-accent" onClick={() => { navigator.clipboard.writeText(log.jobId!).catch(() => {}); }}>
                          {log.jobId.slice(0, 6)}
                        </span>
                      )}
                    </td>
                  )}
                  <td className="py-1 px-2 break-words whitespace-pre-wrap">
                    {log.attempt > 0 && !jobId && (
                      <span className="text-gray-600 mr-1">[#{log.attempt}]</span>
                    )}
                    {log.message}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-1 shrink-0 text-xs text-ink-tertiary">
        共 {filteredLogs.length} 条日志
        {filter !== 'all' && ` (过滤: ${LEVEL_LABELS[filter]})`}
      </div>
    </div>
  );
}

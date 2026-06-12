'use client';

import { useEffect, useState, useRef } from 'react';

interface LogEntry {
  id: string;
  jobId: string | null;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  attempt: number;
  createdAt: string;
}

interface Props {
  projectId: string;
  jobId?: string; // If provided, show only this job's logs
  autoRefresh?: boolean;
  refreshMs?: number;
  fill?: boolean; // When true, fill parent height instead of capping at max-h-96
}

const LEVEL_CONFIG: Record<string, { bg: string; text: string; icon: string }> = {
  info: { bg: 'bg-blue-50', text: 'text-blue-700', icon: 'ℹ️' },
  warn: { bg: 'bg-yellow-50', text: 'text-yellow-700', icon: '⚠️' },
  error: { bg: 'bg-red-50', text: 'text-red-700', icon: '❌' },
  debug: { bg: 'bg-gray-50', text: 'text-gray-500', icon: '🔍' },
};

const LEVEL_LABELS: Record<string, string> = {
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
  debug: 'DEBUG',
};

export default function LogViewer({ projectId, jobId, autoRefresh = false, refreshMs = 1000, fill = false }: Props) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const mountedRef = useRef(true);
  useEffect(() => { return () => { mountedRef.current = false; }; }, []);

  const loadLogs = async () => {
    try {
      const params = new URLSearchParams();
      if (jobId) params.set('jobId', jobId);
      params.set('limit', '300');

      const res = await fetch(`/api/projects/${projectId}/logs?${params}`, {
        cache: 'no-store',
      });
      const data = await res.json();
      if (Array.isArray(data) && mountedRef.current) setLogs(data);
    } catch {
      // Silently fail on log fetch errors
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    const t = setTimeout(loadLogs, 0);
    return () => { clearTimeout(t); mountedRef.current = false; };
  }, [projectId, jobId]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(loadLogs, refreshMs);
    return () => clearInterval(interval);
  }, [autoRefresh, projectId, jobId]);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs.length, autoScroll]);

  const filteredLogs = filter === 'all' ? logs : logs.filter((l) => l.level === filter);

  const handleClear = async () => {
    await loadLogs();
  };

  const copyLogs = async (entries: LogEntry[]) => {
    const text = entries
      .map(
        (l) =>
          `[${new Date(l.createdAt + 'Z').toISOString()}] [${l.level.toUpperCase()}] [${l.jobId ? l.jobId.slice(0, 8) : 'queue'}] ${l.message}`
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
    return <div className="text-sm text-gray-400 py-4 text-center">加载日志...</div>;
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
                  ? 'bg-gray-700 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
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
            <span className="text-xs text-green-500">实时刷新中</span>
          )}
          <button
            onClick={() => copyLogs(logs)}
            className="text-xs text-gray-500 hover:text-gray-700"
            title="复制全部日志"
          >
            📋 全部
          </button>
          <button
            onClick={() => copyLogs(logs.filter(l => l.level === 'error'))}
            className="text-xs text-red-500 hover:text-red-700"
            title="复制错误日志"
          >
            ⚠️ 错误
          </button>
          <label className="flex items-center gap-1 text-xs text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="w-3 h-3"
            />
            自动滚动
          </label>
          <button
            onClick={loadLogs}
            className="text-xs text-blue-600 hover:text-blue-800"
          >
            刷新
          </button>
        </div>
      </div>

      {/* Log list */}
      {filteredLogs.length === 0 ? (
        <div className={`text-center text-gray-400 text-sm ${fill ? 'flex flex-1 items-center justify-center' : 'py-6'}`}>
          {filter === 'all' ? '暂无日志' : `无 ${LEVEL_LABELS[filter]} 级别日志`}
        </div>
      ) : (
        <div
          ref={containerRef}
          className={`${fill ? 'min-h-0 flex-1' : 'max-h-96'} overflow-y-auto border border-gray-200 rounded-lg bg-gray-900 text-gray-100 font-mono text-xs`}
          onScroll={(e) => {
            const el = e.currentTarget;
            const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
            if (!isAtBottom) setAutoScroll(false);
          }}
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
                    {new Date(log.createdAt + 'Z').toLocaleTimeString('zh-CN', {
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
                          : 'bg-blue-800 text-blue-200'
                      }`}
                    >
                      {LEVEL_LABELS[log.level]}
                    </span>
                  </td>
                  {!jobId && (
                    <td className="py-1 px-2 text-gray-500 w-1 whitespace-nowrap">
                      {!log.jobId ? '📋' : log.jobId.slice(0, 6)}
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

      <div className="text-xs text-gray-400 mt-1 shrink-0">
        共 {filteredLogs.length} 条日志
        {filter !== 'all' && ` (过滤: ${LEVEL_LABELS[filter]})`}
      </div>
    </div>
  );
}

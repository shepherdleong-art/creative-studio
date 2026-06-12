'use client';

import LogViewer from '@/components/LogViewer';

interface Props {
  open: boolean;
  projectId: string;
  autoRefresh: boolean;
  onClose: () => void;
}

export default function LogDrawer({ open, projectId, autoRefresh, onClose }: Props) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[110]">
      <div className="absolute inset-0 bg-black/35" onClick={onClose} />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-[640px] flex-col bg-white shadow-2xl sm:border-l sm:border-hairline lg:max-w-[720px]">
        <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">运行日志</h2>
            <p className="text-xs text-ink-tertiary">随时查看队列状态、错误和补抓信息</p>
          </div>
          <button type="button" onClick={onClose} className="btn-secondary btn-sm text-xs">
            关闭
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
          <LogViewer projectId={projectId} autoRefresh={autoRefresh} refreshMs={1000} fill />
        </div>
      </aside>
    </div>
  );
}
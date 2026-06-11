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
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-[440px] flex-col bg-white shadow-2xl sm:border-l sm:border-gray-200">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">运行日志</h2>
            <p className="text-xs text-gray-400">随时查看队列状态、错误和补抓信息</p>
          </div>
          <button type="button" onClick={onClose} className="btn-secondary btn-sm text-xs">
            关闭
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <LogViewer projectId={projectId} autoRefresh={autoRefresh} refreshMs={1000} />
        </div>
      </aside>
    </div>
  );
}
'use client';

import { useState } from 'react';
import Link from 'next/link';

export default function Header() {
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [stopping, setStopping] = useState(false);

  const handleStop = async () => {
    setStopping(true);
    try {
      await fetch('/api/shutdown', { method: 'POST' });
    } catch {
      // Server may close before responding, that's expected
    }
    // If we get here, show a message
    setTimeout(() => {
      setStopping(false);
      setShowStopConfirm(false);
    }, 2000);
  };

  return (
    <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between shrink-0">
      <Link href="/" className="text-lg font-bold text-gray-900 hover:text-blue-600 transition-colors">
        🖼️ 批量图片编辑工作台
      </Link>
      <nav className="flex gap-4 text-sm items-center">
        <Link href="/" className="text-gray-600 hover:text-gray-900">项目列表</Link>
        <Link href="/settings" className="text-gray-600 hover:text-gray-900">供应商配置</Link>
        <Link href="/projects/new" className="text-blue-600 hover:text-blue-800 font-medium">+ 新建项目</Link>
        <span className="text-gray-300 mx-1">|</span>
        <button
          onClick={() => setShowStopConfirm(true)}
          className="text-gray-400 hover:text-red-500 transition-colors text-xs flex items-center gap-1"
          title="关闭服务"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18.36 6.64A9 9 0 0120.82 12" />
            <path d="M12 2v4" />
            <path d="M12 22v-4" />
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
          </svg>
          停止服务
        </button>
      </nav>

      {/* Stop confirmation modal */}
      {showStopConfirm && (
        <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-sm w-full p-6">
            <h3 className="text-lg font-semibold mb-2">关闭服务</h3>
            <p className="text-sm text-gray-600 mb-2">
              确定要停止工作台服务吗？停止后需要重新运行 <code className="bg-gray-100 px-1 rounded text-xs">start.sh</code> 才能再次使用。
            </p>
            <p className="text-xs text-gray-400 mb-4">
              或者直接在终端窗口按 <kbd className="bg-gray-100 px-1 rounded">Ctrl+C</kbd>
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowStopConfirm(false)}
                className="btn-secondary btn-sm"
                disabled={stopping}
              >
                取消
              </button>
              <button
                onClick={handleStop}
                disabled={stopping}
                className="btn-danger btn-sm"
              >
                {stopping ? '关闭中...' : '确定关闭'}
              </button>
            </div>
            {stopping && (
              <p className="text-xs text-green-600 mt-3 text-center">
                服务已关闭，可以关闭此窗口
              </p>
            )}
          </div>
        </div>
      )}
    </header>
  );
}

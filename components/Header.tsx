'use client';

import { useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import ThemeToggle from '@/components/ThemeToggle';

// Read-only probe for the desktop shell. The bridge is injected by the preload
// before any React code runs and never changes afterwards, so the subscription
// is a no-op and the server snapshot is simply "not the desktop shell".
const subscribeToDesktopShell = () => () => {};
const readDesktopShell = () => Boolean((window as { desktopBridge?: unknown }).desktopBridge);
const readDesktopShellOnServer = () => false;

export default function Header() {
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [stopping, setStopping] = useState(false);
  // In the shell, stopping the service also takes the application down, so the
  // copy must not tell the user to close the window themselves.
  const isDesktop = useSyncExternalStore(
    subscribeToDesktopShell,
    readDesktopShell,
    readDesktopShellOnServer,
  );

  const handleStop = async () => {
    setStopping(true);
    try {
      await fetch('/api/shutdown', { method: 'POST' });
    } catch {
      // Server may close before responding, that's expected
    }
    setTimeout(() => {
      setStopping(false);
      setShowStopConfirm(false);
    }, 2000);
  };

  return (
    <header className="toolbar h-12 gap-5 px-6 text-sm">
      <Link href="/" className="font-semibold tracking-tight text-ink transition-colors hover:text-accent">
        产品素材工作台
      </Link>
      <nav className="ml-auto flex items-center gap-4">
        <Link href="/" className="text-ink-secondary transition-colors hover:text-ink">项目</Link>
        <Link href="/usage" className="text-ink-secondary transition-colors hover:text-ink">消耗</Link>
        <Link href="/settings" className="text-ink-secondary transition-colors hover:text-ink">供应商</Link>
        <Link href="/projects/new" className="btn-primary btn-sm">
          <Icon name="plus" size={15} /> 新建项目
        </Link>
        <ThemeToggle />
        <button
          onClick={() => setShowStopConfirm(true)}
          className="icon-btn text-ink-tertiary hover:text-fail"
          title="停止服务"
          aria-label="停止服务"
        >
          <Icon name="power" size={16} />
        </button>
      </nav>

      {showStopConfirm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm">
          <div className="card w-full max-w-sm p-6 shadow-[0_20px_60px_rgba(0,0,0,.18)]">
            <h3 className="mb-2 text-lg font-semibold text-ink">{isDesktop ? '停止服务并退出' : '停止服务'}</h3>
            {isDesktop ? (
              <p className="mb-4 text-sm text-ink-secondary">
                确定要停止工作台服务吗？服务停止后应用会自动退出，后台任务会一并结束；已持久化的任务可在下次启动后恢复。
              </p>
            ) : (
              <>
                <p className="mb-2 text-sm text-ink-secondary">
                  确定要停止工作台服务吗？停止后需重新运行启动脚本（Windows：
                  <code className="rounded bg-surface-subtle px-1 font-mono text-xs">start-windows.cmd</code>；macOS：
                  <code className="rounded bg-surface-subtle px-1 font-mono text-xs">start.command</code>）才能再次使用。
                </p>
                <p className="mb-4 text-xs text-ink-tertiary">
                  或直接在终端按 <kbd className="rounded bg-surface-subtle px-1 font-mono">Ctrl+C</kbd>
                </p>
              </>
            )}
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowStopConfirm(false)} className="btn-secondary btn-sm" disabled={stopping}>
                取消
              </button>
              <button onClick={handleStop} disabled={stopping} className="btn-danger btn-sm">
                {stopping ? '关闭中…' : isDesktop ? '确定关闭并退出' : '确定关闭'}
              </button>
            </div>
            {stopping && (
              <p className="mt-3 text-center text-xs text-ok">
                {isDesktop ? '服务已关闭，应用即将退出…' : '服务已关闭，可关闭此窗口'}
              </p>
            )}
          </div>
        </div>
      )}
    </header>
  );
}

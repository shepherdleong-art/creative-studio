'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '@/components/ui/Icon';
import ThemeToggle from '@/components/ThemeToggle';
import TeamWorkspaceNavigation from '@/components/team/TeamWorkspaceNavigation';
import { WorkspaceLeafMark } from '@/components/team/WorkspaceBrandMark';
import { teamError, teamWrite } from '@/components/team/client';
import { workspaceProductName } from '@/lib/workspace-navigation';

// Read-only probe for the desktop shell. The bridge is injected by the preload
// before any React code runs and never changes afterwards, so the subscription
// is a no-op and the server snapshot is simply "not the desktop shell".
const subscribeToDesktopShell = () => () => {};
const readDesktopShell = () => Boolean((window as { desktopBridge?: unknown }).desktopBridge);
const readDesktopShellOnServer = () => false;

export interface HeaderPrincipal {
  employeeId?: string;
  displayName: string;
  role: 'employee' | 'admin';
  mustChangePassword?: boolean;
}

/**
 * 应用外壳（05 号票）。
 *
 * 两种模式共存：
 * - **个人本地版**（`deploymentMode === 'local'`）：保留原有顶栏结构，只换名字和标志；
 *   「停止服务」只在这里出现。
 * - **团队版**（`deploymentMode === 'server'`）：**不渲染全局顶栏**，改由
 *   `TeamWorkspaceNavigation` 的左侧分组侧栏承担导航、头像菜单、外观、退出登录与
 *   客户端更新提示条；每页标题由 `PageToolbar` 负责。
 *
 * 团队版里本组件只剩两件事：挂侧栏、把桌面壳的「关闭窗口」意图接到退出登录。
 * 侧栏底部仍保留「关闭窗口不会中断服务器任务」这行说明。
 */
export default function Header({
  canvasEnabled = false,
  deploymentMode = 'local',
  principal = null,
}: {
  canvasEnabled?: boolean;
  deploymentMode?: 'local' | 'server';
  principal?: HeaderPrincipal | null;
}) {
  const pathname = usePathname();
  const onCanvas = pathname === '/canvas' || pathname.startsWith('/canvas/');
  const server = deploymentMode === 'server';
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  // 团队版退出登录在侧栏头像菜单里（见 TeamWorkspaceNavigation），这里的错误只用于
  // 桌面壳「关闭窗口 = 退出登录」失败时留痕。
  const [logoutError, setLogoutError] = useState('');
  // In the shell, stopping the service also takes the application down, so the
  // copy must not tell the user to close the window themselves.
  const isDesktop = useSyncExternalStore(
    subscribeToDesktopShell,
    readDesktopShell,
    readDesktopShellOnServer,
  );

  const handleLogout = useCallback(async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError('');
    try {
      const response = await teamWrite('/api/team/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error(await teamError(response, '退出失败'));
      window.location.assign('/team/login');
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : '退出失败，请重试');
      setLoggingOut(false);
    }
  }, [loggingOut]);

  useEffect(() => window.desktopBridge?.onQuitRequested?.(() => {
    if (server) void handleLogout();
    else setShowStopConfirm(true);
  }), [server, handleLogout]);

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

  // ---- 团队版：没有全局顶栏，只有侧栏（客户端版本过旧时侧栏底部出现更新提示条） ----
  if (server) {
    const showSidebar = Boolean(principal && !principal.mustChangePassword);
    return <>
      {showSidebar && principal && <TeamWorkspaceNavigation principal={principal} canvasEnabled={canvasEnabled} />}
      {logoutError && <span className="sr-only" role="alert">{logoutError}</span>}
    </>;
  }

  // ---- 个人本地版：保留原顶栏结构，只换名字、标志与令牌 ----
  return (
    <>
    <header className="toolbar h-12 gap-5 px-6 text-sm">
      <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight text-ink transition-colors hover:text-accent">
        <WorkspaceLeafMark size={17} />
        {workspaceProductName(null)}
      </Link>
      <nav className="ml-auto flex items-center gap-4">
        <Link href="/" className="text-ink-secondary transition-colors hover:text-ink">项目</Link>
        {canvasEnabled && (
          <Link
            href="/canvas"
            aria-current={onCanvas ? 'page' : undefined}
            className={`whitespace-nowrap transition-colors hover:text-ink ${onCanvas ? 'font-medium text-accent' : 'text-ink-secondary'}`}
          >创作画布</Link>
        )}
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
    </>
  );
}

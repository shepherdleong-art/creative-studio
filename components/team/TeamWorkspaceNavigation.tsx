'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '@/components/ui/Icon';
import type { HeaderPrincipal } from '@/components/Header';
import {
  buildWorkspaceNavigation,
  formatBadgeCount,
  isWorkspaceNavActive,
  workspaceBadgeCounts,
  workspaceProductName,
  WORKSPACE_MENU_LINKS,
} from '@/lib/workspace-navigation';
import { THEME_MENU_ORDER, THEME_OPTIONS, useThemePreference } from '@/components/ThemeToggle';
import { teamError, teamWrite } from '@/components/team/client';
import { WorkspaceBrandMark } from './WorkspaceBrandMark';
import s from './workspace.module.css';

type BadgeCounts = ReturnType<typeof workspaceBadgeCounts>;

const EMPTY_COUNTS: BadgeCounts = { tasks: null, errors: null };

// 只有桌面运行壳才注入 bridge；订阅是空操作（preload 早于 React，之后不再变化）。
const subscribeToDesktopShell = () => () => {};
const readDesktopShell = () => Boolean((window as { desktopBridge?: unknown }).desktopBridge);
const readDesktopShellOnServer = () => false;

/**
 * 团队版侧栏（05 号票）：顶部小标志 + 端名，中间分组导航，底部头像菜单。
 *
 * 数据全部来自 `lib/workspace-navigation.ts`——分组、顺序、文案、href、角标字段都在那里，
 * 本组件只负责渲染与交互，不再自带一份入口清单。
 */
export default function TeamWorkspaceNavigation({ principal, canvasEnabled }: { principal: HeaderPrincipal; canvasEnabled: boolean }) {
  const pathname = usePathname();
  const admin = principal.role === 'admin';
  const productName = workspaceProductName(principal.role);
  const groups = buildWorkspaceNavigation({ role: principal.role, canvasEnabled });
  const [counts, setCounts] = useState<BadgeCounts>(EMPTY_COUNTS);
  const [countsReady, setCountsReady] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const [theme, chooseTheme] = useThemePreference();
  const [clientStatus, setClientStatus] = useState<import('@/desktop/bridge-types').ClientStatus | null>(null);
  const [clientUpdating, setClientUpdating] = useState(false);
  const [clientMessage, setClientMessage] = useState('');
  const isDesktop = useSyncExternalStore(subscribeToDesktopShell, readDesktopShell, readDesktopShellOnServer);
  const footerRef = useRef<HTMLDivElement>(null);

  // 数量角标：直接数页面同一个接口的 items，口径与对应页一致（见 workspace-navigation）。
  // 只取一次，路由变化时重取——页面自己刷新时角标不必实时跟随，但切页一定会更新。
  const refreshCounts = useCallback(() => Promise.all([
    fetch('/api/team/tasks', { credentials: 'same-origin', cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null)).catch(() => null),
    fetch('/api/team/errors', { credentials: 'same-origin', cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null)).catch(() => null),
  ]).then(([tasks, errors]) => {
    setCounts(workspaceBadgeCounts({ tasks, errors }));
    setCountsReady(true);
  }), []);

  useEffect(() => { void refreshCounts(); }, [refreshCounts, pathname]);

  // 客户端版本过旧提示：沿用现有 bridge 探针（与旧顶栏同一入口）。
  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => window.desktopBridge?.getClientStatus?.())
      .then((status) => { if (active && status) setClientStatus(status); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  // 头像菜单：点外部或 Esc 收起。
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (footerRef.current && !footerRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

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

  // 更新诊断上报：与旧顶栏完全同一套（POST /api/team/errors/report）。
  const reportUpdateFailure = async (code: string, message: string) => {
    setClientMessage(message);
    try {
      const response = await teamWrite('/api/team/errors/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientEventId: crypto.randomUUID(), stage: 'client_update', code }),
      });
      if (response.ok) {
        const body = await response.json() as { errorId: string };
        setClientMessage(`${message} 错误编号：${body.errorId}`);
      }
    } catch {
      // 更新入口不可用时仍保留原可行动提示，诊断上报不能再次阻断客户端。
    }
  };
  const handleClientUpdate = async () => {
    if (clientUpdating) return;
    setClientUpdating(true);
    setClientMessage('');
    try {
      const result = await window.desktopBridge?.installClientUpdate?.();
      if (!result?.started) await reportUpdateFailure('update_start_unavailable', result?.message ?? '未找到受控更新入口，请联系管理员修复。');
      else setClientMessage('更新助手已启动；验证完成前会暂停本机传输。');
    } catch {
      await reportUpdateFailure('update_start_failed', '更新助手启动失败，请联系管理员修复。');
    } finally {
      setClientUpdating(false);
    }
  };

  const clientCompatible = clientStatus?.compatible !== false;
  const badgeValue = (key: 'tasks' | 'errors') => formatBadgeCount(counts[key]);

  return (
    <aside className={s.sidebar} aria-label="工作台侧栏" data-testid="workspace-sidebar" data-badges-ready={countsReady ? 'true' : 'false'}>
      <Link href="/" className={s.wsBrand} aria-label={productName} data-testid="workspace-brand">
        <span className={s.wsBrandMark}><WorkspaceBrandMark size={26} /></span>
        <span className={s.wsBrandCopy}>
          <strong>{productName}</strong>
          <small>Lin&apos;s Vision</small>
        </span>
      </Link>

      <nav className={s.wsNav} aria-label={admin ? '团队管理导航' : '创作导航'} data-testid="workspace-nav">
        {groups.map((group) => (
          <div key={group.title}>
            <p className={s.wsGroupTitle} data-testid="workspace-nav-group">{group.title}</p>
            {group.items.map((item) => {
              const badge = item.badge ? badgeValue(item.badge) : null;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={s.wsNavRow}
                  title={item.label}
                  aria-label={badge ? `${item.label}，${badge} 条` : item.label}
                  aria-current={isWorkspaceNavActive(pathname, item.href) ? 'page' : undefined}
                  data-testid="workspace-nav-item"
                >
                  <Icon name={item.icon} size={17} />
                  <span className={s.wsNavLabel}>{item.label}</span>
                  {badge && <span className={s.wsBadge} data-testid={`workspace-badge-${item.badge}`}>{badge}</span>}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className={s.wsFooter} ref={footerRef}>
        {!clientCompatible && (
          <div className={s.wsUpdateBar} role="status" data-testid="workspace-update-bar">
            <strong>客户端版本过旧</strong>
            <span>{isDesktop ? '更新后才能继续上传与下载。' : '请在桌面客户端中更新到最新版本。'}</span>
            <button type="button" onClick={() => void handleClientUpdate()} disabled={clientUpdating}>
              {clientUpdating ? '正在启动更新…' : '修复并更新'}
            </button>
            {clientMessage && <span className={s.wsUpdateMessage}>{clientMessage}</span>}
          </div>
        )}

        <div className={s.wsMenuAnchor}>
          {menuOpen && (
            <div className={s.wsMenu} role="menu" aria-label="账号菜单" data-testid="workspace-user-menu">
              <div className={s.wsMenuWho}>
                <strong>{principal.displayName}</strong>
                <small>{principal.employeeId ? `工号 ${principal.employeeId}，` : ''}{admin ? '管理员' : '创作成员'}</small>
              </div>
              <div className={s.wsMenuTheme}>
                <span>外观</span>
                <div className={s.wsThemeSeg} role="radiogroup" aria-label="外观">
                  {THEME_MENU_ORDER.map((key) => (
                    <button
                      key={key}
                      type="button"
                      role="radio"
                      aria-checked={theme === key}
                      onClick={() => chooseTheme(key)}
                    >{THEME_OPTIONS[key].shortLabel}</button>
                  ))}
                </div>
              </div>
              <hr className={s.wsMenuHr} />
              {WORKSPACE_MENU_LINKS.map((link) => (
                <Link key={link.href} href={link.href} className={s.wsMenuItem} role="menuitem" onClick={() => setMenuOpen(false)}>
                  <Icon name={link.icon} size={15} />
                  <span>{link.label}</span>
                </Link>
              ))}
              <hr className={s.wsMenuHr} />
              <button
                type="button"
                role="menuitem"
                className={`${s.wsMenuItem} ${s.wsMenuDanger}`}
                onClick={() => void handleLogout()}
                disabled={loggingOut}
              >
                <Icon name="power" size={15} />
                <span>{loggingOut ? '退出中…' : '退出登录'}</span>
              </button>
              {logoutError && <p className={s.wsMenuHint} role="alert">{logoutError}</p>}
              <p className={s.wsMenuHint} data-testid="workspace-menu-hint">关闭窗口不会中断服务器任务</p>
            </div>
          )}

          <button
            type="button"
            className={s.wsUser}
            onClick={() => setMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`账号菜单：${principal.displayName}`}
            data-testid="workspace-user-button"
          >
            <span className={s.wsAvatar} aria-hidden="true">{(principal.displayName || '·').slice(0, 1)}</span>
            <span className={s.wsUserCopy}>
              <strong>{principal.displayName || '未命名'}</strong>
              <small>{principal.employeeId || '—'} · {admin ? '管理员' : '创作成员'}</small>
            </span>
            <Icon name="chevron-down" size={14} className={s.wsUserChevron} />
          </button>
        </div>
      </div>
    </aside>
  );
}

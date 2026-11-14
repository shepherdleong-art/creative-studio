'use client';

import {
  useCallback, useEffect, useRef, useState, useSyncExternalStore,
  type FocusEvent as ReactFocusEvent, type PointerEvent as ReactPointerEvent,
} from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '@/components/ui/Icon';
import { Segmented } from '@/components/ui/Appearance';
import type { HeaderPrincipal } from '@/components/Header';
import {
  buildWorkspaceNavigation,
  formatBadgeCount,
  isWorkspaceNavActive,
  workspaceBadgeCounts,
  workspaceProductName,
  WORKSPACE_MENU_LINKS,
  WORKSPACE_CLIENT_UPDATE_ACTION,
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

/** 窄窗口判定：规格「小窗口与画面尺寸」的 1280 是断点。 */
const NARROW_QUERY = '(max-width: 1279px)';
const subscribeNarrow = (onChange: () => void) => {
  const query = window.matchMedia(NARROW_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};
const readNarrow = () => window.matchMedia(NARROW_QUERY).matches;
// 服务端不知道窗口宽度：按宽窗口渲染（完整侧栏），水合后按实际宽度收。
const readNarrowOnServer = () => false;

/** 悬停浮层：只记被指的那一行文案与它的纵向中线（浮层的左缘由 CSS 算）。 */
type Flyout = { label: string; top: number } | null;

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

  // ---- 窄窗口收法（15 号票，用户已选定：图标窄条 + 悬停浮出名称）----
  // 规格「小窗口与画面尺寸」：<1280 时侧栏收成只有图标的窄条、悬停显示名称。
  // 用户从三种收法（图标窄条 / 悬停整条展开 / 覆盖式抽屉）里选了第一种，
  // 另外两套与 `?narrow=` 试用开关已按 15 号票 Comments 的清单删掉。
  const narrow = useSyncExternalStore(subscribeNarrow, readNarrow, readNarrowOnServer);
  const [flyout, setFlyout] = useState<Flyout>(null);
  // 窗口变宽后浮层不该继续存在（会悬在内容上挡字）。
  // 渲染期就地重置，避免 effect 里的级联渲染（与 MixcutShell 的 autoExpandOverride 同一手法）。
  const [prevNarrow, setPrevNarrow] = useState(narrow);
  if (narrow !== prevNarrow) {
    setPrevNarrow(narrow);
    if (!narrow) setFlyout(null);
  }
  // 名称浮层：窄条下靠它显示这一行的名称（悬停或键盘聚焦）。
  const showFlyout = narrow;

  const flyoutProps = (label: string) => {
    if (!showFlyout) return {};
    return {
      onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => {
        const box = event.currentTarget.getBoundingClientRect();
        setFlyout({ label, top: box.top + box.height / 2 });
      },
      onPointerLeave: () => setFlyout(null),
      onFocus: (event: ReactFocusEvent<HTMLElement>) => {
        const box = event.currentTarget.getBoundingClientRect();
        setFlyout({ label, top: box.top + box.height / 2 });
      },
      onBlur: () => setFlyout(null),
    };
  };

  // 切页只读取全可见范围的两个计数，避免为角标重复加载任务/错误明细。
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void fetch('/api/team/workspace-counts', {
      credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
    })
      .then((response) => response.ok ? response.json() : null)
      .then((body) => { if (active) setCounts(workspaceBadgeCounts(body)); })
      .catch(() => { if (active) setCounts(EMPTY_COUNTS); })
      .finally(() => { if (active) setCountsReady(true); });
    return () => { active = false; controller.abort(); };
  }, [pathname]);

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
      if (result?.upToDate) setClientMessage(result.message ?? '当前已是最新版本。');
      else if (!result?.started) await reportUpdateFailure('update_start_unavailable', result?.message ?? '未找到受控更新入口，请联系管理员修复。');
      else { setClientMessage('更新已开始，完成后客户端会自动重启；本机上传和下载会暂时暂停。'); }
    } catch {
      await reportUpdateFailure('update_start_failed', '更新助手启动失败，请联系管理员修复。');
    } finally {
      setClientUpdating(false);
    }
  };

  const clientCompatible = clientStatus?.compatible !== false;
  const badgeValue = (key: 'tasks' | 'errors') => formatBadgeCount(counts[key]);

  return (
    <>
    <aside
      id="workspace-sidebar"
      className={s.sidebar}
      aria-label="工作台侧栏"
      data-testid="workspace-sidebar"
      data-badges-ready={countsReady ? 'true' : 'false'}
      {...(narrow ? { 'data-narrow': 'rail' } : {})}
    >
      <Link href="/" className={s.wsBrand} aria-label={productName} data-testid="workspace-brand" {...flyoutProps(productName)}>
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
                  {...flyoutProps(badge ? `${item.label}（${badge}）` : item.label)}
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
                <Segmented
                  value={theme}
                  label="外观"
                  size="small"
                  semantics="toggle"
                  options={THEME_MENU_ORDER.map((key) => ({ value: key, label: THEME_OPTIONS[key].shortLabel }))}
                  onChange={(next) => chooseTheme(next)}
                />
              </div>
              <hr className={s.wsMenuHr} />
              {WORKSPACE_MENU_LINKS.map((link) => (
                <Link key={link.href} href={link.href} className={s.wsMenuItem} role="menuitem" onClick={() => setMenuOpen(false)}>
                  <Icon name={link.icon} size={15} />
                  <span>{link.label}</span>
                </Link>
              ))}
              {isDesktop && (
                <>
                  <button type="button" role="menuitem" className={s.wsMenuItem}
                    data-testid="workspace-client-update" onClick={() => void handleClientUpdate()} disabled={clientUpdating || !clientStatus || (clientStatus.updaterVersion ?? 0) < 2}>
                    <Icon name={WORKSPACE_CLIENT_UPDATE_ACTION.icon} size={15} />
                    <span>{clientUpdating ? '正在检查更新…' : WORKSPACE_CLIENT_UPDATE_ACTION.label}</span>
                  </button>
                  {clientStatus && (clientStatus.updaterVersion ?? 0) < 2 && <p className={`${s.wsMenuHint} ${s.wsClientUpdateMessage}`}>
                    首次启用需升级客户端一次，之后可直接一键更新。
                    <a href="/client-updates/client-latest-installer.zip" download>下载升级包</a>
                  </p>}
                  {clientMessage && <p className={`${s.wsMenuHint} ${s.wsClientUpdateMessage}`} role="status" data-testid="workspace-client-update-message">{clientMessage}</p>}
                </>
              )}
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
    {flyout && (
      <div
        className={s.wsFlyout}
        role="tooltip"
        style={{ top: flyout.top }}
        data-testid="workspace-nav-flyout"
      >{flyout.label}</div>
    )}
    </>
  );
}

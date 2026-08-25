'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Icon, type IconName } from '@/components/ui/Icon';

// 三态外观切换：浅色 / 深色 / 自动（跟随系统）。真实主题由 html[data-theme] 表达
// （globals.css 按它切换设计令牌），这里只负责读写外观偏好并应用到 <html>。
// 页面加载时的首次应用由 layout.tsx 的内联脚本在水合前完成，避免白闪。
type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'creative-studio-theme';
const ORDER: ThemePreference[] = ['light', 'dark', 'system'];
const META: Record<ThemePreference, { icon: IconName; label: string; desc: string }> = {
  light: { icon: 'sun', label: '浅色模式', desc: '始终使用浅色主题' },
  dark: { icon: 'moon', label: '深色模式', desc: '始终使用深色主题' },
  system: { icon: 'monitor', label: '自动模式', desc: '跟随系统主题设置' },
};

function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

// 偏好存 localStorage，走 useSyncExternalStore 读取（localStorage 是浏览器外部系统，
// 且能在 effect 里避免同步 setState）。listeners 让本组件写入后立刻重渲染，
// storage 事件则兜住同一浏览器其他标签页的修改。
const listeners = new Set<() => void>();

function subscribePreference(callback: () => void) {
  listeners.add(callback);
  window.addEventListener('storage', callback);
  return () => {
    listeners.delete(callback);
    window.removeEventListener('storage', callback);
  };
}

function readPreference(): ThemePreference {
  const saved = localStorage.getItem(STORAGE_KEY);
  return isThemePreference(saved) ? saved : 'system';
}

// 服务端快照固定为 system，与内联脚本不设置属性时的初始渲染一致
const readPreferenceOnServer = (): ThemePreference => 'system';

function writePreference(pref: ThemePreference) {
  localStorage.setItem(STORAGE_KEY, pref);
  listeners.forEach((callback) => callback());
}

function applyPreference(pref: ThemePreference) {
  const resolved =
    pref === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : pref;
  document.documentElement.dataset.theme = resolved;
}

export default function ThemeToggle() {
  const pref = useSyncExternalStore(subscribePreference, readPreference, readPreferenceOnServer);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    applyPreference(pref);
    // 桌面壳：原生控件（select 弹出列表、右键菜单）主题由主进程 nativeTheme 决定，
    // 不吃页面 CSS 的 color-scheme，偏好变化时同步过去；浏览器环境无 bridge，忽略即可。
    window.desktopBridge?.setThemePreference(pref).catch(() => {});
    if (pref !== 'system') return;
    // 自动模式：监听系统外观变化实时切换
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyPreference('system');
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [pref]);

  // 打开时点击外部或按 Esc 收起
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const choose = (next: ThemePreference) => {
    writePreference(next);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="icon-btn text-ink-tertiary hover:text-ink"
        title="外观设置"
        aria-label="外观设置"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon name={META[pref].icon} size={16} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="外观"
          className="absolute right-0 top-full z-50 mt-2 w-60 rounded-[14px] border border-hairline bg-surface-subtle p-1.5 shadow-[0_16px_48px_rgba(0,0,0,.24)]"
        >
          {ORDER.map((key) => {
            const meta = META[key];
            const active = pref === key;
            return (
              <button
                key={key}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => choose(key)}
                className={`flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left transition-colors hover:bg-surface-hover ${
                  active ? 'bg-surface shadow-sm' : ''
                }`}
              >
                <Icon name={meta.icon} size={16} className={active ? 'text-accent' : 'text-ink-secondary'} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-ink">{meta.label}</span>
                  <span className="block text-[11px] text-ink-tertiary">{meta.desc}</span>
                </span>
                {active && <Icon name="check" size={14} className="text-accent" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

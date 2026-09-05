'use client';

import { useProxyPlaybackPreference } from './proxy-playback-preference';

/**
 * 播放源切换控件（代理/原片，B1 总开关的 UI 载体）。
 * 只改变当前播放位的源选择，绝不触发任何生成/清理请求。
 * 无代理素材时 disabled(true) 并给引导 hint（与播放器引导按钮呼应，不重复造按钮）。
 */
export function ProxyPlaybackToggle({
  disabled = false,
  disabledHint,
  onBeforeChange,
}: {
  disabled?: boolean;
  /** disabled 时的引导文案(如"生成低清代理后可切换") */
  disabledHint?: string;
  /** 切换生效前回调(播放位用它保存当前播放位置/状态,换源后恢复) */
  onBeforeChange?: (next: boolean) => void;
}) {
  const { proxyPlayback, setProxyPlayback } = useProxyPlaybackPreference();
  const switchTo = (next: boolean) => {
    if (disabled || next === proxyPlayback) return;
    onBeforeChange?.(next);
    setProxyPlayback(next);
  };
  return (
    <div
      className="flex shrink-0 items-center gap-1 rounded-lg bg-surface-subtle p-1"
      role="group"
      aria-label="预览源切换"
      title={disabled ? disabledHint : undefined}
    >
      <button
        type="button"
        className={`rounded-md px-2 py-1 text-[11px] ${proxyPlayback ? 'bg-surface text-ink shadow-sm' : 'text-ink-secondary'} ${disabled ? 'opacity-50' : ''}`}
        aria-pressed={proxyPlayback}
        disabled={disabled}
        onClick={() => switchTo(true)}
      >代理</button>
      <button
        type="button"
        className={`rounded-md px-2 py-1 text-[11px] ${!proxyPlayback ? 'bg-surface text-ink shadow-sm' : 'text-ink-secondary'} ${disabled ? 'opacity-50' : ''}`}
        aria-pressed={!proxyPlayback}
        disabled={disabled}
        onClick={() => switchTo(false)}
      >原片</button>
    </div>
  );
}

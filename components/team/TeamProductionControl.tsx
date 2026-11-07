'use client';

import { useCallback, useEffect, useState } from 'react';
import { teamError, teamWrite } from './client';
import { Dialog } from '@/components/ui/Dialog';
import { StatusDot, ToolbarButton } from '@/components/ui/Appearance';

type State = { paused: boolean; version: number; maintenance: boolean };

/**
 * 暂停 / 恢复生产（12 号票）。
 *
 * 写入逻辑完全沿用原有实现（`/api/team/production-control` 的 `paused` + `expectedVersion`），
 * 只在暂停**前面加一层说明与确认**：
 *   - 点「暂停运行」先弹说明（暂停后不再开始新的生成，已经在跑的继续）；
 *   - 点「取消」什么都不改（不发请求）；
 *   - 点「确认暂停」才真的暂停；
 *   - 暂停后同一个按钮变「恢复运行」，点一下直接恢复（恢复不需要再确认）。
 *
 * 服务器维护中（`maintenance`）时暂停/恢复都不可用，这与原逻辑一致：
 * 维护状态不能被界面恢复动作清掉。
 */
export default function TeamProductionControl({ onStateChange }: { onStateChange?: (paused: boolean) => void }) {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);

  const refresh = useCallback(async () => {
    const response = await fetch('/api/team/production-control', { cache: 'no-store' });
    if (!response.ok) throw new Error(await teamError(response, '无法读取运行状态'));
    const next = await response.json() as State;
    setState(next);
    onStateChange?.(next.paused);
  }, [onStateChange]);

  useEffect(() => {
    const check = () => { void refresh().catch(cause => setError(cause instanceof Error ? cause.message : '状态读取失败')); };
    check();
    const timer = setInterval(check, 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function apply(paused: boolean) {
    if (!state) return;
    setBusy(true);
    setError('');
    try {
      const response = await teamWrite('/api/team/production-control', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused, expectedVersion: state.version }),
      });
      if (!response.ok) throw new Error(await teamError(response, '运行状态保存失败'));
      const next = await response.json() as State;
      setState(next);
      onStateChange?.(next.paused);
      setConfirming(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '运行状态保存失败');
      setConfirming(false);
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  const paused = state?.paused ?? false;
  const disabled = !state || busy || state.maintenance;

  return (
    <>
      <span
        className={`mr-1 inline-flex items-center gap-1.5 text-[12px] ${paused ? 'text-warn' : 'text-ink-secondary'}`}
        role="status"
        data-testid="production-status"
      >
        <StatusDot tone={paused ? 'warn' : 'ok'} />
        {state ? (paused ? '已暂停，新生成任务等待中' : '运行中，正常接收生成任务') : '正在读取运行状态…'}
      </span>
      <ToolbarButton
        onClick={() => { if (paused) void apply(false); else setConfirming(true); }}
        disabled={disabled}
        icon={paused ? 'play' : 'pause'}
      >
        {busy ? '正在保存…' : paused ? '恢复运行' : '暂停运行'}
      </ToolbarButton>
      {state?.maintenance ? <span className="text-[12px] text-warn">服务器正在维护，完成维护后才能恢复生成。</span> : null}
      {error ? <span role="alert" className="text-[12px] text-fail">{error}</span> : null}
      <Dialog
        open={confirming}
        title="暂停生产？"
        description="暂停只影响新的生成，不会打断已经在跑的任务。"
        onClose={() => setConfirming(false)}
        footer={
          <>
            <button type="button" className="btn-secondary btn-sm" onClick={() => setConfirming(false)} disabled={busy}>
              取消
            </button>
            <button
              type="button"
              className="btn-primary btn-sm"
              onClick={() => void apply(true)}
              disabled={busy}
              data-testid="confirm-pause"
            >
              {busy ? '正在暂停…' : '确认暂停'}
            </button>
          </>
        }
      >
        <ul className="list-disc space-y-2 pl-5 text-[13px] leading-6 text-ink-secondary">
          <li>暂停后<b className="text-ink">不再开始新的生成</b>，成员新提交的任务会排队等待。</li>
          <li><b className="text-ink">已经在跑的继续</b>：已提交的任务照常收取结果，不会中断，也不会重复扣费。</li>
          <li>成员仍可登录、编辑项目和下载成果；点「取消」不会暂停。</li>
        </ul>
      </Dialog>
    </>
  );
}

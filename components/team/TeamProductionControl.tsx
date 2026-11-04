'use client';

import { useCallback, useEffect, useState } from 'react';
import { teamError, teamWrite } from './client';

type State = { paused: boolean; version: number; maintenance: boolean };
export default function TeamProductionControl() {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    const response = await fetch('/api/team/production-control', { cache: 'no-store' });
    if (!response.ok) throw new Error(await teamError(response, '无法读取运行状态'));
    setState(await response.json());
  }, []);
  useEffect(() => {
    const check = () => { void refresh().catch(e => setError(e instanceof Error ? e.message : '状态读取失败')); };
    check();
    const timer = setInterval(check, 15000);
    return () => clearInterval(timer);
  }, [refresh]);
  async function toggle() {
    if (!state) return;
    setBusy(true); setError('');
    try {
      const response = await teamWrite('/api/team/production-control', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: !state.paused, expectedVersion: state.version }),
      });
      if (!response.ok) throw new Error(await teamError(response, '运行状态保存失败'));
      setState(await response.json());
    } catch (e) { setError(e instanceof Error ? e.message : '运行状态保存失败'); await refresh().catch(() => undefined); }
    finally { setBusy(false); }
  }
  return <section className="card p-6" aria-label="团队运行控制">
    <div className="flex flex-wrap items-center justify-between gap-5">
      <div><h2 className="text-lg font-semibold text-ink">团队运行</h2>
        <p role="status" className={`mt-2 font-medium ${state?.paused ? 'text-warn' : 'text-ok'}`}>
          {state ? state.paused ? '已暂停 · 新生成任务等待中' : '运行中 · 正常接收生成任务' : '正在读取状态…'}
        </p>
        <p className="mt-2 text-sm leading-6 text-ink-secondary">暂停后不再开始新的付费生成；已提交任务继续收取结果。成员仍可登录、编辑和下载。</p>
      </div>
      <button className={state?.paused ? 'btn-primary' : 'btn-secondary'} disabled={!state || busy || state.maintenance} onClick={() => void toggle()}>
        {busy ? '正在保存…' : state?.paused ? '恢复运行' : '暂停运行'}
      </button>
    </div>
    {state?.maintenance && <p className="mt-3 text-sm text-warn">服务器正在维护，完成维护后才能恢复生成。</p>}
    {error && <p role="alert" className="mt-3 text-sm text-fail">{error}</p>}
  </section>;
}

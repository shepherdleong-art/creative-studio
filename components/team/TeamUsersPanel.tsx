'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { teamError, teamWrite } from './client';

type Member = {
  userId: string;
  employeeId: string;
  displayName: string;
  role: 'employee' | 'admin';
  accountStatus: 'active' | 'disabled';
  mustChangePassword: boolean;
  todayChargedMinor: number;
  monthChargedMinor: number;
  monthSettledMinor: number;
  heldMinor: number;
  monthlyLimitMinor: number | null;
  remainingMinor: number | null;
  currentConcurrency: number;
  concurrencyLimit: number;
  paused: boolean;
  policyVersion: number;
  waitingReason: string | null;
  attention: boolean;
  modules: Array<{ module: string; chargedMinor: number }>;
};

const WAITING_LABELS: Record<string, string> = {
  monthly_budget: '余额不足',
  personal_concurrency: '并发等待',
  actor_paused: '暂停生成',
  actor_disabled: '账号停用',
  pricing_required: '定价缺失',
  cost_unknown: '费用待核查',
  pool_capacity: '共享并发等待',
  pool_missing: '资源池未配置',
  maintenance: '维护等待',
};

function money(minor: number | null): string {
  return minor === null ? '不限额' : `¥${(minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function TeamUsersPanel() {
  const [users, setUsers] = useState<Member[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<'employee' | 'admin'>('employee');
  const [issued, setIssued] = useState<{ employeeId: string; credential: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [limitYuan, setLimitYuan] = useState('0');
  const [unlimited, setUnlimited] = useState(false);
  const [concurrency, setConcurrency] = useState(0);
  const [paused, setPaused] = useState(false);

  const refresh = useCallback(async () => {
    const params = new URLSearchParams();
    if (search.trim()) params.set('search', search.trim());
    if (attentionOnly) params.set('attentionOnly', '1');
    const response = await fetch(`/api/team/members?${params}`, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error(await teamError(response, '无法读取成员列表'));
    const body = await response.json() as { items: Member[] };
    setUsers(body.items);
  }, [attentionOnly, search]);

  useEffect(() => {
    void Promise.resolve().then(refresh).catch((cause) => setError(cause instanceof Error ? cause.message : '无法读取成员列表'));
  }, [refresh]);

  async function run(action: () => Promise<Response>, success?: () => void) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await action();
      if (!response.ok) throw new Error(await teamError(response, '账号操作失败'));
      const body = await response.json() as { credential?: string; user?: { employeeId: string } };
      if (body.credential && body.user) {
        setIssued({ employeeId: body.user.employeeId, credential: body.credential });
        setNotice('新账号默认月度额度 0、个人并发 0，尚未开放生成；请在下方“费用与并发”里显式授权。停生成不影响登录、编辑、收取和下载。');
      }
      success?.();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '账号操作失败');
    } finally {
      setBusy(false);
    }
  }

  function createUser(event: FormEvent) {
    event.preventDefault();
    void run(() => teamWrite('/api/team/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId, displayName, role }),
    }), () => {
      setEmployeeId('');
      setDisplayName('');
    });
  }

  function openPolicy(member: Member) {
    setEditing(member);
    setLimitYuan(member.monthlyLimitMinor === null ? '0' : String(member.monthlyLimitMinor / 100));
    setUnlimited(member.monthlyLimitMinor === null);
    setConcurrency(member.concurrencyLimit);
    setPaused(member.paused);
    setError('');
  }

  function savePolicy(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    const amount = Number(limitYuan);
    if (!unlimited && (!Number.isFinite(amount) || amount < 0)) {
      setError('月度金额必须是非负数字。');
      return;
    }
    void run(() => teamWrite(`/api/team/members/${editing.userId}/policy`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        monthlyLimitMinor: unlimited ? null : Math.round(amount * 100),
        unlimited,
        personalConcurrency: concurrency,
        paused,
        expectedVersion: editing.policyVersion,
      }),
    }), () => {
      setNotice('成员策略已保存；新的付费调用会在下一次准入时使用最新版本。');
      setEditing(null);
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-ink">账号与权限</h1>
        <p className="mt-2 text-sm text-ink-secondary">管理工号、角色、账号启停，以及跨模块月度费用和个人云端并发。</p>
      </div>

      {issued && <section className="card border-ok p-5" role="status">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-semibold text-ink">{issued.employeeId} 的一次性凭据</h2>
            <p className="mt-1 text-sm text-ink-secondary">仅本次显示，请立即交给本人；首次登录后必须改密。</p>
            <code className="mt-3 block select-all break-all rounded bg-surface-subtle p-3 font-mono text-sm text-ink">{issued.credential}</code>
          </div>
          <button className="btn-secondary btn-sm" onClick={() => setIssued(null)}>我已保存</button>
        </div>
      </section>}

      <section className="card p-6">
        <h2 className="mb-5 text-lg font-semibold text-ink">新建账号</h2>
        <form onSubmit={createUser} className="grid gap-4 md:grid-cols-[1fr_1fr_160px_auto] md:items-end">
          <label><span className="label">工号</span><input className="input-field" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} placeholder="例如 00123" required /></label>
          <label><span className="label">姓名</span><input className="input-field" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></label>
          <label><span className="label">角色</span><select className="input-field" value={role} onChange={(event) => setRole(event.target.value as 'employee' | 'admin')}><option value="employee">员工</option><option value="admin">管理员</option></select></label>
          <button className="btn-primary" disabled={busy} type="submit">创建并生成凭据</button>
        </form>
      </section>

      <section className="card space-y-4 p-5" aria-label="成员用量筛选">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-ink-secondary">搜索姓名或工号
              <input className="input-field mt-1 w-56" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="姓名 / 工号" />
            </label>
            <label className="flex items-center gap-2 pb-2 text-sm text-ink-secondary">
              <input type="checkbox" checked={attentionOnly} onChange={(event) => setAttentionOnly(event.target.checked)} />需要关注
            </label>
          </div>
          <a className="btn-secondary btn-sm" href="/api/team/usage/export?period=month">导出本月 CSV</a>
        </div>
        <p className="text-xs leading-5 text-ink-tertiary">已计与预留采用服务端 06 同一账期口径。提额后下一次准入自动重验；降额、降并发或暂停不取消已受理任务，也不影响登录、编辑、查看、结果收取和下载。</p>
      </section>

      {error && <p role="alert" className="text-sm text-fail">{error}</p>}
      {notice && <p role="status" className="text-sm text-ok">{notice}</p>}
      <section className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-left text-sm">
            <thead className="bg-surface-subtle text-xs text-ink-tertiary"><tr><th className="px-4 py-3">成员</th><th className="px-4 py-3">今日已计</th><th className="px-4 py-3">本月已计 / 额度</th><th className="px-4 py-3">held 预留</th><th className="px-4 py-3">剩余</th><th className="px-4 py-3">当前并发 / 上限</th><th className="px-4 py-3">状态</th><th className="px-4 py-3">角色</th><th className="px-4 py-3 text-right">操作</th></tr></thead>
            <tbody className="divide-y divide-hairline">
              {users.map((user) => <tr key={user.userId} className="align-top">
                <td className="px-4 py-4"><div className="font-medium text-ink">{user.displayName}{user.attention && <span className="ml-2 text-xs text-warn">关注</span>}</div><div className="font-mono text-xs text-ink-tertiary">{user.employeeId}</div><details className="mt-2 text-xs text-ink-secondary"><summary className="cursor-pointer">模块明细</summary><div className="mt-1 space-y-1">{user.modules.length ? user.modules.map((module) => <div key={module.module}>{module.module}：{money(module.chargedMinor)}</div>) : <span>本月暂无费用</span>}</div></details></td>
                <td className="px-4 py-4 text-ink-secondary">{money(user.todayChargedMinor)}</td>
                <td className="px-4 py-4 text-ink-secondary"><div>{money(user.monthChargedMinor)} / {money(user.monthlyLimitMinor)}</div><div className="mt-1 text-xs text-ink-tertiary">已结算 {money(user.monthSettledMinor)}</div></td>
                <td className="px-4 py-4 text-ink-secondary">{money(user.heldMinor)}</td>
                <td className="px-4 py-4 text-ink-secondary">{money(user.remainingMinor)}</td>
                <td className="px-4 py-4 text-ink-secondary">{user.currentConcurrency} / {user.concurrencyLimit}</td>
                <td className="px-4 py-4 text-ink-secondary"><div>{user.accountStatus === 'disabled' ? '账号停用' : user.paused ? '暂停新付费' : '启用'}</div>{user.waitingReason && <div className="mt-1 text-xs text-warn">{WAITING_LABELS[user.waitingReason] ?? user.waitingReason}</div>}<div className="mt-1 text-xs text-ink-tertiary">{user.mustChangePassword ? '待首次改密' : '已改密'}</div></td>
                <td className="px-4 py-4"><select aria-label={`${user.displayName}角色`} className="input-field" value={user.role} disabled={busy} onChange={(event) => void run(() => teamWrite(`/api/team/users/${user.userId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: event.target.value }) }))}><option value="employee">员工</option><option value="admin">管理员</option></select></td>
                <td className="px-4 py-4"><div className="flex justify-end gap-2"><button className="btn-secondary btn-sm" disabled={busy} onClick={() => openPolicy(user)}>费用与并发</button><button className="btn-secondary btn-sm" disabled={busy} onClick={() => { if (window.confirm(`确定重置 ${user.displayName} 的凭据并撤销其会话吗？`)) void run(() => teamWrite(`/api/team/users/${user.userId}/reset-credential`, { method: 'POST' })); }}>重置凭据</button><button className="btn-secondary btn-sm" disabled={busy} onClick={() => void run(() => teamWrite(`/api/team/users/${user.userId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: user.accountStatus === 'active' ? 'disabled' : 'active' }) }))}>{user.accountStatus === 'active' ? '停用' : '启用'}</button></div></td>
              </tr>)}
            </tbody>
          </table>
        </div>
        {users.length === 0 && <p className="px-5 py-10 text-center text-sm text-ink-tertiary">没有符合筛选的成员。</p>}
      </section>

      {editing && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label={`${editing.displayName}费用与并发策略`}>
        <form onSubmit={savePolicy} className="card w-full max-w-md space-y-4 p-6 shadow-xl">
          <div><h2 className="text-lg font-semibold text-ink">{editing.displayName}：费用与并发</h2><p className="mt-1 text-xs text-ink-tertiary">策略版本 {editing.policyVersion}；保存与准入在服务端串行化。</p></div>
          <label className="flex items-center gap-2 text-sm text-ink-secondary"><input type="checkbox" checked={unlimited} onChange={(event) => setUnlimited(event.target.checked)} />不限月度金额（仍受并发限制）</label>
          <label className="block text-sm text-ink-secondary">月度金额（元）<input className="input-field mt-1" type="number" min="0" step="0.01" value={limitYuan} disabled={unlimited} onChange={(event) => setLimitYuan(event.target.value)} required={!unlimited} /></label>
          <label className="block text-sm text-ink-secondary">个人云端并发上限<input className="input-field mt-1" type="number" min="0" step="1" value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} required /></label>
          <label className="flex items-center gap-2 text-sm text-ink-secondary"><input type="checkbox" checked={paused} onChange={(event) => setPaused(event.target.checked)} />暂停新的付费生成</label>
          <p className="text-xs leading-5 text-ink-tertiary">暂停或降低上限只影响后续付费步骤；已受理任务不会被中断。</p>
          <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setEditing(null)}>取消</button><button type="submit" className="btn-primary" disabled={busy}>保存策略</button></div>
        </form>
      </div>}
    </div>
  );
}

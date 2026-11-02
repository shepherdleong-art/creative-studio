'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { teamError, teamWrite } from './client';

type User = {
  id: string;
  employeeId: string;
  displayName: string;
  role: 'employee' | 'admin';
  status: 'active' | 'disabled';
  mustChangePassword: boolean;
};

export default function TeamUsersPanel() {
  const [users, setUsers] = useState<User[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<'employee' | 'admin'>('employee');
  const [issued, setIssued] = useState<{ employeeId: string; credential: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const response = await fetch('/api/team/users', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error(await teamError(response, '无法读取账号列表'));
    const body = await response.json() as { users: User[] };
    setUsers(body.users);
  }, []);

  useEffect(() => {
    void Promise.resolve().then(refresh).catch((cause) => setError(cause instanceof Error ? cause.message : '无法读取账号列表'));
  }, [refresh]);

  async function run(action: () => Promise<Response>, success?: () => void) {
    setBusy(true);
    setError('');
    try {
      const response = await action();
      if (!response.ok) throw new Error(await teamError(response, '账号操作失败'));
      const body = await response.json() as { credential?: string; user?: User };
      if (body.credential && body.user) setIssued({ employeeId: body.user.employeeId, credential: body.credential });
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-ink">账号与权限</h1>
        <p className="mt-2 text-sm text-ink-secondary">管理工号、角色和账号启停。费用额度与付费生成策略不在此处修改。</p>
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

      {error && <p role="alert" className="text-sm text-fail">{error}</p>}
      <section className="card overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-surface-subtle text-xs text-ink-tertiary"><tr><th className="px-5 py-3">成员</th><th className="px-5 py-3">角色</th><th className="px-5 py-3">状态</th><th className="px-5 py-3">凭据</th><th className="px-5 py-3 text-right">操作</th></tr></thead>
          <tbody className="divide-y divide-hairline">
            {users.map((user) => <tr key={user.id}>
              <td className="px-5 py-4"><div className="font-medium text-ink">{user.displayName}</div><div className="font-mono text-xs text-ink-tertiary">{user.employeeId}</div></td>
              <td className="px-5 py-4"><select aria-label={`${user.displayName}角色`} className="input-field" value={user.role} disabled={busy} onChange={(event) => void run(() => teamWrite(`/api/team/users/${user.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: event.target.value }) }))}><option value="employee">员工</option><option value="admin">管理员</option></select></td>
              <td className="px-5 py-4 text-ink-secondary">{user.status === 'active' ? '启用' : '已停用'}</td>
              <td className="px-5 py-4 text-ink-secondary">{user.mustChangePassword ? '待首次改密' : '已改密'}</td>
              <td className="px-5 py-4"><div className="flex justify-end gap-2">
                <button className="btn-secondary btn-sm" disabled={busy} onClick={() => { if (window.confirm(`确定重置 ${user.displayName} 的凭据并撤销其会话吗？`)) void run(() => teamWrite(`/api/team/users/${user.id}/reset-credential`, { method: 'POST' })); }}>重置凭据</button>
                <button className="btn-secondary btn-sm" disabled={busy} onClick={() => void run(() => teamWrite(`/api/team/users/${user.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: user.status === 'active' ? 'disabled' : 'active' }) }))}>{user.status === 'active' ? '停用' : '启用'}</button>
              </div></td>
            </tr>)}
          </tbody>
        </table>
      </section>
    </div>
  );
}

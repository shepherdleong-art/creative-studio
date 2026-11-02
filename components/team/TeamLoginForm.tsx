'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { teamError, teamWrite } from './client';

export default function TeamLoginForm() {
  const [mode, setMode] = useState<'login' | 'change'>('login');
  const [employeeId, setEmployeeId] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void fetch('/api/team/auth/session', { credentials: 'same-origin', cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((session: { authenticated?: boolean; mustChangePassword?: boolean } | null) => {
        if (session?.authenticated && session.mustChangePassword) setMode('change');
        else if (session?.authenticated) window.location.assign('/');
      })
      .catch(() => undefined);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (mode === 'change' && newPassword !== confirmation) {
      setError('两次输入的新密码不一致');
      return;
    }
    setBusy(true);
    try {
      const changing = mode === 'change';
      const response = await teamWrite(changing ? '/api/team/auth/change-password' : '/api/team/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changing
          ? { currentPassword, newPassword }
          : { employeeId, password: currentPassword }),
      });
      if (!response.ok) throw new Error(await teamError(response, changing ? '改密失败' : '登录失败'));
      const result = await response.json() as { mustChangePassword: boolean };
      if (!changing && result.mustChangePassword) {
        setMode('change');
        setNewPassword('');
        setConfirmation('');
      } else {
        window.location.assign('/');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card w-full p-8">
      <p className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-ink-tertiary">Creative Studio Team</p>
      <h1 className="text-2xl font-semibold tracking-tight text-ink">{mode === 'login' ? '工号登录' : '设置新密码'}</h1>
      <p className="mt-2 text-sm leading-6 text-ink-secondary">
        {mode === 'login' ? '使用管理员发放的工号和一次性凭据登录。' : '首次凭据或重置凭据只能使用一次，改密后才能进入工作台。'}
      </p>
      <form className="mt-7 space-y-5" onSubmit={submit}>
        {mode === 'login' && <label className="block">
          <span className="label">工号</span>
          <input className="input-field" autoComplete="username" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} required autoFocus />
        </label>}
        <label className="block">
          <span className="label">{mode === 'login' ? '密码或一次性凭据' : '当前密码或一次性凭据'}</span>
          <input className="input-field" type="password" autoComplete={mode === 'login' ? 'current-password' : 'current-password'} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required />
        </label>
        {mode === 'change' && <>
          <label className="block">
            <span className="label">新密码（至少 12 位）</span>
            <input className="input-field" type="password" autoComplete="new-password" minLength={12} maxLength={128} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required />
          </label>
          <label className="block">
            <span className="label">确认新密码</span>
            <input className="input-field" type="password" autoComplete="new-password" minLength={12} maxLength={128} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required />
          </label>
        </>}
        {error && <p role="alert" className="text-sm text-fail">{error}</p>}
        <button className="btn-primary w-full" disabled={busy} type="submit">
          {busy ? '处理中…' : mode === 'login' ? '登录' : '保存新密码并进入'}
        </button>
      </form>
    </section>
  );
}

'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { teamError, teamWrite } from './client';

export default function TeamLoginForm({ changePassword = false }: { changePassword?: boolean }) {
  const [mode, setMode] = useState<'login' | 'change'>(changePassword ? 'change' : 'login');
  const [employeeId, setEmployeeId] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);
  useEffect(() => {
    const reason = new URLSearchParams(window.location.search).get('reason');
    if (reason === 'password-changed') setError('密码已修改，请使用新密码重新登录。');
    else if (reason === 'session-expired') setError('登录状态已到期或失效，请重新登录。');
    try { setRemember(window.localStorage.getItem('creative-studio-remember-login') === 'true'); }
    catch { /* 无持久偏好时只使用当前会话。 */ }
  }, []);
  const nextPasswordInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (mode === 'change') nextPasswordInput.current?.focus(); }, [mode]);

  useEffect(() => {
    void fetch('/api/team/auth/session', { credentials: 'same-origin', cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((session: { authenticated?: boolean; mustChangePassword?: boolean } | null) => {
        if (session?.authenticated && session.mustChangePassword) setMode('change');
        else if (session?.authenticated && !changePassword) window.location.assign('/');
      })
      .catch(() => undefined);
  }, [changePassword]);

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
          : { employeeId, password: currentPassword, remember }),
      });
      if (!response.ok) throw new Error(await teamError(response, changing ? '改密失败' : '登录失败'));
      const result = await response.json() as { mustChangePassword: boolean };
      if (!changing) {
        try { window.localStorage.setItem('creative-studio-remember-login', String(remember)); }
        catch { /* A blocked preference store must not turn login into a password store. */ }
      }
      if (!changing && result.mustChangePassword) {
        setMode('change');
        setNewPassword('');
        setConfirmation('');
        setShowPassword(false);
      } else {
        window.location.assign(changing ? '/team/login?reason=password-changed' : '/');
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
        {mode === 'login' ? '使用管理员发放的工号和一次性密码登录。' : changePassword ? '输入当前密码，设置至少 6 位的新密码。可以使用 6 位数字。' : '首次或重置密码只能登录一次，设置新密码后即可进入工作台。'}
      </p>
      <form className="mt-7 space-y-5" onSubmit={submit}>
        {mode === 'login' && <label className="block">
          <span className="label">工号</span>
          <input className="input-field" autoComplete="username" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} required autoFocus />
        </label>}
        <label className="block">
          <span className="label">{mode === 'login' ? '密码或 6 位一次性密码' : '当前密码或一次性密码'}</span>
          <input className="input-field" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required />
        </label>
        {mode === 'change' && <>
          <label className="block">
            <span className="label">新密码（至少 6 位，可用数字）</span>
            <input ref={nextPasswordInput} className="input-field" type={showPassword ? 'text' : 'password'} autoComplete="new-password" minLength={6} maxLength={128} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required />
          </label>
          <label className="block">
            <span className="label">确认新密码</span>
            <input className="input-field" type={showPassword ? 'text' : 'password'} autoComplete="new-password" minLength={6} maxLength={128} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required />
          </label>
        </>}
        {mode === 'login' && <label className="flex items-center gap-2 text-sm text-ink-secondary">
          <input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />
          记住登录状态（30 天）
        </label>}
        <label className="flex items-center gap-2 text-sm text-ink-secondary"><input type="checkbox" checked={showPassword} onChange={event => setShowPassword(event.target.checked)} />显示密码</label>
        {error && <p role="alert" className="text-sm text-fail">{error}</p>}
        <button className="btn-primary w-full" disabled={busy} type="submit">
          {busy ? '处理中…' : mode === 'login' ? '登录' : '保存新密码并进入'}
        </button>
      </form>
    </section>
  );
}

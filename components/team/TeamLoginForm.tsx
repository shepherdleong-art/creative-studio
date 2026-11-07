'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { teamError, teamWrite } from './client';
import { BRAND_CLAIM, BRAND_NAME } from '@/lib/brand';
import {
  MAX_PASSWORD_LENGTH,
  validateLoginFields,
  type LoginFieldErrors,
  type LoginFieldName,
} from './login-validation';
import styles from './login.module.css';

// 记住登录的浏览器存储键：改名不换键，老用户升级后登录偏好还在。
const REMEMBER_KEY = 'creative-studio-remember-login';

export default function TeamLoginForm({ changePassword = false }: { changePassword?: boolean }) {
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<'login' | 'change'>(changePassword ? 'change' : 'login');
  const [employeeId, setEmployeeId] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const reason = searchParams.get('reason');
  const [notice, setNotice] = useState(reason === 'password-changed' ? '密码已修改，请使用新密码重新登录。'
    : reason === 'session-expired' ? '登录状态已到期或失效，请重新登录。' : '');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<LoginFieldErrors>({});
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);
  const nextPasswordInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let saved = false;
    try { saved = window.localStorage.getItem(REMEMBER_KEY) === 'true'; }
    catch { /* 无可用偏好存储时只保持当前会话。 */ }
    queueMicrotask(() => setRemember(saved));
  }, []);
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
    setNotice('');
    const localErrors = validateLoginFields({ mode, employeeId, currentPassword, newPassword, confirmation });
    setFieldErrors(localErrors);
    if (Object.keys(localErrors).length > 0) return;
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
        try { window.localStorage.setItem(REMEMBER_KEY, String(remember)); }
        catch { /* A blocked preference store must not turn login into a password store. */ }
      }
      if (!changing && result.mustChangePassword) {
        setMode('change');
        setNewPassword('');
        setConfirmation('');
        setCurrentPassword('');
        setEmployeeId('');
        setShowPassword(false);
      } else {
        window.location.assign(changing ? '/team/login?reason=password-changed' : '/');
      }
    } catch (cause) {
      // 服务端拒绝的理由也贴在表单里，不弹浏览器对话框。
      setError(cause instanceof Error ? cause.message : '操作失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  const fieldError = (name: LoginFieldName) => {
    const message = fieldErrors[name];
    return message
      ? <p className={styles.fieldError} role="alert" id={`login-${name}-error`}>{message}</p>
      : null;
  };
  const describedBy = (name: LoginFieldName) => fieldErrors[name] ? `login-${name}-error` : undefined;
  const invalid = (name: LoginFieldName) => Boolean(fieldErrors[name]) || undefined;

  return (
    <section className={styles.card}>
      <header className={styles.header}>
        {/* 标志与 app/icon.svg 同源：绿色渐变圆角方块 + 白色叶子形眼睛。 */}
        <svg className={styles.mark} viewBox="0 0 100 100" width="56" height="56" role="presentation" focusable="false">
          <defs>
            <linearGradient id="login-mark-gradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#46A97B" />
              <stop offset="1" stopColor="#1D6A4B" />
            </linearGradient>
          </defs>
          <rect x="2" y="2" width="96" height="96" rx="22" fill="url(#login-mark-gradient)" />
          <rect x="2.5" y="2.5" width="95" height="95" rx="21.5" fill="none" stroke="#FFFFFF" strokeOpacity="0.22" />
          <g transform="rotate(-45 50 50)">
            <path fill="#FFFFFF" fillRule="evenodd" d="M12 50C28 20 72 20 88 50 72 80 28 80 12 50zM50 39a11 11 0 100 22 11 11 0 000-22z" />
          </g>
        </svg>
        <h1 className={styles.name}>{mode === 'login' ? BRAND_NAME : '设置新密码'}</h1>
        <p className={styles.sub}>
          {mode === 'login'
            ? BRAND_CLAIM
            : changePassword
              ? '输入当前密码，设置至少 6 位的新密码。可以使用 6 位数字。'
              : '首次或重置密码只能登录一次，设置新密码后即可进入工作台。'}
        </p>
      </header>

      <form className={styles.form} onSubmit={submit} noValidate>
        {mode === 'login' && <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="login-employee-id">工号</label>
          <input
            id="login-employee-id"
            name="employeeId"
            className="input-field"
            aria-invalid={invalid('employeeId')}
            aria-describedby={describedBy('employeeId')}
            autoComplete="username"
            placeholder="管理员发放的工号"
            value={employeeId}
            onChange={(event) => setEmployeeId(event.target.value)}
            autoFocus
          />
          {fieldError('employeeId')}
        </div>}

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="login-current-password">
            {mode === 'login' ? '密码或 6 位一次性密码' : '当前密码或一次性密码'}
          </label>
          <input
            id="login-current-password"
            name="password"
            className="input-field"
            type={showPassword ? 'text' : 'password'}
            aria-invalid={invalid('currentPassword')}
            aria-describedby={describedBy('currentPassword')}
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
          {fieldError('currentPassword')}
        </div>

        {mode === 'change' && <>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="login-new-password">新密码（至少 6 位，可用数字）</label>
            <input
              id="login-new-password"
              name="newPassword"
              ref={nextPasswordInput}
              className="input-field"
              type={showPassword ? 'text' : 'password'}
              aria-invalid={invalid('newPassword')}
              aria-describedby={describedBy('newPassword')}
              autoComplete="new-password"
              maxLength={MAX_PASSWORD_LENGTH}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
            {fieldError('newPassword')}
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="login-confirmation">确认新密码</label>
            <input
              id="login-confirmation"
              name="confirmation"
              className="input-field"
              type={showPassword ? 'text' : 'password'}
              aria-invalid={invalid('confirmation')}
              aria-describedby={describedBy('confirmation')}
              autoComplete="new-password"
              maxLength={MAX_PASSWORD_LENGTH}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
            {fieldError('confirmation')}
          </div>
        </>}

        <div className={styles.checks}>
          {mode === 'login' && <label className={styles.check}>
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
            记住登录状态（30 天）
          </label>}
          <label className={styles.check}>
            <input type="checkbox" checked={showPassword} onChange={(event) => setShowPassword(event.target.checked)} />
            显示密码
          </label>
        </div>

        {error && <p role="alert" className={styles.error}>{error}</p>}
        {notice && <p role="status" className={styles.notice}>{notice}</p>}

        <button className={`btn-primary ${styles.submit}`} disabled={busy} type="submit">
          {busy ? '处理中…' : mode === 'login' ? '登录' : '保存新密码并进入'}
        </button>
      </form>
    </section>
  );
}

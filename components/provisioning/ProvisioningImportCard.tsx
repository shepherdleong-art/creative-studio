'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

interface ProvisioningStatus {
  configured: boolean;
  profileName: string | null;
  importedAt: string | null;
  configHashPrefix: string | null;
}

const EMPTY_STATUS: ProvisioningStatus = {
  configured: false,
  profileName: null,
  importedAt: null,
  configHashPrefix: null,
};

export default function ProvisioningImportCard({ onImported }: { onImported?: () => Promise<void> }) {
  const [status, setStatus] = useState<ProvisioningStatus>(EMPTY_STATUS);
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const loadStatus = async () => {
    try {
      const response = await fetch('/api/provisioning', { cache: 'no-store' });
      const value = await response.json();
      if (response.ok && value && typeof value === 'object') setStatus(value as ProvisioningStatus);
    } catch {
      // The settings page remains usable if status inspection is unavailable.
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => void loadStatus(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage('');
    setError('');
    if (!file) {
      setError('请选择统一配置文件');
      return;
    }
    if (password.length < 12) {
      setError('密码至少需要 12 个字符');
      return;
    }
    setBusy(true);
    try {
      const body = new FormData();
      body.set('file', file);
      body.set('password', password);
      const response = await fetch('/api/provisioning', { method: 'POST', body });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : '统一配置导入失败');
      setStatus(value as ProvisioningStatus);
      setMessage('导入成功。请关闭并重新打开工作台，使公司网关加载新配置。');
      setPassword('');
      setFile(null);
      await onImported?.();
      const input = document.getElementById('provisioning-file') as HTMLInputElement | null;
      if (input) input.value = '';
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '统一配置导入失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="provisioning" className="card border-accent/20 bg-accent/[0.035] p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-ink">统一配置导入</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-secondary">
            管理员提供加密配置文件后，在这里输入一次密码导入。密钥不会回显；再次导入可覆盖同一公司的配置并轮换凭据。
          </p>
        </div>
        <span className={`status-badge ${status.configured ? 'status-succeeded' : 'status-pending'}`}>
          {status.configured ? '已导入' : '尚未导入'}
        </span>
      </div>

      {status.configured && (
        <div className="mt-4 grid gap-2 text-xs text-ink-secondary sm:grid-cols-3">
          <div><span className="text-ink-tertiary">配置档案：</span>{status.profileName}</div>
          <div><span className="text-ink-tertiary">导入时间：</span>{status.importedAt}</div>
          <div><span className="text-ink-tertiary">配置哈希：</span><code>{status.configHashPrefix}</code></div>
        </div>
      )}

      <form className="mt-5 grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={submit}>
        <label className="block">
          <span className="label">加密配置文件</span>
          <input
            id="provisioning-file"
            type="file"
            accept=".provision,.json,application/json"
            className="input-field file:mr-3 file:rounded-lg file:border-0 file:bg-surface-subtle file:px-2 file:py-1 file:text-xs"
            onChange={(event) => setFile(event.target.files?.[0] || null)}
          />
        </label>
        <label className="block">
          <span className="label">解密密码</span>
          <input
            type="password"
            className="input-field font-mono"
            minLength={12}
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="至少 12 个字符"
          />
        </label>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? '导入中…' : status.configured ? '再次导入 / 轮换' : '导入配置'}
        </button>
      </form>
      {message && <p className="mt-3 text-sm text-success">{message}</p>}
      {error && <p className="mt-3 text-sm text-fail">{error}</p>}
    </section>
  );
}

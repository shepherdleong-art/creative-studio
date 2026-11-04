'use client';
import { useEffect, useRef, useState } from 'react';

export default function TeamCredentialDialog({ employeeId, credential, onClose }: {
  employeeId: string; credential: string; onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [message, setMessage] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function copy() {
    try { await navigator.clipboard.writeText(`工号：${employeeId}\n一次性密码：${credential}`); setMessage('已复制工号和一次性密码'); }
    catch { setMessage('无法自动复制，请选中下方密码手动复制'); }
  }
  return <dialog ref={dialog} onClose={onClose} aria-labelledby="issued-password-title" className="card fixed inset-0 m-auto w-[calc(100%_-_2rem)] max-w-md p-7 text-ink shadow-xl backdrop:bg-ink/30">
    <h2 id="issued-password-title" className="text-xl font-semibold">一次性密码已生成</h2>
    <p className="mt-3 text-sm leading-6 text-ink-secondary">请将工号和密码交给成员。密码仅在此显示一次，24 小时内有效；首次登录后会立即进入修改密码页面。</p>
    <div className="mt-6 rounded-xl bg-surface-subtle p-5">
      <p className="text-sm text-ink-secondary">工号 <strong className="ml-2 select-all text-ink">{employeeId}</strong></p>
      <p className="mt-3 text-xs text-ink-tertiary">6 位一次性密码</p>
      <output aria-label="一次性密码" className="mt-2 block select-all font-mono text-4xl tracking-[0.25em]">{credential}</output>
    </div>
    <p className="mt-4 text-xs leading-5 text-ink-tertiary">关闭后无法找回。如未保存，请在成员列表重新生成一次性密码。</p>
    {message && <p role="status" className="mt-3 text-sm text-ink-secondary">{message}</p>}
    <div className="mt-6 flex flex-wrap justify-end gap-3">
      <button className="btn-secondary" onClick={() => void copy()}>复制工号和密码</button>
      <button className="btn-primary" onClick={() => dialog.current?.close()}>我已保存，关闭</button>
    </div>
  </dialog>;
}

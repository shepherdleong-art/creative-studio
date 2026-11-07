'use client';
import { useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { StatusDot, ToolbarButton } from '@/components/ui/Appearance';

/**
 * 一次性密码结果（团队版）。14 号票只换外观：原来用原生 `<dialog>` + Tailwind
 * 卡片，现在换成 02 号票的共用 Dialog 外壳；文案、复制与关闭行为不变。
 *
 * 只保留一个模态层：原生 `<dialog>` 的 `showModal()` 会进 top layer 并拦掉
 * 共用 Dialog 上的点击，所以这里不再叠第二层。
 */
export default function TeamCredentialDialog({ employeeId, credential, onClose }: {
  employeeId: string; credential: string; onClose(): void;
}) {
  const [message, setMessage] = useState('');
  const [open, setOpen] = useState(true);
  async function copy() {
    try { await navigator.clipboard.writeText(`工号：${employeeId}\n一次性密码：${credential}`); setMessage('已复制工号和一次性密码'); }
    catch { setMessage('无法自动复制，请选中下方密码手动复制'); }
  }
  function close() {
    setOpen(false);
    onClose();
  }
  return <Dialog
    open={open}
    title="一次性密码已生成"
    description="请将工号和密码交给成员。密码仅在此显示一次，24 小时内有效；首次登录后会立即进入修改密码页面。"
    onClose={close}
    footer={
      <>
        <span className="mr-auto flex items-center gap-1.5 text-[12px] text-ink-secondary"><StatusDot tone="warn" />关闭后无法找回</span>
        <ToolbarButton onClick={() => void copy()}>复制工号和密码</ToolbarButton>
        <ToolbarButton variant="primary" onClick={close}>我已保存，关闭</ToolbarButton>
      </>
    }
  >
    <div className="tile p-4">
      <p className="text-[13px] text-ink-secondary">工号 <strong className="ml-2 select-all text-ink">{employeeId}</strong></p>
      <p className="mt-2 text-[12px] text-ink-tertiary">6 位一次性密码</p>
      <output aria-label="一次性密码" className="mt-1 block select-all font-mono text-[28px] tracking-[0.25em] text-ink">{credential}</output>
    </div>
    <p className="mt-3 text-[12px] leading-5 text-ink-tertiary">
      关闭后无法找回。如未保存，请在成员列表重新生成一次性密码。
    </p>
    {message && <p role="status" className="mt-2 text-[13px] text-ink-secondary">{message}</p>}
  </Dialog>;
}

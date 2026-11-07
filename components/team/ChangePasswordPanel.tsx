'use client';

import { useState, type FormEvent } from 'react';
import { teamError, teamWrite } from '@/components/team/client';
import { Dialog } from '@/components/ui/Dialog';
import {
  GroupList,
  GroupRow,
  PageToolbar,
  Segmented,
  StatusDot,
  Tag,
  ToolbarButton,
} from '@/components/ui/Appearance';

type Visibility = 'hidden' | 'visible';

/**
 * 修改密码（团队版头像菜单里的入口）。
 *
 * 规则与首次登录改密完全一致：当前密码校验、新密码至少 6 位、两次输入一致，
 * 改完撤销全部会话并回到登录页重新认证（`requiresReauthentication`）。
 * 这里只是把界面换成 02 号票的共用部件（工具栏 / 分组列表 / 分段按钮 / 标签 /
 * 状态点 / 对话框外壳），接口和跳转与改版前一致。
 */
export default function ChangePasswordPanel({ displayName }: { displayName?: string }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('hidden');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);

  const tooShort = newPassword.length > 0 && newPassword.length < 6;
  const mismatch = confirmation.length > 0 && confirmation !== newPassword;
  const passwordReady = newPassword.length >= 6 && confirmation === newPassword;
  const canSubmit = Boolean(currentPassword) && passwordReady && !busy;

  function requestSubmit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (newPassword.length < 6) {
      setError('新密码至少 6 位，可以使用数字');
      return;
    }
    if (newPassword !== confirmation) {
      setError('两次输入的新密码不一致');
      return;
    }
    setConfirming(true);
  }

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const response = await teamWrite('/api/team/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!response.ok) throw new Error(await teamError(response, '改密失败'));
      // 改密撤销全部旧会话（含本机），只能回登录页用新密码重新认证。
      window.location.assign('/team/login?reason=password-changed');
    } catch (cause) {
      setConfirming(false);
      setError(cause instanceof Error ? cause.message : '操作失败，请重试');
    } finally {
      setBusy(false);
    }
  }

  const inputType = visibility === 'visible' ? 'text' : 'password';

  return (
    <>
      <PageToolbar
        title="修改密码"
        subtitle={displayName ? `${displayName} · 改完需要用新密码重新登录` : '改完需要用新密码重新登录'}
        back={{ label: '返回工作台', onClick: () => window.location.assign('/') }}
      />
      <form className="mx-auto flex w-full max-w-md flex-col gap-4" onSubmit={requestSubmit} noValidate>
        <GroupList>
          <GroupRow label="当前密码或一次性密码" hint="管理员刚发的一次性密码也可以直接填这里">
            <input
              className="input-field"
              type={inputType}
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
              autoFocus
            />
          </GroupRow>
          <GroupRow
            label="新密码"
            hint={tooShort ? '至少 6 位，可以使用 6 位数字' : '至少 6 位，可以使用 6 位数字'}
            stacked
          >
            <input
              className="input-field"
              type={inputType}
              autoComplete="new-password"
              minLength={6}
              maxLength={128}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              required
              aria-invalid={tooShort || undefined}
              aria-describedby={tooShort ? 'new-password-error' : undefined}
            />
            {tooShort ? (
              <p id="new-password-error" role="alert" className="mt-1 text-[12px] text-fail">
                还差 {6 - newPassword.length} 位
              </p>
            ) : null}
          </GroupRow>
          <GroupRow label="确认新密码" stacked>
            <input
              className="input-field"
              type={inputType}
              autoComplete="new-password"
              minLength={6}
              maxLength={128}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              required
              aria-invalid={mismatch || undefined}
              aria-describedby={mismatch ? 'confirm-password-error' : undefined}
            />
            {mismatch ? (
              <p id="confirm-password-error" role="alert" className="mt-1 text-[12px] text-fail">
                两次输入的新密码不一致
              </p>
            ) : null}
          </GroupRow>
        </GroupList>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segmented
            label="密码显示方式"
            value={visibility}
            onChange={setVisibility}
            size="small"
            options={[
              { value: 'hidden', label: '隐藏密码' },
              { value: 'visible', label: '显示密码' },
            ]}
          />
          <span className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
            {passwordReady ? <StatusDot tone="ok" label="新密码已符合规则" /> : <StatusDot tone="idle" label="新密码尚未符合规则" />}
            {passwordReady ? '新密码可用' : '新密码至少 6 位'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Tag tone={passwordReady ? 'ok' : 'idle'}>{passwordReady ? '已符合规则' : '待填写'}</Tag>
          <ToolbarButton type="submit" variant="primary" disabled={!canSubmit}>
            {busy ? '处理中…' : '保存新密码'}
          </ToolbarButton>
        </div>

        {error ? (
          <p role="alert" className="text-[13px] text-fail">
            {error}
          </p>
        ) : null}
      </form>

      <Dialog
        open={confirming}
        title="确认修改密码"
        description="改完后本机和其他已登录的设备都会退出，需要用新密码重新登录。"
        onClose={() => { if (!busy) setConfirming(false); }}
        footer={
          <>
            <span className="mr-auto text-[12px] text-ink-secondary">正在生产中的任务不受影响。</span>
            <ToolbarButton onClick={() => setConfirming(false)} disabled={busy}>取消</ToolbarButton>
            <ToolbarButton onClick={() => { void submit(); }} variant="primary" disabled={busy}>
              {busy ? '正在保存…' : '确认修改'}
            </ToolbarButton>
          </>
        }
      />
    </>
  );
}

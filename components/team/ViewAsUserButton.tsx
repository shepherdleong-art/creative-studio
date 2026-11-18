'use client';

import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { teamError, teamWrite } from './client';

/**
 * 04 号票：一键进入 / 返回用户视角。
 *
 * 只切展示 Cookie（`/api/team/auth/view-as`），不重新登录；成功后整页刷新，
 * 让服务端布局按新视角重渲染。按钮本身只对管理员渲染（调用方负责过滤）。
 */
export default function ViewAsUserButton({ active }: { active: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  const toggle = async () => {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      const response = await teamWrite('/api/team/auth/view-as', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !active }),
      });
      if (!response.ok) throw new Error(await teamError(response, '切换视角失败'));
      window.location.assign('/');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '切换视角失败，请重试');
      setPending(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="cap"
        onClick={() => void toggle()}
        disabled={pending}
        data-testid="view-as-toggle"
        title={error || undefined}
      >
        <Icon name={active ? 'settings' : 'users'} size={15} />
        {pending ? '正在切换…' : active ? '返回管理界面' : '查看用户视角'}
      </button>
      {error && <span role="alert" className="sr-only">{error}</span>}
    </>
  );
}

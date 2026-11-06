'use client';

import { useCallback, useEffect, useState } from 'react';
import { teamError, teamWrite } from './client';

type RequirementStatus = 'ready' | 'missing' | 'disabled' | 'mapping_mismatch' | 'credential_missing' | 'provider_disabled';

type Requirement = {
  key: string;
  entityType: 'image' | 'video' | 'script' | 'tts' | 'canvas';
  entityId: string;
  label: string;
  poolKey: string;
  kind: 'remote';
  mappingSnapshot: Record<string, unknown>;
  status: RequirementStatus;
  message: string | null;
  poolVersion: number | null;
};

type Pool = { poolKey: string; kind: string; capacity: number; enabled: boolean; version: number };

type PoolState = {
  pools: Pool[];
  bindings: Array<{ bindingKey: string; poolKey: string; label: string }>;
  requirements: Requirement[];
  ready: boolean;
  blockers: string[];
  occupancy: Array<{
    poolKey: string; capacity: number; held: number; accepted: number; maybeSent: number; notSent: number;
    activeMembers: Array<{ actorId: string; held: number; pending: number; running: number }>;
  }>;
};

const STATUS_LABELS: Record<RequirementStatus, string> = {
  ready: '已就绪',
  missing: '未配置',
  disabled: '已停用',
  mapping_mismatch: '映射不一致',
  credential_missing: '缺凭据',
  provider_disabled: '未启用',
};

export default function TeamPoolsPanel() {
  const [state, setState] = useState<PoolState | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { poolKey: string; capacity: string; enabled: boolean }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    const response = await fetch('/api/team/pools', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error(await teamError(response, '无法读取资源池状态'));
    const body = await response.json() as PoolState;
    setState(body);
    setDrafts(Object.fromEntries(body.requirements.map((item) => {
      const pool = body.pools.find((candidate) => candidate.poolKey === item.poolKey);
      return [item.key, {
        poolKey: item.poolKey,
        capacity: String(pool?.capacity ?? 0),
        enabled: pool?.enabled ?? true,
      }];
    })));
  }, []);

  useEffect(() => {
    void Promise.resolve().then(refresh).catch((cause) => setError(cause instanceof Error ? cause.message : '无法读取资源池状态'));
  }, [refresh]);

  async function save(requirement: Requirement) {
    const draft = drafts[requirement.key];
    if (!draft) return;
    const capacity = Number(draft.capacity);
    if (!Number.isSafeInteger(capacity) || capacity < 0) {
      setError('容量必须是非负整数。');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const expectedVersion = state?.pools.find((pool) => pool.poolKey === draft.poolKey.trim())?.version ?? 0;
      const change = requirement.entityType === 'image' || requirement.entityType === 'video'
        ? {
          action: 'bind-media-upstream', entityType: requirement.entityType, entityId: requirement.entityId,
          poolKey: draft.poolKey.trim(), capacity, enabled: draft.enabled, expectedVersion,
        }
        : {
          action: 'upsert', poolKey: draft.poolKey.trim(), kind: 'remote', capacity,
          enabled: draft.enabled, mappingSnapshot: requirement.mappingSnapshot, expectedVersion,
        };
      const response = await teamWrite('/api/team/pools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: [change] }),
      });
      if (!response.ok) throw new Error(await teamError(response, '资源池保存失败'));
      setNotice(`${requirement.label} 的资源池已保存；旧操作继续使用其冻结映射和占额。`);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '资源池保存失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-ink">资源池与共享预算</h1>
        <p className="mt-2 text-sm text-ink-secondary">
          只有管理员可配置。容量由真实上游账户/配额决定；同一上游的多个 Key 需要显式绑定到同一个池才会共享并发。
          凭据只以指纹参与映射，不会出现在本页或接口响应里。
        </p>
      </div>

      {state && !state.ready && <section className="card border-warn p-5" role="status">
        <h2 className="font-semibold text-ink">仍有资源池未就绪</h2>
        <ul className="mt-2 space-y-1 text-sm text-ink-secondary">
          {state.blockers.map((blocker) => <li key={blocker}>· {blocker}</li>)}
        </ul>
        <p className="mt-2 text-xs text-ink-tertiary">未配置或停用的池会阻止新的付费步骤；已受理任务仍可继续收取结果。</p>
      </section>}

      {error && <p role="alert" className="text-sm text-fail">{error}</p>}
      {notice && <p role="status" className="text-sm text-ok">{notice}</p>}

      <section className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="bg-surface-subtle text-xs text-ink-tertiary">
              <tr>
                <th className="px-4 py-3">调用面</th>
                <th className="px-4 py-3">池键</th>
                <th className="px-4 py-3">容量</th>
                <th className="px-4 py-3">启用</th>
                <th className="px-4 py-3">状态</th>
                <th className="px-4 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {(state?.requirements ?? []).map((requirement) => {
                const draft = drafts[requirement.key];
                return <tr key={requirement.key} className="align-top">
                  <td className="px-4 py-4">
                    <div className="font-medium text-ink">{requirement.label}</div>
                    <div className="font-mono text-xs text-ink-tertiary">{requirement.entityType} · {requirement.entityId}</div>
                  </td>
                  <td className="px-4 py-4">
                    <input
                      aria-label={`${requirement.label}池键`}
                      className="input-field w-64 font-mono text-xs"
                      value={draft?.poolKey ?? requirement.poolKey}
                      disabled={busy || !['image', 'video'].includes(requirement.entityType)}
                      onChange={(event) => setDrafts((current) => ({
                        ...current,
                        [requirement.key]: { ...(current[requirement.key] ?? { poolKey: requirement.poolKey, capacity: '0', enabled: true }), poolKey: event.target.value },
                      }))}
                    />
                  </td>
                  <td className="px-4 py-4">
                    <input
                      aria-label={`${requirement.label}容量`}
                      className="input-field w-24"
                      type="number"
                      min="0"
                      step="1"
                      value={draft?.capacity ?? '0'}
                      disabled={busy}
                      onChange={(event) => setDrafts((current) => ({
                        ...current,
                        [requirement.key]: { ...(current[requirement.key] ?? { poolKey: requirement.poolKey, capacity: '0', enabled: true }), capacity: event.target.value },
                      }))}
                    />
                  </td>
                  <td className="px-4 py-4">
                    <input
                      aria-label={`${requirement.label}启用`}
                      type="checkbox"
                      checked={draft?.enabled ?? true}
                      disabled={busy}
                      onChange={(event) => setDrafts((current) => ({
                        ...current,
                        [requirement.key]: { ...(current[requirement.key] ?? { poolKey: requirement.poolKey, capacity: '0', enabled: true }), enabled: event.target.checked },
                      }))}
                    />
                  </td>
                  <td className="px-4 py-4">
                    <div className={requirement.status === 'ready' ? 'text-ok' : 'text-warn'}>{STATUS_LABELS[requirement.status]}</div>
                    {requirement.message && <div className="mt-1 max-w-sm text-xs text-ink-tertiary">{requirement.message}</div>}
                    {requirement.poolVersion !== null && <div className="mt-1 text-xs text-ink-tertiary">版本 {requirement.poolVersion}</div>}
                  </td>
                  <td className="px-4 py-4 text-right">
                    <button className="btn-secondary btn-sm" disabled={busy} onClick={() => void save(requirement)}>
                      保存该池
                    </button>
                  </td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
        {state && state.requirements.length === 0 && <p className="px-5 py-10 text-center text-sm text-ink-tertiary">尚未配置任何供应商；先到“供应商”页配置后回来分配资源池。</p>}
      </section>

      <section className="card space-y-3 p-5" aria-label="共享池实际占用">
        <h2 className="text-lg font-semibold text-ink">共享池实际占用</h2>
        <p className="text-xs leading-5 text-ink-tertiary">占用按实际持有名额统计，不按登录人数推算；待发送和受理不明继续占额，已受理生成继续执行。</p>
        {state?.occupancy.length ? <div className="grid gap-3 md:grid-cols-2">{state.occupancy.map((pool) => <article key={pool.poolKey} className="rounded-lg border border-hairline p-3">
          <div className="flex items-center justify-between gap-2"><strong className="break-all font-mono text-xs text-ink">{pool.poolKey}</strong><span className={pool.held >= pool.capacity && pool.capacity > 0 ? 'text-warn' : 'text-ok'}>{pool.held} / {pool.capacity} 个名额</span></div>
          <p className="mt-2 text-xs text-ink-secondary">已受理 {pool.accepted} · 受理不明 {pool.maybeSent} · 待发送 {pool.notSent}</p>
          {pool.activeMembers.length > 0 && <p className="mt-1 text-xs text-ink-tertiary">需求成员：{pool.activeMembers.map((member) => `${member.actorId}（占用 ${member.held}，排队 ${member.pending}，运行 ${member.running}）`).join('；')}</p>}
        </article>)}</div> : <p className="text-sm text-ink-tertiary">尚未配置资源池，暂无实际占用。</p>}
      </section>

      <section className="card space-y-3 p-5">
        <h2 className="text-lg font-semibold text-ink">已绑定的共享上游</h2>
        {state && state.bindings.length > 0
          ? <ul className="space-y-1 text-sm text-ink-secondary">
            {state.bindings.map((binding) => <li key={binding.bindingKey}>· {binding.label || binding.bindingKey} → <span className="font-mono text-xs">{binding.poolKey}</span></li>)}
          </ul>
          : <p className="text-sm text-ink-tertiary">暂无共享绑定。每个凭证默认使用按指纹隔离的池；需要共享时把多个供应商保存到同一个池键。</p>}
        <p className="text-xs leading-5 text-ink-tertiary">
          下调容量或停用池不会释放已受理或结果不明的占额，也不会中断结果收取；新任务会在准入时重新校验。
        </p>
      </section>
    </div>
  );
}

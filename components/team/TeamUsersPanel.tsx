'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { teamError, teamWrite } from './client';
import TeamCredentialDialog from './TeamCredentialDialog';
import type { TeamModelOption } from '@/lib/team-service/model-permissions';

type Member = {
  userId: string;
  employeeId: string;
  displayName: string;
  role: 'employee' | 'admin';
  accountStatus: 'active' | 'disabled';
  mustChangePassword: boolean;
  todayChargedMinor: number;
  monthChargedMinor: number;
  monthSettledMinor: number;
  heldMinor: number;
  monthlyLimitMinor: number | null;
  remainingMinor: number | null;
  currentConcurrency: number;
  concurrencyLimit: number | null;
  concurrencyMode: 'legacy' | 'inherit' | 'fixed';
  concurrencySource: 'legacy_fixed' | 'team_default' | 'personal_fixed';
  paused: boolean;
  allowedModels: string[] | null;
  policyVersion: number;
  waitingReason: string | null;
  attention: boolean;
  modules: Array<{ module: string; chargedMinor: number }>;
};

type TeamConcurrencyPolicy = { mode: 'auto' | 'manual'; manualDefaultConcurrency: number; version: number };

const CONCURRENCY_SOURCE_LABELS = {
  legacy_fixed: '旧个人固定值（未迁移）',
  team_default: '继承团队规则（自动或手动，以团队当前设置为准）',
  personal_fixed: '个人固定覆盖',
} as const;

const WAITING_LABELS: Record<string, string> = {
  monthly_budget: '余额不足',
  personal_concurrency: '个人生效上限已满，等待名额',
  actor_paused: '暂停生成',
  actor_disabled: '账号停用',
  pricing_required: '定价缺失',
  cost_unknown: '费用待核查',
  pool_capacity: '共享并发等待',
  fair_share: '等待公平共享名额，释放后按顺序继续',
  pool_missing: '资源池未配置',
  maintenance: '维护等待',
  model_forbidden: '模型未授权',
};

function money(minor: number | null): string {
  return minor === null ? '不限额' : `¥${(minor / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function TeamUsersPanel() {
  const [users, setUsers] = useState<Member[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<'employee' | 'admin'>('employee');
  const [issued, setIssued] = useState<{ employeeId: string; credential: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [limitYuan, setLimitYuan] = useState('0');
  const [unlimited, setUnlimited] = useState(false);
  const [concurrency, setConcurrency] = useState(0);
  const [concurrencyMode, setConcurrencyMode] = useState<'inherit' | 'fixed'>('inherit');
  const [teamPolicy, setTeamPolicy] = useState<TeamConcurrencyPolicy | null>(null);
  const [teamDefault, setTeamDefault] = useState('0');
  const [teamMode, setTeamMode] = useState<'auto' | 'manual'>('auto');
  const [teamPolicyBusy, setTeamPolicyBusy] = useState(false);
  const [teamPolicyError, setTeamPolicyError] = useState('');
  const [teamPolicyNotice, setTeamPolicyNotice] = useState('');
  const [paused, setPaused] = useState(false);
  const [modelOptions, setModelOptions] = useState<TeamModelOption[]>([]);
  const [allModels, setAllModels] = useState(true);
  const [allowedModels, setAllowedModels] = useState<string[]>([]);
  const [customModel, setCustomModel] = useState('');

  const refresh = useCallback(async () => {
    const params = new URLSearchParams();
    if (search.trim()) params.set('search', search.trim());
    if (attentionOnly) params.set('attentionOnly', '1');
    const [response, policyResponse] = await Promise.all([
      fetch(`/api/team/members?${params}`, { credentials: 'same-origin', cache: 'no-store' }),
      fetch('/api/team/concurrency-policy', { credentials: 'same-origin', cache: 'no-store' }),
    ]);
    if (!response.ok) throw new Error(await teamError(response, '无法读取成员列表'));
    if (!policyResponse.ok) throw new Error(await teamError(policyResponse, '无法读取团队并发默认'));
    const body = await response.json() as { items: Member[]; modelOptions: TeamModelOption[] };
    const policy = await policyResponse.json() as TeamConcurrencyPolicy;
    setUsers(body.items);
    setModelOptions(body.modelOptions);
    setTeamPolicy(policy);
    setTeamMode(policy.mode);
    setTeamDefault(String(policy.manualDefaultConcurrency));
  }, [attentionOnly, search]);

  useEffect(() => {
    void Promise.resolve().then(refresh).catch((cause) => setError(cause instanceof Error ? cause.message : '无法读取成员列表'));
  }, [refresh]);

  async function run(action: () => Promise<Response>, success?: () => void) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await action();
      if (!response.ok) throw new Error(await teamError(response, '账号操作失败'));
      const body = await response.json() as { credential?: string; user?: { employeeId: string } };
      if (body.credential && body.user) {
        setIssued({ employeeId: body.user.employeeId, credential: body.credential });
        setNotice(`一次性密码已生成。新成员继承${teamPolicy?.mode === 'auto' ? '团队自动公平共享' : `团队手动默认并发 ${teamPolicy?.manualDefaultConcurrency ?? 0}`}；还需配置可调用模型和生成额度，不影响首次登录和改密。`);
      }
      success?.();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '账号操作失败');
    } finally {
      setBusy(false);
    }
  }

  async function saveTeamPolicy(event: FormEvent) {
    event.preventDefault();
    if (!teamPolicy) return;
    const manualDefaultConcurrency = Number(teamDefault);
    if (!Number.isSafeInteger(manualDefaultConcurrency) || manualDefaultConcurrency < 0) {
      setTeamPolicyError('团队默认并发须为非负整数。');
      return;
    }
    setTeamPolicyBusy(true);
    setTeamPolicyError('');
    setTeamPolicyNotice('');
    try {
      const response = await teamWrite('/api/team/concurrency-policy', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: teamMode, manualDefaultConcurrency, expectedVersion: teamPolicy.version }),
      });
      if (!response.ok) throw new Error(await teamError(response, '团队并发默认保存失败'));
      setTeamPolicyNotice(teamMode === 'auto' ? '团队自动公平共享已启用。按实际排队与运行需求分配容量，不按在线人数分配。' : '团队手动固定默认已保存。仅后续准入使用新值。');
      await refresh();
    } catch (cause) {
      setTeamPolicyError(cause instanceof Error ? cause.message : '团队并发默认保存失败');
    } finally {
      setTeamPolicyBusy(false);
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

  function openPolicy(member: Member) {
    setEditing(member);
    setLimitYuan(member.monthlyLimitMinor === null ? '0' : String(member.monthlyLimitMinor / 100));
    setUnlimited(member.monthlyLimitMinor === null);
    setConcurrency(member.concurrencySource === 'team_default' ? 0 : member.concurrencyLimit ?? 0);
    setConcurrencyMode(member.concurrencyMode === 'inherit' ? 'inherit' : 'fixed');
    setPaused(member.paused);
    setAllModels(member.allowedModels === null);
    setAllowedModels(member.allowedModels ?? []);
    setCustomModel('');
    setError('');
  }

  function savePolicy(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    const amount = Number(limitYuan);
    if (!unlimited && (!Number.isFinite(amount) || amount < 0)) {
      setError('月度金额必须是非负数字。');
      return;
    }
    if (!Number.isSafeInteger(concurrency) || concurrency < 0) {
      setError('个人固定并发须为非负整数；零表示禁止新的生成，与暂停不同。');
      return;
    }
    void run(() => teamWrite(`/api/team/members/${editing.userId}/policy`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        monthlyLimitMinor: unlimited ? null : Math.round(amount * 100),
        unlimited,
        personalConcurrency: concurrency,
        concurrencyMode,
        paused,
        expectedVersion: editing.policyVersion,
        allowedModels: allModels ? null : allowedModels,
      }),
    }), () => {
      setNotice('成员策略已保存；新的付费调用会在下一次准入时使用最新版本。');
      setEditing(null);
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-ink">账号与权限</h1>
        <p className="mt-2 text-sm text-ink-secondary">管理工号、角色、账号启停、可调用模型，以及月度费用和个人云端并发。</p>
      </div>

      {issued && <TeamCredentialDialog {...issued} onClose={() => setIssued(null)} />}

      <section className="card p-6" aria-labelledby="team-concurrency-default-heading">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="max-w-2xl">
            <h2 id="team-concurrency-default-heading" className="text-lg font-semibold text-ink">团队并发默认</h2>
            <p className="mt-2 text-sm leading-6 text-ink-secondary">自动模式按各共享池的合格排队与真实运行需求公平分配容量；单人可借用空闲名额，多人按顺序轮转。手动模式使用固定的团队个人默认。两者都不是保留席位，也不放宽权限、费用或暂停状态。</p>
          </div>
          <label className="text-sm text-ink-secondary">团队并发模式
            <select aria-label="团队并发模式" className="input-field mt-1" value={teamMode} onChange={event => setTeamMode(event.target.value as 'auto' | 'manual')}>
              <option value="auto">自动公平共享</option><option value="manual">手动固定默认</option>
            </select>
          </label>
        </div>
        <form onSubmit={saveTeamPolicy} className="mt-5 flex flex-wrap items-end gap-3">
          <label className="block text-sm text-ink-secondary">团队手动默认上限
            <input aria-label="团队手动默认上限" className="input-field mt-1 w-44" type="number" min="0" step="1" value={teamDefault} disabled={teamMode === 'auto'} onChange={event => setTeamDefault(event.target.value)} required={teamMode === 'manual'} />
          </label>
          <button className="btn-primary" type="submit" disabled={teamPolicyBusy || !teamPolicy}>保存团队默认</button>
          <span className="pb-2 text-xs text-ink-tertiary">策略版本 {teamPolicy?.version ?? '—'}</span>
        </form>
        <p className="mt-3 text-xs leading-5 text-ink-tertiary">零表示不能开始新的生成，与“暂停新的付费生成”分别生效。调低上限或恢复继承只影响后续提交，已受理及受理不明的请求继续收取结果。</p>
        <p className="mt-2 text-xs leading-5 text-ink-tertiary">升级时旧个人固定值已一次性迁移为继承，并保留原值审计；之后明确设置的个人固定覆盖不会在重启时重置。自动上限随实际需求变化，不是承诺给个人的永久配额。</p>
        {teamPolicyError && <p role="alert" className="mt-3 text-sm text-fail">{teamPolicyError}</p>}
        {teamPolicyNotice && <p role="status" className="mt-3 text-sm text-ok">{teamPolicyNotice}</p>}
      </section>

      <section className="card p-6">
        <h2 className="mb-5 text-lg font-semibold text-ink">新建账号</h2>
        <form onSubmit={createUser} className="grid gap-4 md:grid-cols-[1fr_1fr_160px_auto] md:items-end">
          <label><span className="label">工号</span><input className="input-field" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} placeholder="例如 00123" required /></label>
          <label><span className="label">姓名</span><input className="input-field" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></label>
          <label><span className="label">角色</span><select className="input-field" value={role} onChange={(event) => setRole(event.target.value as 'employee' | 'admin')}><option value="employee">员工</option><option value="admin">管理员</option></select></label>
          <button className="btn-primary" disabled={busy} type="submit">添加成员并生成密码</button>
        </form>
      </section>

      <section className="card space-y-4 p-5" aria-label="成员用量筛选">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-ink-secondary">搜索姓名或工号
              <input className="input-field mt-1 w-56" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="姓名 / 工号" />
            </label>
            <label className="flex items-center gap-2 pb-2 text-sm text-ink-secondary">
              <input type="checkbox" checked={attentionOnly} onChange={(event) => setAttentionOnly(event.target.checked)} />需要关注
            </label>
          </div>
          <a className="btn-secondary btn-sm" href="/api/team/usage/export?period=month">导出本月 CSV</a>
        </div>
        <p className="text-xs leading-5 text-ink-tertiary">已计金额包含已结算费用与尚未结算的预留，按北京时间自然月统计。权限调整影响后续调用；已受理任务继续收取结果，不影响登录、编辑、查看和下载。</p>
      </section>

      {error && <p role="alert" className="text-sm text-fail">{error}</p>}
      {notice && <p role="status" className="text-sm text-ok">{notice}</p>}
      <section className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-left text-sm">
            <thead className="bg-surface-subtle text-xs text-ink-tertiary"><tr><th className="px-4 py-3">成员</th><th className="px-4 py-3">今日已计</th><th className="px-4 py-3">本月已计 / 额度</th><th className="px-4 py-3">待结算预留</th><th className="px-4 py-3">剩余</th><th className="px-4 py-3">当前并发 / 上限</th><th className="px-4 py-3">状态</th><th className="px-4 py-3">角色</th><th className="px-4 py-3 text-right">操作</th></tr></thead>
            <tbody className="divide-y divide-hairline">
              {users.map((user) => <tr key={user.userId} className="align-top">
                <td className="px-4 py-4"><div className="font-medium text-ink">{user.displayName}{user.attention && <span className="ml-2 text-xs text-warn">关注</span>}</div><div className="font-mono text-xs text-ink-tertiary">{user.employeeId}</div><details className="mt-2 text-xs text-ink-secondary"><summary className="cursor-pointer">模块明细</summary><div className="mt-1 space-y-1">{user.modules.length ? user.modules.map((module) => <div key={module.module}>{module.module}：{money(module.chargedMinor)}</div>) : <span>本月暂无费用</span>}</div></details></td>
                <td className="px-4 py-4 text-ink-secondary">{money(user.todayChargedMinor)}</td>
                <td className="px-4 py-4 text-ink-secondary"><div>{money(user.monthChargedMinor)} / {money(user.monthlyLimitMinor)}</div><div className="mt-1 text-xs text-ink-tertiary">已结算 {money(user.monthSettledMinor)}</div></td>
                <td className="px-4 py-4 text-ink-secondary">{money(user.heldMinor)}</td>
                <td className="px-4 py-4 text-ink-secondary">{money(user.remainingMinor)}</td>
                <td className="px-4 py-4 text-ink-secondary"><div>{user.currentConcurrency} / {user.concurrencyLimit ?? '自动'}</div><div className="mt-1 max-w-36 text-xs text-ink-tertiary">{CONCURRENCY_SOURCE_LABELS[user.concurrencySource]}</div></td>
                <td className="px-4 py-4 text-ink-secondary"><div>{user.accountStatus === 'disabled' ? '账号停用' : user.paused ? '暂停新付费' : '启用'}</div>{user.waitingReason && <div className="mt-1 text-xs text-warn">{WAITING_LABELS[user.waitingReason] ?? user.waitingReason}</div>}<div className="mt-1 text-xs text-ink-tertiary">{user.mustChangePassword ? '待首次改密' : '已改密'}</div></td>
                <td className="px-4 py-4"><select aria-label={`${user.displayName}角色`} className="input-field" value={user.role} disabled={busy} onChange={(event) => void run(() => teamWrite(`/api/team/users/${user.userId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: event.target.value }) }))}><option value="employee">员工</option><option value="admin">管理员</option></select></td>
                <td className="px-4 py-4"><div className="flex justify-end gap-2"><button className="btn-secondary btn-sm" disabled={busy} onClick={() => openPolicy(user)}>模型与额度</button><button className="btn-secondary btn-sm" disabled={busy} onClick={() => { if (window.confirm(`确定重置 ${user.displayName} 的凭据并撤销其会话吗？`)) void run(() => teamWrite(`/api/team/users/${user.userId}/reset-credential`, { method: 'POST' })); }}>重置一次性密码</button><button className="btn-secondary btn-sm" disabled={busy} onClick={() => void run(() => teamWrite(`/api/team/users/${user.userId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: user.accountStatus === 'active' ? 'disabled' : 'active' }) }))}>{user.accountStatus === 'active' ? '停用' : '启用'}</button></div></td>
              </tr>)}
            </tbody>
          </table>
        </div>
        {users.length === 0 && <p className="px-5 py-10 text-center text-sm text-ink-tertiary">没有符合筛选的成员。</p>}
      </section>

      {editing && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label={`${editing.displayName}模型与额度策略`}>
        <form onSubmit={savePolicy} className="card max-h-[90vh] w-full max-w-xl space-y-4 overflow-y-auto p-6 shadow-xl">
          <div><h2 className="text-lg font-semibold text-ink">{editing.displayName}：模型、费用与并发</h2><p className="mt-1 text-xs text-ink-tertiary">保存后对后续调用生效，已受理任务继续收取结果。</p></div>
          <fieldset className="space-y-3 border-b border-hairline pb-4">
            <legend className="text-sm font-medium text-ink">可调用模型</legend>
            <label className="flex items-center gap-2 text-sm text-ink-secondary"><input type="checkbox" checked={allModels} onChange={event => setAllModels(event.target.checked)} />不限模型（包含以后新增的模型）</label>
            {!allModels && <>
              <p className="text-xs text-ink-tertiary">仅允许勾选的模型；不选任何模型将禁止所有模型调用。涉及配音、字幕对齐的流程也需要授权对应模型。</p>
              <div className="max-h-52 space-y-2 overflow-y-auto rounded-lg border border-hairline p-3">
                {[...modelOptions, ...allowedModels.filter(model => !modelOptions.some(option => option.model === model)).map(model => ({ model, label: '自定义模型', category: '其他' }))].map(option => <label key={option.model} className="flex items-start gap-2 text-sm text-ink-secondary">
                  <input type="checkbox" className="mt-1" checked={allowedModels.includes(option.model)} onChange={event => setAllowedModels(current => event.target.checked ? [...current, option.model] : current.filter(model => model !== option.model))} />
                  <span className="min-w-0 break-all">{option.label}<span className="ml-2 text-xs text-ink-tertiary">{option.category}</span><span className="block text-xs text-ink-tertiary">{option.model}</span></span>
                </label>)}
              </div>
              <div className="flex gap-2"><input className="input-field min-w-0 flex-1" aria-label="自定义模型标识" placeholder="其他模型：输入完整模型标识" value={customModel} maxLength={200} onChange={event => setCustomModel(event.target.value)} /><button type="button" className="btn-secondary btn-sm" disabled={!customModel.trim()} onClick={() => { setAllowedModels(current => [...new Set([...current, customModel.trim()])]); setCustomModel(''); }}>添加</button></div>
              <p className="text-xs text-ink-secondary">已允许 {allowedModels.length} 个模型</p>
            </>}
          </fieldset>
          {error && <p role="alert" className="text-sm text-fail">{error}</p>}
          <label className="flex items-center gap-2 text-sm text-ink-secondary"><input type="checkbox" checked={unlimited} onChange={(event) => setUnlimited(event.target.checked)} />不限月度金额（仍受并发限制）</label>
          <label className="block text-sm text-ink-secondary">月度金额（元）<input className="input-field mt-1" type="number" min="0" step="0.01" value={limitYuan} disabled={unlimited} onChange={(event) => setLimitYuan(event.target.value)} required={!unlimited} /></label>
          <fieldset className="space-y-3 rounded-xl border border-hairline p-4">
            <legend className="px-1 text-sm font-medium text-ink">并发规则</legend>
            <label className="flex items-start gap-2 text-sm text-ink-secondary"><input className="mt-1" type="radio" name="member-concurrency-mode" value="inherit" checked={concurrencyMode === 'inherit'} onChange={() => setConcurrencyMode('inherit')} /><span>继承团队规则<span className="block text-xs text-ink-tertiary">{teamPolicy?.mode === 'auto' ? '当前为自动公平共享，按实际任务需求分配，不保留固定个人名额。' : `当前生效上限 ${teamPolicy?.manualDefaultConcurrency ?? 0}，团队设置变化后自动采用。`}</span></span></label>
            <label className="flex items-start gap-2 text-sm text-ink-secondary"><input className="mt-1" type="radio" name="member-concurrency-mode" value="fixed" checked={concurrencyMode === 'fixed'} onChange={() => setConcurrencyMode('fixed')} /><span>使用个人固定上限<span className="block text-xs text-ink-tertiary">只限制自己的最大占用，不预留共享池名额。</span></span></label>
            <label className="block text-sm text-ink-secondary">个人固定并发上限<input aria-label="个人固定并发上限" className="input-field mt-1" type="number" min="0" step="1" value={concurrency} disabled={concurrencyMode === 'inherit'} onChange={(event) => setConcurrency(event.target.value === '' ? Number.NaN : event.target.valueAsNumber)} required={concurrencyMode === 'fixed'} /></label>
            <p className="text-xs text-warn">固定值设为 0 会阻止新的生成任务，但不等于暂停，也不取消已受理任务。</p>
            {editing.concurrencySource === 'legacy_fixed' && <p className="text-xs leading-5 text-ink-tertiary">此成员当前使用旧个人固定值。选择“个人固定上限”并保存后才会标记为明确的个人覆盖；仅打开或查看页面不会迁移。</p>}
          </fieldset>
          <label className="flex items-center gap-2 text-sm text-ink-secondary"><input type="checkbox" checked={paused} onChange={(event) => setPaused(event.target.checked)} />暂停新的付费生成</label>
          <p className="text-xs leading-5 text-ink-tertiary">暂停或降低上限只影响后续付费步骤；已受理任务不会被中断。</p>
          <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setEditing(null)}>取消</button><button type="submit" className="btn-primary" disabled={busy}>保存策略</button></div>
        </form>
      </div>}
    </div>
  );
}

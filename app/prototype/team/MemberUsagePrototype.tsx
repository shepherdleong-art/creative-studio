'use client';
// THROWAWAY: monthly money limits and concurrent calls, all in memory and cents.
import { useState, type ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { modules, initialJobs, type Job, type ModuleName } from './demo-data';
import s from './prototype.module.css';

export type DemoMember = { id: string; name: string; enabled: boolean; admin: boolean };
type UsageRow = { module: ModuleName; cents: number; todayCents: number; calls: number };
export type UsageProfile = { monthlyLimitCents: number | null; concurrency: number; generationPaused: boolean; rows: UsageRow[] };
export type UsageProfiles = Record<string, UsageProfile>;
export type UsagePolicy = Pick<UsageProfile, 'monthlyLimitCents' | 'concurrency' | 'generationPaused'>;
export const money = (cents: number) => `¥${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const profile = (amounts: number[], today: number[], calls: number[], limit: number | null, concurrency: number): UsageProfile => ({ monthlyLimitCents: limit, concurrency, generationPaused: false, rows: modules.map((m, i) => ({ module: m.name, cents: amounts[i] || 0, todayCents: today[i] || 0, calls: calls[i] || 0 })) });
export const initialUsageProfiles: UsageProfiles = {
  '00106': profile([6840, 4260, 540, 1000], [1240, 1060, 140, 200], [48, 20, 12, 16], 50000, 3),
  '00112': profile([24000, 15000, 1500, 4500], [2100, 1700, 100, 600], [120, 54, 30, 42], 50000, 2),
  '00118': profile([10000, 10000, 2000, 8000], [800, 700, 200, 800], [60, 36, 40, 52], 30000, 2),
  '00001': profile([1800, 0, 400, 800], [300, 0, 100, 100], [12, 0, 8, 6], 100000, 5),
  '00002': profile([0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], null, 5),
};
export const defaultUsageProfile = (): UsageProfile => profile([], [], [], 0, 2);
export const getProfile = (profiles: UsageProfiles, id: string) => profiles[id] ?? defaultUsageProfile();
export const isCloudInFlight = (j: Job) => j.status === 'unknown' || (j.status === 'running' && !j.stage.includes('渲染'));
export const initialUsageJobs: Job[] = initialJobs.map(j => ({ ...j,
  ownerId: ({ 林晓: '00106', 陈可: '00112', 周宁: '00118' } as Record<string, string>)[j.owner],
  estimatedCents: j.stage.includes('渲染') ? 0 : 1000,
  reservedCents: ({ 'CS-1102-083': 1200, 'CS-1102-080': 2000, 'CS-1102-078': 300 } as Record<string, number>)[j.id] || 0,
}));
export function usageFor(member: DemoMember, p: UsageProfile, jobs: Job[]) {
  const own = jobs.filter(j => j.ownerId === member.id);
  const spent = p.rows.reduce((sum, r) => sum + r.cents, 0);
  const today = p.rows.reduce((sum, r) => sum + r.todayCents, 0);
  const reserved = own.reduce((sum, j) => sum + (j.reservedCents || 0), 0);
  const occupied = spent + reserved;
  const active = own.filter(isCloudInFlight).length;
  const remaining = p.monthlyLimitCents === null ? null : Math.max(0, p.monthlyLimitCents - occupied);
  const ratio = p.monthlyLimitCents === null ? 0 : p.monthlyLimitCents === 0 ? 1 : occupied / p.monthlyLimitCents;
  const blocked = !member.enabled || p.generationPaused || remaining === 0;
  const label = !member.enabled ? '账号停用' : p.generationPaused ? '生成已暂停' : remaining === 0 ? '费用已达上限' : ratio >= .8 ? '接近额度' : active >= p.concurrency ? '并发已满' : '正常';
  return { spent, today, reserved, occupied, remaining, ratio, active, blocked, label, attention: blocked || ratio >= .8 };
}
export function evaluatePaidCall(member: DemoMember, p: UsageProfile, jobs: Job[], serverBudget: number, estimate: number): { state: 'ready' | 'wait' | 'blocked'; reason: string } {
  const u = usageFor(member, p, jobs);
  if (!member.enabled) return { state: 'blocked', reason: '账号已停用，不能发起新任务' };
  if (p.generationPaused) return { state: 'blocked', reason: '管理员已暂停新的付费生成' };
  if (u.remaining !== null && estimate > u.remaining) return { state: 'blocked', reason: `本月可用 ${money(u.remaining)}，不足以预留本次 ${money(estimate)}` };
  if (u.active >= p.concurrency) return { state: 'wait', reason: `个人并发 ${u.active}/${p.concurrency}，等待名额，不预留费用` };
  if (jobs.filter(isCloudInFlight).length >= serverBudget) return { state: 'wait', reason: '服务器共享池已满，等待名额，不预留费用' };
  return { state: 'ready', reason: `可开始执行，先预留 ${money(estimate)}` };
}

function UsageBadge({ u }: { u: ReturnType<typeof usageFor> }) { return <span className={`${s.badge} ${u.blocked ? s.usageBlocked : u.attention ? s.unknown : u.label === '正常' ? s.online : s.queued}`}><i/>{u.label}</span>; }
function BudgetTrack({ u, limit }: { u: ReturnType<typeof usageFor>; limit: number | null }) {
  return <div className={`${s.budgetTrack} ${u.ratio >= 1 ? s.limitReached : u.ratio >= .8 ? s.limitNear : ''}`} aria-label={limit === null ? '未设月度费用上限' : `已计与预留合计占额度 ${Math.round(u.ratio * 100)}%`}>
    {limit !== null && <><i style={{ width: `${limit ? Math.min(100, u.spent / limit * 100) : 100}%` }}/><b style={{ width: `${limit ? Math.min(Math.max(0, 100 - u.spent / limit * 100), u.reserved / limit * 100) : 0}%` }}/></>}
  </div>;
}

export function MemberUsagePanel({ members, profiles, jobs, onOpen, accountActions }: { members: DemoMember[]; profiles: UsageProfiles; jobs: Job[]; onOpen: (id: string) => void; accountActions?: (member: DemoMember) => ReactNode }) {
  const [search, setSearch] = useState(''); const [onlyAttention, setOnlyAttention] = useState(false);
  const all = members.map(m => ({ m, p: getProfile(profiles, m.id), u: usageFor(m, getProfile(profiles, m.id), jobs) }));
  const rows = all.filter(({ m, u }) => `${m.name}${m.id}`.includes(search) && (!onlyAttention || u.attention));
  return <>
    <div className={`${s.stats} ${s.usageStats}`}>
      <div className={s.stat}><header>本月已计费用 <Icon name="table" size={16}/></header><strong>{money(all.reduce((a, x) => a + x.u.spent, 0))}</strong><small>全部成员 · 四类生产模块</small></div>
      <div className={s.stat}><header>在途预留 <Icon name="logs" size={16}/></header><strong>{money(all.reduce((a, x) => a + x.u.reserved, 0))}</strong><small>含待核查调用，结算前保留</small></div>
      <div className={s.stat}><header>费用达到上限 <Icon name="lock" size={16}/></header><strong>{all.filter(x => x.u.remaining === 0).length}<em> 人</em></strong><small>停止新的付费步骤</small></div>
      <div className={s.stat}><header>接近费用额度 <Icon name="alert" size={16}/></header><strong>{all.filter(x => x.u.ratio >= .8 && x.u.ratio < 1).length}<em> 人</em></strong><small>已计＋预留达到 80%</small></div>
    </div>
    <section className={s.panel}>
      <div className={s.sectionHead}><h2>成员用量与限制 <small>本月 · 示例账本</small></h2><span className={s.footnote}>{members.length} 位成员 · {members.filter(m => m.admin).length} 位管理员</span></div>
      <div className={s.tableToolbar}><div className={s.filters}><button aria-pressed={!onlyAttention} onClick={() => setOnlyAttention(false)}>全部成员 <span>{all.length}</span></button><button aria-pressed={onlyAttention} onClick={() => setOnlyAttention(true)}>需要关注 <span>{all.filter(x => x.u.attention).length}</span></button></div><label className={s.search}><Icon name="search" size={15}/><input aria-label="搜索成员姓名或工号" placeholder="搜索姓名或工号" value={search} onChange={e => setSearch(e.target.value)}/></label></div>
      <div className={s.tableWrap}><table className={`${s.taskTable} ${s.memberUsageTable}`}><thead><tr><th>成员</th><th>今日费用</th><th>本月已计 / 费用额度</th><th>在途预留</th><th>云端并发 / 上限</th><th>使用状态</th><th>操作</th></tr></thead><tbody>{rows.map(({ m, p, u }) => <tr key={m.id}>
        <td><div className={s.usagePerson}><span className={s.miniAvatar}>{m.name[0]}</span><div><strong>{m.name}<em>{m.admin ? '管理员' : '员工'}</em></strong><small className={s.mono}>{m.id}</small></div></div></td>
        <td className={s.money}>{money(u.today)}</td>
        <td><div className={s.memberBudget}><strong>{money(u.spent)}</strong><span> / {p.monthlyLimitCents === null ? '不限额' : money(p.monthlyLimitCents)}</span><BudgetTrack u={u} limit={p.monthlyLimitCents}/><small>{u.remaining === null ? '未设置月度金额上限' : `剩余可用 ${money(u.remaining)}`}</small></div></td>
        <td className={s.money}>{money(u.reserved)}<small>尚未结算</small></td>
        <td><span className={s.concurrencyNumber}>{u.active}<small> / {p.concurrency}</small></span>{u.active >= p.concurrency && <small>后续调用等待</small>}</td>
        <td><UsageBadge u={u}/></td>
        <td><div className={s.usageActions}><button className={s.usageManage} onClick={() => onOpen(m.id)} aria-label={`管理${m.name}的用量与限额`}>用量与限额 <Icon name="chevron-right" size={13}/></button>{accountActions && <details><summary>账号操作</summary><div>{accountActions(m)}</div></details>}</div></td>
      </tr>)}</tbody></table>{rows.length === 0 && <div className={s.empty}>没有符合条件的成员</div>}</div>
      <div className={s.usageLegend}><span><i/>已计费用</span><span><b/>在途预留</span><p>额度跨项目和模块合并计算；达到上限仍可查看、编辑与下载。金额为示例估算。</p></div>
    </section>
  </>;
}

export function MemberUsageDialog({ member, profile: p, jobs, serverBudget, onClose, onSave, onSimulate }: { member: DemoMember; profile: UsageProfile; jobs: Job[]; serverBudget: number; onClose: () => void; onSave: (policy: UsagePolicy) => void; onSimulate: () => void }) {
  const [amount, setAmount] = useState(p.monthlyLimitCents === null ? '' : (p.monthlyLimitCents / 100).toFixed(2));
  const [unlimited, setUnlimited] = useState(p.monthlyLimitCents === null); const [concurrency, setConcurrency] = useState(String(p.concurrency));
  const [paused, setPaused] = useState(p.generationPaused);
  const u = usageFor(member, p, jobs);
  const validAmount = unlimited || (/^\d+(\.\d{1,2})?$/.test(amount) && Number.isSafeInteger(Math.round(Number(amount) * 100)));
  const validConcurrency = /^\d+$/.test(concurrency) && Number(concurrency) >= 1 && Number(concurrency) <= 10;
  const nextLimit = unlimited ? null : Math.round(Number(amount) * 100);
  const call = evaluatePaidCall(member, p, jobs, serverBudget, 1000);
  return <div className={s.modalBackdrop} onClick={onClose}><section className={`${s.modal} ${s.usageModal}`} role="dialog" aria-modal="true" aria-label={`${member.name}的用量与限额`} onClick={e => e.stopPropagation()}>
    <button className={`${s.iconButton} ${s.modalClose}`} aria-label="关闭用量与限额" onClick={onClose}><Icon name="close"/></button>
    <div className={s.usageDialogTitle}><span className={s.avatar}>{member.name[0]}</span><div><h2>{member.name}的用量与限额</h2><p>{member.id} · {member.admin ? '管理员' : '员工'} · 本月额度</p></div><UsageBadge u={u}/></div>
    <div className={s.usageTotals}><div><span>本月已计</span><strong>{money(u.spent)}</strong></div><div><span>在途预留</span><strong>{money(u.reserved)}</strong></div><div><span>剩余可用</span><strong>{u.remaining === null ? '不限额' : money(u.remaining)}</strong></div></div>
    <div className={s.usageDialogGrid}>
      <section><h3>用量明细</h3><p className={s.footnote}>统计已计费用；在途预留单独展示。</p><table className={`${s.taskTable} ${s.usageBreakdown}`}><thead><tr><th>生产模块</th><th>调用次数</th><th>本月费用</th></tr></thead><tbody>{p.rows.map(r => <tr key={r.module}><td>{r.module}</td><td>{r.calls}</td><td>{money(r.cents)}</td></tr>)}</tbody></table><div className={s.notice}>今日已计 {money(u.today)}。提交结果不明的调用继续保留额度，核查后再结算或释放。</div></section>
      <section><h3>使用限制</h3><label className={s.field}>每月费用上限（元）<input aria-label="每月费用上限" type="text" inputMode="decimal" placeholder="例如 500.00" value={amount} disabled={unlimited} onChange={e => setAmount(e.target.value)}/></label><label className={s.checkField}><input type="checkbox" checked={unlimited} onChange={e => setUnlimited(e.target.checked)}/>不设金额上限</label><label className={s.field}>个人云端并发上限<input aria-label="个人云端并发上限" type="number" min="1" max="10" value={concurrency} onChange={e => setConcurrency(e.target.value)}/></label><p className={s.footnote}>当前在途 {u.active} 个，受服务器总池 {serverBudget} 个约束。降低上限不打断已受理任务。</p><label className={s.checkField}><input type="checkbox" checked={paused} onChange={e => setPaused(e.target.checked)}/>暂停新的付费生成</label><p className={s.footnote}>账号仍可登录、查看成果和下载。</p></section>
    </div>
    {!validAmount || !validConcurrency ? <div className={s.usageValidation}>金额需为非负数，最多两位小数；并发上限为 1–10 的整数。</div> : nextLimit !== null && nextLimit <= u.occupied ? <div className={s.usageValidation}>新额度不高于已计＋预留 {money(u.occupied)}。保存后暂停新的付费步骤，已有在途任务继续收取。</div> : null}
    <div className={s.usageSimulation}><div><span>原型试算 · 以已保存限制为准</span><p>{call.reason}</p></div><button className={s.button} onClick={onSimulate}>模拟该成员调用 ¥10</button></div>
    <div className={s.modalActions}><button className={s.button} onClick={onClose}>关闭</button><button className={s.primary} disabled={!validAmount || !validConcurrency} onClick={() => onSave({ monthlyLimitCents: nextLimit, concurrency: Number(concurrency), generationPaused: paused })}>保存限制</button></div>
  </section></div>;
}

export function PersonalUsage({ member, profile: p, jobs }: { member: DemoMember; profile: UsageProfile; jobs: Job[] }) {
  const u = usageFor(member, p, jobs);
  return <><section className={`${s.panel} ${s.personalAllowance}`}><div className={s.sectionHead}><h2>我的本月额度</h2><UsageBadge u={u}/></div><div className={s.usageTotals}><div><span>已计 / 每月费用额度</span><strong>{money(u.spent)} <small>/ {p.monthlyLimitCents === null ? '不限额' : money(p.monthlyLimitCents)}</small></strong></div><div><span>在途预留</span><strong>{money(u.reserved)}</strong></div><div><span>个人云端并发</span><strong>{u.active} <small>/ {p.concurrency}</small></strong></div></div><BudgetTrack u={u} limit={p.monthlyLimitCents}/><p className={s.footnote}>{u.remaining === null ? '管理员未设置月度金额上限。' : `剩余可用 ${money(u.remaining)}。`}需要调整额度时请联系管理员。已有任务、素材和成片继续保留。</p></section><section className={s.panel}><div className={s.sectionHead}><h2>各模块用量</h2><small>本月 · 示例估算</small></div><table className={s.taskTable}><thead><tr><th>模块</th><th>今日费用</th><th>本月调用</th><th>本月费用</th></tr></thead><tbody>{p.rows.map(r => <tr key={r.module}><td>{r.module}</td><td>{money(r.todayCents)}</td><td>{r.calls} 次</td><td>{money(r.cents)}</td></tr>)}</tbody></table></section></>;
}

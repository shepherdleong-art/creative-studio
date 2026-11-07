'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Icon, type IconName } from '@/components/ui/Icon';
import PageToolbar from '@/components/team/PageToolbar';
import { EmptyState, GroupList, GroupRow, StatusDot, Tag, ToolbarButton, type TagTone } from '@/components/ui/Appearance';
import TeamProductionControl from './TeamProductionControl';
import { teamError } from './client';
import { consoleDefaultsView, type ConsoleDefaultsView } from '@/lib/team-console-overview';
import s from './console.module.css';
import type { WorkspaceRole } from '@/lib/workspace-navigation';

type Counts = { running: number; queued: number; completedToday: number; failed: number; total: number };
type RecentRow = {
  operationId: string; taskLabel: string; stepName: string; projectName: string;
  actorName: string; employeeId: string; modelLabel: string;
  status: string; statusLabel: string; tone: TagTone; timeLabel: string; href: string;
};
type MemberRow = { actorUserId: string; displayName: string; employeeId: string; summary: string; running: number };
type PoolRow = { poolKey: string; capacity: number; used: number; percent: number; hint: string; activeMembers: Array<{ actorId: string }> };
type SetupItem = { key: string; label: string; state: 'ok' | 'action' | 'unknown'; detail: string; href: string; actionLabel: string; reasons: string[] };
type Setup = { items: SetupItem[]; ready: boolean; pendingCount: number; title: string };
type Overview = {
  counts: Counts;
  recent: RecentRow[];
  members: MemberRow[];
  pools: PoolRow[];
  setup: Setup;
  productionDefaults: unknown;
  empty: boolean;
  taskTotal: number;
  errorTotal: number;
  recentLimit: number;
};

const CARDS: Array<{ key: keyof Counts; label: string; icon: IconName; hint: string }> = [
  { key: 'running', label: '正在跑', icon: 'play-circle', hint: '已占名额，供应商正在处理' },
  { key: 'queued', label: '在排队', icon: 'logs', hint: '等名额或运行条件' },
  { key: 'completedToday', label: '今天已完成', icon: 'check-circle', hint: '按北京时间，成功结束的' },
  { key: 'failed', label: '出错', icon: 'alert', hint: '失败或提交结果待核查' },
];

async function read<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error(await teamError(response, '读取运行总览失败'));
  return response.json() as Promise<T>;
}

/**
 * 管理员「运行总览」（12 号票）。员工首页在 `TeamDashboard` 的另一个分支，归 06 号票。
 *
 * 数据只打一个接口 `/api/team/console/overview`：数量卡、最近任务、今天成员、名额占用、
 * 开工前清单全在服务端按 `lib/team-console-overview.ts` 的口径算好，这里只渲染。
 * 点最近任务表的任意一行跳到 `/team/tasks?taskId=<operationId>` 打开那条详情。
 */
export default function TeamConsoleOverview({ role, displayName }: { role: WorkspaceRole; displayName: string }) {
  const router = useRouter();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setData(await read<Overview>('/api/team/console/overview'));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取运行总览失败');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(refresh);
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const defaults: ConsoleDefaultsView = consoleDefaultsView(data?.productionDefaults);
  const counts = data?.counts;
  const empty = data?.empty === true;

  return (
    <div className={s.page}>
      <PageToolbar
        role={role}
        subtitle={`${displayName} · 每 30 秒自动更新`}
        actions={
          <>
            <TeamProductionControl onStateChange={setPaused} />
            <ToolbarButton icon="retry" onClick={() => void refresh()} disabled={busy} label="刷新状态">
              {busy ? '读取中…' : '刷新'}
            </ToolbarButton>
            <Link className="cap" href="/team/tasks"><Icon name="search" size={15} />找任务</Link>
          </>
        }
      />
      {error ? <p role="alert" className="text-[13px] text-fail">{error}</p> : null}

      <section className={s.cards} aria-label="任务数量">
        {CARDS.map(card => (
          <div className={s.card} key={card.key} data-testid={`count-${card.key}`}>
            <header className={s.cardHead}>{card.label}<Icon name={card.icon} size={15} /></header>
            <strong className={s.cardValue}>{counts ? counts[card.key] : '—'}</strong>
            <small className={s.cardHint}>{card.hint}</small>
          </div>
        ))}
      </section>

      {empty ? (
        <section className={s.panel} aria-label="还没有任务">
          <EmptyState
            icon="sparkle"
            title="服务器上还没有生产任务，四项都是 0"
            description={data && data.setup.ready
              ? '开工前的事都准备好了：成员在项目里提交第一个任务后，这里会显示数量、最近任务和今天的成员。'
              : '先看右栏「开工前还差几件事」，把公司模型代理、参考图中转和模型名额配好，成员就能开工。'}
            action={
              <div className="flex flex-wrap items-center gap-2">
                <Link className="cap cap-primary" href="/projects/new">新建项目</Link>
                <Link className="cap" href="/team/admin/pools">配置模型名额</Link>
                <Link className="cap" href="/team/tasks">看全员任务</Link>
              </div>
            }
          />
        </section>
      ) : null}

      <div className={s.columns}>
        <section className={s.panel} aria-label="最近任务">
          <div className={s.panelHead}>
            <h2>最近任务</h2>
            <Link href="/team/tasks">查看全部 →</Link>
          </div>
          {data && data.recent.length > 0 ? (
            <div className="overflow-x-auto">
              <table className={s.table}>
                <thead>
                  <tr>{['任务', '项目', '发起人', '模型', '状态', '时间'].map(label => <th key={label}>{label}</th>)}</tr>
                </thead>
                <tbody>
                  {data.recent.map(row => (
                    <tr
                      key={row.operationId}
                      tabIndex={0}
                      role="link"
                      data-testid="recent-task-row"
                      data-operation-id={row.operationId}
                      aria-label={`打开任务 ${row.taskLabel} ${row.stepName} 的详情`}
                      onClick={() => router.push(row.href)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          router.push(row.href);
                        }
                      }}
                    >
                      <td>
                        <span className={s.taskName}>{row.taskLabel}</span>
                        <span className={s.taskStep}>{row.stepName}</span>
                      </td>
                      <td className={`${s.secondary} truncate`}>{row.projectName}</td>
                      <td className={s.secondary}>
                        {row.actorName}
                        <span className={`${s.taskStep} block`}>工号 {row.employeeId}</span>
                      </td>
                      <td className={`${s.secondary} ${s.mono} truncate`}>{row.modelLabel}</td>
                      <td className={s.nowrap}><Tag tone={row.tone}>{row.statusLabel}</Tag></td>
                      <td className={`${s.secondary} ${s.nowrap} ${s.mono}`}>{row.timeLabel}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : data ? (
            <div className={s.panelBody}><p className="text-[12.5px] text-ink-secondary">最近没有任务。</p></div>
          ) : (
            <div className={s.panelBody}><p className="text-[12.5px] text-ink-tertiary" role="status">读取运行总览…</p></div>
          )}
          {data ? <p className={s.panelNote}>显示最近 {data.recent.length} 条，共 {data.taskTotal} 条已登记任务；点一行打开它在全员任务里的详情。</p> : null}
        </section>

        <aside className={s.rail} aria-label="运行信息">
          <section className={s.panel}>
            <div className={s.panelHead}><h2>名额占用</h2><Link href="/team/admin/pools">管理 →</Link></div>
            {data && data.pools.length > 0 ? (
              <div className={s.panelBody}>
                {data.pools.map(pool => (
                  <div className={s.poolBlock} key={pool.poolKey}>
                    <div className={s.poolTop}>
                      <span title={pool.poolKey}>{pool.poolKey}</span>
                      <span>{pool.used} / {pool.capacity}</span>
                    </div>
                    <div className={s.bar} role="img" aria-label={`${pool.poolKey} 已用 ${pool.percent}%`}>
                      <i style={{ width: `${pool.percent}%` }} />
                    </div>
                    <span className={s.poolHint}>{pool.hint}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className={s.panelBody}>
                <p className="text-[12.5px] text-ink-secondary">{data ? '还没有配置名额池。' : '读取中…'}</p>
              </div>
            )}
          </section>

          <section className={s.panel}>
            <div className={s.panelHead}><h2>今天的成员</h2><Link href="/usage">团队用量 →</Link></div>
            {data && data.members.length > 0 ? (
              <GroupList>
                {data.members.slice(0, 6).map(member => (
                  <GroupRow
                    key={member.actorUserId}
                    label={member.displayName}
                    hint={`工号 ${member.employeeId}`}
                  >
                    <span className="text-[12px] text-ink-secondary">{member.summary}</span>
                  </GroupRow>
                ))}
              </GroupList>
            ) : (
              <div className={s.panelBody}>
                <p className="text-[12.5px] text-ink-secondary">{data ? '今天还没有成员在生产。' : '读取中…'}</p>
              </div>
            )}
          </section>

          <section className={s.panel} aria-label="开工前还差几件事">
            <div className={s.panelHead}>
              <h2>{data ? data.setup.title : '开工前还差几件事'}</h2>
              {data && !data.setup.ready ? <Link href="/team/admin/pools">去处理 →</Link> : null}
            </div>
            {data && data.setup.ready ? (
              <p className={s.setupReady} data-testid="setup-ready"><StatusDot tone="ok" />已就绪，可以开工。</p>
            ) : data ? (
              <div>
                {data.setup.items.map(item => (
                  <div className={s.setupItem} key={item.key} data-testid={`setup-${item.key}`}>
                    <i className={`${s.setupMark} ${item.state === 'ok' ? s.setupMarkOk : item.state === 'action' ? s.setupMarkAction : ''}`}>
                      {item.state === 'ok' ? <Icon name="check" size={11} /> : null}
                    </i>
                    <div className={s.setupCopy}>
                      <span className={s.setupTitle}>{item.label}<span>{item.detail}</span></span>
                      {item.reasons.length > 0 ? (
                        <ul className={s.setupReasons}>
                          {item.reasons.slice(0, 3).map(reason => <li key={reason}>{reason}</li>)}
                          {item.reasons.length > 3 ? <li>还有 {item.reasons.length - 3} 项，去页面查看</li> : null}
                        </ul>
                      ) : null}
                      {item.state !== 'ok' ? <Link className={s.setupAction} href={item.href}>{item.actionLabel} →</Link> : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className={s.panelBody}><p className="text-[12.5px] text-ink-tertiary">读取中…</p></div>
            )}
          </section>

          {defaults.available ? (
            <section className={s.panel} aria-label="服务器默认参数">
              <div className={s.panelHead}><h2>服务器默认参数</h2><span className="text-[11.5px] text-ink-tertiary">只读</span></div>
              <GroupList>
                {defaults.rows.map(row => (
                  <GroupRow key={row.label} label={row.label} hint={row.hint}>
                    <span className="text-[12px] text-ink">{row.value}</span>
                  </GroupRow>
                ))}
              </GroupList>
              <p className={s.panelNote}>{defaults.note}</p>
            </section>
          ) : null}
        </aside>
      </div>

      {paused ? (
        <p className={s.panelNote} role="status">生产已暂停：新提交的任务会排队，已经在跑的照常收取结果。</p>
      ) : null}
    </div>
  );
}

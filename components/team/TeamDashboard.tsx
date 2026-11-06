'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon, type IconName } from '@/components/ui/Icon';
import { teamError } from './client';
import s from './workspace.module.css';
import TeamProductionControl from './TeamProductionControl';

type Task = { operationId: string; taskId: string; module: string; step: string; status: string; actorDisplayName: string };
type Project = { id: string; name: string; thumbnailImageUrl?: string; totalJobs: number; completedJobs: number };
type Pools = { ready: boolean; blockers: string[]; pools: Array<{ poolKey: string; capacity: number; enabled: boolean }> };
type Runtime = { proxyAvailable: boolean; cosConfigured: boolean };
const taskLabels: Record<string, string> = { pending: '等待登记', deferred: '等待中', admitted: '执行中', maybe_sent: '提交中', accepted: '已受理', reconciling: '核查中', succeeded: '已完成', failed: '失败', unknown: '待核查' };

async function read<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error(await teamError(response, '读取工作台状态失败'));
  return response.json() as Promise<T>;
}

export default function TeamDashboard({ admin, displayName, canvasEnabled }: { admin: boolean; displayName: string; canvasEnabled: boolean }) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [pools, setPools] = useState<Pools | null>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setBusy(true);
    const results = await Promise.allSettled([
      read<{ items: Task[] }>('/api/team/tasks').then(data => setTasks(data.items)),
      read<Project[]>('/api/projects').then(setProjects),
      ...(admin ? [read<Pools>('/api/team/pools').then(setPools), read<Runtime>('/api/company-provider/health').then(setRuntime)] : []),
    ]);
    setError(results.some(result => result.status === 'rejected') ? '部分状态读取失败，下面保留上次成功读取的数据。请刷新重试。' : '');
    setBusy(false);
  }, [admin]);
  useEffect(() => {
    void Promise.resolve().then(refresh);
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const stats: Array<{ label: string; statuses: string[]; icon: IconName; hint: string }> = [
    { label: '进行中的任务', statuses: ['admitted', 'maybe_sent', 'accepted'], icon: 'play-circle', hint: '服务器持续处理' },
    { label: '等待中的任务', statuses: ['pending', 'deferred'], icon: 'logs', hint: '等待执行条件就绪' },
    { label: '已完成的任务', statuses: ['succeeded'], icon: 'check-circle', hint: '成果保存在服务器' },
    { label: '待核查的提交', statuses: ['unknown', 'reconciling'], icon: 'alert', hint: '先核对结果，再决定重试' },
  ];
  const modules: Array<{ name: string; text: string; icon: IconName; href: string }> = [
    { name: '常规项目', text: '场景、分镜到成片', icon: 'film', href: '/projects/new' },
    { name: '批量生产', text: '进入项目开展批量制作', icon: 'grid', href: '/projects' },
    { name: '详情页脚本', text: '进入项目编写产品文案', icon: 'file-text', href: '/projects' },
    ...(canvasEnabled ? [{ name: '创作画布', text: '连接灵感与生成流程', icon: 'sparkle' as const, href: '/canvas' }] : []),
  ];
  return <div className={s.dashboard}>
    {admin && <TeamProductionControl />}
    <div className={s.title}><div><span className={s.eyebrow}>{admin ? 'SERVER CONSOLE / OVERVIEW' : 'CREATIVE STUDIO / WORKSPACE'}</span><h1>{admin ? '生产有序，状态清楚。' : '让今天的灵感，成为作品。'}</h1><p>{admin ? '集中查看任务、资源和异常，及时处理需要你介入的事项。' : `${displayName}，欢迎回来。从这里继续你的创作。`}</p></div>{admin ? <button className="btn-secondary btn-sm" disabled={busy} onClick={() => void refresh()}><Icon name="retry" size={14}/>{busy ? '读取中…' : '刷新状态'}</button> : <Link className="btn-primary btn-sm" href="/projects/new"><Icon name="plus" size={15}/>新建项目</Link>}</div>
    {error && <p role="alert" className="text-warn">{error}</p>}
    {admin ? <section><div className={s.stats}>{stats.map(stat => <div className={s.stat} key={stat.label}><header>{stat.label}<Icon name={stat.icon} size={17}/></header><strong>{tasks === null ? '—' : tasks.filter(task => stat.statuses.includes(task.status)).length.toString().padStart(2, '0')}</strong><small>{stat.hint}</small></div>)}</div><p className="mt-2 text-xs text-ink-tertiary">统计最近最多 500 条已登记任务；每 30 秒更新。</p></section> : <><div className={s.modules}>{modules.map(module => <Link key={module.name} href={module.href} className={s.module}><span className={s.moduleIcon}><Icon name={module.icon} size={22}/></span><div><strong>{module.name}</strong><small>{module.text}</small></div></Link>)}</div><section><div className={s.sectionHead}><h2>继续创作</h2><Link href="/projects">查看全部 →</Link></div>{projects?.length ? <div className={s.projects}>{projects.slice(0, 3).map(project => <Link key={project.id} href={`/projects/${project.id}`} className={s.project}><div className={s.projectImage}>{project.thumbnailImageUrl ? <img src={project.thumbnailImageUrl} alt=""/> : <Icon name="image" size={32}/>}</div><div className={s.projectCopy}><strong>{project.name}</strong><small>{project.completedJobs} / {project.totalJobs} 个图片任务完成</small></div></Link>)}</div> : <div className={s.panel}><p className={s.empty}>{projects === null ? '读取项目中…' : '还没有项目，从新建项目开始。'}</p></div>}</section></>}
    {admin && pools && !pools.ready && <div className={s.notice}><Icon name="alert" size={18}/><div><strong>生产资源尚未配置完成</strong><p className="text-xs text-ink-secondary">{pools.blockers.length} 项资源需求待处理，配置完成后才能使用对应生成能力。</p></div><Link href="/team/admin/pools">去配置 →</Link></div>}
    <div className={s.columns}><section className={s.panel}><div className={s.sectionHead}><h2>{admin ? '全员任务' : '正在为你生产'}</h2><Link href="/team/tasks">查看全部 →</Link></div>{tasks?.length ? tasks.slice(0, 5).map(task => <div className={s.task} key={task.operationId}><div><strong title={task.taskId}>{task.taskId}</strong><small>{task.actorDisplayName} · {task.module} / {task.step}</small></div><span>{taskLabels[task.status] ?? task.status}</span></div>) : <p className={s.empty}>{tasks === null ? '读取任务中…' : '暂无已登记的生产任务'}</p>}</section>
      <section className={s.panel}><div className={s.sectionHead}><h2>{admin ? '资源与容量' : '创作与交付'}</h2>{admin && <Link href="/team/admin/pools">管理 →</Link>}</div>{admin ? <><div className={s.resource}><span>已启用资源池</span><strong>{pools ? pools.pools.filter(pool => pool.enabled).length : '—'}</strong></div><div className={s.resource}><span>公司模型代理</span><strong>{runtime ? runtime.proxyAvailable ? '已就绪' : '未就绪' : '—'}</strong></div><div className={s.resource}><span>参考图中转 COS</span><strong>{runtime ? runtime.cosConfigured ? '已配置' : '未配置' : '—'}</strong></div><p className="mt-4 text-xs leading-6 text-ink-secondary">供应商 Key、代理和共享并发需分别配置。</p><Link className="mt-4 inline-block text-accent" href="/settings">配置供应商 →</Link></> : <><p className="text-ink-secondary leading-7">任务由服务器持续处理。你可以离开页面，稍后继续查看成果。</p><Link className="btn-secondary btn-sm mt-5" href="/projects">打开项目查看成果</Link><p className="mt-4 text-xs text-ink-tertiary">成片交付使用客户端已设置的下载目录。</p></>}</section>
    </div>
    {admin && <div className="flex justify-between text-xs text-ink-secondary"><span>按账号权限展示团队数据</span><Link href="/team/admin/operations" className="text-accent">版本与备份 →</Link></div>}
  </div>;
}

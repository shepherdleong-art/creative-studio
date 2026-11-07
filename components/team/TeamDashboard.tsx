'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Icon, type IconName } from '@/components/ui/Icon';
import { teamError } from './client';
import s from './workspace.module.css';
import TeamTaskModel, { type TeamTaskModelCall } from './TeamTaskModel';
import TeamConsoleOverview from './TeamConsoleOverview';
import { TASK_STATUS_LABELS } from '@/lib/team-task-labels';

type Task = { operationId: string; taskName: string; stepName: string; scopeName: string; scope: { resourceType: string; resourceId: string }; status: string; actorDisplayName: string; model: string | null; providerName: string; modelStatus: string; modelCalls: TeamTaskModelCall[] };
type Project = { id: string; name: string; thumbnailImageUrl?: string; totalJobs: number; completedJobs: number };
const taskLabels = TASK_STATUS_LABELS;

async function read<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error(await teamError(response, '读取工作台状态失败'));
  return response.json() as Promise<T>;
}

/**
 * 团队首页的**分流点**。
 *
 * - 管理员 → `TeamConsoleOverview`（运行总览，归 12 号票）。
 * - 员工 → 下面的 `EmployeeDashboard`（员工工作台，归 06 号票）。
 *
 * 拆成两个组件（而不是在一个组件里按 `admin` 分支）有两个原因：管理员与员工各由一张票
 * 拥有，分开后两边互不改对方的 JSX；也避免「先 return 再调 hook」这种条件 hook 写法。
 */
export default function TeamDashboard({ admin, displayName, canvasEnabled }: { admin: boolean; displayName: string; canvasEnabled: boolean }) {
  if (admin) return <TeamConsoleOverview role="admin" displayName={displayName} />;
  return <EmployeeDashboard displayName={displayName} canvasEnabled={canvasEnabled} />;
}

/** 员工工作台：内容归 06 号票，这里只保留改版前的实现，等 06 的版本替换。 */
function EmployeeDashboard({ displayName, canvasEnabled }: { displayName: string; canvasEnabled: boolean }) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setBusy(true);
    const results = await Promise.allSettled([
      read<{ items: Task[] }>('/api/team/tasks').then(data => setTasks(data.items)),
      read<Project[]>('/api/projects').then(setProjects),
    ]);
    setError(results.some(result => result.status === 'rejected') ? '部分状态读取失败，下面保留上次成功读取的数据。请刷新重试。' : '');
    setBusy(false);
  }, []);
  useEffect(() => {
    void Promise.resolve().then(refresh);
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const modules: Array<{ name: string; text: string; icon: IconName; href: string }> = [
    { name: '常规项目', text: '场景、分镜到成片', icon: 'film', href: '/projects/new' },
    { name: '批量生产', text: '进入项目开展批量制作', icon: 'grid', href: '/projects' },
    { name: '详情页脚本', text: '进入项目编写产品文案', icon: 'file-text', href: '/projects' },
    ...(canvasEnabled ? [{ name: '创作画布', text: '连接灵感与生成流程', icon: 'sparkle' as const, href: '/canvas' }] : []),
  ];
  return <div className={s.dashboard}>
    <div className={s.title}><div><span className={s.eyebrow}>CREATIVE STUDIO / WORKSPACE</span><h1>让今天的灵感，成为作品。</h1><p>{`${displayName}，欢迎回来。从这里继续你的创作。`}</p></div><Link className="btn-primary btn-sm" href="/projects/new"><Icon name="plus" size={15}/>新建项目</Link></div>
    {error && <p role="alert" className="text-warn">{error}</p>}
    <><div className={s.modules}>{modules.map(module => <Link key={module.name} href={module.href} className={s.module}><span className={s.moduleIcon}><Icon name={module.icon} size={22}/></span><div><strong>{module.name}</strong><small>{module.text}</small></div></Link>)}</div><section><div className={s.sectionHead}><h2>继续创作</h2><Link href="/projects">查看全部 →</Link></div>{projects?.length ? <div className={s.projects}>{projects.slice(0, 3).map(project => <Link key={project.id} href={`/projects/${project.id}`} className={s.project}><div className={s.projectImage}>{project.thumbnailImageUrl ? <img src={project.thumbnailImageUrl} alt=""/> : <Icon name="image" size={32}/>}</div><div className={s.projectCopy}><strong>{project.name}</strong><small>{project.completedJobs} / {project.totalJobs} 个图片任务完成</small></div></Link>)}</div> : <div className={s.panel}><p className={s.empty}>{projects === null ? '读取项目中…' : '还没有项目，从新建项目开始。'}</p></div>}</section></>
    <div className={s.columns}><section className={s.panel}><div className={s.sectionHead}><h2>正在为你生产</h2><Link href="/team/tasks">查看全部 →</Link></div>{tasks?.length ? tasks.slice(0, 5).map(task => <div className={s.task} key={task.operationId}><div><strong>{task.taskName} · {task.stepName}</strong><small>{['project', 'canvas'].includes(task.scope.resourceType) ? <Link href={task.scope.resourceType === 'project' ? `/projects/${encodeURIComponent(task.scope.resourceId)}` : `/canvas/${encodeURIComponent(task.scope.resourceId)}`}>{task.scopeName}</Link> : task.scopeName} · {task.actorDisplayName}</small><TeamTaskModel compact providerName={task.providerName} model={task.model} modelStatus={task.modelStatus} calls={task.modelCalls} /></div><span>{taskLabels[task.status] ?? task.status}</span></div>) : <p className={s.empty}>{tasks === null ? '读取任务中…' : '暂无已登记的生产任务'}</p>}</section>
      <section className={s.panel}><div className={s.sectionHead}><h2>创作与交付</h2></div><p className="text-ink-secondary leading-7">任务由服务器持续处理。你可以离开页面，稍后继续查看成果。</p><Link className="btn-secondary btn-sm mt-5" href="/projects">打开项目查看成果</Link><p className="mt-4 text-xs text-ink-tertiary">成片交付使用客户端已设置的下载目录。</p></section>
    </div>
    {busy ? <p className="text-xs text-ink-tertiary" role="status">刷新中…</p> : null}
  </div>;
}

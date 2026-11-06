import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDb } from '@/lib/db';
import { readRuntimeConfig } from '@/lib/team-service/config';
import { TEAM_SESSION_COOKIE } from '@/lib/team-service/auth/request';
import { getTeamAuthService } from '@/lib/team-service/auth/runtime';
import { getTeamErrorDiagnostic, getTeamErrorTask } from '@/lib/team-service/diagnostics';

export const dynamic = 'force-dynamic';

export default async function TeamErrorTaskPage({ params }: { params: Promise<{ id: string }> }) {
  if (readRuntimeConfig().mode !== 'server') redirect('/');
  const token = (await cookies()).get(TEAM_SESSION_COOKIE)?.value;
  const principal = token ? getTeamAuthService().resolveSession(token) : null;
  if (!principal || principal.mustChangePassword) redirect('/team/login');
  const { id } = await params;
  const viewer = { userId: principal.userId, role: principal.role };
  const error = getTeamErrorDiagnostic(getDb(), viewer, id);
  const tasks = getTeamErrorTask(getDb(), viewer, id) as Array<Record<string, unknown>>;
  return <main className="mx-auto max-w-5xl space-y-6 px-6 py-8">
    <div><a className="text-sm text-accent" href={`/team/errors?errorId=${encodeURIComponent(id)}`}>← 返回错误中心</a><h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink">关联制作任务</h1><p className="mt-2 text-sm text-ink-secondary">{error.safeMessage}</p></div>
    <section className="card space-y-4 p-5">{tasks.map((task) => <article key={`${String(task.operationId)}:${String(task.attemptId)}`} className="border-b border-hairline pb-4 last:border-0 last:pb-0"><h2 className="font-medium text-ink">{String(task.module)} / {String(task.step)}</h2><dl className="mt-3 grid gap-3 text-sm text-ink-secondary sm:grid-cols-2"><div><dt className="text-xs text-ink-tertiary">实际模型</dt><dd>{String(task.model ?? '未记录')}</dd></div><div><dt className="text-xs text-ink-tertiary">任务轮次</dt><dd>第 {String(task.businessAttemptNo)} 轮</dd></div><div><dt className="text-xs text-ink-tertiary">执行记录</dt><dd className="break-all font-mono text-xs">{String(task.operationId)}</dd></div><div><dt className="text-xs text-ink-tertiary">执行尝试</dt><dd className="break-all font-mono text-xs">{String(task.attemptId ?? '未记录')}</dd></div><div><dt className="text-xs text-ink-tertiary">输入版本</dt><dd>{String(task.inputRevision)}</dd></div><div><dt className="text-xs text-ink-tertiary">终态</dt><dd>{String(task.terminalState ?? '尚无终态')}</dd></div></dl></article>)}</section>
  </main>;
}

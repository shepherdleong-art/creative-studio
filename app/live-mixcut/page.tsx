'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface LiveMixcutProject {
  id: string;
  name: string;
  productName: string;
  createdAt: string;
}

type ProjectResponse = { project?: LiveMixcutProject; projects?: LiveMixcutProject[]; message?: string };

function formatCompactTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function readProjectResponse(response: Response, fallback: string): Promise<ProjectResponse> {
  const body = await response.json().catch(() => ({})) as ProjectResponse;
  if (!response.ok) throw new Error(body.message || fallback);
  return body;
}

export default function LiveMixcutListPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<LiveMixcutProject[]>([]);
  const [name, setName] = useState('');
  const [productName, setProductName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/live-mixcut/projects', { cache: 'no-store' });
      const body = await readProjectResponse(response, '任务列表加载失败。');
      setProjects(body.projects ?? []);
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '任务列表加载失败。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // load() 的 setState 都在 await 之后，不是同步级联渲染。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const create = useCallback(async () => {
    if (!name.trim() || !productName.trim()) return;
    setCreating(true);
    setMessage(null);
    try {
      const response = await fetch('/api/live-mixcut/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), productName: productName.trim() }),
      });
      const body = await readProjectResponse(response, '任务创建失败。');
      if (!body.project) throw new Error('任务创建失败。');
      router.push(`/live-mixcut/${body.project.id}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '任务创建失败。');
      setCreating(false);
    }
  }, [name, productName, router]);

  const remove = useCallback(async (project: LiveMixcutProject) => {
    if (!window.confirm(`确定删除任务「${project.name}」吗？制作记录和导出文件会保留。`)) return;
    setDeletingId(project.id);
    setMessage(null);
    try {
      const response = await fetch(`/api/live-mixcut/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
      await readProjectResponse(response, '任务删除失败。');
      setProjects(current => current.filter(item => item.id !== project.id));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '任务删除失败。');
    } finally {
      setDeletingId(null);
    }
  }, []);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[1.6rem] font-semibold tracking-tight text-ink">实拍混剪</h1>
      </header>

      <form
        className="card flex flex-wrap items-center gap-2 p-2 pl-4"
        data-testid="create-live-mixcut"
        onSubmit={(event) => { event.preventDefault(); void create(); }}
      >
        <input
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-tertiary"
          placeholder="任务名，例如：PS866 实拍首批"
          aria-label="任务名"
          value={name}
          data-testid="new-live-mixcut-name"
          onChange={(event) => setName(event.target.value)}
        />
        <input
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-tertiary"
          placeholder="产品名，例如：PS866 沙发"
          aria-label="产品名"
          value={productName}
          data-testid="new-live-mixcut-product"
          onChange={(event) => setProductName(event.target.value)}
        />
        <button
          type="submit"
          className="btn-primary btn-sm"
          data-testid="create-live-mixcut-button"
          disabled={creating || !name.trim() || !productName.trim()}
        >{creating ? '创建中…' : '创建'}</button>
      </form>

      <section data-testid="live-mixcut-list">
        {message && <p className="mb-4 rounded-xl bg-warn/10 px-4 py-3 text-sm text-warn" role="alert">{message}</p>}
        {loading ? (
          <div className="py-10 text-center text-ink-tertiary">
            <div className="mx-auto mb-2 h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            加载中…
          </div>
        ) : projects.length === 0 ? (
          <div className="py-14 text-center">
            <h3 className="mb-2 text-lg font-medium text-ink">还没有实拍混剪任务</h3>
            <p className="text-sm text-ink-tertiary">先在上方填写任务名和产品名，创建一个任务</p>
          </div>
        ) : (
          <div className="card overflow-hidden p-0">
            {projects.map(project => (
              <div
                key={project.id}
                className="flex flex-wrap items-center gap-3 border-b border-hairline-soft px-4 py-3 last:border-b-0"
                data-testid={`live-mixcut-item-${project.id}`}
              >
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-sm font-medium text-ink" title={project.name}>{project.name}</h2>
                  <p className="mt-1 text-xs text-ink-secondary">{project.productName} · {formatCompactTime(project.createdAt)}</p>
                </div>
                <Link href={`/live-mixcut/${project.id}`} className="btn-secondary btn-sm">打开</Link>
                <button
                  type="button"
                  className="btn-secondary btn-sm text-fail"
                  disabled={deletingId !== null}
                  onClick={() => { void remove(project); }}
                >{deletingId === project.id ? '删除中…' : '删除'}</button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

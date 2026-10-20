'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { ProductionView, ProductionTask } from '@/lib/final-edit/reassembled/production-types';

const statuses = { queued: '待提交', running: '生成中', succeeded: '已完成', failed: '失败', cancelled: '已取消' };
const kinds = { scene: '场景', shot: '分镜', script: '脚本', video: '视频' };

/** Progress and completed results inside the existing five-step project, never an executor. */
export function ReassembledProductionStatus({ projectId, tab }: { projectId: string; tab: string }) {
  const searchParams = useSearchParams();
  const [productions, setProductions] = useState<ProductionView[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!window.desktopBridge) return;
    let stopped = false;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const response = await fetch(`/api/reassembled-films/productions?projectId=${encodeURIComponent(projectId)}`, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('制作进度暂时无法读取，已同步素材仍保留');
        const result = await response.json();
        if (!stopped) { setProductions(result); setError(''); }
      } catch (error) { if (!stopped) setError(error instanceof Error ? error.message : String(error)); }
    };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 4000);
    return () => { stopped = true; controller.abort(); clearInterval(timer); };
  }, [projectId]);
  if (!productions.length) return null;
  const selectedGroup = searchParams.get('filmGroup');
  const films = productions.flatMap(production => production.films);
  if (selectedGroup && films.some(film => film.groupId === selectedGroup && film.bindingId)) {
    return <nav className="my-3 text-sm" aria-label="实拍成片批次导航">
      <a className="text-accent" href={`/projects/${projectId}?tab=final-edit`}>返回成片总览（{films.length} 条）</a>
    </nav>;
  }
  const selectedKind = tab === 'storyboard' ? 'shot' : tab;
  const mediaStyle = { maxWidth: 180, maxHeight: 180, borderRadius: 8, objectFit: 'contain' as const };
  const matches = (task: ProductionTask) => selectedKind === 'final-edit' || task.kind === selectedKind;
  return <section className="card my-4 p-4" aria-label="实拍重组制作进度">
    <h3 className="font-semibold">实拍重组制作进度</h3>
    <p className="text-sm text-ink-secondary">生成由制作任务执行；此处展示已同步的进度和结果。成片就绪后可进入第五步修改。</p>
    {error && <p role="status">{error}</p>}
    {productions.flatMap(production => production.films.map(film => <details key={film.id} open={production.films.length === 1} data-testid={`production-${film.key}`} className="my-3">
      <summary>{film.key} · {film.title} · {film.bindingId ? '成片可编辑' : film.conflict ? '检测到人工修改' : `已完成 ${film.snapshot.tasks.filter(t => t.status === 'succeeded').length}/${film.snapshot.tasks.length}`}</summary>
      {film.conflict && <p role="alert">工作台已有人工修改，自动同步已受保护。请核对当前内容，不能用旧制作结果覆盖。</p>}
      {/* Mixcut reads its initial film selection on mount; reset the page when selecting a production film. */}
      {film.bindingId && <a className="btn-secondary" href={`/projects/${projectId}?tab=final-edit&filmGroup=${film.groupId}&filmShotSet=${film.shotSetId}`}>编辑这条成片</a>}
      <div className="flex flex-wrap gap-3 my-3">
        {film.snapshot.tasks.filter(matches).map(task => <div key={task.id} className="rounded-lg border p-2" style={{ borderColor: 'var(--color-border)' }}>
          <p>{kinds[task.kind]} {task.clipId || ''} · {statuses[task.status]}</p>
          {task.status === 'succeeded' && task.outputFile && film.images[task.outputFile] && <a href={film.images[task.outputFile]} target="_blank" rel="noreferrer">
            {/* Local generated images have no fixed dimensions; retain their actual ratio. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={film.images[task.outputFile]} alt={`${film.key} ${task.clipId || '场景'} 同步结果`} style={mediaStyle} />
          </a>}
          {task.status === 'succeeded' && film.videos[task.id] && <video controls preload="metadata" src={film.videos[task.id]} style={mediaStyle} />}
        </div>)}
      </div>
      {(tab === 'script' || tab === 'final-edit') && film.snapshot.script && <div><h4>制作脚本</h4><p className="whitespace-pre-wrap">{film.snapshot.script.narration}</p></div>}
    </details>))}
  </section>;
}

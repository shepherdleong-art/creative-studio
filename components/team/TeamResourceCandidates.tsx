'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { teamError, teamWrite } from './client';

export interface TeamResourceCandidate {
  resourceType: 'video_prompt_template' | 'title_preset' | 'lut' | 'bgm' | 'script_catalog_revision' | 'viral_template_revision';
  resourceId: string;
  typeLabel: string;
  name: string;
  preview: string;
  sourceInfo: string;
  published: boolean;
  previouslyPublished: boolean;
  currentRevisionId: string | null;
  revisionNumber: number | null;
  entryCount: number | null;
  sourceFilename: string;
  parseStatus: 'ready' | 'failed';
  settingsHref: string;
}

export default function TeamResourceCandidates() {
  const [candidates, setCandidates] = useState<TeamResourceCandidate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function refresh() {
    const response = await fetch('/api/team/public-resources', { cache: 'no-store' });
    if (!response.ok) throw new Error(await teamError(response, '候选资源读取失败'));
    const body = await response.json() as { candidates: TeamResourceCandidate[] };
    setCandidates(body.candidates);
  }

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/team/public-resources', { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(await teamError(response, '候选资源读取失败'));
        return response.json() as Promise<{ candidates: TeamResourceCandidate[] }>;
      })
      .then(body => { if (!controller.signal.aborted) setCandidates(body.candidates); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '候选资源读取失败'); })
      .finally(() => { if (!controller.signal.aborted) setLoaded(true); });
    return () => controller.abort();
  }, []);

  async function publish(candidate: TeamResourceCandidate) {
    setBusyId(candidate.resourceId);
    setError('');
    setNotice('');
    try {
      const response = await teamWrite('/api/team/public-resources', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceType: candidate.resourceType, resourceId: candidate.resourceId, baseRevisionId: candidate.currentRevisionId }),
      });
      const body = await response.json() as { alreadyPublished?: boolean };
      if (!response.ok) throw new Error(await teamError(response, '发布失败，请刷新后重试'));
      await refresh();
      setNotice(body.alreadyPublished ? `「${candidate.name}」此前已发布，无需重复操作。` : `「${candidate.name}」已发布给团队，员工现在可以在制作入口选用。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '发布失败，请刷新后重试');
    } finally {
      setBusyId('');
    }
  }

  return <section className="card p-6" aria-labelledby="resource-candidates-heading">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 id="resource-candidates-heading" className="text-lg font-semibold text-ink">已有资源候选</h2>
        <p className="mt-2 text-sm leading-6 text-ink-secondary">这里直接读取设置和项目中已有的受管资源。选中名称并显式发布，无需复制文件或填写资源 ID。</p>
      </div>
      <button className="btn-secondary btn-sm" type="button" disabled={!loaded || Boolean(busyId)} onClick={() => void refresh().catch(cause => setError(cause instanceof Error ? cause.message : '刷新失败'))}>刷新候选</button>
    </div>
    {error && <p role="alert" className="mt-4 text-sm text-fail">{error}</p>}
    {notice && <p role="status" className="mt-4 text-sm text-ok">{notice}</p>}
    {!loaded && <p role="status" className="mt-6 text-sm text-ink-secondary">正在读取已有资源…</p>}
    {loaded && !candidates.length && <div className="mt-6 rounded-xl bg-surface-subtle p-5 text-sm text-ink-secondary">
      暂无可发布资源。请先到 <Link className="text-accent underline underline-offset-4" href="/settings?section=motion-template">设置中的视频提示词模板</Link> 创建资源，或在 <Link className="text-accent underline underline-offset-4" href="/settings?section=script-knowledge">脚本知识与模板</Link> 上传知识库／模板；标题与 LUT 可在相应制作入口保存／上传，再返回这里发布。
    </div>}
    <div className="mt-5 divide-y divide-hairline" role="list" aria-label="已有资源候选列表">
      {candidates.map(candidate => <article role="listitem" key={`${candidate.resourceType}:${candidate.resourceId}`} className="grid gap-4 py-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-surface-subtle px-2.5 py-1 text-xs text-ink-secondary">{candidate.typeLabel}</span>
            <span className={`text-xs ${candidate.published ? 'text-ok' : 'text-ink-tertiary'}`}>{candidate.published ? '团队当前版本' : candidate.previouslyPublished ? '历史已发布' : '待发布'}</span>
            {candidate.revisionNumber !== null && <span className="text-xs text-ink-secondary">v{candidate.revisionNumber} · {candidate.entryCount ?? 0} 条</span>}
          </div>
          <h3 className="mt-2 break-words font-medium text-ink">{candidate.name}</h3>
          <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-sm leading-6 text-ink-secondary">{candidate.preview}</p>
          <p className="mt-1 break-all text-xs text-ink-tertiary">{candidate.sourceInfo}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link className="text-sm text-accent underline underline-offset-4" href={candidate.settingsHref}>管理资源</Link>
          {!candidate.published && candidate.parseStatus === 'ready' && <button className="btn-primary btn-sm" type="button" disabled={Boolean(busyId)} onClick={() => void publish(candidate)}>{busyId === candidate.resourceId ? '正在发布…' : candidate.previouslyPublished ? '重新发布此版本' : '发布给团队'}</button>}
        </div>
      </article>)}
    </div>
    <p className="mt-4 text-xs leading-5 text-ink-tertiary">知识库、脚本模板库与爆文模板按完整版本发布：库、修订、条目和参考素材一次生效，旧任务继续使用冻结输入。若其他管理员已切换版本，请刷新候选并确认后再发布。BGM 的上传与试听沿用下方既有公共音乐库。</p>
  </section>;
}

'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { PublicResourceCandidate } from '@/lib/team-service/resource-candidates';
import { teamError, teamWrite } from './client';
import { EmptyState, StatusDot, Tag, ToolbarButton } from '@/components/ui/Appearance';

export type TeamResourceCandidate = PublicResourceCandidate;
const PAGE_SIZE = 20;
const CATEGORIES = ['视频提示词模板', '标题预设', '产品策略知识库', '脚本模板库', '爆文模板', 'LUT', 'BGM'];
type ResourceAction = 'publish' | 'withdraw' | 'trash';

/**
 * 资源分类与发布（团队版）。14 号票只换外观：分类折叠、分页与逐项操作
 * 的结构不动，标签、状态点、按钮与空状态换成 02 号票的共用部件。
 */
export default function TeamResourceCandidates({ refreshKey = 0 }: { refreshKey?: number }) {
  const [candidates, setCandidates] = useState<TeamResourceCandidate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  async function refresh() {
    const response = await fetch('/api/team/public-resources', { cache: 'no-store' });
    if (!response.ok) throw new Error(await teamError(response, '资源读取失败'));
    const body = await response.json() as { candidates: TeamResourceCandidate[] };
    setCandidates(body.candidates);
    setError('');
  }

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/team/public-resources', { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(await teamError(response, '资源读取失败'));
        return response.json() as Promise<{ candidates: TeamResourceCandidate[] }>;
      })
      .then(body => { if (!controller.signal.aborted) { setCandidates(body.candidates); setError(''); } })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '资源读取失败'); })
      .finally(() => { if (!controller.signal.aborted) setLoaded(true); });
    return () => controller.abort();
  }, [refreshKey]);

  async function update(candidate: TeamResourceCandidate, action: ResourceAction) {
    if (action === 'withdraw' && !window.confirm(`撤回「${candidate.name}」的团队发布？撤回后成员不能在新创作中选用，可稍后重新发布。`)) return;
    if (action === 'trash' && !window.confirm(`将「${candidate.name}」移入回收站？它将从资源列表中隐藏，可在回收站恢复。`)) return;
    setBusyId(`${candidate.resourceType}:${candidate.resourceId}`);
    setError(''); setNotice('');
    try {
      const response = await teamWrite('/api/team/public-resources', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, resourceType: candidate.resourceType, resourceId: candidate.resourceId, baseRevisionId: candidate.currentRevisionId }),
      });
      if (!response.ok) throw new Error(await teamError(response, '操作失败，请刷新后重试'));
      await refresh();
      setNotice(`「${candidate.name}」${action === 'publish' ? '已发布给团队' : action === 'withdraw' ? '已撤回发布，可重新发布' : '已移入回收站，可在那里恢复'}。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请刷新后重试');
    } finally { setBusyId(''); }
  }

  const query = search.trim().toLocaleLowerCase();
  const filtered = candidates.filter(candidate =>
    (!query || `${candidate.name} ${candidate.sourceFilename} ${candidate.preview}`.toLocaleLowerCase().includes(query))
    && (status === 'all' || candidate.published === (status === 'published')));
  const categories = [...new Set([...CATEGORIES, ...candidates.map(candidate => candidate.typeLabel)])];

  return <section className="card p-5" aria-labelledby="resource-candidates-heading">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 id="resource-candidates-heading" className="text-[15px] font-semibold text-ink">资源分类</h2>
        <p className="mt-1.5 text-[13px] leading-6 text-ink-secondary">共 {candidates.length} 项资源。展开分类后可试听、发布或撤回；移入回收站的资源可以恢复。</p>
      </div>
      <ToolbarButton icon="retry" disabled={!loaded || Boolean(busyId)} onClick={() => void refresh().catch(cause => setError(cause instanceof Error ? cause.message : '刷新失败'))}>刷新资源</ToolbarButton>
    </div>
    <div className="mt-4 flex flex-wrap gap-3">
      <input aria-label="搜索公共资源" className="input-field min-w-0 flex-1" placeholder="搜索名称、文件名或内容" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} />
      <select aria-label="发布状态" className="input-field w-auto" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}>
        <option value="all">全部状态</option><option value="published">已发布</option><option value="unpublished">未发布 / 已撤回</option>
      </select>
    </div>
    {error && <p role="alert" className="mt-3 text-[13px] text-fail">{error}</p>}
    {notice && <p role="status" className="mt-3 flex items-center gap-2 text-[13px] text-ok"><StatusDot tone="ok" />{notice}</p>}
    {!loaded && <p role="status" className="mt-4 text-[13px] text-ink-secondary">正在读取资源…</p>}
    {loaded && !filtered.length && <EmptyState
      icon="image"
      title={candidates.length ? '没有匹配的资源，请调整搜索或发布状态。' : '暂无资源。可在设置中创建模板或上传知识库，也可在下方添加 BGM。'}
    />}
    <div className="mt-4 space-y-3">
      {categories.map((category, index) => {
        const items = filtered.filter(candidate => candidate.typeLabel === category);
        const total = candidates.filter(candidate => candidate.typeLabel === category).length;
        if (!total || (!items.length && (query || status !== 'all'))) return null;
        const open = expanded === category;
        const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
        const currentPage = Math.min(page, pages);
        return <div key={category} className="overflow-hidden rounded-[11px] border border-hairline">
          <button type="button" className="flex w-full items-center justify-between gap-4 bg-group px-4 py-3 text-left" aria-expanded={open} aria-controls={`resource-category-${index}`} onClick={() => { setExpanded(open ? null : category); setPage(1); }}>
            <span className="text-[13px] font-medium text-ink">{category} <span className="ml-2 text-[12px] font-normal text-ink-secondary">{items.length} 项 · 已发布 {items.filter(item => item.published).length} 项</span></span>
            <span className="text-[12px] text-ink-secondary">{open ? '收起 −' : '展开 +'}</span>
          </button>
          {open && <div id={`resource-category-${index}`} className="px-4">
            <div className="divide-y divide-hairline" role="list" aria-label={`${category}资源列表`}>
              {items.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE).map(candidate => <article role="listitem" key={`${candidate.resourceType}:${candidate.resourceId}`} className="grid gap-3 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="break-words text-[13px] font-medium text-ink">{candidate.name}</h3>
                    <Tag tone={candidate.published ? 'ok' : 'idle'}>{candidate.published ? '已发布' : candidate.previouslyPublished ? '历史版本 / 已撤回' : '未发布'}</Tag>
                    {candidate.revisionNumber !== null && <span className="tnum text-[12px] text-ink-secondary">v{candidate.revisionNumber} · {candidate.entryCount ?? 0} 条</span>}
                  </div>
                  {candidate.resourceType === 'bgm' ? <audio controls preload="none" aria-label={`试听 ${candidate.name}`} src={`/api/final-edit-bgm/${encodeURIComponent(candidate.resourceId)}/file`} className="mt-2 h-9 max-w-full" /> : <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-[13px] leading-6 text-ink-secondary">{candidate.preview}</p>}
                  {candidate.resourceType !== 'bgm' && <p className="mt-1 break-all text-[12px] text-ink-tertiary">{candidate.sourceInfo}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {candidate.resourceType !== 'bgm' && <Link className="text-[13px] text-accent underline underline-offset-4" href={candidate.settingsHref}>管理资源</Link>}
                  {candidate.published ? <ToolbarButton disabled={Boolean(busyId)} onClick={() => void update(candidate, 'withdraw')}>撤回发布</ToolbarButton> : candidate.parseStatus === 'ready' && <ToolbarButton variant="primary" disabled={Boolean(busyId)} onClick={() => void update(candidate, 'publish')}>发布给团队</ToolbarButton>}
                  {candidate.revisionNumber === null && <ToolbarButton icon="trash" disabled={Boolean(busyId)} onClick={() => void update(candidate, 'trash')}>移入回收站</ToolbarButton>}
                </div>
              </article>)}
            </div>
            {pages > 1 && <nav aria-label={`${category}分页`} className="flex flex-wrap items-center justify-end gap-3 border-t border-hairline py-3 text-[12px] text-ink-secondary">
              <span className="tnum">第 {currentPage} / {pages} 页 · 每页 {PAGE_SIZE} 项</span>
              <ToolbarButton disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>上一页</ToolbarButton>
              <ToolbarButton disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>下一页</ToolbarButton>
            </nav>}
          </div>}
        </div>;
      })}
    </div>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <p className="text-[12px] leading-5 text-ink-tertiary">知识库与模板库按完整版本发布或撤回，保留历史版本供已有任务追溯。若其他管理员已切换版本，请刷新后操作。</p>
    </div>
  </section>;
}

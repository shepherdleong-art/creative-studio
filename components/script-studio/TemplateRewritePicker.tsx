'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';

/**
 * 爆文模板勾选（迁移方案 §3.1.4）：
 * - 系统按卖点库本地推荐（同类目优先 + 关键词命中），展示真实命中原因；
 * - 用户能看标题、参考全文、类目，勾选 1–6 个；可搜索其他可用模板；
 * - 不自动替用户提交生成；勾选数量即生成数量（每个模板一条）。
 */

export interface ViralTemplateEntryView {
  id: string;
  sourceTemplateId: string;
  category: string;
  subCategory: string;
  name: string;
  title: string;
  refText: string;
  structure: string;
  structureOrigin: 'source' | 'fallback';
  status: 'usable' | 'unusable' | 'review';
  statusReason: string;
}

interface RecommendationView {
  entry: ViralTemplateEntryView;
  score: number;
  reasons: string[];
}

function TemplateCard({
  entry,
  reasons,
  checked,
  disabled,
  onToggle,
}: {
  entry: ViralTemplateEntryView;
  reasons?: string[];
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const [showFull, setShowFull] = useState(false);
  return (
    <label className={`block rounded-[14px] border p-3 text-sm transition-colors ${checked ? 'border-accent bg-accent/[0.04]' : 'border-hairline bg-surface'} ${disabled && !checked ? 'opacity-55' : ''}`}>
      <span className="flex items-start gap-2.5">
        <input type="checkbox" className="mt-1" checked={checked} disabled={disabled && !checked} onChange={onToggle} aria-label={`选择模板：${entry.name || entry.title}`} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold">{entry.name || entry.title || entry.sourceTemplateId}</span>
            {entry.category && <span className="rounded-full bg-surface-subtle px-2 py-0.5 text-[0.62rem] text-ink-secondary">{entry.category}{entry.subCategory ? ` · ${entry.subCategory}` : ''}</span>}
            {entry.structureOrigin === 'fallback' && <span className="rounded-full bg-surface-subtle px-2 py-0.5 text-[0.62rem] text-ink-tertiary" title="表格未提供结构，使用默认结构">结构默认</span>}
          </span>
          {entry.title && entry.title !== entry.name && <span className="mt-0.5 block text-xs text-ink-secondary">{entry.title}</span>}
          {reasons && reasons.length > 0 && (
            <span className="mt-1 flex flex-wrap gap-1">
              {reasons.map((reason) => (
                <span key={reason} className="rounded-full bg-ok-tint px-2 py-0.5 text-[0.62rem] font-semibold text-ok">{reason}</span>
              ))}
            </span>
          )}
          <button
            type="button"
            className="mt-1.5 text-xs text-accent"
            onClick={(event) => { event.preventDefault(); setShowFull((current) => !current); }}
          >
            {showFull ? '收起参考文案' : '查看参考全文'}
          </button>
          {showFull && (
            <pre className="mt-1.5 max-h-44 overflow-y-auto whitespace-pre-wrap rounded-[10px] bg-surface-subtle p-2.5 text-xs leading-5 text-ink-secondary">{entry.refText}</pre>
          )}
        </span>
      </span>
    </label>
  );
}

export default function TemplateRewritePicker({
  projectId,
  libraryRevisionId,
  selectedIds,
  onChange,
  disabled,
}: {
  projectId: string;
  libraryRevisionId: string;
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const [recommendations, setRecommendations] = useState<RecommendationView[]>([]);
  const [usableCount, setUsableCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ViralTemplateEntryView[] | null>(null);
  const [expandBeyond, setExpandBeyond] = useState(false);

  const loadRecommend = useCallback(async (expand: boolean) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/projects/${projectId}/script-studio/viral-template-recommend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expandBeyondCategory: expand, limit: 12 }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string; recommendations?: RecommendationView[]; usableCount?: number };
      if (!res.ok) throw new Error(body.message || `推荐加载失败：HTTP ${res.status}`);
      setRecommendations(Array.isArray(body.recommendations) ? body.recommendations : []);
      setUsableCount(Number(body.usableCount ?? 0));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!libraryRevisionId) return;
    // 延迟到宏任务执行，避免 effect 内同步 setState 触发级联渲染。
    const timer = window.setTimeout(() => { void loadRecommend(expandBeyond); }, 0);
    return () => window.clearTimeout(timer);
  }, [libraryRevisionId, expandBeyond, loadRecommend]);

  const search = useCallback(async (q: string) => {
    if (!q.trim()) {
      setSearchResults(null);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/script-studio/viral-templates/entries?status=usable&q=${encodeURIComponent(q.trim())}&limit=30`);
      const body = (await res.json().catch(() => ({}))) as { message?: string; entries?: ViralTemplateEntryView[] };
      if (!res.ok) throw new Error(body.message || `搜索失败：HTTP ${res.status}`);
      setSearchResults(Array.isArray(body.entries) ? body.entries : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  const toggle = (id: string) => {
    if (disabled) return;
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((item) => item !== id));
    } else if (selectedIds.length < 6) {
      onChange([...selectedIds, id]);
    }
  };

  const recommendedIds = useMemo(() => new Set(recommendations.map((item) => item.entry.id)), [recommendations]);
  const selectedEntries = useMemo(() => {
    const all = [...recommendations.map((item) => item.entry), ...(searchResults ?? [])];
    return selectedIds
      .map((id) => all.find((entry) => entry.id === id))
      .filter((entry): entry is ViralTemplateEntryView => Boolean(entry));
  }, [selectedIds, recommendations, searchResults]);

  if (!libraryRevisionId) {
    return <p className="rounded-[14px] bg-surface-subtle p-4 text-sm text-ink-tertiary">需要先有卖点库（从详情页提取或复用已有），才能推荐匹配的爆文模板。</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-ink-secondary">
          已选 <strong className={selectedIds.length > 0 ? 'text-accent' : ''}>{selectedIds.length}</strong> / 6 个模板，每个生成 1 条脚本
        </p>
        <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
          <input type="checkbox" checked={expandBeyond} onChange={(event) => setExpandBeyond(event.target.checked)} disabled={disabled} />
          类目不足时扩大搜索
        </label>
      </div>

      {selectedEntries.length > 0 && (
        <div className="space-y-2">
          <p className="text-[0.7rem] font-semibold text-ink-tertiary">已勾选（按生成顺序）</p>
          {selectedEntries.map((entry, index) => (
            <div key={entry.id} className="flex items-center justify-between gap-2 rounded-[12px] border border-accent/40 bg-accent/[0.04] px-3 py-2 text-sm">
              <span className="min-w-0 truncate">
                <span className="mr-2 text-[0.65rem] font-bold text-accent">{index + 1}.</span>
                {entry.name || entry.title}
              </span>
              <button type="button" className="shrink-0 text-xs text-ink-tertiary hover:text-fail" disabled={disabled} onClick={() => toggle(entry.id)}>移除</button>
            </div>
          ))}
        </div>
      )}

      {error && <p className="rounded-[12px] bg-fail/[0.04] p-3 text-xs text-fail">{error}</p>}
      {loading && <p className="text-xs text-ink-tertiary">加载模板…</p>}

      {!loading && searchResults === null && (
        <>
          {recommendations.length === 0 ? (
            <p className="rounded-[14px] bg-surface-subtle p-4 text-sm text-ink-tertiary">
              当前卖点库与模板库没有匹配项{usableCount > 0 ? `（库内共 ${usableCount} 个可用模板）` : ''}。可用搜索查找其他模板，或勾选「类目不足时扩大搜索」。
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-[0.7rem] font-semibold text-ink-tertiary">推荐模板（按卖点库本地匹配，原因如实展示）</p>
              {recommendations.map((item) => (
                <TemplateCard
                  key={item.entry.id}
                  entry={item.entry}
                  reasons={item.reasons}
                  checked={selectedIds.includes(item.entry.id)}
                  disabled={Boolean(disabled) || (selectedIds.length >= 6 && !selectedIds.includes(item.entry.id))}
                  onToggle={() => toggle(item.entry.id)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {searchResults !== null && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[0.7rem] font-semibold text-ink-tertiary">搜索结果（{searchResults.length}）</p>
            <button type="button" className="text-xs text-accent" onClick={() => { setQuery(''); setSearchResults(null); }}>返回推荐</button>
          </div>
          {searchResults.length === 0 && <p className="text-xs text-ink-tertiary">没有匹配的可用模板。</p>}
          {searchResults.map((entry) => (
            <TemplateCard
              key={entry.id}
              entry={entry}
              reasons={recommendedIds.has(entry.id) ? recommendations.find((item) => item.entry.id === entry.id)?.reasons : undefined}
              checked={selectedIds.includes(entry.id)}
              disabled={Boolean(disabled) || (selectedIds.length >= 6 && !selectedIds.includes(entry.id))}
              onToggle={() => toggle(entry.id)}
            />
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void search(query); }}
          placeholder="搜索模板名称 / 标题 / 参考文案 / 类目"
          className="input-field h-9 text-xs"
          disabled={disabled}
        />
        <button type="button" className="btn-secondary btn-sm shrink-0" disabled={disabled || loading} onClick={() => void search(query)}>
          <Icon name="search" size={13} /> 搜索
        </button>
      </div>
    </div>
  );
}

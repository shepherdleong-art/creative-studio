'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { describeTemplateSelection, setTemplateEntryCount, toggleTemplateEntry } from '@/lib/script-studio/panel-rules';

/**
 * 爆文模板勾选（迁移方案 §3.1.4 + 2026-09-17 流程修正 + 08 号票改版）：
 * - 系统按卖点库本地推荐（同类目优先 + 关键词命中），展示真实命中原因；
 * - 用户能看标题、参考全文、类目，勾选 1–6 个；可搜索其他可用模板；
 * - 每个模板可选生成 1 条或多条变体，全部模板合计不超过 6 条；
 * - 不自动替用户提交生成；对外 selectedIds 为展开数组（同一 id 重复 = 该模板条数）。
 *
 * 08 号票（V11）：规格要求「模板的参考文案、结构和匹配原因直接显示，长文能展开全文」。
 * 所以卡片里 **参考文案默认摊开**（长文截断到若干行，按钮是「展开全文 / 收起全文」），
 * 结构、匹配原因、类目也一律常显，不再需要先点开才能看到。
 */

export interface ViralTemplateEntryView {
  id: string;
  scriptCode?: string;
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
  // 参考文案默认摊开：长文先用 4 行截断，按钮只负责「展开全文 / 收起全文」。
  const [showFull, setShowFull] = useState(false);
  const refText = entry.refText?.trim() || '';
  const longRef = refText.length > 100;
  const structureText = entry.structure?.trim()
    ? entry.structure.trim()
    : (entry.structureOrigin === 'fallback' ? '默认（表格未提供）' : '');
  return (
    <label
      className={`block rounded-[14px] border p-3 text-sm transition-colors ${checked ? 'border-accent bg-accent/[0.04]' : 'border-hairline bg-surface'} ${disabled && !checked ? 'opacity-55' : ''}`}
      data-testid="viral-template-card"
    >
      <span className="flex items-start gap-2.5">
        <input type="checkbox" className="mt-1" checked={checked} disabled={disabled && !checked} onChange={onToggle} aria-label={`选择模板：${entry.name || entry.title}`} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold">{entry.scriptCode ? `${entry.scriptCode.toLowerCase()} · ` : ''}{entry.name || entry.title || entry.sourceTemplateId}</span>
            {entry.category && <span className="rounded-full bg-surface-subtle px-2 py-0.5 text-[0.62rem] text-ink-secondary">{entry.category}{entry.subCategory ? ` · ${entry.subCategory}` : ''}</span>}
            {entry.structureOrigin === 'fallback' && <span className="rounded-full bg-surface-subtle px-2 py-0.5 text-[0.62rem] text-ink-tertiary" title="表格未提供结构，使用默认结构">结构默认</span>}
          </span>
          {entry.title && entry.title !== entry.name && <span className="mt-0.5 block text-xs text-ink-secondary">{entry.title}</span>}

          {/* 结构：常显，不用点开。 */}
          <span className="mt-1 block text-[0.68rem] text-ink-secondary" data-testid="viral-template-structure">
            <span className="font-semibold text-ink">结构</span>：{structureText || '未提供'}
          </span>

          {/* 匹配原因：常显，如实展示命中项。 */}
          {reasons && reasons.length > 0 && (
            <span className="mt-1 flex flex-wrap gap-1" data-testid="viral-template-reasons">
              {reasons.map((reason) => (
                <span key={reason} className="rounded-full bg-ok-tint px-2 py-0.5 text-[0.62rem] font-semibold text-ok">{reason}</span>
              ))}
            </span>
          )}

          {/* 参考文案：默认摊开。长文先截断到 4 行，点按钮展开全文。 */}
          {refText ? (
            <span className="mt-1.5 block" data-testid="viral-template-ref">
              {showFull || !longRef ? (
                <span className="block max-h-44 overflow-y-auto whitespace-pre-wrap rounded-[10px] bg-surface-subtle p-2.5 text-xs leading-5 text-ink-secondary">{refText}</span>
              ) : (
                <span className="line-clamp-4 block whitespace-pre-wrap rounded-[10px] bg-surface-subtle p-2.5 text-xs leading-5 text-ink-secondary">{refText}</span>
              )}
            </span>
          ) : (
            <span className="mt-1.5 block text-[0.68rem] text-ink-tertiary" data-testid="viral-template-ref">这条模板没有参考文案。</span>
          )}
          {longRef && (
            <button
              type="button"
              className="mt-1.5 text-xs text-accent"
              aria-expanded={showFull}
              onClick={(event) => { event.preventDefault(); setShowFull((current) => !current); }}
            >
              {showFull ? '收起全文' : '展开全文'}
            </button>
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
  maxCount = 6,
}: {
  projectId: string;
  libraryRevisionId: string;
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  maxCount?: 1 | 6;
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

  /** 勾选 / 取消：合计上限沿用 `panel-rules`（现有 6 条规则），不在这里另写一份。 */
  const toggle = (id: string) => {
    if (disabled) return;
    if (maxCount === 1) {
      onChange(selectedIds.includes(id) ? [] : [id]);
      return;
    }
    onChange(toggleTemplateEntry(selectedIds, id, maxCount));
  };

  /** 调整某个模板的生成条数：保持该模板在生成顺序中的首个位置，总量不超过上限。 */
  const setCount = (id: string, nextCount: number) => {
    if (disabled) return;
    const next = setTemplateEntryCount(selectedIds, id, nextCount, maxCount);
    if (next.join('\u0000') !== selectedIds.join('\u0000')) onChange(next);
  };

  const recommendedIds = useMemo(() => new Set(recommendations.map((item) => item.entry.id)), [recommendations]);
  /** 合计条数 / 剩余可加：与面板同一份纯函数（上限 6 条沿用现有规则）。 */
  const selection = useMemo(() => describeTemplateSelection(selectedIds, maxCount), [selectedIds, maxCount]);
  /** 已勾选按模板分组（首个出现位置 = 生成顺序），count 为该模板生成条数。 */
  const selectedGroups = useMemo(() => {
    const all = [...recommendations.map((item) => item.entry), ...(searchResults ?? [])];
    const groups: Array<{ entry: ViralTemplateEntryView; count: number }> = [];
    for (const id of selectedIds) {
      const existing = groups.find((group) => group.entry.id === id);
      if (existing) {
        existing.count += 1;
        continue;
      }
      const entry = all.find((item) => item.id === id);
      if (entry) groups.push({ entry, count: 1 });
    }
    return groups;
  }, [selectedIds, recommendations, searchResults]);

  if (!libraryRevisionId) {
    return (
      <p className="rounded-[14px] bg-surface-subtle p-4 text-sm text-ink-tertiary">
        还没有卖点库。确认已添加详情页后，点击下方「分析详情页，提取卖点」；建库完成后，这里会推荐匹配的爆文模板。
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-ink-secondary" data-testid="template-selection-summary">
          已选 <strong className={selection.templateCount > 0 ? 'text-accent' : ''}>{selection.templateCount}</strong> 个模板 · 共 <strong className={selection.totalCount > 0 ? 'text-accent' : ''}>{selection.totalCount}</strong> / {maxCount} 条{maxCount === 1 ? '（为当前脚本生成一个新版本）' : '（同一模板多条生成不同变体）'}
        </p>
        <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
          <input type="checkbox" checked={expandBeyond} onChange={(event) => setExpandBeyond(event.target.checked)} disabled={disabled} />
          类目不足时扩大搜索
        </label>
      </div>

      {selectedGroups.length > 0 && (
        <div className="space-y-2">
          <p className="text-[0.7rem] font-semibold text-ink-tertiary">已勾选（按生成顺序）</p>
          {selectedGroups.map((group, index) => (
            <div key={group.entry.id} className="flex items-center justify-between gap-2 rounded-[12px] border border-accent/40 bg-accent/[0.04] px-3 py-2 text-sm">
              <span className="min-w-0 truncate">
                <span className="mr-2 text-[0.65rem] font-bold text-accent">{index + 1}.</span>
                {group.entry.scriptCode ? `${group.entry.scriptCode.toLowerCase()} · ` : ''}{group.entry.name || group.entry.title}
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <span className="flex items-center rounded-full border border-hairline bg-surface">
                  <button
                    type="button"
                    className="flex h-6 w-6 items-center justify-center text-ink-secondary disabled:opacity-35"
                    disabled={disabled || group.count <= 1}
                    onClick={() => setCount(group.entry.id, group.count - 1)}
                    aria-label={`减少「${group.entry.name || group.entry.title}」条数`}
                  >
                    −
                  </button>
                  <span className="min-w-7 text-center text-xs font-semibold tabular-nums" aria-label={`「${group.entry.name || group.entry.title}」生成条数`}>{group.count} 条</span>
                  <button
                    type="button"
                    className="flex h-6 w-6 items-center justify-center text-ink-secondary disabled:opacity-35"
                    disabled={disabled || selectedIds.length >= maxCount}
                    onClick={() => setCount(group.entry.id, group.count + 1)}
                    aria-label={`增加「${group.entry.name || group.entry.title}」条数`}
                  >
                    +
                  </button>
                </span>
                <button type="button" className="text-xs text-ink-tertiary hover:text-fail" disabled={disabled} onClick={() => toggle(group.entry.id)}>移除</button>
              </span>
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
              {usableCount === 0
                ? '暂无团队发布的爆文模板，请联系管理员发布；你无需上传或导入公共版本。'
                : `当前卖点库与模板库没有匹配项（库内共 ${usableCount} 个可用模板）。可用搜索查找其他模板，或勾选「类目不足时扩大搜索」。`}
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
                  disabled={Boolean(disabled) || (maxCount > 1 && selectedIds.length >= maxCount && !selectedIds.includes(item.entry.id))}
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
              disabled={Boolean(disabled) || (maxCount > 1 && selectedIds.length >= maxCount && !selectedIds.includes(entry.id))}
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

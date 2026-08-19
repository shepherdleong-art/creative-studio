'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import type { CoreUsageCategory, CoreUsageModelKey } from '@/lib/usage-pricing';
import type {
  UsageDashboardResult,
  UsageRecord,
  UsageRecordsResult,
} from '@/lib/usage-query';

const MODEL_KEYS: readonly CoreUsageModelKey[] = [
  'company-image2-medium',
  'company-kling-3-0',
  'company-seedance-fast',
  'company-gpt-5-6-luna',
  'doubao-seed-tts-2',
];

const MODEL_LABELS: Record<CoreUsageModelKey, string> = {
  'company-image2-medium': 'image2-medium',
  'company-kling-3-0': 'kling-3.0',
  'company-seedance-fast': 'Seedance 2.0 Fast',
  'company-gpt-5-6-luna': 'GPT-5-6-Luna-Standard',
  'doubao-seed-tts-2': 'seed-tts-2.0',
};

const MODEL_COLORS: Record<CoreUsageModelKey, string> = {
  'company-image2-medium': '#0071e3',
  'company-kling-3-0': '#8b5cf6',
  'company-seedance-fast': '#0f9d8a',
  'company-gpt-5-6-luna': '#f59e0b',
  'doubao-seed-tts-2': '#e0528b',
};

const CATEGORY_LABELS: Record<CoreUsageCategory, string> = {
  image: '图片',
  video: '视频',
  llm_text: '文本模型',
  llm_vision: '视觉模型',
  tts: '语音',
};

const NUMBER_FORMAT = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const INTEGER_FORMAT = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const YUAN_FORMAT = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 });

type UsageFilters = {
  from: string;
  to: string;
  coreModelKey: string;
  category: string;
};

type RequestError = Error & { status?: number };

function dateInputValue(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDate(dateOnly: string, days: number): string {
  const value = new Date(`${dateOnly}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function initialFilters(): UsageFilters {
  const today = dateInputValue(new Date());
  return { from: addDate(today, -29), to: today, coreModelKey: '', category: '' };
}

function buildQuery(filters: UsageFilters, page: number): string {
  const params = new URLSearchParams();
  if (filters.from) params.set('from', filters.from);
  // The UI's end date is inclusive; the API uses [from, to).
  if (filters.to) params.set('to', addDate(filters.to, 1));
  if (filters.coreModelKey) params.set('coreModelKey', filters.coreModelKey);
  if (filters.category) params.set('category', filters.category);
  params.set('page', String(page));
  params.set('pageSize', '12');
  return params.toString();
}

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: 'no-store' });
  const body = await response.json().catch(() => ({})) as { message?: string; error?: string };
  if (!response.ok) {
    const error = new Error(body.message || body.error || `请求失败（${response.status}）`) as RequestError;
    error.status = response.status;
    throw error;
  }
  return body as T;
}

function formatYuan(costMicros: number): string {
  return `¥${YUAN_FORMAT.format(Number(costMicros || 0) / 1_000_000)}`;
}

function formatQuantity(quantity: number, unit: string): string {
  return `${NUMBER_FORMAT.format(Number(quantity || 0))} ${unit || '单位'}`;
}

function formatTime(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return value;
  return timestamp.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function numericDetailValue(detail: Record<string, unknown>, names: string[]): number | undefined {
  for (const name of names) {
    const value = detail[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function tokenBreakdown(record: UsageRecord): {
  input?: number;
  output?: number;
  cached?: number;
  estimated: boolean;
} | null {
  if (record.category !== 'llm_text' && record.category !== 'llm_vision') return null;
  const detail = record.detail || {};
  const components = Array.isArray(detail.priceComponents) ? detail.priceComponents : [];
  const componentValue = (keys: string[]): number | undefined => {
    for (const component of components) {
      if (!component || typeof component !== 'object') continue;
      const row = component as Record<string, unknown>;
      if (typeof row.key === 'string' && keys.includes(row.key)) {
        const value = row.quantity ?? row.tokens ?? row.amount;
        if (typeof value === 'number' && Number.isFinite(value)) return value;
      }
    }
    return undefined;
  };
  const input = numericDetailValue(detail, ['uncachedInputTokens', 'inputTokens', 'promptTokens', 'input_token'])
    ?? componentValue(['input_token']);
  const output = numericDetailValue(detail, ['outputTokens', 'completionTokens', 'output_token'])
    ?? componentValue(['output_token']);
  const cached = numericDetailValue(detail, ['cachedReadTokens', 'cachedTokens', 'cached_input_token'])
    ?? componentValue(['cached_input_token']);
  if (input === undefined && output === undefined && cached === undefined && detail.estimated === undefined) return null;
  return {
    input,
    output,
    cached,
    estimated: detail.estimated === true,
  };
}

function TrendChart({ trend }: { trend: UsageDashboardResult['trend'] }) {
  const width = 900;
  const height = 260;
  const padding = { top: 18, right: 18, bottom: 34, left: 58 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maximum = Math.max(
    1,
    ...trend.flatMap((point) => MODEL_KEYS.map((key) => Number(point.costByModel[key] || 0))),
  );
  const hasData = trend.some((point) => point.totalCostMicros > 0);
  const xFor = (index: number) => padding.left + (trend.length <= 1 ? 0 : index / (trend.length - 1)) * plotWidth;
  const yFor = (value: number) => padding.top + plotHeight - (Math.max(0, value) / maximum) * plotHeight;

  return (
    <div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${width} ${height}`} className="h-auto min-w-[620px] w-full" role="img" aria-label="近 30 天多模型消耗趋势">
          <line x1={padding.left} x2={width - padding.right} y1={padding.top + plotHeight} y2={padding.top + plotHeight} stroke="currentColor" className="text-hairline" />
          <line x1={padding.left} x2={padding.left} y1={padding.top} y2={padding.top + plotHeight} stroke="currentColor" className="text-hairline" />
          <text x={padding.left - 8} y={padding.top + 4} textAnchor="end" className="fill-ink-tertiary text-[11px]">{formatYuan(maximum)}</text>
          <text x={padding.left - 8} y={padding.top + plotHeight + 4} textAnchor="end" className="fill-ink-tertiary text-[11px]">¥0</text>
          {trend.length > 0 && (
            <>
              <text x={xFor(0)} y={height - 9} className="fill-ink-tertiary text-[11px]">{trend[0].date.slice(5)}</text>
              <text x={xFor(trend.length - 1)} y={height - 9} textAnchor="end" className="fill-ink-tertiary text-[11px]">{trend[trend.length - 1].date.slice(5)}</text>
            </>
          )}
          {MODEL_KEYS.map((key) => {
            const values = trend.map((point) => Number(point.costByModel[key] || 0));
            if (!values.some((value) => value > 0)) return null;
            return (
              <polyline
                key={key}
                fill="none"
                stroke={MODEL_COLORS[key]}
                strokeWidth="3"
                strokeLinejoin="round"
                strokeLinecap="round"
                points={values.map((value, index) => `${xFor(index)},${yFor(value)}`).join(' ')}
              />
            );
          })}
          {!hasData && <text x={width / 2} y={height / 2} textAnchor="middle" className="fill-ink-tertiary text-sm">近 30 天暂无消耗记录</text>}
        </svg>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-ink-secondary">
        {MODEL_KEYS.map((key) => (
          <span key={key} className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: MODEL_COLORS[key] }} />
            {MODEL_LABELS[key]}
          </span>
        ))}
      </div>
    </div>
  );
}

function PeriodCard({ label, costMicros }: { label: string; costMicros: number }) {
  return (
    <div className="card p-5">
      <p className="text-sm text-ink-secondary">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">{formatYuan(costMicros)}</p>
      <p className="mt-1 text-xs text-ink-tertiary">固定核心模型预估</p>
    </div>
  );
}

function RecordsTable({ records, expanded, onToggle }: {
  records: UsageRecordsResult;
  expanded: Set<string>;
  onToggle: (id: string) => void;
}) {
  if (records.items.length === 0) {
    return <div className="rounded-xl bg-surface-subtle px-4 py-10 text-center text-sm text-ink-tertiary">当前筛选没有调用记录</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="border-b border-hairline text-xs text-ink-tertiary">
          <tr>
            <th className="px-3 py-3 font-medium">时间</th>
            <th className="px-3 py-3 font-medium">模型 / 类别</th>
            <th className="px-3 py-3 font-medium">原生用量</th>
            <th className="px-3 py-3 text-right font-medium">金额</th>
            <th className="w-10 px-3 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {records.items.map((record) => {
            const breakdown = tokenBreakdown(record);
            const isExpanded = expanded.has(record.id);
            return (
              <Fragment key={record.id}>
                <tr key={record.id} className="align-top hover:bg-surface-subtle/60">
                  <td className="whitespace-nowrap px-3 py-3 text-ink-secondary">{formatTime(record.createdAt)}</td>
                  <td className="px-3 py-3">
                    <div className="font-medium text-ink">{record.model || MODEL_LABELS[record.coreModelKey]}</div>
                    <div className="mt-1 text-xs text-ink-tertiary">{CATEGORY_LABELS[record.category]} · {record.providerName || record.providerId}</div>
                  </td>
                  <td className="px-3 py-3 text-ink-secondary">{formatQuantity(record.quantity, record.unit)}<span className="ml-2 text-xs text-ink-tertiary">{INTEGER_FORMAT.format(record.callCount)} 次</span></td>
                  <td className="px-3 py-3 text-right font-medium text-ink">{formatYuan(record.costMicros)}</td>
                  <td className="px-3 py-3 text-right">
                    {breakdown && (
                      <button type="button" onClick={() => onToggle(record.id)} className="text-xs text-accent hover:underline" aria-expanded={isExpanded}>
                        {isExpanded ? '收起' : '明细'}
                      </button>
                    )}
                  </td>
                </tr>
                {breakdown && isExpanded && (
                  <tr key={`${record.id}-detail`} className="bg-surface-subtle/50">
                    <td colSpan={5} className="px-3 py-3 text-xs text-ink-secondary">
                      <div className="flex flex-wrap gap-x-5 gap-y-2">
                        <span>input_token：{NUMBER_FORMAT.format(breakdown.input || 0)}</span>
                        <span>output_token：{NUMBER_FORMAT.format(breakdown.output || 0)}</span>
                        <span>cached_input_token：{NUMBER_FORMAT.format(breakdown.cached || 0)}</span>
                        <span>预估：{breakdown.estimated ? '是' : '否'}</span>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function UsageDashboard() {
  const [filters, setFilters] = useState<UsageFilters>(initialFilters);
  const [page, setPage] = useState(1);
  const [dashboard, setDashboard] = useState<UsageDashboardResult | null>(null);
  const [records, setRecords] = useState<UsageRecordsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<RequestError | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [reloadNonce, setReloadNonce] = useState(0);
  const query = useMemo(() => buildQuery(filters, page), [filters, page]);

  useEffect(() => {
    const controller = new AbortController();
    // The request lifecycle is external state synchronization; reset these
    // flags before subscribing to the two API responses.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    Promise.all([
      fetchJson<UsageDashboardResult>(`/api/usage?${query}`, controller.signal),
      fetchJson<UsageRecordsResult>(`/api/usage/records?${query}`, controller.signal),
    ]).then(([nextDashboard, nextRecords]) => {
      setDashboard(nextDashboard);
      setRecords(nextRecords);
      setExpanded(new Set());
    }).catch((reason: unknown) => {
      if (reason instanceof DOMException && reason.name === 'AbortError') return;
      setError(reason instanceof Error ? reason as RequestError : new Error('消耗统计加载失败'));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [query, reloadNonce]);

  const updateFilter = (key: keyof UsageFilters, value: string) => {
    setPage(1);
    setFilters((current) => ({ ...current, [key]: value }));
  };

  const hasEmptyDashboard = dashboard && dashboard.models.length === 0 && dashboard.totals.callCount === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-accent">Usage</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-[-0.03em]">消耗</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-secondary">固定核心模型的本地用量汇总、趋势与调用流水。</p>
        </div>
        <p className="max-w-md rounded-xl border border-accent/20 bg-accent-tint/10 px-3 py-2 text-xs leading-5 text-ink-secondary">仅统计固定核心模型；预估消耗由后台固定单价与记录用量计算，非上游真实账单。</p>
      </div>

      <div className="card grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-xs text-ink-secondary">开始日期
          <input type="date" value={filters.from} onChange={(event) => updateFilter('from', event.target.value)} className="input-field mt-1" />
        </label>
        <label className="text-xs text-ink-secondary">结束日期（含）
          <input type="date" value={filters.to} onChange={(event) => updateFilter('to', event.target.value)} className="input-field mt-1" />
        </label>
        <label className="text-xs text-ink-secondary">模型
          <select value={filters.coreModelKey} onChange={(event) => updateFilter('coreModelKey', event.target.value)} className="input-field mt-1">
            <option value="">全部核心模型</option>
            {MODEL_KEYS.map((key) => <option key={key} value={key}>{MODEL_LABELS[key]}</option>)}
          </select>
        </label>
        <label className="text-xs text-ink-secondary">类别
          <select value={filters.category} onChange={(event) => updateFilter('category', event.target.value)} className="input-field mt-1">
            <option value="">全部类别</option>
            {(Object.keys(CATEGORY_LABELS) as CoreUsageCategory[]).map((category) => <option key={category} value={category}>{CATEGORY_LABELS[category]}</option>)}
          </select>
        </label>
      </div>

      {loading && !dashboard ? (
        <div className="card flex items-center justify-center gap-3 py-20 text-sm text-ink-tertiary"><span className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />加载消耗数据…</div>
      ) : error ? (
        <div className="card border-fail/25 bg-fail/5 px-5 py-10 text-center">
          <p className="font-medium text-fail">{error.status === 503 ? '消耗统计暂不可用' : '消耗数据加载失败'}</p>
          <p className="mt-2 text-sm text-ink-secondary">{error.message}</p>
          <button type="button" onClick={() => setReloadNonce((current) => current + 1)} className="btn-secondary btn-sm mt-4">重新加载</button>
        </div>
      ) : dashboard && records ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <PeriodCard label="今日" costMicros={dashboard.periodTotals.todayCostMicros} />
            <PeriodCard label="本周" costMicros={dashboard.periodTotals.weekCostMicros} />
            <PeriodCard label="本月" costMicros={dashboard.periodTotals.monthCostMicros} />
          </div>

          <section className="card p-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div><h2 className="text-lg font-semibold">模型消耗排行</h2><p className="mt-1 text-xs text-ink-tertiary">按当前日期与筛选范围汇总</p></div>
              <p className="text-xs text-ink-tertiary">总计 {formatYuan(dashboard.totals.costMicros)} · {INTEGER_FORMAT.format(dashboard.totals.callCount)} 次</p>
            </div>
            {dashboard.models.length === 0 ? <p className="py-10 text-center text-sm text-ink-tertiary">当前范围暂无模型消耗</p> : <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[680px] text-left text-sm"><thead className="border-b border-hairline text-xs text-ink-tertiary"><tr><th className="px-3 py-3 font-medium">模型</th><th className="px-3 py-3 font-medium">类别</th><th className="px-3 py-3 font-medium">调用次数</th><th className="px-3 py-3 font-medium">原生用量</th><th className="px-3 py-3 text-right font-medium">金额</th><th className="px-3 py-3 text-right font-medium">占比</th></tr></thead><tbody className="divide-y divide-hairline">{dashboard.models.map((model) => <tr key={`${model.coreModelKey}-${model.unit}`}><td className="px-3 py-3 font-medium text-ink">{model.model || MODEL_LABELS[model.coreModelKey]}</td><td className="px-3 py-3 text-ink-secondary">{model.categories.map((category) => CATEGORY_LABELS[category]).join('、')}</td><td className="px-3 py-3 text-ink-secondary">{INTEGER_FORMAT.format(model.callCount)}</td><td className="px-3 py-3 text-ink-secondary">{formatQuantity(model.quantity, model.unit)}</td><td className="px-3 py-3 text-right font-medium text-ink">{formatYuan(model.costMicros)}</td><td className="px-3 py-3 text-right"><div className="flex items-center justify-end gap-2"><span className="text-xs text-ink-secondary">{model.percentage.toFixed(2)}%</span><span className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-subtle"><span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, model.percentage))}%` }} /></span></div></td></tr>)}</tbody></table></div>}
          </section>

          <section className="card p-5">
            <div><h2 className="text-lg font-semibold">近 30 天</h2><p className="mt-1 text-xs text-ink-tertiary">按模型查看每日固定价格预估</p></div>
            <div className="mt-5"><TrendChart trend={dashboard.trend} /></div>
          </section>

          <section className="card p-5">
            <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-lg font-semibold">调用流水</h2><p className="mt-1 text-xs text-ink-tertiary">按时间倒序，金额均为人民币展示值</p></div><p className="text-xs text-ink-tertiary">共 {records.total} 条</p></div>
            <div className="mt-4"><RecordsTable records={records} expanded={expanded} onToggle={(id) => setExpanded((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })} /></div>
            {records.totalPages > 1 && <div className="mt-5 flex items-center justify-between text-sm"><button type="button" className="btn-secondary btn-sm" disabled={records.page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>上一页</button><span className="text-xs text-ink-tertiary">第 {records.page} / {records.totalPages} 页</span><button type="button" className="btn-secondary btn-sm" disabled={records.page >= records.totalPages} onClick={() => setPage((current) => current + 1)}>下一页</button></div>}
          </section>

          {hasEmptyDashboard && <p className="text-center text-sm text-ink-tertiary">当前范围没有固定核心模型记录，可调整日期后重试。</p>}
          {dashboard.unresolvedCount > 0 && <p className="text-xs text-ink-tertiary">有 {dashboard.unresolvedCount} 条调用无法确认，未计入金额。</p>}
        </>
      ) : null}
    </div>
  );
}

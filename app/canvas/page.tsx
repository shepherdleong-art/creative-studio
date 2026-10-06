'use client';

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { canvasApi, type CanvasSummaryDto } from '@/components/creative-canvas/api';
import { CanvasThumbnail } from '@/components/creative-canvas/CanvasThumbnail';
import { Icon } from '@/components/ui/Icon';

type ViewMode = 'card' | 'table';
type SortKey = 'name' | 'nodeCount' | 'updatedAt';
type SortDir = 'asc' | 'desc';

// 视图偏好与首页项目列表同一套机制：useSyncExternalStore 读 localStorage，
// 服务端快照固定 'card'，hydration 后才切到真实偏好。
const VIEW_MODE_STORAGE_KEY = 'creative-studio:canvas-view-mode';

const viewModeListeners = new Set<() => void>();

function subscribeViewMode(onChange: () => void): () => void {
  viewModeListeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    viewModeListeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

function readViewMode(): ViewMode {
  try {
    return window.localStorage.getItem(VIEW_MODE_STORAGE_KEY) === 'table' ? 'table' : 'card';
  } catch {
    return 'card';
  }
}

const readViewModeOnServer = (): ViewMode => 'card';

function writeViewMode(mode: ViewMode): void {
  try {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // 隐私模式下偏好丢失即可，不影响功能
  }
  viewModeListeners.forEach((listener) => listener());
}

function formatDateOnly(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('zh-CN');
}

function formatCompactTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function CanvasListPage() {
  const router = useRouter();
  const [canvases, setCanvases] = useState<CanvasSummaryDto[]>([]);
  const [name, setName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const viewMode = useSyncExternalStore(subscribeViewMode, readViewMode, readViewModeOnServer);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('updatedAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const load = useCallback(async () => {
    try {
      const { canvases: next } = await canvasApi.list();
      setCanvases(next);
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '画布列表加载失败。');
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
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const { canvas } = await canvasApi.create(trimmed);
      window.location.href = `/canvas/${canvas.id}`;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '新建画布失败。');
    }
  }, [name]);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredCanvases = useMemo(() => {
    if (!normalizedQuery) return canvases;
    return canvases.filter((canvas) => canvas.name.toLowerCase().includes(normalizedQuery));
  }, [canvases, normalizedQuery]);

  // 排序只作用于表格视图，卡片视图保持接口返回顺序
  const tableCanvases = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filteredCanvases].sort((a, b) => {
      if (sortKey === 'name') return a.name.localeCompare(b.name, 'zh-CN') * dir;
      if (sortKey === 'nodeCount') return (a.nodeCount - b.nodeCount) * dir;
      return a.updatedAt.localeCompare(b.updatedAt) * dir;
    });
  }, [filteredCanvases, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  };

  const hasCanvases = canvases.length > 0;
  const noMatches = hasCanvases && filteredCanvases.length === 0;

  const sortHeader = (key: SortKey, label: string) => (
    <button
      type="button"
      onClick={() => toggleSort(key)}
      className={`inline-flex items-center gap-1 font-medium transition-colors hover:text-ink ${
        sortKey === key ? 'text-ink' : ''
      }`}
      aria-label={`按${label}排序`}
    >
      {label}
      <Icon
        name="chevron-right"
        size={13}
        className={`transition-transform ${sortDir === 'asc' ? '-rotate-90' : 'rotate-90'} ${
          sortKey === key ? 'opacity-100' : 'opacity-0'
        }`}
      />
    </button>
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[1.6rem] font-semibold tracking-tight text-ink">创作画布</h1>
        <p className="mt-1 text-sm text-ink-secondary">按创作主题组织画布，多组图片与视频任务并行推进。</p>
      </header>

      <section className="card flex items-center gap-2 p-2 pl-4" data-testid="create-canvas">
        <input
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-ink-tertiary"
          placeholder="新画布名称，例如：沙发场景探索"
          value={name}
          data-testid="new-canvas-name"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void create();
          }}
        />
        <button type="button" className="btn-primary btn-sm" data-testid="create-canvas-button" onClick={() => { void create(); }}>
          新建画布
        </button>
      </section>

      {message ? (
        <p className="sc-canvas-banner" data-testid="list-message">{message}</p>
      ) : null}

      <section data-testid="canvas-list">
        {hasCanvases && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[1.15rem] font-semibold tracking-tight text-ink">
              画布
              {normalizedQuery && (
                <span className="ml-2 text-sm font-normal text-ink-tertiary">
                  {filteredCanvases.length} / {canvases.length}
                </span>
              )}
            </h2>

            <div className="flex items-center gap-2.5">
              {/* 宽度给在外层:.input-field 自带 width:100%,直接给 input 加 w-* 会被压掉 */}
              <div className="relative w-[16.5rem] max-w-full">
                <Icon
                  name="search"
                  size={15}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-tertiary"
                />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索画布名称"
                  aria-label="搜索画布"
                  className="input-field search-field"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-ink-tertiary transition-colors hover:text-ink"
                    aria-label="清除搜索"
                  >
                    <Icon name="close" size={13} />
                  </button>
                )}
              </div>

              <div className="segmented" role="group" aria-label="列表视图切换">
                <button
                  type="button"
                  aria-pressed={viewMode === 'card'}
                  onClick={() => writeViewMode('card')}
                  className="inline-flex items-center gap-1.5"
                  title="卡片视图"
                >
                  <Icon name="grid" size={14} />卡片
                </button>
                <button
                  type="button"
                  aria-pressed={viewMode === 'table'}
                  onClick={() => writeViewMode('table')}
                  className="inline-flex items-center gap-1.5"
                  title="表格视图"
                >
                  <Icon name="table" size={14} />表格
                </button>
              </div>
            </div>
          </div>
        )}

        {loading ? (
          <div className="py-10 text-center text-ink-tertiary">
            <div className="mx-auto mb-2 h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            加载中…
          </div>
        ) : !hasCanvases ? (
          <div className="py-14 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-subtle text-ink-tertiary">
              <Icon name="image" size={26} />
            </div>
            <h3 className="mb-2 text-lg font-medium text-ink">还没有画布</h3>
            <p className="text-sm text-ink-tertiary">先在上方输入名称，新建一个画布</p>
          </div>
        ) : noMatches ? (
          <div className="py-14 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-subtle text-ink-tertiary">
              <Icon name="search" size={24} />
            </div>
            <h3 className="mb-2 text-lg font-medium text-ink">没有匹配的画布</h3>
            <p className="mb-5 text-sm text-ink-tertiary">「{query.trim()}」没有匹配到任何画布名称</p>
            <button type="button" onClick={() => setQuery('')} className="btn-secondary">清除搜索</button>
          </div>
        ) : viewMode === 'table' ? (
          <div className="card max-h-[calc(100vh-22rem)] overflow-y-auto overscroll-contain p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-hairline text-left text-ink-secondary">
                  <th className="px-4 py-2.5 font-medium">{sortHeader('name', '画布')}</th>
                  <th className="px-4 py-2.5 font-medium">{sortHeader('nodeCount', '节点')}</th>
                  <th className="px-4 py-2.5 font-medium">创建时间</th>
                  <th className="px-4 py-2.5 font-medium">{sortHeader('updatedAt', '最近更新')}</th>
                </tr>
              </thead>
              <tbody>
                {tableCanvases.map((canvas) => (
                  <tr
                    key={canvas.id}
                    onClick={() => router.push(`/canvas/${canvas.id}`)}
                    className="cursor-pointer border-b border-hairline-soft transition-colors last:border-b-0 hover:bg-surface-subtle"
                    data-testid={`canvas-item-${canvas.id}`}
                  >
                    <td className="max-w-[26rem] px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-subtle text-ink-tertiary">
                          <Icon name="image" size={14} />
                        </div>
                        <span className="truncate font-medium text-ink" title={canvas.name}>{canvas.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-ink-secondary">{canvas.nodeCount} 个节点</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs text-ink-secondary">{formatCompactTime(canvas.createdAt)}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs text-ink-secondary">{formatCompactTime(canvas.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        ) : (
          /* 卡片视图与首页项目列表同一版式：色块占位 + 名称 + 一行元信息 */
          <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4">
            {filteredCanvases.map((canvas) => (
              <Link
                key={canvas.id}
                href={`/canvas/${canvas.id}`}
                className="group block"
                data-testid={`canvas-item-${canvas.id}`}
              >
                <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-surface-subtle ring-1 ring-hairline transition-shadow group-hover:shadow-[0_10px_30px_rgba(0,0,0,.14)]">
                  {canvas.preview.nodes.length > 0 ? (
                    <CanvasThumbnail preview={canvas.preview} />
                  ) : (
                    <div className="grid h-full w-full place-items-center text-ink-tertiary">
                      <Icon name="image" size={28} />
                    </div>
                  )}
                </div>
                <div className="mt-2 truncate text-[0.9rem] font-medium text-ink" title={canvas.name}>{canvas.name}</div>
                <div className="mt-0.5 flex items-baseline justify-between gap-2 text-xs text-ink-tertiary">
                  <span className="truncate">{canvas.nodeCount} 个节点</span>
                  <span className="shrink-0">{formatDateOnly(canvas.updatedAt)}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

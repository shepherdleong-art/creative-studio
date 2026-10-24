'use client';

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/ui/Icon';
import { STORE_CODES } from '@/lib/project-production-identity';
import {
  LIVE_MIXCUT_PRODUCTION_TYPE,
  buildLiveMixcutTaskName,
  liveMixcutToday,
} from '@/lib/live-mixcut/naming';

type ViewMode = 'card' | 'table';

// 与首页/画布列表同一套视图偏好机制：服务端固定卡片，hydration 后读取本机偏好。
const VIEW_MODE_STORAGE_KEY = 'creative-studio:live-mixcut-view-mode';
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
    // 隐私模式下偏好丢失即可，不影响功能。
  }
  viewModeListeners.forEach(listener => listener());
}

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

function formatDateOnly(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('zh-CN');
}

async function readProjectResponse(response: Response, fallback: string): Promise<ProjectResponse> {
  const body = await response.json().catch(() => ({})) as ProjectResponse;
  if (!response.ok) throw new Error(body.message || fallback);
  return body;
}

export default function LiveMixcutListPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<LiveMixcutProject[]>([]);
  const [storeCode, setStoreCode] = useState('');
  const [productCode, setProductCode] = useState('');
  const [editorName, setEditorName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const viewMode = useSyncExternalStore(subscribeViewMode, readViewMode, readViewModeOnServer);
  const [query, setQuery] = useState('');

  const namingDate = useMemo(() => liveMixcutToday(), []);
  const namePreview = useMemo(() => {
    if (!storeCode || !productCode.trim() || !editorName.trim()) return '';
    try {
      return buildLiveMixcutTaskName({
        storeCode,
        productCode: productCode.trim(),
        editorName: editorName.trim(),
      }, namingDate);
    } catch {
      return '';
    }
  }, [storeCode, productCode, editorName, namingDate]);
  const canCreate = Boolean(namePreview);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredProjects = useMemo(() => {
    if (!normalizedQuery) return projects;
    return projects.filter(project => `${project.name} ${project.productName}`.toLocaleLowerCase().includes(normalizedQuery));
  }, [projects, normalizedQuery]);
  const noMatches = projects.length > 0 && filteredProjects.length === 0;

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
    if (!canCreate) return;
    setCreating(true);
    setMessage(null);
    try {
      const response = await fetch('/api/live-mixcut/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storeCode,
          productCode: productCode.trim(),
          editorName: editorName.trim(),
        }),
      });
      const body = await readProjectResponse(response, '任务创建失败。');
      if (!body.project) throw new Error('任务创建失败。');
      router.push(`/live-mixcut/${body.project.id}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '任务创建失败。');
      setCreating(false);
    }
  }, [canCreate, storeCode, productCode, editorName, router]);

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
        className="card p-4"
        data-testid="create-live-mixcut"
        onSubmit={(event) => { event.preventDefault(); void create(); }}
      >
        <h3 className="mb-3 text-sm font-semibold text-ink">生产身份</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="live-mixcut-store">店铺 *</label>
            <select
              id="live-mixcut-store"
              className="input-field"
              value={storeCode}
              data-testid="new-live-mixcut-store"
              onChange={(event) => setStoreCode(event.target.value)}
            >
              <option value="">请选择</option>
              {STORE_CODES.map((store) => (<option key={store} value={store}>{store}</option>))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="live-mixcut-product-code">型号 *</label>
            <input
              id="live-mixcut-product-code"
              className="input-field"
              placeholder="例如：XQ9A 或 PC672-A"
              value={productCode}
              data-testid="new-live-mixcut-product-code"
              onChange={(event) => setProductCode(event.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="live-mixcut-production-type">生产类型 *</label>
            <input
              id="live-mixcut-production-type"
              className="input-field bg-transparent text-ink-secondary"
              readOnly
              value={LIVE_MIXCUT_PRODUCTION_TYPE}
            />
          </div>
          <div>
            <label className="label" htmlFor="live-mixcut-editor">剪辑师 *</label>
            <input
              id="live-mixcut-editor"
              className="input-field"
              placeholder="例如：紫菜卷"
              value={editorName}
              data-testid="new-live-mixcut-editor"
              onChange={(event) => setEditorName(event.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="live-mixcut-name">任务名（自动生成）</label>
            <input
              id="live-mixcut-name"
              className="input-field bg-transparent text-ink-secondary"
              readOnly
              placeholder="填写完生产身份后自动生成"
              value={namePreview}
              data-testid="new-live-mixcut-name"
            />
          </div>
        </div>
        <p className="mt-3 text-xs text-ink-tertiary">
          任务名由系统按「日期-店铺-型号-{LIVE_MIXCUT_PRODUCTION_TYPE}-剪辑师」自动生成，创建后不再改变。
        </p>
        <div className="mt-4 flex items-center justify-end">
          <button
            type="submit"
            className="btn-primary btn-sm"
            data-testid="create-live-mixcut-button"
            disabled={creating || !canCreate}
          >{creating ? '创建中…' : '创建任务'}</button>
        </div>
      </form>

      <section data-testid="live-mixcut-list">
        {message && <p className="mb-4 rounded-xl bg-warn/10 px-4 py-3 text-sm text-warn" role="alert">{message}</p>}
        {!loading && projects.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[1.15rem] font-semibold tracking-tight text-ink">
              任务
              {normalizedQuery && (
                <span className="ml-2 text-sm font-normal text-ink-tertiary">
                  {filteredProjects.length} / {projects.length}
                </span>
              )}
            </h2>

            <div className="flex items-center gap-2.5">
              <div className="relative w-[16.5rem] max-w-full">
                <Icon
                  name="search"
                  size={15}
                  className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-tertiary"
                />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索任务名 / 型号"
                  aria-label="搜索任务"
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
        ) : projects.length === 0 ? (
          <div className="py-14 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-subtle text-ink-tertiary">
              <Icon name="image" size={26} />
            </div>
            <h3 className="mb-2 text-lg font-medium text-ink">还没有实拍混剪任务</h3>
            <p className="text-sm text-ink-tertiary">在上方填写店铺、型号和剪辑师，点「创建任务」开始。</p>
          </div>
        ) : noMatches ? (
          <div className="py-14 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-subtle text-ink-tertiary">
              <Icon name="search" size={24} />
            </div>
            <h3 className="mb-2 text-lg font-medium text-ink">没有匹配的任务</h3>
            <p className="mb-5 text-sm text-ink-tertiary">「{query.trim()}」没有匹配到任何任务名或型号</p>
            <button type="button" onClick={() => setQuery('')} className="btn-secondary">清除搜索</button>
          </div>
        ) : viewMode === 'table' ? (
          <div className="card overflow-hidden p-0">
            {filteredProjects.map(project => (
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
        ) : (
          <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4">
            {filteredProjects.map(project => (
              <article key={project.id} className="group relative" data-testid={`live-mixcut-item-${project.id}`}>
                <Link href={`/live-mixcut/${project.id}`} className="block">
                  <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-surface-subtle ring-1 ring-hairline transition-shadow group-hover:shadow-[0_10px_30px_rgba(0,0,0,.14)]">
                    <span className="absolute left-2 top-2 rounded-full bg-surface/90 px-2 py-0.5 text-[11px] text-ink-secondary">实拍混剪</span>
                    <div className="grid h-full w-full place-items-center text-ink-tertiary">
                      <Icon name="image" size={28} />
                    </div>
                  </div>
                  <div className="mt-2 truncate text-[0.9rem] font-medium text-ink" title={project.name}>{project.name}</div>
                  <div className="mt-0.5 flex items-baseline justify-between gap-2 text-xs text-ink-tertiary">
                    <span className="truncate">{project.productName || '暂无任务'}</span>
                    <span className="shrink-0">{formatDateOnly(project.createdAt)}</span>
                  </div>
                </Link>
                <button
                  type="button"
                  className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-surface/90 text-ink-tertiary transition-colors hover:text-fail disabled:opacity-50"
                  aria-label={`删除任务 ${project.name}`}
                  disabled={deletingId !== null}
                  onClick={() => { void remove(project); }}
                >
                  <Icon name="trash" size={13} />
                </button>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

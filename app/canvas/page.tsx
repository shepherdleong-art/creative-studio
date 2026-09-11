'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { canvasApi, type CanvasSummaryDto } from '@/components/creative-canvas/api';
import ThemeToggle from '@/components/ThemeToggle';

export default function CanvasListPage() {
  const [canvases, setCanvases] = useState<CanvasSummaryDto[]>([]);
  const [name, setName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-6 px-6 py-12">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-[22px] font-semibold">创作画布</h1>
          <p className="mt-1 text-[12px] text-ink-secondary">按创作主题组织画布，多组图片与视频任务并行推进。</p>
        </div>
        <div className="flex items-center gap-2">
          <Link className="sc-canvas-button" href="/">返回工作台</Link>
          <ThemeToggle />
        </div>
      </header>

      <section className="sc-canvas-card flex items-center gap-2" data-testid="create-canvas">
        <input
          className="sc-canvas-input flex-1 bg-transparent text-[13px] outline-none"
          placeholder="新画布名称，例如：沙发场景探索"
          value={name}
          data-testid="new-canvas-name"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void create();
          }}
        />
        <button type="button" className="sc-canvas-button sc-canvas-button-primary" data-testid="create-canvas-button" onClick={() => { void create(); }}>
          新建画布
        </button>
      </section>

      {message ? (
        <p className="sc-canvas-banner" data-testid="list-message">{message}</p>
      ) : null}

      <section className="space-y-2" data-testid="canvas-list">
        {loading ? <p className="text-[12px] text-ink-secondary">加载中…</p> : null}
        {!loading && canvases.length === 0 ? (
          <p className="text-[12px] text-ink-secondary">还没有画布，先新建一个。</p>
        ) : null}
        {canvases.map((canvas) => (
          <Link
            key={canvas.id}
            className="sc-canvas-card flex items-center justify-between"
            href={`/canvas/${canvas.id}`}
            data-testid={`canvas-item-${canvas.id}`}
          >
            <span className="text-[13px] font-medium">{canvas.name}</span>
            <span className="text-[11px] text-ink-tertiary">
              {canvas.nodeCount} 个节点 · {new Date(canvas.updatedAt).toLocaleString('zh-CN')}
            </span>
          </Link>
        ))}
      </section>
    </main>
  );
}
